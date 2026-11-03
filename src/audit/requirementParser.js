import crypto from 'node:crypto';

/**
 * RequirementParser
 * Extracts structured, testable feature specifications, dynamic requirement registries (REQ-001...),
 * and immutable scope locks from user instructions to ensure agents build exactly what was requested.
 */
export class RequirementParser {
  /**
   * Parse user instruction into an immutable RequirementLock
   * @param {string} instruction Raw user prompt or instruction
   * @param {Object} [projectContext] Existing project map
   * @returns {Object} RequirementLock
   */
  static parse(instruction, projectContext = {}) {
    const raw = (instruction || '').trim();
    if (!raw) {
      throw new Error('User instruction cannot be empty');
    }

    const domain = RequirementParser.detectDomain(raw);
    const featureName = RequirementParser.extractFeatureName(raw, domain);
    const rawRequirements = RequirementParser.extractRequirements(raw, domain);
    const explicitRequirements = rawRequirements.map((req, idx) => ({
      ...req,
      targetFile: RequirementParser.normalizeTargetFile(req.targetFile, req.category),
      acceptanceCriteria: req.acceptanceCriteria || `AC-${idx + 1}: ${req.text} is fully verified and operational.`
    }));

    if (!explicitRequirements.some(r => r.category === 'TESTING' || r.targetFile === 'tests/api.test.js')) {
      explicitRequirements.push({
        id: `REQ-${domain}-TEST`,
        category: 'TESTING',
        text: 'Automated test suite verifying critical execution in tests/api.test.js',
        targetFile: 'tests/api.test.js',
        acceptanceCriteria: 'Automated test runner executes with exit code 0.'
      });
    }
    const explicitExclusions = RequirementParser.extractExclusions(raw, domain);
    const acceptanceCriteria = RequirementParser.extractAcceptanceCriteria(raw, domain, explicitRequirements);
    const expectedRoutes = RequirementParser.extractExpectedRoutes(domain, raw);
    const allowedFiles = RequirementParser.extractAllowedFiles(domain, projectContext);

    const lockId = `lock-${crypto.randomUUID().slice(0, 8)}`;
    const buildRunId = `run-${crypto.randomUUID().slice(0, 8)}`;

    const traceabilityMatrix = explicitRequirements.map((req, idx) => ({
      requirementId: req.id,
      category: req.category || 'FUNCTIONAL',
      description: req.text,
      targetFile: req.targetFile || (domain === 'AUTH' ? 'public/index.html' : 'src/api.js'),
      testId: `TEST-${req.id}`,
      browserCheckId: `BROWSER-ASSERT-${idx + 1}`,
      acceptanceCriteria: req.acceptanceCriteria || `AC-${idx + 1}: ${req.text} verified operational.`,
      status: 'PENDING' // PENDING | IN_PROGRESS | IMPLEMENTED | TESTING | VERIFIED | BLOCKED
    }));

    return {
      lockId,
      buildRunId,
      timestamp: Date.now(),
      instruction: raw,
      featureName,
      domain,
      explicitRequirements,
      explicitExclusions,
      acceptanceCriteria,
      expectedRoutes,
      allowedFiles,
      traceabilityMatrix,
      isLocked: true
    };
  }

  /**
   * Deep async parser leveraging Gemini LLM when available, with automatic rule-based fallback
   * @param {string} instruction
   * @param {Object} llm GeminiClient instance
   * @param {Object} [projectContext]
   * @returns {Promise<Object>}
   */
  static async parseWithLLM(instruction, llm, projectContext = {}) {
    const raw = (instruction || '').trim();
    if (!raw) throw new Error('User instruction cannot be empty');

    // If no live LLM or simulation mode, use deterministic semantic parser
    if (!llm || llm.simulationMode) {
      return RequirementParser.parse(raw, projectContext);
    }

    const systemPrompt = `You are a Principal Software Requirement Analyst.
Decompose the complete user prompt into an exhaustive, structured requirement specification.
Preserve the user's exact intent, constraints, and scope.
Do not omit explicitly requested features or invent incompatible functionality.

Respond with ONLY a raw JSON object (no markdown backticks, no extra text) matching this schema:
{
  "objective": "Primary objective of the application",
  "domain": "PLACEMENT | LIBRARY | HEALTHCARE | ECOMMERCE | CHAT | ANALYTICS | WORKFLOW | AUTH | CUSTOM",
  "featureName": "Concise descriptive title of the project",
  "requirements": [
    {
      "id": "REQ-001",
      "category": "FUNCTIONAL | UI | API | DATABASE | SECURITY | TESTING",
      "text": "Specific requirement description",
      "targetFile": "public/index.html or src/api.js or tests/api.test.js",
      "acceptanceCriteria": "Unambiguous testable acceptance criterion"
    }
  ],
  "exclusions": ["Things explicitly excluded or forbidden based on scope"],
  "nonFunctional": ["Performance, accessibility, and responsive design expectations"]
}`;

    try {
      const result = await llm.generate({
        role: 'PM',
        systemPrompt,
        userMessage: `Analyze this complete prompt:\n\n${raw}`,
        temperature: 0.2,
        timeoutMs: projectContext.timeoutMs || 30000
      });

      let jsonStr = result.text.trim();
      if (jsonStr.startsWith('```json')) jsonStr = jsonStr.slice(7);
      if (jsonStr.startsWith('```')) jsonStr = jsonStr.slice(3);
      if (jsonStr.endsWith('```')) jsonStr = jsonStr.slice(0, -3);
      jsonStr = jsonStr.trim();

      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) jsonStr = jsonMatch[0];
      jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

      const parsed = JSON.parse(jsonStr);

      if (parsed && Array.isArray(parsed.requirements) && parsed.requirements.length > 0) {
        const lockId = `lock-${crypto.randomUUID().slice(0, 8)}`;
        const buildRunId = `run-${crypto.randomUUID().slice(0, 8)}`;
        const detectedDomain = RequirementParser.detectDomain(raw);
        const isSpecializedDomain = ['PLACEMENT', 'LIBRARY', 'HEALTHCARE', 'AUTH', 'EXPENSE'].includes(detectedDomain);
        const domain = isSpecializedDomain ? detectedDomain : (parsed.domain || detectedDomain);
        const featureName = parsed.featureName || RequirementParser.extractFeatureName(raw, domain);

        const explicitRequirements = parsed.requirements.map((r, i) => {
          const category = r.category || 'FUNCTIONAL';
          const targetFile = RequirementParser.normalizeTargetFile(r.targetFile, category);
          return {
            id: r.id || `REQ-${String(i + 1).padStart(3, '0')}`,
            category,
            text: r.text || r.description,
            targetFile,
            acceptanceCriteria: r.acceptanceCriteria || `AC-${i + 1}: ${r.text || r.description} is verified operational.`
          };
        });

        // Always guarantee an automated testing requirement in the registry
        if (!explicitRequirements.some(r => r.category === 'TESTING' || r.targetFile === 'tests/api.test.js')) {
          explicitRequirements.push({
            id: `REQ-${String(explicitRequirements.length + 1).padStart(3, '0')}`,
            category: 'TESTING',
            text: 'Automated test suite execution in tests/api.test.js',
            targetFile: 'tests/api.test.js',
            acceptanceCriteria: 'Automated test suite executes with exit code 0.'
          });
        }

        const explicitExclusions = Array.isArray(parsed.exclusions) && parsed.exclusions.length > 0
          ? parsed.exclusions
          : RequirementParser.extractExclusions(raw, domain);

        const acceptanceCriteria = explicitRequirements.map(r => r.acceptanceCriteria);

        const traceabilityMatrix = explicitRequirements.map((req, idx) => ({
          requirementId: req.id,
          category: req.category,
          description: req.text,
          targetFile: req.targetFile,
          testId: `TEST-${req.id}`,
          browserCheckId: `BROWSER-ASSERT-${idx + 1}`,
          acceptanceCriteria: req.acceptanceCriteria,
          status: 'PENDING'
        }));

        return {
          lockId,
          buildRunId,
          timestamp: Date.now(),
          instruction: raw,
          featureName,
          domain,
          explicitRequirements,
          explicitExclusions,
          acceptanceCriteria,
          expectedRoutes: RequirementParser.extractExpectedRoutes(domain, raw),
          allowedFiles: RequirementParser.extractAllowedFiles(domain, projectContext),
          traceabilityMatrix,
          isLocked: true,
          source: 'GEMINI_LLM_ANALYSIS'
        };
      }
    } catch (err) {
      console.warn(`[RequirementParser] LLM analysis fallback to semantic parser: ${err.message}`);
    }

    return RequirementParser.parse(raw, projectContext);
  }

  /**
   * Normalize arbitrary or LLM-suggested target paths to standard project architecture files
   */
  static normalizeTargetFile(targetFile, category = 'FUNCTIONAL') {
    if (!targetFile || typeof targetFile !== 'string') {
      if (category === 'API' || category === 'DATABASE') return 'src/api.js';
      if (category === 'TESTING') return 'tests/api.test.js';
      if (category === 'NON_FUNCTIONAL') return 'public/style.css';
      if (category === 'DEVOPS') return 'package.json';
      return 'public/index.html';
    }

    const clean = targetFile.trim().replace(/^\.?\//, '');
    if (clean === 'src/api.js' || clean === 'public/index.html' || clean === 'public/style.css' || clean === 'tests/api.test.js' || clean === 'package.json' || clean === 'README.md') {
      return clean;
    }

    const lc = clean.toLowerCase();
    if (lc.includes('test') || lc.includes('spec')) return 'tests/api.test.js';
    if (lc.includes('style') || lc.includes('css')) return 'public/style.css';
    if (lc.includes('package') || lc.includes('docker') || lc.includes('manifest')) return 'package.json';
    if (lc.includes('api') || lc.includes('database') || lc.includes('db') || lc.includes('model') || lc.includes('server') || lc.includes('backend') || lc.includes('service') || lc.includes('portfolio') || lc.includes('route')) {
      return 'src/api.js';
    }
    return 'public/index.html';
  }

  /**
   * Semantic domain detector with high-priority intent matching
   */
  static detectDomain(text) {
    const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean);
    const firstLine = lines[0] ? lines[0].toLowerCase() : '';
    const lc = text.toLowerCase();

    // 1. Explicit domain concepts that MUST NEVER be hijacked by generic auth or ecommerce
    const hasFinanceExpense = /\b(expense\s+tracker|smart\s+expense|personal\s+finance|budget\s+tracker|income\s+and\s+expenses?|spending\s+tracker|financial\s+insights?|monthly\s+budgets?|expense\s+management|track\s+expenses?)\b/i.test(lc);
    if (hasFinanceExpense) {
      return 'EXPENSE';
    }

    const hasRecruitmentPlacement = /\b((?:student|campus|job|career)\s+placement|placement\s+(?:portal|drive|management|cell|season|system|records?)|student\s+records?|campus\s+drive|recruitment\s+management|interview\s+status)\b/i.test(lc)
      || (/\bplacement\b/i.test(lc) && !/\b(order\s+placement|product\s+placement|ad\s+placement)\b/i.test(lc));
    if (hasRecruitmentPlacement) {
      return 'PLACEMENT';
    }
    if (/\b(library|book\s+inventory|isbn|overdue\s+fines?|borrowing|book\s+catalog|circulation)\b/i.test(lc)) {
      return 'LIBRARY';
    }
    if (/\b(patient|hospital|doctor|clinic|medical\s+record|vital\s+signs?|prescription|intensive\s+care)\b/i.test(lc)) {
      return 'HEALTHCARE';
    }

    // Check if the prompt has explicit structured items (numbered or bullets)
    const granular = RequirementParser.extractGranularListItems(text);
    if (granular && granular.length >= 2) {
      if (hasFinanceExpense) return 'EXPENSE';
      if (hasRecruitmentPlacement) return 'PLACEMENT';
      if (/\b(library|book\s+inventory|isbn|overdue\s+fines?|borrowing)\b/i.test(firstLine) || /\b(library|book\s+inventory|isbn)\b/i.test(lc)) return 'LIBRARY';
      if (/\b(patient|hospital|doctor|medical\s+record)\b/i.test(firstLine) || /\b(patient|hospital|medical\s+record)\b/i.test(lc)) return 'HEALTHCARE';
      if (/\b(e-?commerce|store|shop|cart|market)\b/i.test(firstLine)) return 'ECOMMERCE';
      if (/\b(chat|messaging|channel)\b/i.test(firstLine)) return 'CHAT';
      if (/\b(telemetry|server\s+monitoring|p99\s+latency|system\s+metrics)\b/i.test(firstLine)) return 'ANALYTICS';
      if (/\b(kanban|task|workflow)\b/i.test(firstLine)) return 'WORKFLOW';
      if (/\b(auth|login|signup|user identity)\b/i.test(firstLine) && !firstLine.includes('platform') && !firstLine.includes('management') && !firstLine.includes('telemetry') && !firstLine.includes('hospital')) return 'AUTH';
      return 'CUSTOM';
    }

    // 2. Authentication / Login ONLY when it is the primary focus of the prompt
    const isDedicatedAuthPrompt = /^(build\s+(a\s+)?)?(user\s+)?(login|auth|authentication|identity\s+gateway|signup|registration)(\s+(and|&)\s+signup|\s+portal|\s+service|\s+system|\s+flow)?$/i.test(firstLine)
      || (/\b(build a login|login and signup|login\/signup)\b/i.test(lc) && !/\b(placement|library|hospital|patient|store|cart|ecommerce|expense|finance)\b/i.test(lc));
    if (isDedicatedAuthPrompt) {
      return 'AUTH';
    }

    // 3. Shopping cart / E-Commerce ONLY when primarily an online store or shopping cart
    if (/\b(shopping cart|checkout funnel|product catalog|ecommerce|e-commerce|storefront|order placement|stripe payment)\b/i.test(lc) && !/\b(library|book|hospital|expense|budget)\b/i.test(lc) && !hasRecruitmentPlacement) {
      return 'ECOMMERCE';
    }

    // 4. Real-time chat & messaging
    if (/\b(chat|messaging|realtime message|channel|direct message|presence|typing indicator|collaborative chat)\b/i.test(lc)) {
      return 'CHAT';
    }

    // 5. System Telemetry (strictly infrastructure/system telemetry, NEVER expense/financial or recruitment)
    if (/\b(telemetry|server\s+monitoring|system\s+metrics|p99\s+latency|throughput\s+monitor|application\s+telemetry)\b/i.test(lc) && !hasFinanceExpense && !hasRecruitmentPlacement) {
      return 'ANALYTICS';
    }

    // 6. Tasks & Workflow
    if (/\b(kanban|task board|todo|sprint board|ticket|workflow management)\b/i.test(lc)) {
      return 'WORKFLOW';
    }

    return 'CUSTOM';
  }

  /**
   * Extract explicit structured requirements from numbered lists, bullets, or distinct requirement lines
   */
  static extractGranularListItems(text) {
    if (!text || typeof text !== 'string') return null;

    // Normalize text: handle inline bullets, inline headers, and windows line endings
    const normalized = text
      .replace(/\r\n/g, '\n')
      .replace(/\s+-\s+/g, '\n- ')
      .replace(/\s+[*•]\s+/g, '\n* ')
      .replace(/\s+###\s+/g, '\n### ')
      .replace(/\s+(\d+)\.\s+/g, '\n$1. ');

    const lines = normalized.split('\n').map(l => l.trim()).filter(Boolean);
    const numberedRegex = /^\s*(\d+)[\.\)]\s*(.+)$/;
    const bulletRegex = /^\s*[-*•]\s*(.+)$/;

    const extractedItems = [];
    for (const line of lines) {
      if (line.startsWith('#')) continue; // skip markdown header lines
      const numMatch = line.match(numberedRegex);
      if (numMatch && numMatch[2].length > 5) {
        extractedItems.push(numMatch[2].trim());
        continue;
      }
      const bulletMatch = line.match(bulletRegex);
      if (bulletMatch && bulletMatch[1].length > 5) {
        extractedItems.push(bulletMatch[1].trim());
        continue;
      }
    }

    if (extractedItems.length >= 2) {
      return extractedItems.map((itemText, idx) => {
        const id = `REQ-${String(idx + 1).padStart(3, '0')}`;
        const lc = itemText.toLowerCase();

        let category = 'FUNCTIONAL';
        let targetFile = 'public/index.html';

        if (/\b(test|tests|testing|unit test|integration test|assert)\b/i.test(lc)) {
          category = 'TESTING';
          targetFile = 'tests/api.test.js';
        } else if (/\b(database|sqlite|acid|wal|schema|table|persist|store)\b/i.test(lc)) {
          category = 'DATABASE';
          targetFile = 'src/api.js';
        } else if (/\b(api|rest|restful|endpoint|route|crud|http|ingest|health)\b/i.test(lc)) {
          category = 'API';
          targetFile = 'src/api.js';
        } else if (/\b(responsive|css|stylesheet|mobile|tablet|viewport|glassmorphic)\b/i.test(lc)) {
          category = 'NON_FUNCTIONAL';
          targetFile = 'public/style.css';
        } else if (/\b(docker|dockerfile|deploy|manifest|container|deployment)\b/i.test(lc)) {
          category = 'DEVOPS';
          targetFile = 'package.json';
        } else if (/\b(auth|authentication|password|hash|bcrypt|scrypt|jwt|token|session|security|rate limit|xss|sql injection|rbac|role-based)\b/i.test(lc)) {
          category = 'SECURITY';
          targetFile = lc.includes('hash') || lc.includes('token') || lc.includes('rate limit') || lc.includes('injection') ? 'src/api.js' : 'public/index.html';
        } else if (/\b(dashboard|interface|ui|card|chart|view|visual|screen)\b/i.test(lc)) {
          category = 'UI';
          targetFile = 'public/index.html';
        } else if (/\b(validation|alert|notification|export|search|filter|sort|audit)\b/i.test(lc)) {
          category = 'FUNCTIONAL';
          targetFile = lc.includes('audit') || lc.includes('export') ? 'src/api.js' : 'public/index.html';
        }

        return {
          id,
          category,
          text: itemText,
          targetFile,
          acceptanceCriteria: `AC-${idx + 1}: ${itemText} is verified operational.`
        };
      });
    }

    return null;
  }

  static extractFeatureName(text, domain) {
    const lc = text.toLowerCase();
    if (domain === 'PLACEMENT') return 'Student Placement Management System';
    if (domain === 'LIBRARY') return 'Library Inventory Management System';
    if (domain === 'HEALTHCARE') return 'Healthcare Patient Management Portal';
    if (domain === 'AUTH') {
      if (lc.includes('login') && lc.includes('signup')) return 'User Authentication & Registration (Login & Signup)';
      if (lc.includes('signup') || lc.includes('register')) return 'User Registration & Signup Portal';
      return 'User Authentication Gateway & Login';
    }
    if (domain === 'ECOMMERCE') {
      if (lc.includes('checkout')) return 'E-Commerce Shopping Cart & Checkout Funnel';
      return 'E-Commerce Storefront & Shopping Cart';
    }
    if (domain === 'EXPENSE') return 'Smart Expense Tracker & Financial Insights';
    if (domain === 'CHAT') return 'Real-Time Team Messaging & Channels';
    if (domain === 'ANALYTICS') return 'Live Performance & Analytics Telemetry Dashboard';
    if (domain === 'WORKFLOW') return 'Interactive Kanban & Task Workflow Board';

    // Derive a clean, descriptive title from custom prompt
    const firstLine = text.split('\n')[0].trim();
    const cleanTitle = firstLine.replace(/^(build|create|implement|make|design)\s+(a|an|the)?\s*/i, '').trim();
    if (cleanTitle.length > 3) {
      return cleanTitle.slice(0, 50).trim();
    }
    return text.slice(0, 48).trim();
  }

  static extractRequirements(text, domain) {
    // 1. Highest priority: User's explicitly listed structured requirements
    const granular = RequirementParser.extractGranularListItems(text);
    if (granular && granular.length >= 2) {
      return granular;
    }
    // Standard domain requirements for audit backwards-compatibility
    if (domain === 'EXPENSE') {
      return [
        { id: 'REQ-EXP-01', text: 'Income and expense transaction CRUD operations with categories and payment methods', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-EXP-02', text: 'Real-time financial summary calculating total income, total expenses, net balance, and monthly savings', targetFile: 'src/api.js', category: 'FUNCTIONAL' },
        { id: 'REQ-EXP-03', text: 'Monthly category budget management with active threshold alerts when spending approaches or exceeds budget', targetFile: 'src/api.js', category: 'FUNCTIONAL' },
        { id: 'REQ-EXP-04', text: 'Interactive financial charts displaying monthly expense trends and category breakdowns', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-EXP-05', text: 'Search, multi-attribute filtering (date range, category, type), and transaction history export to CSV', targetFile: 'public/index.html', category: 'FUNCTIONAL' },
        { id: 'REQ-EXP-06', text: 'Natural language AI expense parsing with user confirmation modal before transaction creation', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-EXP-07', text: 'PostgreSQL database persistence with versioned relational migrations and strict per-user data isolation', targetFile: 'src/api.js', category: 'DATABASE' },
        { id: 'REQ-EXP-08', text: 'Automated test suite in tests/api.test.js covering authentication, transaction calculations, budgets, and isolation', targetFile: 'tests/api.test.js', category: 'TESTING' }
      ];
    }

    if (domain === 'PLACEMENT') {
      return [
        { id: 'REQ-PLC-01', text: 'Student profile registration and directory with CGPA, branch, and resume URL', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-PLC-02', text: 'Campus recruitment drive catalog with minimum CGPA cutoff and eligible branch criteria', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-PLC-03', text: 'Real-time eligibility verification engine validating student qualifications against company cutoff', targetFile: 'src/api.js', category: 'FUNCTIONAL' },
        { id: 'REQ-PLC-04', text: 'Placement application submission and tracking console', targetFile: 'public/index.html', category: 'FUNCTIONAL' },
        { id: 'REQ-PLC-05', text: 'Multi-stage interview status workflow (Applied, Shortlisted, Technical, HR, Offered, Rejected)', targetFile: 'src/api.js', category: 'FUNCTIONAL' },
        { id: 'REQ-PLC-06', text: 'Departmental and branch-wise placement statistics and performance reporting', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-PLC-07', text: 'Persistent SQLite database storage for students, companies, and placement applications', targetFile: 'src/api.js', category: 'DATABASE' },
        { id: 'REQ-PLC-08', text: 'Automated test suite in tests/api.test.js covering registration, eligibility, applications, and branch reports', targetFile: 'tests/api.test.js', category: 'TESTING' }
      ];
    }

    if (domain === 'LIBRARY') {
      return [
        { id: 'REQ-LIB-01', text: 'Comprehensive book catalog with title, author, category, total copies, and available stock', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-LIB-02', text: 'Instant ISBN search and keyword filtering engine across catalog titles and authors', targetFile: 'public/index.html', category: 'FUNCTIONAL' },
        { id: 'REQ-LIB-03', text: 'Member registration and directory with unique library member codes', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-LIB-04', text: 'Book circulation and issuance tracking with automated due date calculation', targetFile: 'public/index.html', category: 'FUNCTIONAL' },
        { id: 'REQ-LIB-05', text: 'Book return processing and real-time overdue fine computation ($1.50/day past due)', targetFile: 'src/api.js', category: 'FUNCTIONAL' },
        { id: 'REQ-LIB-06', text: 'Real-time inventory tracking ensuring available stock decrements on borrow and increments on return', targetFile: 'src/api.js', category: 'DATABASE' },
        { id: 'REQ-LIB-07', text: 'Active borrowing records ledger with member and book details', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-LIB-08', text: 'Automated test suite in tests/api.test.js validating search, borrowing, returns, and fine calculation', targetFile: 'tests/api.test.js', category: 'TESTING' }
      ];
    }

    if (domain === 'HEALTHCARE') {
      return [
        { id: 'REQ-HC-01', text: 'Patient admission registry and directory with vitals and medical history', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-HC-02', text: 'Doctor consultation scheduler and specialty department directory', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-HC-03', text: 'Prescription and medication dosage tracking engine', targetFile: 'src/api.js', category: 'FUNCTIONAL' },
        { id: 'REQ-HC-04', text: 'Electronic health record persistence with SQLite database storage', targetFile: 'src/api.js', category: 'DATABASE' },
        { id: 'REQ-HC-05', text: 'Automated health analytics and patient vital sign telemetry monitoring', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-HC-06', text: 'Automated test suite in tests/api.test.js validating patient admissions and appointments', targetFile: 'tests/api.test.js', category: 'TESTING' }
      ];
    }

    if (domain === 'AUTH') {
      return [
        { id: 'REQ-AUTH-01', text: 'Dedicated Login Form with Email and Password input fields', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-AUTH-02', text: 'Dedicated Signup / Registration Form with Name, Email, Password, and Confirm Password fields', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-AUTH-03', text: 'Interactive Mode Navigation Switch between Login and Signup modes without page reload', targetFile: 'public/index.html', category: 'UI/UX' },
        { id: 'REQ-AUTH-04', text: 'Client-side Validation: Reject empty fields and malformed email addresses with visible alerts', targetFile: 'public/index.html', category: 'FUNCTIONAL' },
        { id: 'REQ-AUTH-05', text: 'Password Security Rules: Enforce minimum 8-character password length and confirm matching passwords', targetFile: 'public/index.html', category: 'SECURITY' },
        { id: 'REQ-AUTH-06', text: 'Password Visibility Toggle button allowing users to reveal/hide entered password', targetFile: 'public/index.html', category: 'UI/UX' },
        { id: 'REQ-AUTH-07', text: 'Visual Loading Spinner & Error Feedback Banner for submission and rejected authentication', targetFile: 'public/index.html', category: 'UI/UX' },
        { id: 'REQ-AUTH-08', text: 'Backend Authentication API with registration, scrypt password hashing, and session generation', targetFile: 'src/api.js', category: 'API' },
        { id: 'REQ-AUTH-09', text: 'Post-Login Destination State: Show authenticated user profile with sign-out capability', targetFile: 'public/index.html', category: 'FUNCTIONAL' },
        { id: 'REQ-AUTH-10', text: 'Responsive Layout: Optimized for Desktop (100%), Tablet (768px), and Mobile (375px) viewports', targetFile: 'public/style.css', category: 'NON_FUNCTIONAL' }
      ];
    }

    if (domain === 'ECOMMERCE') {
      return [
        { id: 'REQ-ECOM-01', text: 'Interactive Shopping Cart drawer or page displaying selected product items', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-ECOM-02', text: 'Quantity Modification: increment (+), decrement (-), and item deletion controls', targetFile: 'public/index.html', category: 'FUNCTIONAL' },
        { id: 'REQ-ECOM-03', text: 'Live Financial Computation: subtotal, estimated tax (8%), and grand total calculations', targetFile: 'public/index.html', category: 'FUNCTIONAL' },
        { id: 'REQ-ECOM-04', text: 'Checkout Funnel Form collecting shipping address and mock payment information', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-ECOM-05', text: 'Order Confirmation Modal displaying unique order tracking ID and status', targetFile: 'public/index.html', category: 'UI/UX' },
        { id: 'REQ-ECOM-06', text: 'Backend Orders API processing transactions with atomic inventory checks', targetFile: 'src/api.js', category: 'API' }
      ];
    }

    if (domain === 'CHAT') {
      return [
        { id: 'REQ-CHAT-01', text: 'Channel Navigation bar displaying available communication channels', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-CHAT-02', text: 'Message Stream Feed displaying chat history, usernames, and timestamps', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-CHAT-03', text: 'Message Composition Input box with send button and keyboard Enter submission', targetFile: 'public/index.html', category: 'UI/UX' },
        { id: 'REQ-CHAT-04', text: 'Backend Messaging API persisting conversation history in SQLite database', targetFile: 'src/api.js', category: 'API' }
      ];
    }

    if (domain === 'ANALYTICS') {
      return [
        { id: 'REQ-ANA-01', text: 'KPI Metric summary cards displaying operational indicators and totals', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-ANA-02', text: 'Interactive charting canvas displaying time-series metric trends', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-ANA-03', text: 'Time-range filtering controls (24h, 7d, 30d) for dynamic telemetry', targetFile: 'public/index.html', category: 'FUNCTIONAL' },
        { id: 'REQ-ANA-04', text: 'Telemetry ingest API endpoint aggregating events in real time', targetFile: 'src/api.js', category: 'API' }
      ];
    }

    if (domain === 'WORKFLOW') {
      return [
        { id: 'REQ-WF-01', text: 'Multi-column Kanban board displaying stage columns (Backlog, In Progress, Review, Done)', targetFile: 'public/index.html', category: 'UI' },
        { id: 'REQ-WF-02', text: 'Task creation form with title, priority badge, and description fields', targetFile: 'public/index.html', category: 'FUNCTIONAL' },
        { id: 'REQ-WF-03', text: 'Interactive card stage navigation buttons and drag-and-drop transitions', targetFile: 'public/index.html', category: 'UI/UX' },
        { id: 'REQ-WF-04', text: 'REST API endpoints for task creation, stage updates, and deletion', targetFile: 'src/api.js', category: 'API' }
      ];
    }

    // Dynamic semantic extraction for CUSTOM prompts
    return RequirementParser._extractDynamicCustomRequirements(text);
  }

  /**
   * Deconstruct custom natural language prompt into granular testable requirements
   */
  static _extractDynamicCustomRequirements(text) {
    const requirements = [];
    let counter = 1;

    const addReq = (desc, targetFile, category = 'FUNCTIONAL') => {
      requirements.push({
        id: `REQ-${String(counter++).padStart(3, '0')}`,
        text: desc.trim(),
        targetFile,
        category,
        acceptanceCriteria: `AC-${counter - 1}: ${desc.trim()} is fully implemented and tested.`
      });
    };

    // 1. Primary Objective
    const firstSentence = text.split(/[.\n]/)[0].trim();
    addReq(`Implement primary application interface for: "${firstSentence.slice(0, 60)}"`, 'public/index.html', 'UI');

    // 2. Identify explicit features by analyzing keywords & clauses
    const clauses = text
      .split(/[,;\n•\-\*]/)
      .map(c => c.trim())
      .filter(c => c.length > 5 && !c.match(/^(and|or|with|the|in|for)\s*$/i));

    const clauseKeywords = [
      { pattern: /auth|login|signup|user|account|profile/i, category: 'SECURITY', target: 'public/index.html', text: 'User identity authentication and session management' },
      { pattern: /search|filter|sort|query/i, category: 'FUNCTIONAL', target: 'public/index.html', text: 'Interactive search and filtering controls' },
      { pattern: /form|input|submit|create|add/i, category: 'UI', target: 'public/index.html', text: 'Form input handling with validation alerts' },
      { pattern: /database|store|persist|save|record/i, category: 'DATABASE', target: 'src/api.js', text: 'Data persistence layer with SQLite storage' },
      { pattern: /api|endpoint|route|service|backend/i, category: 'API', target: 'src/api.js', text: 'RESTful API controller endpoints' },
      { pattern: /notification|alert|message|toast/i, category: 'UI/UX', target: 'public/index.html', text: 'Visual alert notifications and status feedback' },
      { pattern: /dashboard|chart|metric|table|view/i, category: 'UI', target: 'public/index.html', text: 'Responsive dashboard visualization' }
    ];

    const addedTexts = new Set();
    for (const clause of clauses) {
      for (const kw of clauseKeywords) {
        if (kw.pattern.test(clause) && !addedTexts.has(kw.text)) {
          addedTexts.add(kw.text);
          addReq(kw.text, kw.target, kw.category);
          break;
        }
      }

      // Also directly capture specific feature clauses as explicit requirements
      const cleanClause = clause.replace(/^(and|or|with|include|including|featuring|featuring\s+a)\s+/i, '').trim();
      const clauseKey = cleanClause.toLowerCase();
      if (cleanClause.length >= 8 && cleanClause.length <= 90 && !addedTexts.has(clauseKey)) {
        let target = 'src/api.js';
        let cat = 'FUNCTIONAL';
        if (/\b(ui|interface|dashboard|report|view|screen|form|table|search)\b/i.test(cleanClause)) {
          target = 'public/index.html';
          cat = 'UI';
        } else if (/\b(auth|login|security|rbac|permission)\b/i.test(cleanClause)) {
          target = 'src/api.js';
          cat = 'SECURITY';
        } else if (/\b(storage|database|sqlite|persist|records?)\b/i.test(cleanClause)) {
          target = 'src/api.js';
          cat = 'DATABASE';
        }
        addedTexts.add(clauseKey);
        addReq(cleanClause, target, cat);
      }
    }

    // 3. Ensure essential baseline requirements are guaranteed
    if (!addedTexts.has('RESTful API controller endpoints') && !requirements.some(r => r.category === 'API')) {
      addReq('RESTful API controller endpoints and business logic', 'src/api.js', 'API');
    }
    if (!addedTexts.has('Data persistence layer with SQLite storage') && !requirements.some(r => r.category === 'DATABASE')) {
      addReq('Data persistence and state storage layer', 'src/api.js', 'DATABASE');
    }

    addReq('Responsive layout optimized for desktop, tablet, and mobile', 'public/style.css', 'NON_FUNCTIONAL');
    addReq('Automated test suite verifying critical path execution in tests/api.test.js', 'tests/api.test.js', 'TESTING');

    return requirements;
  }

  static extractExclusions(text, domain) {
    if (domain === 'AUTH') {
      return [
        'DO NOT create or display a shopping cart drawer or product catalog as the primary view.',
        'DO NOT implement checkout or Stripe payment processing forms.',
        'DO NOT replace authentication with an unrelated blog, chat, or ecommerce store.',
        'DO NOT destructively delete unrelated existing files or reset repository history.',
        'DO NOT fabricate fake authentication states without real input handling and validation.'
      ];
    }

    if (domain === 'ECOMMERCE') {
      return [
        'DO NOT replace the shopping cart with an unrelated social chat application.',
        'DO NOT delete existing repository files outside the ecommerce feature scope.',
        'DO NOT mock order completion without calculating actual item totals and tax.'
      ];
    }

    return [
      'DO NOT substitute a generic placeholder or unrelated feature for the requested application.',
      'DO NOT build rogue shopping cart or payment flows unless explicitly requested in the prompt.',
      'DO NOT destructively delete existing project assets, tests, or documentation.'
    ];
  }

  static extractAcceptanceCriteria(text, domain, requirements) {
    if (domain === 'AUTH') {
      return [
        'AC-1: The application renders a visible Login heading and Form with Email and Password inputs.',
        'AC-2: A Signup toggle button is present and switches the viewport to the Registration Form.',
        'AC-3: Submitting an empty login form immediately displays a validation error message.',
        'AC-4: Entering an invalid email format (e.g. "invalidemail") is rejected with feedback.',
        'AC-5: Password visibility toggle button changes password input type from password to text.',
        'AC-6: Valid credentials trigger authentication and display the Authenticated Dashboard.',
        'AC-7: The rendered page does NOT contain a shopping cart or checkout as the active view.',
        'AC-8: All automated Node.js unit tests pass with exit code 0.'
      ];
    }

    return requirements.map((r, i) => `AC-${i + 1}: ${r.text} is fully functional, styled, and verified.`);
  }

  static extractExpectedRoutes(domain, text) {
    if (domain === 'PLACEMENT') {
      return ['/', '/students', '/companies', '/applications', '/interviews', '/reports'];
    }
    if (domain === 'LIBRARY') {
      return ['/', '/catalog', '/members', '/borrowings', '/returns'];
    }
    if (domain === 'HEALTHCARE') {
      return ['/', '/patients', '/appointments', '/prescriptions'];
    }
    if (domain === 'AUTH') {
      return ['/', '/login', '/signup'];
    }
    if (domain === 'ECOMMERCE') {
      return ['/', '/cart', '/checkout', '/orders'];
    }
    return ['/'];
  }

  static extractAllowedFiles(domain, projectContext) {
    return [
      'public/index.html',
      'public/style.css',
      'public/app.js',
      'src/api.js',
      'tests/api.test.js',
      'package.json',
      'docs/PRD.md',
      'docs/ADR-001.md',
      'docs/REQUIREMENT_COVERAGE.md'
    ];
  }
}
