import '../config/env.js';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';

import { StorageEngine } from '../storage/db.js';
import { BudgetManager, BudgetExceededError } from '../budget/budgetManager.js';
import { SandboxExecutor, SecurityError } from '../sandbox/sandboxExecutor.js';
import { ApprovalManager, GatedActions, ApprovalRequiredError } from '../approval/approvalManager.js';
import { AgentFactory, AgentRoles } from '../agents/agentFactory.js';
import { GeminiClient } from '../llm/geminiClient.js';
import { ModelGateway } from '../llm/modelGateway.js';
import { EventBus, BusEvents } from '../core/eventBus.js';
import { Orchestrator } from '../core/orchestrator.js';
import { StageDefinitions } from '../core/pipelineDAG.js';
import { PreviewManager } from './previewManager.js';
import { AuditEngine } from '../audit/auditEngine.js';
import { RequirementParser } from '../audit/requirementParser.js';
import { packageProjectAsZip } from '../export/zipExporter.js';
import { TokenService } from '../auth/tokenService.js';
import { AuthManager, AuthError } from '../auth/authManager.js';
import { AuthMiddleware, getClientIp } from '../auth/authMiddleware.js';
import { RateLimiter } from '../auth/rateLimiter.js';
import { MemoryEmailProvider } from '../auth/emailProvider.js';
import { Permissions, SystemRoles } from '../auth/rbac.js';
import { QueueManager, QueueNames, JobStates, WorkerManager, EmbeddedRedisServer } from '../queue/index.js';
import {
  ArtifactService,
  StorageError,
  PathValidationError,
  SignedUrlError,
  RetentionPolicies,
  ArtifactTypes,
  ArtifactCategories
} from '../artifacts/index.js';
import { DeploymentManager, QuotaExceededError } from '../deploy/deploymentManager.js';
import { rootLogger, StructuredLogger } from '../observability/logger.js';
import { telemetry, TraceContext } from '../observability/telemetry.js';
import { sentryProvider } from '../observability/sentryProvider.js';
import { UsageMeter, PlanTiers, DEFAULT_PLAN_LIMITS, QuotaExceededError as BillingQuotaError } from '../billing/usageMeter.js';
import { StripeBillingProvider, WebhookVerificationError } from '../billing/stripeBillingProvider.js';
import { MockBillingProvider } from '../billing/mockBillingProvider.js';
import { V2Router } from './v2Router.js';
import { WebSocketGateway } from './websocketGateway.js';

// ── Utility: safe integer limit parsing (prevents NaN from reaching SQL) ──────
const safeLimit = (val, def = 20, max = 200) =>
  Math.max(1, Math.min(max, parseInt(val, 10) || def));

export const OFFICE_EMPLOYEES = [
  { id: 'emp-pm', name: 'Sofia Ramos', role: 'PM', title: 'Project Manager / Orchestrator', department: 'pm_area', status: 'IDLE', task: 'Monitoring Organization DAG', completion: 100, avatarColor: '#38bdf8', skills: ['Roadmaps', 'PRD', 'DAG Scheduling', 'Resource Allocation'] },
  { id: 'emp-ba', name: 'Elena Rostova', role: 'BA', title: 'Senior Business Analyst', department: 'ui_ux', status: 'IDLE', task: 'Synthesizing User Stories', completion: 100, avatarColor: '#818cf8', skills: ['Requirements Gathering', 'User Stories', 'Acceptance Criteria', 'Domain Modeling'] },
  { id: 'emp-designer', name: 'Maya Lin', role: 'DESIGNER', title: 'Lead UI/UX Designer', department: 'ui_ux', status: 'IDLE', task: 'Polishing Glassmorphic Design System', completion: 100, avatarColor: '#f472b6', skills: ['Design Systems', 'Micro-interactions', 'Accessibility', 'Figma Tokens'] },
  { id: 'emp-frontend', name: 'Aria Patel', role: 'FRONTEND', title: 'Lead Frontend Developer', department: 'frontend', status: 'IDLE', task: 'Responsive UI Synthesis', completion: 100, avatarColor: '#a78bfa', skills: ['HTML5/CSS3', 'ES Modules', 'State Management', 'Web Animations'] },
  { id: 'emp-backend', name: 'David Chen', role: 'BACKEND', title: 'Senior Backend Developer', department: 'backend', status: 'IDLE', task: 'Node.js Microservices & Self-Healing', completion: 100, avatarColor: '#34d399', skills: ['Node.js APIs', 'Microservices', 'Business Logic', 'Self-Healing'] },
  { id: 'emp-database', name: 'Tariq Al-Mansoor', role: 'DATABASE', title: 'Principal Database Engineer', department: 'db_eng', status: 'IDLE', task: 'SQLite WAL Schema Modeling', completion: 100, avatarColor: '#fbbf24', skills: ['SQLite WAL', 'Schema Modeling', 'ACID Transactions', 'Query Tuning'] },
  { id: 'emp-ai', name: 'Dr. Aris Thorne', role: 'AI_ENGINEER', title: 'Staff AI/ML Engineer', department: 'ai_ml', status: 'IDLE', task: 'LLM Prompt Engineering & Context Reranking', completion: 100, avatarColor: '#c084fc', skills: ['LLM Inferences', 'Embeddings', 'Prompt Topology', 'Vector Memory'] },
  { id: 'emp-reviewer', name: 'Kaito Tanaka', role: 'CODE_REVIEWER', title: 'Principal Code Reviewer', department: 'code_review', status: 'IDLE', task: 'Static Analysis & Code Quality Gate', completion: 100, avatarColor: '#2dd4bf', skills: ['Static Analysis', 'Security Audit', 'Code Smells', 'Refactoring'] },
  { id: 'emp-qa', name: 'Quinn Sterling', role: 'QA', title: 'QA & Test Automation Lead', department: 'qa_lab', status: 'IDLE', task: 'Integration Testing & Regression Suite', completion: 100, avatarColor: '#fb7185', skills: ['Integration Tests', 'Boundary Analysis', 'Regression Suites', 'Assertion Trees'] },
  { id: 'emp-security', name: 'Valerie Vance', role: 'SECURITY', title: 'Security & Compliance Lead', department: 'code_review', status: 'IDLE', task: 'Sandbox Jail & Isolation Audit', completion: 100, avatarColor: '#e879f9', skills: ['Sandbox Jail Containment', 'Secret Isolation', 'CVE Scanning', 'Policy Gates'] },
  { id: 'emp-devops', name: 'Devon Kross', role: 'DEVOPS', title: 'DevOps & Cloud Architect', department: 'devops_hub', status: 'IDLE', task: 'Release Packaging & Container Manifests', completion: 100, avatarColor: '#f97316', skills: ['Release Packaging', 'CI/CD Pipelines', 'Gated Approvals', 'Artifact Attestation'] }
];

export class VirtualHouseServer {
  constructor(options = {}) {
    this.port = options.port !== undefined ? options.port : 3000;
    this.host = options.host || '127.0.0.1';

    // Init Core Services
    const dbDir = path.resolve('data');
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    this.dbPath = options.dbPath || path.resolve('data/virtual_company.db');
    this.workspacesDir = options.workspacesDir || path.resolve('data/workspaces');

    this.ownsStorage = !options.storage;
    this.storage = options.storage || new StorageEngine(this.dbPath);

    // Authentication, Identity & RBAC Configuration
    this.authEnabled = options.authEnabled !== undefined ? options.authEnabled : (process.env.AUTH_ENABLED === 'true' || options.authRequired === true);

    // Production safety guard — prevent accidental unauthenticated deployment
    if (process.env.NODE_ENV === 'production' && !this.authEnabled) {
      throw new Error('[FATAL] AUTH_ENABLED must be true in production. Set AUTH_ENABLED=true in your .env file.');
    }
    this.tokenService = options.tokenService || new TokenService({
      jwtSecret: options.jwtSecret,
      secureCookies: options.secureCookies
    });
    this.rateLimiter = options.rateLimiter || new RateLimiter();
    this.emailProvider = options.emailProvider || new MemoryEmailProvider();
    this.authManager = options.authManager || new AuthManager({
      storage: this.storage,
      tokenService: this.tokenService,
      rateLimiter: this.rateLimiter,
      emailProvider: this.emailProvider
    });
    this.authMiddleware = new AuthMiddleware({
      tokenService: this.tokenService,
      storage: this.storage,
      rateLimiter: this.rateLimiter
    });

    this.budgetManager = new BudgetManager(this.storage, { costPer1kTokens: 0.002 });
    this.sandbox = options.sandbox || new SandboxExecutor(this.workspacesDir, this.storage, {
      defaultTimeoutMs: 15000,
      maxTimeoutMs: 30000
    });
    this.approvalManager = new ApprovalManager(this.storage);
    this.agentFactory = new AgentFactory({
      storage: this.storage,
      budgetManager: this.budgetManager,
      sandbox: this.sandbox,
      approvalManager: this.approvalManager
    });
    this.team = this.agentFactory.createFullTeam();
    const hasLiveKey = Boolean(process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.startsWith('mock_'));
    const defaultSimulation = options.simulationMode !== undefined
      ? Boolean(options.simulationMode)
      : (!hasLiveKey || process.env.SIMULATION_MODE === 'true');

    if (options.llm) {
      this.llm = options.llm;
    } else if (process.env.ENABLE_V2_MULTI_MODEL_GATEWAY === 'true') {
      this.llm = new ModelGateway({ simulationMode: defaultSimulation });
    } else {
      this.llm = new GeminiClient({
        apiKey: process.env.GEMINI_API_KEY,
        simulationMode: defaultSimulation
      });
    }
    this.eventBus = new EventBus(this.storage);

    this.orchestrator = new Orchestrator({
      storage: this.storage,
      budgetManager: this.budgetManager,
      sandbox: this.sandbox,
      approvalManager: this.approvalManager,
      agentFactory: this.agentFactory,
      llm: this.llm,
      eventBus: this.eventBus
    });

    this.previewManager = new PreviewManager({
      storage: this.storage,
      sandbox: this.sandbox,
      eventBus: this.eventBus
    });

    this.auditEngine = new AuditEngine({
      storage: this.storage,
      sandbox: this.sandbox,
      eventBus: this.eventBus,
      previewManager: this.previewManager,
      orchestrator: this.orchestrator
    });

    // Asynchronous BullMQ & Redis Queue Architecture
    this.asyncEnabled = options.asyncEnabled !== undefined
      ? options.asyncEnabled
      : (process.env.ASYNC_GENERATION_ENABLED === 'true' || Boolean(options.queueManager));
    this.embeddedRedis = options.embeddedRedis || null;
    this.queueManager = options.queueManager || (this.asyncEnabled ? new QueueManager({
      storage: this.storage,
      eventBus: this.eventBus,
      redisConfig: options.redisConfig
    }) : null);
    // Multi-Cloud Deployment Manager
    this.deploymentManager = options.deploymentManager || new DeploymentManager({
      storage: this.storage,
      sandbox: this.sandbox,
      approvalManager: this.approvalManager,
      eventBus: this.eventBus
    }, {
      defaultProvider: options.defaultDeploymentProvider || 'mock',
      mockConfig: options.mockDeploymentConfig,
      cloudflareConfig: options.cloudflarePagesConfig,
      vercelConfig: options.vercelConfig
    });

    const effectiveRedisConfig = options.redisConfig || (this.queueManager ? this.queueManager.redisConfig : undefined);
    const effectivePrefix = options.prefix || (this.queueManager ? this.queueManager.prefix : undefined);
    this.workerManager = options.workerManager || ((this.asyncEnabled && this.queueManager) ? new WorkerManager({
      storage: this.storage,
      orchestrator: this.orchestrator,
      eventBus: this.eventBus,
      deploymentManager: this.deploymentManager,
      redisConfig: effectiveRedisConfig,
      prefix: effectivePrefix,
      concurrency: options.concurrency
    }) : null);

    // Project Artifact Storage & Signed URL Service
    this.artifactService = options.artifactService || new ArtifactService({
      storageEngine: this.storage,
      storageProvider: options.storageProvider
    });
    if (this.storage && this.artifactService.storageEngine !== this.storage) {
      this.artifactService.setStorageEngine(this.storage);
    }

    // SSE Subscribers (all connected dashboard clients)
    this.sseClients = new Set();
    this.activePipelines = new Map();

    // Forward EventBus events to SSE stream
    this.eventBus.subscribeAll((event) => {
      this._broadcastSSE(event.type, event.payload);
    });

    // Observability, Telemetry & Sentry Configuration
    this.logger = options.logger || rootLogger.child({ service: 'api-server' });
    this.telemetry = options.telemetry || telemetry;
    this.sentry = options.sentryProvider || sentryProvider;

    // Usage Metering & Limit Guardrails
    this.usageMeter = options.usageMeter || new UsageMeter({
      storage: this.storage,
      customLimits: options.customLimits,
      workspacesDir: this.workspacesDir,
      logger: this.logger
    });
    this.budgetManager.usageMeter = this.usageMeter;

    // Payment & Billing Provider Configuration
    this.billingEnabled = options.billingEnabled !== undefined ? options.billingEnabled : (process.env.BILLING_ENABLED === 'true');
    this.billingProvider = options.billingProvider || (
      options.useMockBilling || (!options.stripeWebhookSecret && !process.env.STRIPE_WEBHOOK_SECRET)
        ? new MockBillingProvider({ storage: this.storage, webhookSecret: options.stripeWebhookSecret })
        : new StripeBillingProvider({ storage: this.storage, webhookSecret: options.stripeWebhookSecret, apiKey: options.stripeApiKey })
    );

    // Seed default project
    this.initDefaultProject();

    // V2 Router & Real-Time WebSocket Gateway
    this.v2Router = new V2Router({ orchestrator: this.orchestrator, storage: this.storage });
    this.wsGateway = new WebSocketGateway({
      tokenVerifier: (token) => {
        try {
          return this.tokenService ? this.tokenService.verifyToken(token) : null;
        } catch (_) {
          return null;
        }
      }
    });
    this.v2Router.wsGateway = this.wsGateway;

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.wsGateway.attach(this.server);
  }

  _sanitizeForPublicBroadcast(data) {
    if (!data || typeof data !== 'object') return data;
    if (Array.isArray(data)) {
      return data.map(item => this._sanitizeForPublicBroadcast(item));
    }
    const clean = {};
    for (const [key, val] of Object.entries(data)) {
      const lower = key.toLowerCase();
      if (lower.includes('secret') || lower.includes('password') || lower.includes('token') || lower.includes('apikey') || lower.includes('jwt')) {
        clean[key] = '***';
      } else if (lower.includes('prompt') && typeof val === 'string' && val.length > 200) {
        clean[key] = val.slice(0, 150) + '... [truncated]';
      } else if (typeof val === 'object' && val !== null) {
        clean[key] = this._sanitizeForPublicBroadcast(val);
      } else {
        clean[key] = val;
      }
    }
    return clean;
  }

  _broadcastSSE(eventType, data) {
    const sanitized = this._sanitizeForPublicBroadcast(data);
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(sanitized)}\n\n`;
    for (const client of this.sseClients) {
      try { client.write(payload); }
      catch (_) { this.sseClients.delete(client); }
    }
  }

  initDefaultProject() {
    const projects = this.storage.listProjects();
    if (projects.length === 0) {
      const proj = this.storage.createProject({
        id: 'proj-ecommerce-core',
        name: 'Nexus Cloud Store Engine',
        description: 'Next-generation microservices eCommerce engine with real-time inventory and Stripe billing.',
        budgetUsd: 25.0,
        budgetTokens: 125000
      });

      this.storage.createTask({
        id: 'task-prd',
        projectId: proj.id,
        title: 'Draft Product Specifications & User Journeys',
        assignedAgent: AgentRoles.PM,
        stage: 'INTAKE'
      });
      this.storage.createTask({
        id: 'task-arch',
        projectId: proj.id,
        title: 'Design API Schema & Microservice Contracts',
        assignedAgent: AgentRoles.ARCHITECT,
        stage: 'ARCHITECTURE'
      });

      // Seed workspace files
      this.sandbox.writeFileSafely(proj.id, 'package.json', JSON.stringify({ name: 'nexus-store-engine', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2));
      this.sandbox.writeFileSafely(proj.id, 'src/api.js', `// Nexus Store API — generated by AI Virtual Software House\nimport crypto from 'node:crypto';\n\nexport function checkout(cart) {\n  if (!cart.items?.length) throw new Error("Cart cannot be empty");\n  const orderId = "ord_" + crypto.randomUUID().slice(0, 8);\n  return { orderId, total: cart.total, status: 'PAID' };\n}\n`);
      this.sandbox.writeFileSafely(proj.id, 'tests/checkout.test.js', `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { checkout } from '../src/api.js';\n\ntest('checkout processes valid cart', () => {\n  const res = checkout({ items: [{ id: 1 }], total: 49.99 });\n  assert.equal(res.status, 'PAID');\n  assert.ok(res.orderId.startsWith('ord_'));\n});\n\ntest('rejects empty cart', () => {\n  assert.throws(() => checkout({ items: [], total: 0 }), /empty/i);\n});\n`);

      // Initial git commit
      const git = this.orchestrator.getGit(proj.id);
      git.commit({
        message: 'Initial project scaffold by System Architect',
        author: 'System',
        agentRole: 'SYSTEM',
        files: ['package.json', 'src/api.js', 'tests/checkout.test.js']
      });

      // Seed approval
      this.approvalManager.requestApproval({
        projectId: proj.id,
        actionType: GatedActions.PRODUCTION_DEPLOYMENT,
        payload: { releaseTarget: 'us-east-1.prod', version: 'v1.0.0-rc4', qaVerification: 'PASS' },
        riskLevel: 'CRITICAL',
        reason: 'Release candidate v1.0.0 passed all automated QA tests. Explicit operator approval required.',
        requestedBy: AgentRoles.DEVOPS
      });
    }
  }

  async handleRequest(req, res) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname;
    const query = Object.fromEntries(parsedUrl.searchParams);
    const method = req.method;

    // Request ID & Context Propagation
    const requestId = req.headers['x-request-id'] || ('req_' + crypto.randomUUID().slice(0, 12));
    req.id = requestId;
    res.setHeader('X-Request-Id', requestId);

    // OpenTelemetry Tracing Span & Duration Tracking
    const startTime = Date.now();
    const traceparentHeader = req.headers['traceparent'];
    const span = this.telemetry.startSpan(`HTTP ${method} ${pathname}`, {
      'http.method': method,
      'http.url': req.url,
      'http.request_id': requestId
    }, traceparentHeader);
    res.setHeader('traceparent', span.context.traceparent);

    const clientIp = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';

    // Log request completion and record HTTP duration metrics
    res.on('finish', () => {
      span.setAttribute('http.status_code', res.statusCode);
      span.end();
      const durationMs = Date.now() - startTime;
      this.telemetry.recordHttpRequest({
        method,
        path: pathname,
        status: res.statusCode,
        durationSeconds: durationMs / 1000
      });
      this.logger.info(`HTTP ${method} ${pathname} ${res.statusCode}`, {
        requestId,
        tenantId: req.user?.tenantId || req.headers['x-tenant-id'] || null,
        userId: req.user?.id || null,
        method,
        pathname,
        statusCode: res.statusCode,
        durationMs,
        clientIp
      });
    });

    const allowedOrigin = process.env.CORS_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    if (allowedOrigin !== '*') {
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-CSRF-Token, X-Request-Id, traceparent, stripe-signature');

    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Authenticate caller (attaches req.user or null)
    this.authMiddleware.authenticate(req);
    if (!req.user && !this.authEnabled) {
      const headerTenant = req.headers['x-tenant-id'];
      req.user = { id: 'usr-default', tenantId: headerTenant || 'tenant-default', role: SystemRoles.DEVELOPER, email: 'dev@pulse.local' };
    }

    // CSRF Protection on state-modifying requests when auth is enabled and not an auth or webhook route
    if (this.authEnabled && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && !pathname.startsWith('/api/auth/') && pathname !== '/api/billing/webhook') {
      if (!this.authMiddleware.verifyCsrf(req, res)) return;
    }

    // SSE Stream — replay recent history then subscribe
    if (pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write(': heartbeat\n\n');

      // Replay recent bus history to newly connected client (sanitize before sending)
      const history = this.eventBus.getHistory(30);
      history.forEach(evt => {
        const sanitized = this._sanitizeForPublicBroadcast(evt.payload);
        res.write(`event: ${evt.type}\ndata: ${JSON.stringify(sanitized)}\n\n`);
      });

      this.sseClients.add(res);
      req.on('close', () => this.sseClients.delete(res));
      return;
    }

    try {
      // ── Version 2.0 Enterprise REST Routes ───────────────────────────────
      if (pathname.startsWith('/api/v2/')) {
        let body = {};
        if (['POST', 'PUT', 'PATCH'].includes(method)) {
          try { body = await this.readBody(req); } catch (_) { body = {}; }
        }
        const handled = await this.v2Router.handle(req, res, {
          user: req.user,
          tenantId: req.user?.tenantId || req.headers['x-tenant-id'] || 'tenant-default',
          url: parsedUrl,
          pathname,
          method,
          body
        });
        if (handled) return;
      }

      // ── Version 2.0 Glassmorphism UI ──────────────────────────────────────
      if (pathname === '/v2' || pathname === '/v2/' || pathname.startsWith('/v2/')) {
        return this.serveStaticV2(req, res, pathname);
      }

      // ── Observability & Health Endpoints ─────────────────────────────────
      // Liveness probe (process responsive)
      if (pathname === '/healthz' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        return;
      }

      // Readiness probe (subsystems functional without credential leakage)
      if (pathname === '/readyz' && method === 'GET') {
        let dbReady = false;
        try {
          if (this.storage.isPostgres) {
            await this.storage.query('SELECT 1');
          } else if (this.storage.db) {
            this.storage.db.prepare('SELECT 1').get();
          }
          dbReady = true;
        } catch (_) {
          dbReady = false;
        }

        let storageReady = false;
        try {
          if (fs.existsSync(this.workspacesDir)) {
            storageReady = true;
          }
        } catch (_) {
          storageReady = false;
        }

        let queueReady = true;
        if (this.queueManager) {
          try {
            const qh = await this.queueManager.getHealth();
            queueReady = qh.status === 'HEALTHY' || qh.status === 'OK' || qh.status === 'DISABLED';
          } catch (_) {
            queueReady = false;
          }
        }

        const isAllReady = dbReady && storageReady && queueReady;
        const checks = {
          database: dbReady ? 'up' : 'down',
          storage: storageReady ? 'up' : 'down',
          queue: queueReady ? 'up' : (this.queueManager ? 'down' : 'disabled')
        };

        res.writeHead(isAllReady ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: isAllReady ? 'ready' : 'not_ready',
          checks,
          timestamp: new Date().toISOString()
        }));
        return;
      }

      // OpenTelemetry & Prometheus Metrics Endpoint
      if (pathname === '/api/metrics' && method === 'GET') {
        const format = query.format;
        if (format === 'json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.telemetry.toJSON(), null, 2));
        } else {
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
          res.end(this.telemetry.toPrometheusFormat());
        }
        return;
      }

      // Usage & Limit Visibility
      if (pathname === '/api/usage' && method === 'GET') {
        const tenantId = req.user?.tenantId || req.headers['x-tenant-id'] || 'tenant-default';
        const usageData = await this.usageMeter.getUsageAndLimits(tenantId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(usageData));
        return;
      }

      if (pathname === '/api/usage/limits' && method === 'GET') {
        const tenantId = req.user?.tenantId || req.headers['x-tenant-id'] || 'tenant-default';
        const info = await this.usageMeter.getLimitsForTenant(tenantId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          tenantId,
          plan: info.plan,
          limits: info.limits,
          allPlanTiers: DEFAULT_PLAN_LIMITS
        }));
        return;
      }

      if (pathname === '/api/usage/reconcile' && method === 'POST') {
        const tenantId = req.user?.tenantId || req.headers['x-tenant-id'] || 'tenant-default';
        const report = await this.usageMeter.reconcileUsage(tenantId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
        return;
      }

      // ── Billing Webhooks (Cryptographically Verified Server-Side) ─────────
      if (pathname === '/api/billing/webhook' && method === 'POST') {
        const rawPayload = await this.readRawBody(req);
        const signatureHeader = req.headers['stripe-signature'] || '';
        try {
          const result = await this.billingProvider.processWebhook(rawPayload, signatureHeader);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true, result }));
        } catch (webhookErr) {
          this.logger.warn('Webhook processing rejected', { error: webhookErr.message });
          res.writeHead(webhookErr.statusCode || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: webhookErr.message, code: 'WEBHOOK_FAILED' }));
        }
        return;
      }

      // ── Health & Diagnostics ─────────────────────────────────────────────
      if (pathname === '/api/health' && method === 'GET') {
        const queueHealth = this.queueManager ? await this.queueManager.getHealth() : { status: 'DISABLED' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'OK',
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
          asyncQueue: queueHealth
        }));
        return;
      }

      if (pathname === '/api/workers/health' && method === 'GET') {
        if (!this.queueManager) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ enabled: false, message: 'Async queue is disabled' }));
          return;
        }
        const health = await this.queueManager.getHealth();
        const workerStatus = this.workerManager ? this.workerManager.getStatus() : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          enabled: true,
          health,
          workers: workerStatus,
          timestamp: new Date().toISOString()
        }));
        return;
      }

      // ── Auth Endpoints ───────────────────────────────────────────────────
      if (pathname === '/api/auth/register' && method === 'POST') {
        const body = await this.readJsonBody(req);
        // Whitelist roles that a user may self-assign at registration time
        const SELF_ASSIGNABLE_ROLES = new Set(['DEVELOPER', 'REVIEWER']);
        const safeRole = SELF_ASSIGNABLE_ROLES.has(body.role) ? body.role : SystemRoles.DEVELOPER;
        const user = await this.authManager.register({
          email: body.email,
          password: body.password,
          name: body.name,
          tenantId: body.tenantId || 'tenant-default',
          role: safeRole,
          ipAddress: clientIp,
          userAgent
        });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, user }));
        return;
      }

      if (pathname === '/api/auth/login' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const result = await this.authManager.login({
          email: body.email,
          password: body.password,
          ipAddress: clientIp,
          userAgent
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': result.refreshCookie
        });
        res.end(JSON.stringify({
          success: true,
          user: result.user,
          accessToken: result.accessToken,
          expiresIn: result.expiresIn
        }));
        return;
      }

      if (pathname === '/api/auth/refresh' && method === 'POST') {
        const body = await this.readJsonBody(req).catch(() => ({}));
        const rawToken = TokenService.extractCookie(req.headers['cookie'], 'pulse_refresh_token') || body.refreshToken;
        const result = await this.authManager.refreshSession(rawToken, { ipAddress: clientIp, userAgent });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': result.refreshCookie
        });
        res.end(JSON.stringify({
          success: true,
          user: result.user,
          accessToken: result.accessToken,
          expiresIn: result.expiresIn
        }));
        return;
      }

      if (pathname === '/api/auth/logout' && method === 'POST') {
        const body = await this.readJsonBody(req).catch(() => ({}));
        const rawToken = TokenService.extractCookie(req.headers['cookie'], 'pulse_refresh_token') || body.refreshToken;
        const result = await this.authManager.logout(rawToken, req.user?.id, { ipAddress: clientIp, userAgent });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': result.clearCookie
        });
        res.end(JSON.stringify({ success: true, message: 'Logged out successfully' }));
        return;
      }

      if (pathname === '/api/auth/me' && method === 'GET') {
        if (!this.authMiddleware.requireAuth(req, res)) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, user: req.user }));
        return;
      }

      if (pathname === '/api/auth/password-reset/request' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const result = await this.authManager.requestPasswordReset(body.email, { ipAddress: clientIp, userAgent });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (pathname === '/api/auth/password-reset/confirm' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const result = await this.authManager.resetPassword({
          token: body.token,
          newPassword: body.newPassword,
          ipAddress: clientIp,
          userAgent
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (pathname === '/api/auth/verify-email/request' && method === 'POST') {
        if (!this.authMiddleware.requireAuth(req, res)) return;
        const result = await this.authManager.requestEmailVerification(req.user.id, { ipAddress: clientIp, userAgent });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (pathname === '/api/auth/verify-email/confirm' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const result = await this.authManager.confirmEmailVerification(body.token);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (pathname === '/api/admin/bootstrap' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const result = await this.authManager.bootstrapPlatformAdmin({
          email: body.email,
          password: body.password,
          name: body.name
        });
        res.writeHead(result.created ? 201 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (pathname === '/api/admin/audit-logs' && method === 'GET') {
        if (this.authEnabled && !this.authMiddleware.requirePermission(req, res, Permissions.PLATFORM_ADMIN)) return;
        const tenantId = query.tenantId || (req.user?.role === SystemRoles.PLATFORM_ADMIN ? null : req.user?.tenantId);
        const limit = safeLimit(query.limit, 50);
        const logs = await this.storage.listAuthAuditLogs({ tenantId, limit });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(logs));
        return;
      }

      // ── Project Members ──────────────────────────────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/members$/) && method === 'GET') {
        const projectId = pathname.split('/')[3];
        if (this.authEnabled && !(await this.authMiddleware.requireProjectAccess(req, res, projectId, Permissions.PROJECT_MEMBERS_READ))) return;
        const members = await this.storage.listProjectMembers(projectId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(members));
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/members$/) && method === 'POST') {
        const projectId = pathname.split('/')[3];
        if (this.authEnabled && !(await this.authMiddleware.requireProjectAccess(req, res, projectId, Permissions.PROJECT_MEMBERS_MANAGE))) return;
        const body = await this.readJsonBody(req);
        const member = await this.storage.addProjectMember({
          tenantId: req.user?.tenantId || 'tenant-default',
          projectId,
          userId: body.userId,
          role: body.role || 'DEVELOPER'
        });
        await this.storage.recordAuthAudit({
          tenantId: req.user?.tenantId || 'tenant-default',
          userId: req.user?.id,
          action: 'PROJECT_MEMBER_ADDED',
          ipAddress: clientIp,
          userAgent,
          details: { projectId, targetUserId: body.userId, role: body.role }
        });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, member }));
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/members\/([^/]+)$/) && method === 'DELETE') {
        const parts = pathname.split('/');
        const projectId = parts[3];
        const targetUserId = parts[5];
        if (this.authEnabled && !(await this.authMiddleware.requireProjectAccess(req, res, projectId, Permissions.PROJECT_MEMBERS_MANAGE))) return;
        await this.storage.removeProjectMember(projectId, targetUserId);
        await this.storage.recordAuthAudit({
          tenantId: req.user?.tenantId || 'tenant-default',
          userId: req.user?.id,
          action: 'PROJECT_MEMBER_REMOVED',
          ipAddress: clientIp,
          userAgent,
          details: { projectId, targetUserId }
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Member removed' }));
        return;
      }

      // ── Status ──────────────────────────────────────────────────────────
      if (pathname === '/api/status' && method === 'GET') {
        if (this.authEnabled && !this.authMiddleware.requirePermission(req, res, Permissions.PROJECT_READ)) return;
        const projects = this.storage.listProjects();
        const activeProject = projects[0] || null;
        let budgetSummary = null, pendingApprovals = [], auditLogs = [], files = [], dag = null, gitLog = [];

        if (activeProject) {
          const raw = this.budgetManager.getBudgetSummary(activeProject.id);
          // Normalize field names for frontend (limitTokens, limitUsd etc.)
          budgetSummary = {
            ...raw,
            limitTokens: raw.budgetTokens,
            limitUsd: raw.budgetUsd,
            spentUsd: raw.spentUsd,
          };
          pendingApprovals = this.approvalManager.listPending(activeProject.id);
          auditLogs = this.storage.getAuditLogs(activeProject.id, 30);
          files = this.sandbox.listFiles(activeProject.id);
          dag = this.orchestrator.getDAG(activeProject.id).serialize();
          try { gitLog = this.orchestrator.getGit(activeProject.id).getLog(10); } catch (_) {}
        }

        const statusPayload = JSON.stringify({
          status: 'ONLINE',
          uptimeSec: process.uptime(),
          activeProject,
          budgetSummary,
          pendingApprovals,
          auditLogs,
          files,
          dag,
          gitLog,
          stageDefinitions: StageDefinitions,
          llmMode: this.llm.simulationMode ? 'SIMULATION' : 'LIVE',
          employees: OFFICE_EMPLOYEES,
          team: Object.values(this.team).map(a => ({
            role: a.role, name: a.name, systemPrompt: a.systemPrompt
          }))
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(statusPayload);
        return;
      }

      // ── Projects ─────────────────────────────────────────────────────────
      if (pathname === '/api/projects' && method === 'GET') {
        if (this.authEnabled && !this.authMiddleware.requirePermission(req, res, Permissions.PROJECT_READ)) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.storage.listProjects()));
        return;
      }

      if (pathname === '/api/projects' && method === 'POST') {
        if (this.authEnabled && !this.authMiddleware.requirePermission(req, res, Permissions.PROJECT_CREATE)) return;
        const body = await this.readJsonBody(req);
        const id = 'proj-' + crypto.randomUUID().slice(0, 8);
        const isRealUser = Boolean(req.user?.id && req.user.id !== 'usr-default');
        const tenantId = req.user?.tenantId || req.tenantId || req.headers?.['x-tenant-id'] || body.tenantId || 'tenant-default';
        const project = this.storage.createProject({
          id,
          tenantId,
          ownerId: isRealUser ? req.user.id : null,
          name: body.name || 'Autonomous Web App',
          description: body.description || '',
          budgetTokens: body.budgetTokens || 100000,
          budgetUsd: body.budgetUsd || 10.0
        });

        if (isRealUser) {
          await this.storage.addProjectMember({
            tenantId: req.user.tenantId || 'tenant-default',
            projectId: id,
            userId: req.user.id,
            role: 'OWNER'
          });
        }

        this.sandbox.writeFileSafely(id, 'package.json', JSON.stringify({ name: id, version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2));
        this.orchestrator.getGit(id).commit({ message: 'Initial project scaffold', author: 'System', agentRole: 'SYSTEM', files: ['package.json'] });
        this._broadcastSSE('PROJECT_CREATED', project);

        // Automatically trigger autonomous pipeline so code writing starts immediately
        if (body.autoRun !== false) {
          const pipelinePromise = this._runFullPipeline(id).catch(err => {
            this.eventBus.publish('PIPELINE_ERROR', { projectId: id, message: err.message });
          }).finally(() => {
            this.activePipelines.delete(id);
          });
          this.activePipelines.set(id, pipelinePromise);
        }

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(project));
        return;
      }

      // ── Get Single Project ────────────────────────────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)$/) && method === 'GET') {
        const projectId = pathname.split('/')[3];
        if (this.authEnabled && !(await this.authMiddleware.requireProjectAccess(req, res, projectId, Permissions.PROJECT_READ))) return;
        const project = this.storage.getProject(projectId);
        if (!project) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(project));
        return;
      }

      // ── Project Diagnostics ───────────────────────────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/diagnostics$/) && method === 'GET') {
        const projectId = pathname.split('/')[3];
        const diagnostics = this.orchestrator.getDiagnostics(projectId);
        let diskDiagnostics = null;
        try {
          const content = this.sandbox.readFileSafely(projectId, 'reports/pipeline-diagnostics.json');
          diskDiagnostics = JSON.parse(content);
        } catch (_) {}

        const payload = diagnostics || diskDiagnostics;
        if (!payload) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Diagnostics not found for project ' + projectId }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, projectId, diagnostics: payload }));
        return;
      }

      // ── Artifact Download via Short-Lived Signed Token ────────────────────
      if (pathname === '/api/artifacts/download' && (method === 'GET' || method === 'HEAD')) {
        const token = query.token;
        if (!token) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing signed download token', code: 'MISSING_TOKEN' }));
          return;
        }

        let payload;
        try {
          payload = this.artifactService.signedUrlService.verifyToken(token);
        } catch (err) {
          const status = err.code === 'TOKEN_EXPIRED' ? 401 : 403;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message, code: err.code }));
          return;
        }

        try {
          const buffer = await this.artifactService.storageProvider.getObject(payload.key);
          const filename = path.basename(payload.key);

          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': buffer.length
          });
          if (method === 'HEAD') {
            res.end();
            return;
          }
          res.end(buffer);
          return;
        } catch (err) {
          const status = err.statusCode || 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message, code: err.code || 'STORAGE_ERROR' }));
          return;
        }
      }

      // ── Retention Policy Cleanup ──────────────────────────────────────────
      if (pathname === '/api/artifacts/cleanup' && method === 'POST') {
        if (this.authEnabled && !this.authMiddleware.requirePermission(req, res, Permissions.PROJECT_DELETE)) return;

        try {
          const stats = await this.artifactService.cleanupExpiredArtifacts();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, stats }));
          return;
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message, code: 'CLEANUP_FAILED' }));
          return;
        }
      }

      // ── List Project Artifacts ────────────────────────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/artifacts$/) && method === 'GET') {
        const projectId = pathname.split('/')[3];
        if (this.authEnabled && !(await this.authMiddleware.requireProjectAccess(req, res, projectId, Permissions.PROJECT_READ))) return;

        const tenantId = req.user?.tenantId || req.tenantId || 'tenant-default';
        const filters = {
          fileType: query.fileType || null,
          retentionPolicy: query.retentionPolicy || null
        };

        try {
          const artifacts = await this.artifactService.listProjectArtifacts(projectId, tenantId, filters);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, projectId, artifacts }));
          return;
        } catch (err) {
          const status = err.statusCode || 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message, code: err.code || 'STORAGE_ERROR' }));
          return;
        }
      }

      // ── Upload Project Artifact ───────────────────────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/artifacts\/upload$/) && method === 'POST') {
        const projectId = pathname.split('/')[3];
        if (this.authEnabled && !(await this.authMiddleware.requireProjectAccess(req, res, projectId, Permissions.PROJECT_EDIT))) return;

        const tenantId = req.user?.tenantId || req.tenantId || 'tenant-default';
        const filename = req.headers['x-artifact-filename'] || query.filename || `upload-${Date.now()}.bin`;
        const fileType = req.headers['x-artifact-type'] || query.fileType || ArtifactTypes.BUILD_ARTIFACT;
        const category = req.headers['x-artifact-category'] || query.category || ArtifactCategories.BUILDS;
        const retentionPolicy = req.headers['x-retention-policy'] || query.retentionPolicy || RetentionPolicies.TEMPORARY_BUILD;
        const expectedHash = req.headers['x-content-sha256'] || null;
        const contentType = req.headers['content-type'] || 'application/octet-stream';

        try {
          const rawBuffer = await this.readRawBody(req, 50 * 1024 * 1024);

          const { artifact, signedDownloadUrl } = await this.artifactService.storeArtifact({
            tenantId,
            projectId,
            filename,
            fileType,
            category,
            content: rawBuffer,
            retentionPolicy,
            isConfidential: true,
            contentType,
            expectedHash
          });

          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, artifact, signedDownloadUrl }));
          return;
        } catch (err) {
          const status = err.statusCode || (err.name === 'PathValidationError' ? 400 : 500);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message, code: err.code || 'UPLOAD_FAILED' }));
          return;
        }
      }

      // ── Download Project Artifact Metadata or File ─────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/artifacts\/([^/]+)\/download$/) && (method === 'GET' || method === 'HEAD')) {
        const parts = pathname.split('/');
        const projectId = parts[3];
        const artifactId = parts[5];

        if (this.authEnabled && !(await this.authMiddleware.requireProjectAccess(req, res, projectId, Permissions.PROJECT_READ))) return;
        const tenantId = req.user?.tenantId || req.tenantId || 'tenant-default';

        try {
          const { artifact, signedDownloadUrl } = await this.artifactService.getArtifact(artifactId, tenantId);

          if (query.redirect === 'true') {
            res.writeHead(302, { Location: signedDownloadUrl });
            res.end();
            return;
          }

          if (query.stream === 'true') {
            const buffer = await this.artifactService.storageProvider.getObject(artifact.storage_key);
            res.writeHead(200, {
              'Content-Type': artifact.content_type || 'application/octet-stream',
              'Content-Disposition': `attachment; filename="${path.basename(artifact.file_path || artifact.storage_key)}"`,
              'Content-Length': buffer.length
            });
            if (method === 'HEAD') { res.end(); return; }
            res.end(buffer);
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, artifact, signedDownloadUrl }));
          return;
        } catch (err) {
          const status = err.statusCode || 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message, code: err.code || 'DOWNLOAD_ERROR' }));
          return;
        }
      }

      // ── Delete Project Artifact ───────────────────────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/artifacts\/([^/]+)$/) && method === 'DELETE') {
        const parts = pathname.split('/');
        const projectId = parts[3];
        const artifactId = parts[5];

        if (this.authEnabled && !(await this.authMiddleware.requireProjectAccess(req, res, projectId, Permissions.PROJECT_DELETE))) return;
        const tenantId = req.user?.tenantId || req.tenantId || 'tenant-default';

        try {
          await this.artifactService.deleteArtifact(artifactId, tenantId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, deleted: true, artifactId }));
          return;
        } catch (err) {
          const status = err.statusCode || 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message, code: err.code || 'DELETE_ERROR' }));
          return;
        }
      }

      // ── Export Project as Production ZIP Archive (Safe Packaging & Object Storage) ──
      if ((pathname.match(/^\/api\/projects\/([^/]+)\/export\/zip$/) || pathname.match(/^\/api\/projects\/([^/]+)\/zip$/)) &&
          (method === 'GET' || method === 'POST' || method === 'HEAD')) {
        const projectId = pathname.split('/')[3];
        if (this.authEnabled && !(await this.authMiddleware.requireProjectAccess(req, res, projectId, Permissions.PROJECT_EXPORT))) return;

        const project = this.storage.getProject(projectId);
        if (!project) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project not found' }));
          return;
        }

        const tenantId = req.user?.tenantId || req.tenantId || project.tenant_id || 'tenant-default';

        try {
          const workspaceDir = this.sandbox.getProjectWorkspace(projectId);
          const { artifact, signedDownloadUrl, buffer } = await this.artifactService.packageAndStoreProjectZip(
            projectId,
            tenantId,
            workspaceDir,
            project
          );

          // If client explicitly requests JSON or is doing a POST trigger
          if (method === 'POST' || (req.headers['accept'] && req.headers['accept'].includes('application/json'))) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, artifact, signedDownloadUrl }));
            return;
          }

          // Direct browser download
          const filename = path.basename(artifact.file_path || `${(project.name || projectId).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}.zip`);
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': buffer.length
          });
          if (method === 'HEAD') {
            res.end();
            return;
          }
          res.end(buffer);
          return;
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to package project: ' + err.message }));
          return;
        }
      }

      // ── One-Click Autonomous Project Builder ──────────────────────────────
      if (pathname === '/api/projects/autonomous' && method === 'POST') {
        if (this.authEnabled && !this.authMiddleware.requirePermission(req, res, Permissions.PROJECT_CREATE)) return;
        const body = await this.readJsonBody(req);
        const rawTitle = (body.title || body.name || '').trim();
        const rawDesc = (body.description || '').trim();

        if (!rawTitle && !rawDesc) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: 'Project prompt is required. Please provide a project title or description to build.'
          }));
          return;
        }

        const title = rawTitle || rawDesc.slice(0, 60);
        const description = rawDesc;
        const appType = body.appType || 'Auto-Detect';
        const id = 'proj-' + crypto.randomUUID().slice(0, 8);
        const isRealUser = Boolean(req.user?.id && req.user.id !== 'usr-default');
        const tenantId = req.user?.tenantId || 'tenant-default';
        const createdBy = isRealUser ? req.user.id : null;
        const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey || null;
        let isDuplicateIdempotency = false;
        if (idempotencyKey) {
          const existingJob = await this.storage.getGenerationJobByIdempotencyKey(idempotencyKey, tenantId);
          if (existingJob) {
            isDuplicateIdempotency = true;
          }
        }

        // Quota Limit Enforcement (Generations & Concurrency) for new requests
        if (this.usageMeter && !isDuplicateIdempotency) {
          await this.usageMeter.checkLimit(tenantId, 'generation');
          await this.usageMeter.checkLimit(tenantId, 'concurrency');
        }

        const project = this.storage.createProject({
          id,
          tenantId,
          ownerId: createdBy,
          name: title,
          description,
          budgetTokens: body.budgetTokens || 120000,
          budgetUsd: body.budgetUsd || 15.0
        });

        // Record usage event with idempotency protection
        if (this.usageMeter) {
          await this.usageMeter.recordUsage({
            tenantId,
            userId: createdBy,
            projectId: id,
            eventType: 'GENERATION_JOB',
            quantity: 1,
            unit: 'COUNT',
            idempotencyKey: idempotencyKey || `gen_${id}`,
            metadata: { title, appType }
          });
        }

        if (isRealUser) {
          await this.storage.addProjectMember({
            tenantId,
            projectId: id,
            userId: req.user.id,
            role: 'OWNER'
          });
        }

        this._broadcastSSE('PROJECT_CREATED', project);

        // Async BullMQ Queue Generation: delegate to Redis worker without blocking HTTP handler
        if (this.asyncEnabled && this.queueManager) {
          const enqueueResult = await this.queueManager.enqueueGeneration({
            projectId: id,
            tenantId,
            createdBy,
            title,
            description,
            appType,
            fastMode: Boolean(body.fastMode),
            maxRetries: Number(body.maxRetries) || 3,
            budgetTokens: body.budgetTokens || 120000,
            budgetUsd: body.budgetUsd || 15.0,
            idempotencyKey
          });

          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            jobId: enqueueResult.job.id,
            projectId: id,
            status: enqueueResult.status,
            deduplicated: enqueueResult.deduplicated,
            project
          }));
          return;
        }

        // Legacy direct orchestrator execution (fallback if async queue is disabled)
        const pipelinePromise = this.orchestrator.buildProjectAutonomous(id, {
          title,
          description,
          prompt: [title, description].filter(Boolean).join('\n\n'),
          appType,
          fastMode: Boolean(body.fastMode)
        }).catch(err => {
          this.eventBus.publish('PIPELINE_ERROR', { projectId: id, message: err.message });
        }).finally(() => {
          this.activePipelines.delete(id);
        });
        this.activePipelines.set(id, pipelinePromise);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          projectId: id,
          status: 'BUILDING',
          project
        }));
        return;
      }

      // ── Job Status, Polling & Cancellation Endpoints ──────────────────────
      if (pathname === '/api/jobs' && method === 'GET') {
        const tenantId = (this.authEnabled && req.user?.role !== SystemRoles.PLATFORM_ADMIN) ? req.user?.tenantId : null;

        const jobs = await this.storage.listGenerationJobs({
          projectId: query.projectId || null,
          queueName: query.queueName || null,
          status: query.status || null,
          limit: safeLimit(query.limit, 50),
          tenantId
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, jobs }));
        return;
      }

      if ((pathname.match(/^\/api\/jobs\/([^/]+)$/) || pathname.match(/^\/api\/projects\/([^/]+)\/jobs\/([^/]+)$/)) && method === 'GET') {
        const parts = pathname.split('/');
        const isDirectJob = parts[2] === 'jobs';
        const jobId = isDirectJob ? parts[3] : parts[5];
        const routeProjectId = !isDirectJob ? parts[3] : null;

        const unconstrainedJob = await this.storage.getGenerationJob(jobId, null);
        if (!unconstrainedJob) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Job not found' }));
          return;
        }

        // Project and Tenant Access Authorization Guard
        if (this.authEnabled) {
          const jobTenantId = unconstrainedJob.tenant_id || unconstrainedJob.tenantId;
          if (req.user?.tenantId && jobTenantId && req.user.tenantId !== jobTenantId && req.user.role !== SystemRoles.PLATFORM_ADMIN) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Access denied to cross-tenant job' }));
            return;
          }
          const jobProjectId = unconstrainedJob.project_id || unconstrainedJob.projectId;
          if (jobProjectId && !(await this.authMiddleware.requireProjectAccess(req, res, jobProjectId, Permissions.PROJECT_READ))) {
            return;
          }
        }

        let job = null;
        if (this.queueManager) {
          job = await this.queueManager.getJobStatus(jobId, unconstrainedJob.tenant_id || null);
        } else {
          job = unconstrainedJob;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, job }));
        return;
      }

      if ((pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/) || pathname.match(/^\/api\/projects\/([^/]+)\/cancel$/)) && method === 'POST') {
        const parts = pathname.split('/');
        const isJobCancel = parts[2] === 'jobs';
        const jobId = isJobCancel ? parts[3] : null;
        const projectId = !isJobCancel ? parts[3] : null;

        if (this.authEnabled && projectId && !(await this.authMiddleware.requireProjectAccess(req, res, projectId, Permissions.PROJECT_UPDATE))) return;

        let targetJobId = jobId;
        if (!targetJobId && projectId) {
          const projectJobs = await this.storage.listGenerationJobs({ projectId, status: 'RUNNING', limit: 1 });
          targetJobId = projectJobs[0]?.id;
        }

        // Cancel the orchestrator pipeline (covers both sync and async modes)
        if (projectId) {
          try {
            const resCtrl = this.orchestrator.cancel(projectId);
            this._broadcastSSE('PIPELINE_CANCELLED', resCtrl);
          } catch (_) {}
        }

        // Cancel the pipelineControls flag for in-flight pipelines
        if (projectId && this.orchestrator?.pipelineControls && this.orchestrator.pipelineControls[projectId]) {
          this.orchestrator.pipelineControls[projectId].cancelled = true;
        }

        // Cancel BullMQ job and abort active worker (async queue mode)
        if (targetJobId) {
          this.workerManager?.abortActiveJob(targetJobId);
          await this.queueManager?.cancelJob(targetJobId, 'User requested cancellation', req.user?.tenantId);
        }

        // Remove from activePipelines tracking map
        if (projectId) this.activePipelines.delete(projectId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, status: 'CANCELLED', jobId: targetJobId, projectId }));
        return;
      }

      // ── Requirement Inspection & Scope Lock ──────────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/requirements\/parse$/) && method === 'POST') {
        const projectId = pathname.split('/')[3];
        const body = await this.readJsonBody(req);
        const instruction = (body.instruction || body.request || body.prompt || '').trim();
        if (!instruction) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing instruction' }));
          return;
        }
        const spec = await RequirementParser.parseWithLLM(instruction, this.orchestrator.llm, { projectId });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(spec));
        return;
      }

      // ── Requirement-Accurate Self-Auditing Feature Build ───────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/feature-build$/) && method === 'POST') {
        const projectId = pathname.split('/')[3];
        if (this.authEnabled && !(await this.authMiddleware.requireProjectAccess(req, res, projectId, Permissions.BUILD_TRIGGER))) return;
        const body = await this.readJsonBody(req);
        const instruction = (body.instruction || body.prompt || body.request || '').trim();
        if (!instruction) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing instruction for feature build' }));
          return;
        }

        const project = this.storage.getProject(projectId);
        if (!project) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project not found' }));
          return;
        }

        const result = await this.auditEngine.executeFeatureBuild(projectId, instruction, {
          maxIterations: body.maxIterations || 5,
          autoFix: body.autoFix !== false
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // ── Persistent Audit Report & History ────────────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/audit-report$/) && method === 'GET') {
        const projectId = pathname.split('/')[3];
        const latestRun = this.storage.getLatestBuildRun(projectId);
        if (latestRun) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(latestRun.report || latestRun));
          return;
        }

        // Fallback to requirement coverage report if available
        try {
          const content = this.sandbox.readFileSafely(projectId, 'reports/requirement-coverage.json');
          if (content) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(content);
            return;
          }
        } catch (_) {}

        const tracker = this.orchestrator.trackers?.[projectId];
        if (tracker) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(tracker.generateReport()));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No audit report found for this project' }));
        return;
      }

      // ── Requirement Coverage Report ───────────────────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/coverage$/) && method === 'GET') {
        const projectId = pathname.split('/')[3];
        try {
          const content = this.sandbox.readFileSafely(projectId, 'reports/requirement-coverage.json');
          if (content) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(content);
            return;
          }
        } catch (_) {}

        const tracker = this.orchestrator.trackers?.[projectId];
        if (tracker) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(tracker.generateReport()));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No requirement coverage report found for this project' }));
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/build-runs$/) && method === 'GET') {
        const projectId = pathname.split('/')[3];
        const limit = safeLimit(query.limit, 20);
        const runs = this.storage.listBuildRuns(projectId, limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(runs));
        return;
      }

      if (pathname.match(/^\/api\/build-runs\/([^/]+)$/) && method === 'GET') {
        const runId = pathname.split('/')[3];
        const run = this.storage.getBuildRun(runId);
        if (!run) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Build run not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(run));
        return;
      }

      // ── Pipeline Controls (Pause, Resume, Cancel, Retry, Tests) ───────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/pause$/) && method === 'POST') {
        const projectId = pathname.split('/')[3];
        const resCtrl = this.orchestrator.pause(projectId);
        this._broadcastSSE('PIPELINE_PAUSED', resCtrl);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resCtrl));
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/resume$/) && method === 'POST') {
        const projectId = pathname.split('/')[3];
        const resCtrl = this.orchestrator.resume(projectId);
        this._broadcastSSE('PIPELINE_RESUMED', resCtrl);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resCtrl));
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/retry$/) && method === 'POST') {
        const projectId = pathname.split('/')[3];
        const body = await this.readJsonBody(req).catch(() => ({}));
        this.orchestrator.retry(projectId, body).catch(err => {
          this.eventBus.publish('PIPELINE_ERROR', { projectId, message: err.message });
        });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ retrying: true, projectId }));
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/run-tests$/) && method === 'POST') {
        const projectId = pathname.split('/')[3];
        const runResult = await this.sandbox.executeCommand(projectId, 'node --test', {
          agentRole: 'QA',
          timeoutMs: 15000
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(runResult));
        return;
      }

      // ── DAG ───────────────────────────────────────────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/dag$/) && method === 'GET') {
        const projectId = pathname.split('/')[3];
        const dag = this.orchestrator.getDAG(projectId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(dag.serialize()));
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/dag\/reset$/) && method === 'POST') {
        const projectId = pathname.split('/')[3];
        this.orchestrator.getDAG(projectId).reset();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reset: true }));
        return;
      }

      // ── Pipeline ──────────────────────────────────────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/pipeline$/) && method === 'POST') {
        const projectId = pathname.split('/')[3];
        const body = await this.readJsonBody(req);
        const stage = body.stage || 'STAGE_INTAKE';

        const result = await this.orchestrator.executeStage(projectId, stage, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // ── Full Autonomous Pipeline Run ──────────────────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/run-all$/) && method === 'POST') {
        const projectId = pathname.split('/')[3];
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'PIPELINE_STARTED', message: 'Full autonomous pipeline initiated. Follow the event stream.' }));

        // Run asynchronously in background
        this._runFullPipeline(projectId).catch(err => {
          this.eventBus.publish('PIPELINE_ERROR', { projectId, message: err.message });
        });
        return;
      }

      // ── Sandbox ───────────────────────────────────────────────────────────
      if (pathname === '/api/sandbox/run' && method === 'POST') {
        if (this.authEnabled && !this.authMiddleware.requirePermission(req, res, Permissions.SANDBOX_RUN)) return;
        const body = await this.readJsonBody(req);
        const { projectId, command } = body;
        if (!projectId || !command) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing projectId or command' }));
          return;
        }
        if (this.authEnabled && !(await this.authMiddleware.requireProjectAccess(req, res, projectId, Permissions.SANDBOX_RUN))) return;
        const runResult = await this.sandbox.executeCommand(projectId, command);
        this._broadcastSSE('SANDBOX_RUN', runResult);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(runResult));
        return;
      }

      // ── Git Log ───────────────────────────────────────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/git\/log$/) && method === 'GET') {
        const projectId = pathname.split('/')[3];
        const limit = safeLimit(query.limit, 20);
        const git = this.orchestrator.getGit(projectId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(git.getLog(limit)));
        return;
      }

      // ── Files ─────────────────────────────────────────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/files\/content$/) && method === 'GET') {
        const projectId = pathname.split('/')[3];
        if (this.authEnabled && !(await this.authMiddleware.requireProjectAccess(req, res, projectId, Permissions.FILE_READ))) return;
        const file = query.file;
        if (!file) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing file query param' }));
          return;
        }
        const content = this.sandbox.readFileSafely(projectId, file);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ file, content }));
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/files$/) && method === 'GET') {
        const projectId = pathname.split('/')[3];
        if (this.authEnabled && !(await this.authMiddleware.requireProjectAccess(req, res, projectId, Permissions.FILE_READ))) return;
        const files = this.sandbox.listFiles(projectId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(files));
        return;
      }

      // ── Save/Update File (Code Editor Hot Reload) ──────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/files$/) && method === 'POST') {
        const projectId = pathname.split('/')[3];
        if (this.authEnabled && !(await this.authMiddleware.requireProjectAccess(req, res, projectId, Permissions.FILE_WRITE))) return;
        const body = await this.readJsonBody(req);
        const file = body.file || body.filename;
        const content = body.content;
        if (!file || typeof content !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing file or content' }));
          return;
        }

        try {
          this.sandbox.writeFileSafely(projectId, file, content);
          await this.previewManager.handleFileChange(projectId, file, content);
          try {
            this.orchestrator.getGit(projectId).commit({
              message: `Live editor update: ${file}`,
              author: 'Developer (Code Studio)',
              agentRole: 'FRONTEND',
              files: [file]
            });
          } catch (_) {}
          this.storage.logAuditEvent(projectId, 'DEVELOPER', 'FILE_EDIT', `Edited ${file} via Code Studio`);
          this._broadcastSSE('FILE_MODIFIED', { projectId, file, filename: file, timestamp: Date.now() });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, file, filename: file, savedAt: Date.now() }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // ── Approvals ─────────────────────────────────────────────────────────
      if (pathname === '/api/approvals' && method === 'GET') {
        const projectId = query.projectId;
        if (!projectId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing projectId' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.storage.listApprovals(projectId)));
        return;
      }

      if (pathname.match(/^\/api\/approvals\/([^/]+)\/(resolve|decide)$/) && method === 'POST') {
        if (this.authEnabled && !this.authMiddleware.requirePermission(req, res, Permissions.APPROVAL_DECIDE)) return;
        const approvalId = pathname.split('/')[3];
        const body = await this.readJsonBody(req);
        const rawDec = (body.decision || '').toUpperCase();
        const decision = rawDec === 'APPROVED' ? 'APPROVE' : (rawDec === 'REJECTED' ? 'REJECT' : rawDec);
        const resolved = this.approvalManager.resolveApproval(approvalId, {
          decision,
          operatorId: body.operatorId || body.reviewer || 'Operator',
          notes: body.notes || ''
        });
        this._broadcastSSE('APPROVAL_RESOLVED', resolved);
        if (resolved.action_type === GatedActions.PRODUCTION_DEPLOYMENT && resolved.status === 'APPROVED') {
          const projectId = resolved.project_id;
          this.storage.logAuditEvent(projectId, 'DEVOPS', 'PRODUCTION_RELEASE_COMPLETE',
            `Production deployment authorized by ${resolved.resolved_by} (Approval: ${resolved.id})`);
          this._broadcastSSE('DEPLOYMENT_COMPLETE', { status: 'DEPLOYED_TO_PRODUCTION', resolved });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resolved));
        return;
      }

      // ── Budget ────────────────────────────────────────────────────
      if (pathname === '/api/budget/increase' && method === 'POST') {
        if (this.authEnabled && !this.authMiddleware.requirePermission(req, res, Permissions.ORG_BILLING_MANAGE)) return;
        const body = await this.readJsonBody(req);
        const updated = this.budgetManager.applyApprovedBudgetIncrease(
          body.projectId, Number(body.additionalTokens) || 25000, body.authorizedBy || 'OPERATOR'
        );
        this._broadcastSSE('BUDGET_UPDATED', updated);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(updated));
        return;
      }

      // ── Project Live Preview Management Endpoints ─────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/preview\/status$/) && method === 'GET') {
        const projectId = pathname.split('/')[3];
        const project = this.storage.getProject(projectId);
        if (!project) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Project not found' })); return; }
        const effectiveTenantId = req.tenantId || req.headers?.['x-tenant-id'];
        if (effectiveTenantId && project.tenant_id && project.tenant_id !== effectiveTenantId) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden: Access to another tenant\'s preview session is prohibited' }));
          return;
        }
        const session = await this.previewManager.getOrCreateSession(projectId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session.toJSON()));
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/preview\/start$/) && method === 'POST') {
        const projectId = pathname.split('/')[3];
        const project = this.storage.getProject(projectId);
        if (!project) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Project not found' })); return; }
        const effectiveTenantId = req.tenantId || req.headers?.['x-tenant-id'];
        if (effectiveTenantId && project.tenant_id && project.tenant_id !== effectiveTenantId) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden: Access to another tenant\'s project is prohibited' }));
          return;
        }
        try {
          const session = await this.previewManager.startSession(projectId);
          this._broadcastSSE('PREVIEW_STARTED', { projectId, status: session.status, port: session.port });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(session.toJSON()));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/preview\/restart$/) && method === 'POST') {
        const projectId = pathname.split('/')[3];
        const session = await this.previewManager.restartSession(projectId);
        this._broadcastSSE('PREVIEW_RESTARTED', { projectId, status: session.status });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session.toJSON()));
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/preview\/stop$/) && method === 'POST') {
        const projectId = pathname.split('/')[3];
        await this.previewManager.stopSession(projectId);
        this._broadcastSSE('PREVIEW_STOPPED', { projectId });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, status: 'stopped' }));
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/preview\/cleanup$/) && method === 'POST') {
        const projectId = pathname.split('/')[3];
        const result = await this.previewManager.cleanupSession(projectId);
        this._broadcastSSE('PREVIEW_CLEANED', { projectId });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/preview\/logs$/) && method === 'GET') {
        const projectId = pathname.split('/')[3];
        const project = this.storage.getProject(projectId);
        if (!project) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Project not found' })); return; }
        const effectiveTenantId = req.tenantId || req.headers?.['x-tenant-id'];
        if (effectiveTenantId && project.tenant_id && project.tenant_id !== effectiveTenantId) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden: Access to another tenant\'s preview logs is prohibited' }));
          return;
        }
        const session = await this.previewManager.getOrCreateSession(projectId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session.logs));
        return;
      }

      // ── Project Live Preview (Dynamic Router & Proxy) ───────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/preview(\/.*)?$/)) {
        const parts = pathname.split('/');
        const projectId = parts[3];
        const subpath = parts.slice(5).join('/') || query.file || '';
        const effectiveTenantId = req.tenantId || req.headers?.['x-tenant-id'];

        await this.previewManager.handlePreviewRequest(req, res, projectId, subpath, effectiveTenantId);
        return;
      }

      // ── Cloud Deployment Management Endpoints ─────────────────────────
      if (pathname === '/api/deploy/providers' && method === 'GET') {
        const providers = this.deploymentManager.listProviders();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ providers }));
        return;
      }

      if (pathname.match(/^\/api\/deploy\/checklist\/([^/]+)$/) && method === 'GET') {
        const providerName = pathname.split('/')[4];
        try {
          const checklist = this.deploymentManager.getSetupChecklist(providerName);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(checklist));
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/deploy$/) && method === 'POST') {
        const projectId = pathname.split('/')[3];
        const body = await this.readJsonBody(req);
        const effectiveTenantId = req.tenantId || req.headers?.['x-tenant-id'] || 'tenant-default';

        try {
          if (this.usageMeter) {
            await this.usageMeter.checkLimit(effectiveTenantId, 'deployment');
          }

          const deployment = await this.deploymentManager.deployProject({
            projectId,
            tenantId: effectiveTenantId,
            providerName: body.provider || null,
            environment: body.environment || 'preview',
            envVars: body.envVars || {},
            commitSha: body.commitSha || null,
            approvalId: body.approvalId || null,
            operatorId: req.user?.id || body.operatorId || 'OPERATOR',
            metadata: body.metadata || {}
          });

          // Record telemetry metric
          this.telemetry.recordDeployment({
            provider: deployment.provider,
            environment: deployment.environment,
            status: deployment.status
          });

          // Record usage event with idempotency protection
          if (this.usageMeter) {
            await this.usageMeter.recordUsage({
              tenantId: effectiveTenantId,
              projectId,
              eventType: 'DEPLOYMENT',
              quantity: 1,
              unit: 'COUNT',
              idempotencyKey: `dep_${deployment.id}`,
              metadata: { provider: deployment.provider, environment: deployment.environment }
            });
          }

          this._broadcastSSE('DEPLOYMENT_STARTED', { projectId, deploymentId: deployment.id, status: deployment.status });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(deployment));
        } catch (err) {
          if (err instanceof ApprovalRequiredError) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              approvalRequired: true,
              message: err.message,
              details: err.details
            }));
            return;
          }
          if (err instanceof QuotaExceededError) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message, details: err.details }));
            return;
          }
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/deployments$/) && method === 'GET') {
        const projectId = pathname.split('/')[3];
        const effectiveTenantId = req.tenantId || req.headers?.['x-tenant-id'];
        const deployments = this.storage.listDeployments(projectId, effectiveTenantId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(deployments));
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/deployments\/([^/]+)\/rollback$/) && method === 'POST') {
        const parts = pathname.split('/');
        const projectId = parts[3];
        const depId = parts[5];
        const body = await this.readJsonBody(req);
        const targetDeploymentId = body.targetDeploymentId;
        const effectiveTenantId = req.tenantId || req.headers?.['x-tenant-id'] || 'tenant-default';

        try {
          const rolledBack = await this.deploymentManager.rollbackDeployment(depId, targetDeploymentId, effectiveTenantId);
          this._broadcastSSE('DEPLOYMENT_ROLLED_BACK', { projectId, deploymentId: rolledBack.id, targetDeploymentId });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(rolledBack));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/deployments\/([^/]+)$/) && method === 'GET') {
        const parts = pathname.split('/');
        const projectId = parts[3];
        const depId = parts[5];
        const effectiveTenantId = req.tenantId || req.headers?.['x-tenant-id'];
        const deployment = this.storage.getDeployment(depId, effectiveTenantId);
        if (!deployment) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Deployment not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(deployment));
        return;
      }

      if (pathname.match(/^\/api\/projects\/([^/]+)\/deployments\/([^/]+)$/) && method === 'DELETE') {
        const parts = pathname.split('/');
        const projectId = parts[3];
        const depId = parts[5];
        const effectiveTenantId = req.tenantId || req.headers?.['x-tenant-id'] || 'tenant-default';

        try {
          const result = await this.deploymentManager.teardownDeployment(depId, effectiveTenantId);
          this._broadcastSSE('DEPLOYMENT_TERMINATED', { projectId, deploymentId: depId });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // ── Export Project Bundle ─────────────────────────────────────────────
      if (pathname.match(/^\/api\/projects\/([^/]+)\/export$/) && method === 'GET') {
        const projectId = pathname.split('/')[3];
        const project = this.storage.getProject(projectId);
        if (!project) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Project not found' })); return; }

        const files = this.sandbox.listFiles(projectId);
        const exportPackage = {
          projectId: project.id,
          name: project.name,
          description: project.description,
          budgetTokens: project.budget_tokens,
          exportedAt: new Date().toISOString(),
          fileCount: files.length,
          files: {}
        };

        for (const file of files) {
          try {
            exportPackage.files[file] = this.sandbox.readFileSafely(projectId, file);
          } catch (_) {}
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${projectId}-export.json"`
        });
        res.end(JSON.stringify(exportPackage, null, 2));
        return;
      }

      // ── Idea Studio Analysis Endpoint ─────────────────────────────────────
      if (pathname === '/api/idea/analyze' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const idea = (body.idea || '').trim();
        if (!idea) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Please provide an idea description' }));
          return;
        }

        // Domain analysis
        const isCommerce = /store|shop|cart|payment|checkout|ecommerce|stripe/i.test(idea);
        const isChat = /chat|realtime|message|collaborative|socket|stream/i.test(idea);
        const isAuth = /auth|login|security|token|jwt|session/i.test(idea);

        const title = isCommerce
          ? 'OmniChannel eCommerce Engine'
          : isChat
            ? 'Real-Time Collaborative Network'
            : isAuth
              ? 'Zero-Trust Identity Gateway'
              : 'Autonomous High-Velocity Application';

        const prd = `## Product Specification Document\n\n**Mission Statement**: ${idea}\n\n### Primary Architectural Goals\n1. Autonomous 11-agent parallel execution across UI, Backend, Database, AI, and QA.\n2. Strict sandbox isolation, deterministic tests, and explicit human sign-off on release.\n3. Modern, responsive glassmorphic design system and sub-100ms API response times.`;

        const clarifyingQuestions = isCommerce
          ? [
              'Do you need multi-currency payment gateway support (Stripe, PayPal, Crypto)?',
              'Should product inventory decrement atomically under high concurrency?'
            ]
          : isChat
            ? [
                'Do you prefer WebSockets or zero-latency Server-Sent Events (SSE)?',
                'Should channel message history be persisted in SQLite with WAL mode?'
              ]
            : [
                'What target environments should the application build for (Web, Mobile, Desktop)?',
                'Do you require token-based rate limiting on sensitive endpoints?'
              ];

        const taskBreakdown = [
          { role: 'PM', title: 'Breakdown User Stories & Milestone DAG', stage: 'STAGE_INTAKE', agent: 'Sofia Ramos' },
          { role: 'BA', title: 'Compile Acceptance Criteria & Edge Cases', stage: 'STAGE_INTAKE', agent: 'Elena Rostova' },
          { role: 'DESIGNER', title: 'Design Modern Glassmorphism System & Responsive Layout', stage: 'STAGE_ARCHITECTURE', agent: 'Maya Lin' },
          { role: 'ARCHITECT', title: 'Draft API Schemas & Microservice Topology', stage: 'STAGE_ARCHITECTURE', agent: 'Marcus Vance' },
          { role: 'BACKEND', title: 'Synthesize Core Server Logic & Database Layer', stage: 'STAGE_BACKEND', agent: 'David Chen' },
          { role: 'DATABASE', title: 'Establish Normalized Schema & Indexes', stage: 'STAGE_BACKEND', agent: 'Tariq Al-Mansoor' },
          { role: 'FRONTEND', title: 'Implement Interactive Client Components & Animations', stage: 'STAGE_FRONTEND', agent: 'Aria Patel' },
          { role: 'CODE_REVIEWER', title: 'Perform Code Quality & Architectural Integrity Audit', stage: 'STAGE_QA', agent: 'Kaito Tanaka' },
          { role: 'QA', title: 'Run Automated Sandboxed Test Rig & Verification', stage: 'STAGE_QA', agent: 'Quinn Sterling' },
          { role: 'SECURITY', title: 'Verify Sandbox Jail & Secret Containment', stage: 'STAGE_QA', agent: 'Valerie Vance' },
          { role: 'DEVOPS', title: 'Build Release Candidate & Await Operator Approval', stage: 'STAGE_DEPLOY_REQUEST', agent: 'Devon Kross' }
        ];

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          title,
          summary: `Decomposed "${idea.slice(0, 80)}..." into 11 specialized agent assignments with 6 governance stages.`,
          prd,
          clarifyingQuestions,
          taskBreakdown,
          estimatedTokens: 95000,
          estimatedBudgetUsd: 19.00
        }));
        return;
      }

      // ── Office Action Trigger ─────────────────────────────────────────────
      if (pathname === '/api/office/action' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const { action, agentRole, targetRole, payload, projectId } = body;

        this.eventBus.publish(action || 'OFFICE_ACTION', {
          projectId: projectId || (this.storage.listProjects()[0]?.id),
          agentRole,
          targetRole,
          ...payload,
          timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, action }));
        return;
      }

      // If an /api/ path was requested but not handled above, return 404 JSON
      if (pathname.startsWith('/api/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API endpoint not found', path: pathname }));
        return;
      }

      // ── Static Files ──────────────────────────────────────────────────────
      if (method === 'GET' || method === 'HEAD') {
        return this.serveStatic(req, res, pathname);
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Endpoint not found' }));

    } catch (err) {
      if (this.sentry) {
        this.sentry.captureException(err, {
          requestId: req.id,
          url: req.url,
          method: req.method,
          tenantId: req.user?.tenantId,
          userId: req.user?.id
        });
      }
      if (!res.headersSent) {
        const code = err instanceof SecurityError ? 403 :
                     err instanceof BudgetExceededError ? 402 :
                     (err instanceof QuotaExceededError || err instanceof BillingQuotaError) ? 429 :
                     err instanceof WebhookVerificationError ? 400 :
                     err instanceof AuthError ? err.statusCode :
                     err.statusCode || 500;
        res.writeHead(code, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({
        error: err.message,
        code: err.code || err.name || 'INTERNAL_ERROR',
        details: err.details || undefined
      }));
    }
  }

  async _runFullPipeline(projectId) {
    return this.orchestrator.buildProjectAutonomous(projectId);
  }

  readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      let done = false;
      req.on('data', c => {
        data += c;
        if (!done && data.length > 1e6) {
          done = true;
          req.destroy();
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('Invalid JSON')); }
      });
      req.on('error', err => {
        if (done) return;
        done = true;
        reject(err);
      });
    });
  }

  readRawBody(req, maxSizeBytes = 1 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let totalLength = 0;
      let done = false;

      const cl = parseInt(req.headers['content-length'] || '0', 10);
      if (cl > maxSizeBytes) {
        return reject(new StorageError(`Payload size (${cl} bytes) exceeds maximum limit of ${maxSizeBytes} bytes`, 'PAYLOAD_TOO_LARGE', 413));
      }

      req.on('data', chunk => {
        if (done) return;
        totalLength += chunk.length;
        if (totalLength > maxSizeBytes) {
          done = true;
          req.destroy();
          return reject(new StorageError(`Payload size exceeds maximum limit of ${maxSizeBytes} bytes`, 'PAYLOAD_TOO_LARGE', 413));
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (done) return;
        done = true;
        resolve(Buffer.concat(chunks));
      });

      req.on('error', err => {
        if (done) return;
        done = true;
        reject(err);
      });
    });
  }

  serveStaticV2(req, res, pathname) {
    const v2Dir = path.resolve('public/v2');
    const rel = pathname.replace(/^\/v2\/?/, '');
    let filePath = path.join(v2Dir, rel === '' ? 'index.html' : rel);
    if (!filePath.startsWith(v2Dir + path.sep) && filePath !== v2Dir) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(v2Dir, 'index.html');
    }
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png'
    };
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain; charset=utf-8' });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  }

  serveStatic(req, res, pathname) {
    const publicDir = path.resolve('public');
    let filePath = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
    if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) { res.writeHead(403); res.end('Forbidden'); return; }

    const ext = path.extname(filePath).toLowerCase();

    // If file does not exist or is a directory
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // If client requested a specific asset with file extension that does not exist, return 404
      if (ext && ext !== '.html') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`File not found: ${pathname}`);
        return;
      }
      // Otherwise fallback to index.html for SPA client navigation
      filePath = path.join(publicDir, 'index.html');
    }

    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2'
    };
    const finalExt = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': mimeTypes[finalExt] || 'text/plain'
    };

    if (['.js', '.css', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.woff', '.woff2', '.ico'].includes(finalExt)) {
      headers['Cache-Control'] = 'public, max-age=3600';
    }

    try {
      const stat = fs.statSync(filePath);
      headers['Content-Length'] = stat.size;
    } catch (_) {}

    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end('Read error');
    });
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  start() {
    return new Promise(resolve => {
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : this.port;
        if (this.auditEngine) {
          this.auditEngine.serverPort = this.port;
        }
        if (this.artifactService && typeof this.artifactService.setBaseUrl === 'function') {
          this.artifactService.setBaseUrl(`http://${this.host}:${this.port}`);
        }
        this.logger.info('AI Virtual Software House Control Center started', {
          host: this.host,
          port: this.port,
          url: `http://${this.host}:${this.port}`,
          llmMode: this.llm.simulationMode ? 'SIMULATION' : 'LIVE'
        });
        if (process.env.NODE_ENV !== 'test') {
          console.log(`[HTTP Server] AI Virtual Software House Control Center live at http://${this.host}:${this.port}`);
          console.log(`[LLM] Mode: ${this.llm.simulationMode ? '🤖 Intelligent Simulation (set GEMINI_API_KEY for live mode)' : '⚡ Live Gemini API'}`);
        }
        resolve(`http://${this.host}:${this.port}`);
      });
    });
  }

  async stop() {
    try { await this.previewManager.shutdownAll(); } catch (_) {}
    if (this.workerManager) {
      try { await this.workerManager.close(); } catch (_) {}
    }
    if (this.queueManager) {
      try { await this.queueManager.close(); } catch (_) {}
    }
    if (this.embeddedRedis) {
      try { await this.embeddedRedis.stop(); } catch (_) {}
    }
    for (const [id] of this.activePipelines) {
      try { this.orchestrator.cancel(id); } catch (_) {}
    }
    await Promise.allSettled(Array.from(this.activePipelines.values()));
    return new Promise(resolve => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          if (this.ownsStorage) {
            try { this.storage.close(); } catch (_) {}
          }
          resolve();
        }
      };
      const timer = setTimeout(done, 1500);

      try {
        if (typeof this.server.closeAllConnections === 'function') {
          this.server.closeAllConnections();
        } else if (typeof this.server.closeIdleConnections === 'function') {
          this.server.closeIdleConnections();
        }
      } catch (_) {}

      this.server.close(() => {
        clearTimeout(timer);
        done();
      });
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('src/server/server.js')) {
  const srv = new VirtualHouseServer({ port: 3000 });
  srv.start();
}
