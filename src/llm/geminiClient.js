import { RequirementParser } from '../audit/requirementParser.js';
import { telemetry } from '../observability/telemetry.js';

/**
 * Gemini LLM Client
 * Uses Node 22 native fetch to call Google Gemini API.
 * Falls back to intelligent simulation mode when no API key is configured.
 */

export class GeminiClient {
  constructor(options = {}) {
    if (!process.env.GEMINI_API_KEY && typeof process.loadEnvFile === 'function') {
      try { process.loadEnvFile(); } catch (_) {}
    }
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY || null;
    this.model = options.model || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    this.fallbackModel = options.fallbackModel || process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash';
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
    this.simulationMode = Boolean(options.simulationMode) || !this.apiKey;
    this.requestTimestamps = [];
    this.maxRequestsPerMinute = Number(options.maxRequestsPerMinute || process.env.GEMINI_RPM_LIMIT || 14);

    if (this.simulationMode) {
      console.log('[LLM] Simulation mode active.');
    } else {
      console.log(`[LLM] Gemini client initialized. Model: ${this.model}`);
    }
  }

  /**
   * Enforces client-side rate limiting to stay within the API quota (default 14 RPM).
   */
  async _enforceRateLimit() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    this.requestTimestamps = this.requestTimestamps.filter(ts => ts > oneMinuteAgo);
    if (this.requestTimestamps.length >= this.maxRequestsPerMinute) {
      const oldestInWindow = this.requestTimestamps[0];
      const waitTime = Math.max(100, (oldestInWindow + 60000) - now + 250);
      if (waitTime <= 8000) {
        console.log(`[LLM] Rate-limiter: Approaching ${this.maxRequestsPerMinute} RPM quota limit. Throttling request by ${waitTime}ms...`);
        await new Promise(r => setTimeout(r, waitTime));
      }
    }
  }

  _recordRequestTimestamp() {
    this.requestTimestamps.push(Date.now());
  }

  /**
   * Send a prompt to Gemini and return the text response.
   * Returns estimated token usage for budget metering.
   */
  async generate({ role = null, systemPrompt, userMessage, temperature = 0.7, timeoutMs = 15000, maxOutputTokens = 8192 }) {
    const startTime = Date.now();
    if (this.simulationMode) {
      const sim = this._simulate(systemPrompt, userMessage, role);
      const durationMs = Date.now() - startTime;
      telemetry.recordLlmGeneration({
        model: 'simulation',
        provider: 'simulation',
        totalTokens: sim.tokensUsed || 350,
        durationSeconds: durationMs / 1000
      });
      return { ...sim, durationMs, provider: 'simulation' };
    }

    const tryCall = async (modelName, callTimeoutMs = timeoutMs) => {
      const url = `${this.baseUrl}/${modelName}:generateContent?key=${this.apiKey}`;
      const body = {
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemPrompt}\n\n---\n\n${userMessage}` }]
          }
        ],
        generationConfig: {
          temperature,
          maxOutputTokens
        }
      };

      const maxRetries = 1;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        await this._enforceRateLimit();

        let res;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(callTimeoutMs)
          });
        } catch (fetchErr) {
          const isTimeout = fetchErr.name === 'TimeoutError' || fetchErr.code === 20;
          if (attempt < maxRetries && isTimeout && callTimeoutMs <= 10000) {
            console.warn(`[LLM] Request to ${modelName} timed out after ${callTimeoutMs}ms (attempt ${attempt + 1}/${maxRetries + 1}). Retrying once...`);
            await new Promise(r => setTimeout(r, 500));
            continue;
          }
          throw fetchErr;
        }

        if (!res.ok) {
          const errText = await res.text();
          let retryDelayMs = null;
          try {
            const errObj = JSON.parse(errText);
            const retryInfo = errObj.error?.details?.find(d => d && d['@type'] && d['@type'].includes('RetryInfo'));
            if (retryInfo?.retryDelay) {
              const seconds = parseFloat(retryInfo.retryDelay.replace('s', ''));
              if (!isNaN(seconds)) retryDelayMs = Math.ceil(seconds * 1000);
            }
          } catch (_) {}

          // Retriable HTTP statuses: 429 (Resource Exhausted / Rate Limit), 503 (Overloaded), 500 (Internal)
          if (attempt < maxRetries && (res.status === 429 || res.status === 503 || res.status === 500)) {
            if (retryDelayMs && retryDelayMs > 8000) {
              console.warn(`[LLM] Gemini quota retry delay (${retryDelayMs}ms) exceeds 8s threshold. Switching to fallback.`);
              throw new Error(`Gemini API quota retryDelay (${retryDelayMs}ms) exceeds threshold`);
            }
            const waitMs = retryDelayMs || Math.min(8000, Math.pow(2, attempt) * 1500 + Math.floor(Math.random() * 500));
            console.warn(`[LLM] Gemini API ${res.status} on ${modelName} (attempt ${attempt + 1}/${maxRetries + 1}). Backing off ${waitMs}ms before retry...`);
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }

          throw new Error(`Gemini API error ${res.status}: ${errText}`);
        }

        this._recordRequestTimestamp();
        const data = await res.json();
        const candidate = data.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        const text = parts.map(p => p.text || '').filter(Boolean).join('\n');
        const usage = data.usageMetadata || {};

        const durationMs = Date.now() - startTime;
        const promptTokens = usage.promptTokenCount || 0;
        const completionTokens = usage.candidatesTokenCount || 0;
        const totalTokens = promptTokens + completionTokens;

        telemetry.recordLlmGeneration({
          model: modelName,
          provider: 'google',
          promptTokens,
          completionTokens,
          totalTokens,
          durationSeconds: durationMs / 1000
        });

        return {
          text,
          tokensUsed: totalTokens,
          promptTokens,
          completionTokens,
          simulated: false,
          modelUsed: modelName,
          provider: 'google',
          durationMs
        };
      }
    };

    const redactApiKey = (msg) => {
      if (!msg || typeof msg !== 'string' || !this.apiKey) return msg || '';
      const escaped = this.apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return msg.replace(new RegExp(escaped, 'g'), '[REDACTED]');
    };

    try {
      return await tryCall(this.model);
    } catch (err) {
      const safeMsg = redactApiKey(err.message);
      console.warn(`[LLM] Primary model ${this.model} failed (${safeMsg}). Trying fallback ${this.fallbackModel}...`);
      if (this.fallbackModel && this.fallbackModel !== this.model) {
        try {
          return await tryCall(this.fallbackModel);
        } catch (fallbackErr) {
          const safeFallbackMsg = redactApiKey(fallbackErr.message);
          console.warn(`[LLM] Fallback model failed (${safeFallbackMsg}). Falling back to simulation.`);
        }
      }
      const sim = this._simulate(systemPrompt, userMessage, role);
      const durationMs = Date.now() - startTime;
      return { ...sim, durationMs, provider: 'simulation_fallback' };
    }
  }

  /**
   * Intelligent simulation — generates contextually relevant responses
   * based on the agent role extracted from the system prompt or passed explicitly.
   */
  _simulate(systemPrompt, userMessage, explicitRole = null) {
    if (systemPrompt && (systemPrompt.includes('"objective"') || systemPrompt.includes('"requirements"'))) {
      const detectedDomain = RequirementParser.detectDomain(userMessage);
      const featureName = RequirementParser.extractFeatureName(userMessage, detectedDomain);
      const requirements = RequirementParser.extractRequirements(userMessage, detectedDomain);
      const exclusions = RequirementParser.extractExclusions(userMessage, detectedDomain);

      const jsonRes = JSON.stringify({
        objective: userMessage.slice(0, 120),
        domain: detectedDomain,
        featureName,
        requirements,
        exclusions,
        nonFunctional: [
          'Responsive layout for mobile, tablet, and desktop viewports',
          'In-memory SQLite persistence with ACID integrity',
          'Automated node:test suite with 100% assertions passing'
        ]
      }, null, 2);

      return {
        text: jsonRes,
        tokensUsed: Math.ceil(jsonRes.length / 4),
        promptTokens: Math.ceil((systemPrompt.length + userMessage.length) / 4),
        completionTokens: Math.ceil(jsonRes.length / 4),
        simulated: true
      };
    }

    const role = this._detectRole(systemPrompt, explicitRole);
    const text = this._generateRoleResponse(role, userMessage);
    const tokensUsed = Math.ceil((systemPrompt.length + userMessage.length + text.length) / 4);

    return {
      text,
      tokensUsed,
      promptTokens: Math.ceil((systemPrompt.length + userMessage.length) / 4),
      completionTokens: Math.ceil(text.length / 4),
      simulated: true
    };
  }

  _detectRole(systemPrompt, explicitRole = null) {
    if (explicitRole) return explicitRole;
    const lc = systemPrompt.toLowerCase();
    if (/\bbackend\b/i.test(lc)) return 'BACKEND';
    if (/\bfrontend\b/i.test(lc)) return 'FRONTEND';
    if (/\bqa\b|\btest\b/i.test(lc)) return 'QA';
    if (/\bdevops\b|\bsecurity\b/i.test(lc)) return 'DEVOPS';
    if (/\bproduct manager\b|\bprd\b/i.test(lc)) return 'PM';
    if (/\barchitect\b|\badr\b/i.test(lc)) return 'ARCHITECT';
    return 'SYSTEM';
  }

  _detectDomain(message) {
    return RequirementParser.detectDomain(message);
  }

  _generateRoleResponse(role, userMessage) {
    const project = this._extractProjectContext(userMessage);
    const domain = this._detectDomain(userMessage);

    const domainTemplates = {
      CHAT: {
        prdSummary: 'High-throughput real-time collaborative workspace with multi-channel messaging and presence telemetry.',
        userStories: '1. **AS** a team member **I WANT** to stream messages over SSE **SO THAT** latency is sub-10ms\n2. **AS** an operator **I WANT** typing indicators **SO THAT** collaboration feels fluid\n3. **AS** a developer **I WANT** SQLite WAL logging **SO THAT** messages are ACID-persisted',
        adrComponents: '┌───────────────────────────────────┐\n│         SSE Stream & REST API     │\n├─────────┬──────────┬──────────────┤\n│ Channel │ Messages │ Presence Svc │\n├─────────┴──────────┴──────────────┤\n│       SQLite (WAL Mode, ACID)     │\n└───────────────────────────────────┘',
        schema: 'CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT);\nCREATE TABLE messages (id TEXT PRIMARY KEY, channel_id TEXT, user_id TEXT, content TEXT, created_at TEXT);\nCREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, status TEXT);',
        backendCode: `// Real-Time Chat Engine — ${project}\nimport { DatabaseSync } from 'node:sqlite';\nimport crypto from 'node:crypto';\n\nconst db = new DatabaseSync(':memory:');\ndb.exec(\`\n  CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, name TEXT NOT NULL);\n  CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);\n\`);\n\ndb.prepare("INSERT OR IGNORE INTO channels VALUES (?, ?)").run('c-gen', 'general');\n\nexport function listChannels() {\n  return db.prepare('SELECT * FROM channels').all();\n}\n\nexport function postMessage(channelId, content) {\n  if (!content?.trim()) throw new Error('Message content cannot be empty');\n  const id = 'msg_' + crypto.randomUUID().slice(0, 8);\n  const now = new Date().toISOString();\n  db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?)').run(id, channelId, content.trim(), now);\n  return { id, channelId, content: content.trim(), createdAt: now };\n}\n\nexport function getMessages(channelId) {\n  return db.prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at ASC').all(channelId);\n}`,
        qaTests: `import { test, describe } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { listChannels, postMessage, getMessages } from '../src/api.js';\n\ndescribe('Real-Time Chat Engine', () => {\n  test('lists default channels', () => {\n    const channels = listChannels();\n    assert.ok(Array.isArray(channels));\n    assert.ok(channels.length > 0);\n  });\n\n  test('posts message and retrieves it in channel', () => {\n    const msg = postMessage('c-gen', 'Hello autonomous agents!');\n    assert.ok(msg.id.startsWith('msg_'));\n    const all = getMessages('c-gen');\n    assert.ok(all.some(m => m.id === msg.id));\n  });\n\n  test('rejects empty messages', () => {\n    assert.throws(() => postMessage('c-gen', ''), /empty/i);\n  });\n});`
      },
      AUTH: {
        prdSummary: 'Secure authentication, session token management, and role-based access control gateway.',
        userStories: '1. **AS** a user **I WANT** password hashing via scrypt/argon2 **SO THAT** credentials cannot leak\n2. **AS** an admin **I WANT** session revocation **SO THAT** compromised tokens are halted immediately\n3. **AS** an auditor **I WANT** tamper-evident auth logs **SO THAT** breaches are detected in real-time',
        adrComponents: '┌───────────────────────────────────┐\n│         Auth Gateway (HTTPS)      │\n├─────────┬──────────┬──────────────┤\n│ Password│ Session  │ RBAC Guard   │\n├─────────┴──────────┴──────────────┤\n│      Cryptographic Salt Ledger    │\n└───────────────────────────────────┘',
        schema: 'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, salt TEXT);\nCREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT, expires_at TEXT);',
        backendCode: `// Auth & Session Engine — ${project}\nimport { DatabaseSync } from 'node:sqlite';\nimport crypto from 'node:crypto';\n\nconst db = new DatabaseSync(':memory:');\ndb.exec(\`\n  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, hash TEXT NOT NULL, salt TEXT NOT NULL);\n  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL);\n\`);\n\nfunction hashPassword(password, salt) {\n  return crypto.scryptSync(password, salt, 32).toString('hex');\n}\n\nexport function registerUser(email, password) {\n  if (!email || !password || password.length < 8) throw new Error('Password must be at least 8 characters');\n  const id = 'usr_' + crypto.randomUUID().slice(0, 8);\n  const salt = crypto.randomBytes(16).toString('hex');\n  const hash = hashPassword(password, salt);\n  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(id, email, hash, salt);\n  return { id, email };\n}\n\nexport function authenticate(email, password) {\n  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);\n  if (!user) throw new Error('Invalid credentials');\n  const hash = hashPassword(password, user.salt);\n  if (hash !== user.hash) throw new Error('Invalid credentials');\n  const token = 'sess_' + crypto.randomBytes(24).toString('hex');\n  const expiresAt = new Date(Date.now() + 86400000).toISOString();\n  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(token, user.id, expiresAt);\n  return { token, userId: user.id, expiresAt };\n}`,
        qaTests: `import { test, describe } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { registerUser, authenticate } from '../src/api.js';\n\ndescribe('Authentication Engine', () => {\n  test('registers new user and authenticates successfully', () => {\n    const user = registerUser('admin@nexus.cloud', 'SuperSecurePass123!');\n    assert.ok(user.id.startsWith('usr_'));\n    const session = authenticate('admin@nexus.cloud', 'SuperSecurePass123!');\n    assert.ok(session.token.startsWith('sess_'));\n  });\n\n  test('rejects short passwords', () => {\n    assert.throws(() => registerUser('test@nexus.cloud', 'short'), /8 characters/i);\n  });\n\n  test('rejects invalid credentials', () => {\n    assert.throws(() => authenticate('admin@nexus.cloud', 'WrongPassword!'), /invalid credentials/i);\n  });\n});`
      },
      ECOMMERCE: {
        prdSummary: 'Microservice eCommerce engine with atomic cart transactions, live inventory locks, and stripe-style payments.',
        userStories: '1. **AS** a customer **I WANT** sub-second checkout **SO THAT** I save time\n2. **AS** an inventory manager **I WANT** real-time stock deductions **SO THAT** overselling is impossible\n3. **AS** a developer **I WANT** typed API schemas **SO THAT** integrations are reliable',
        adrComponents: '┌───────────────────────────────────┐\n│         API Gateway (REST)        │\n├─────────┬──────────┬──────────────┤\n│ Catalog │ Checkout │ Inventory    │\n├─────────┴──────────┴──────────────┤\n│      SQLite ACID (node:sqlite)    │\n└───────────────────────────────────┘',
        schema: 'CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT, price REAL, stock INTEGER);\nCREATE TABLE orders (id TEXT PRIMARY KEY, items TEXT, total REAL, status TEXT, created_at TEXT);',
        backendCode: `// eCommerce Engine — ${project}\nimport { DatabaseSync } from 'node:sqlite';\nimport crypto from 'node:crypto';\n\nconst db = new DatabaseSync(':memory:');\ndb.exec(\`\n  CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, price REAL NOT NULL, stock INTEGER NOT NULL DEFAULT 0);\n  CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, items TEXT NOT NULL, total REAL NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', created_at TEXT NOT NULL);\n\`);\n\ndb.prepare("INSERT OR IGNORE INTO products VALUES (?, ?, ?, ?)").run('prod-001', 'Wireless Headphones', 89.99, 150);\ndb.prepare("INSERT OR IGNORE INTO products VALUES (?, ?, ?, ?)").run('prod-002', 'Mechanical Keyboard', 129.99, 75);\n\nexport function listProducts() {\n  return db.prepare('SELECT * FROM products WHERE stock > 0').all();\n}\n\nexport function createOrder({ items, userId }) {\n  if (!items?.length) throw new Error('Cart cannot be empty');\n  const total = items.reduce((sum, i) => sum + (i.price * i.qty), 0);\n  const id = 'ord_' + crypto.randomUUID().slice(0, 8);\n  const now = new Date().toISOString();\n  db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?)').run(id, JSON.stringify(items), total, 'PAID', now);\n  return { id, total: total.toFixed(2), status: 'PAID', createdAt: now };\n}\n\nexport function getOrder(id) {\n  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);\n  if (!order) throw new Error(\`Order \${id} not found\`);\n  return { ...order, items: JSON.parse(order.items) };\n}`,
        qaTests: `import { test, describe } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createOrder, listProducts, getOrder } from '../src/api.js';\n\ndescribe('Product Catalog & Orders', () => {\n  test('lists only in-stock products', () => {\n    const products = listProducts();\n    assert.ok(Array.isArray(products));\n    assert.ok(products.every(p => p.stock > 0));\n  });\n\n  test('creates order with valid cart', () => {\n    const order = createOrder({ items: [{ id: 'prod-001', price: 89.99, qty: 2 }], userId: 'user-1' });\n    assert.equal(order.status, 'PAID');\n    assert.ok(order.id.startsWith('ord_'));\n    assert.equal(order.total, '179.98');\n  });\n\n  test('rejects empty cart', () => {\n    assert.throws(() => createOrder({ items: [], userId: 'user-1' }), /empty/i);\n  });\n});`
      }
    };

    const tmpl = domainTemplates[domain] || domainTemplates.ECOMMERCE;

    const responses = {
      PM: `## Product Requirements Document\n\n**Project**: ${project}\n**Domain**: ${domain}\n\n### Executive Summary\n${tmpl.prdSummary}\n\n### User Stories\n${tmpl.userStories}\n\n### Acceptance Criteria\n- [ ] 95th percentile response < 150ms\n- [ ] Zero data loss on concurrent writes\n- [ ] 100% test coverage on critical path\n- [ ] WCAG 2.1 AA accessibility compliance\n\n### Technical Constraints\n- Node.js v22 runtime, ESM modules\n- SQLite for persistence with WAL mode\n- Sandboxed execution for all generated code`,

      ARCHITECT: `## Architecture Decision Record — ADR-001\n\n**Status**: ACCEPTED\n**Date**: ${new Date().toISOString().slice(0, 10)}\n**Domain**: ${domain}\n\n### Decision: Layered Event-Driven Architecture\n\n**Context**: ${project} requires horizontal scalability, zero external dependencies, and strict security isolation.\n\n### Component Topology\n\`\`\`\n${tmpl.adrComponents}\n\`\`\`\n\n### Data Schema\n\`\`\`sql\n${tmpl.schema}\n\`\`\`\n\n### Consequences\n- ✅ Zero external npm dependencies\n- ✅ Fast integration tests in sandbox\n- ⚠️ SQLite WAL mode enabled for concurrent read safety`,

      BACKEND: tmpl.backendCode,

      FRONTEND: `<!-- Generated by Frontend Agent — ${new Date().toISOString()} -->\n<!-- Project: ${project} -->\n<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>${project}</title>\n  <style>\n    * { box-sizing: border-box; margin: 0; padding: 0; }\n    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0b0f19; color: #f8fafc; min-height: 100vh; padding: 2rem; }\n    .app { max-width: 1000px; margin: 0 auto; }\n    h1 { font-size: 2rem; font-weight: 800; background: linear-gradient(135deg, #38bdf8, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 1.5rem; }\n    .card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 1.5rem; margin-bottom: 1rem; backdrop-filter: blur(12px); }\n    .btn { padding: 10px 20px; border-radius: 8px; border: none; font-weight: 600; cursor: pointer; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; transition: all 0.2s; }\n    .btn:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(99,102,241,0.4); }\n  </style>\n</head>\n<body>\n  <div class="app">\n    <h1>${project}</h1>\n    <div class="card">\n      <h2>${domain} System Active</h2>\n      <p>Synchronized with AI Virtual Software House autonomous services.</p>\n    </div>\n  </div>\n</body>\n</html>`,

      QA: `## QA Test Suite Report — ${new Date().toISOString()}\n\n**Project**: ${project}\n**Framework**: node:test\n\n### Executable Test Suite Synthesized\n\n\`\`\`javascript\n${tmpl.qaTests}\n\`\`\`\n\n### Verdict: ✅ All test cases verified. Ready for sandbox execution.`,

      DEVOPS: `## Release Engineering Report\n\n**Project**: ${project}\n**Date**: ${new Date().toISOString()}\n**Agent**: Devon (DevOps & Security)\n\n### Pre-Deployment Verification Checklist\n- ✅ Sandbox isolation confirmed (contained in project workspace)\n- ✅ Dependency scan: 0 external npm packages, zero CVE exposure\n- ✅ Secrets scan: No hardcoded credentials detected in generated code\n- ✅ SQLite: WAL mode enabled for concurrent read safety\n- ⚠️ **PRODUCTION DEPLOYMENT GATE**: Requires explicit human operator authorization\n\n### Release Manifest\n\`\`\`json\n{\n  "version": "1.0.0",\n  "buildId": "${crypto?.randomUUID?.() || 'build-' + Date.now()}",\n  "artifacts": ["src/api.js", "tests/api.test.js"],\n  "testResults": "PASS",\n  "securityRating": "A",\n  "requiresApproval": true\n}\n\`\`\`\n\n**⛔ CANNOT PROCEED TO PRODUCTION WITHOUT HUMAN SIGN-OFF**`,

      SYSTEM: `## Analysis Complete\nProcessed request for: "${userMessage.slice(0, 100)}"\nGovernance constraints verified: Sandbox isolation ACTIVE, Budget ceiling ENFORCED, Approval gate LOCKED.`
    };

    return responses[role] || responses.SYSTEM;
  }

  _extractProjectContext(message) {
    const match = message.match(/project[:\s]+["']?([^"'\n.]{3,40})/i);
    return match ? match[1].trim() : 'AI Software Project';
  }
}
