import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StorageEngine } from '../src/storage/db.js';
import { SandboxExecutor } from '../src/sandbox/sandboxExecutor.js';
import { BudgetManager } from '../src/budget/budgetManager.js';
import { ApprovalManager } from '../src/approval/approvalManager.js';
import { EventBus } from '../src/core/eventBus.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { GeminiClient } from '../src/llm/geminiClient.js';

describe('Phase 8 — Real AI Generation Evaluation Suite (Live Gemini LLM)', { timeout: 240000 }, () => {
  let tmpDir;
  let dbPath;
  let workspacesDir;
  let storage;
  let sandbox;
  let budgetManager;
  let approvalManager;
  let eventBus;
  let llm;
  let orchestrator;

  const generatedResults = {};

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-audit-ai-'));
    dbPath = path.join(tmpDir, 'audit_eval.db');
    workspacesDir = path.join(tmpDir, 'workspaces');
    fs.mkdirSync(workspacesDir, { recursive: true });

    storage = new StorageEngine(dbPath);
    sandbox = new SandboxExecutor(workspacesDir, storage);
    budgetManager = new BudgetManager(storage, { costPer1kTokens: 0.002 });
    approvalManager = new ApprovalManager(storage);
    eventBus = new EventBus(storage);

    llm = new GeminiClient({
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
      fallbackModel: 'gemini-3.5-flash',
      simulationMode: false
    });

    orchestrator = new Orchestrator({
      storage,
      sandbox,
      budgetManager,
      approvalManager,
      eventBus,
      llm
    });
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  test('1. Application 1: Student Placement Management System (Real AI Generation)', async () => {
    const projId = 'proj-placement-eval';
    const title = 'Student Placement Management System';
    const description = 'Campus recruitment platform with student profiles, drive scheduling, eligibility checks, application tracking, and interview pipelines.';

    const project = storage.createProject({
      id: projId,
      name: title,
      description,
      budgetTokens: 150000,
      budgetUsd: 20.0
    });

    const result = await orchestrator.buildProjectAutonomous(projId, {
      title,
      description,
      appType: 'Campus Recruitment Portal',
      fastMode: true
    });

    generatedResults.placement = { result, project };

    // 1. Verify build outcome
    assert.strictEqual(result.status, 'READY_FOR_DEPLOYMENT');
    assert.strictEqual(result.testPassed, true);

    // 2. Inspect diagnostics to verify original prompt reached real model
    const diag = orchestrator.getDiagnostics(projId);
    assert.ok(diag, 'Diagnostics record must exist');
    assert.ok(diag.selectedStrategy === 'LIVE_GEMINI_SYNTHESIS' || diag.selectedStrategy === 'DYNAMIC_REQUIREMENT_SYNTHESIS');
    assert.strictEqual(diag.domain, 'PLACEMENT');
    assert.ok(diag.extractedRequirementCount >= 3, 'Must have extracted multiple requirements');

    // 3. Inspect generated files
    const files = sandbox.listFiles(projId);
    assert.ok(files.includes('src/api.js'));
    assert.ok(files.includes('tests/api.test.js'));
    assert.ok(files.includes('public/index.html'));
    assert.ok(files.includes('docs/PRD.md'));
    assert.ok(files.includes('docs/ADR-001.md'));

    // 4. Verify domain-specific business logic & data models in src/api.js
    const apiCode = sandbox.readFileSafely(projId, 'src/api.js');
    assert.ok(/student/i.test(apiCode), 'API must contain student domain concepts');
    assert.ok(/placement|drive|company|recruit/i.test(apiCode), 'API must contain placement/drive concepts');
    assert.ok(/eligib|cgpa|branch|status/i.test(apiCode), 'API must contain eligibility/status concepts');

    // 5. Verify sandboxed tests execution
    const testRun = await sandbox.executeCommand(projId, 'node --test', { timeoutMs: 15000 });
    assert.strictEqual(testRun.exitCode, 0, `Sandbox node --test must pass: ${testRun.stderr || testRun.stdout}`);

    // 6. Verify coverage report
    const coverage = JSON.parse(sandbox.readFileSafely(projId, 'reports/requirement-coverage.json'));
    assert.ok(coverage.summary.total > 0, 'Total requirements must be > 0');
    assert.ok(coverage.summary.coveragePercentage > 0, 'Coverage percentage must be > 0');
  });

  test('2. Application 2: Library Inventory Management System (Real AI Generation)', async () => {
    const projId = 'proj-library-eval';
    const title = 'Library Inventory Management System';
    const description = 'Book catalog management with ISBN lookup, borrower membership records, loan checkouts and returns, and overdue fine calculations.';

    const project = storage.createProject({
      id: projId,
      name: title,
      description,
      budgetTokens: 150000,
      budgetUsd: 20.0
    });

    const result = await orchestrator.buildProjectAutonomous(projId, {
      title,
      description,
      appType: 'Library Inventory System',
      fastMode: true
    });

    generatedResults.library = { result, project };

    // 1. Verify build outcome
    assert.strictEqual(result.status, 'READY_FOR_DEPLOYMENT');
    assert.strictEqual(result.testPassed, true);

    // 2. Inspect diagnostics
    const diag = orchestrator.getDiagnostics(projId);
    assert.ok(diag);
    assert.ok(diag.selectedStrategy === 'LIVE_GEMINI_SYNTHESIS' || diag.selectedStrategy === 'DYNAMIC_REQUIREMENT_SYNTHESIS');
    assert.strictEqual(diag.domain, 'LIBRARY');

    // 3. Inspect generated files
    const files = sandbox.listFiles(projId);
    assert.ok(files.includes('src/api.js'));
    assert.ok(files.includes('tests/api.test.js'));

    // 4. Verify domain-specific business logic in src/api.js
    const apiCode = sandbox.readFileSafely(projId, 'src/api.js');
    assert.ok(/book|title|isbn|catalog/i.test(apiCode), 'API must contain book catalog logic');
    assert.ok(/loan|borrow|checkout|return/i.test(apiCode), 'API must contain loan checkout logic');
    assert.ok(/fine|overdue|member/i.test(apiCode), 'API must contain fine/member logic');

    // 5. Verify sandboxed tests execution
    const testRun = await sandbox.executeCommand(projId, 'node --test', { timeoutMs: 15000 });
    assert.strictEqual(testRun.exitCode, 0, `Sandbox node --test must pass: ${testRun.stderr || testRun.stdout}`);
  });

  test('3. Application 3: E-commerce Platform with Catalog, Cart, Orders & Inventory (Real AI Generation)', async () => {
    const projId = 'proj-ecommerce-eval';
    const title = 'E-commerce Application';
    const description = 'Online store platform with product catalog, category filters, shopping cart, checkout order placement, and admin inventory management.';

    const project = storage.createProject({
      id: projId,
      name: title,
      description,
      budgetTokens: 150000,
      budgetUsd: 20.0
    });

    const result = await orchestrator.buildProjectAutonomous(projId, {
      title,
      description,
      appType: 'E-commerce Web App',
      fastMode: true
    });

    generatedResults.ecommerce = { result, project };

    // 1. Verify build outcome
    assert.strictEqual(result.status, 'READY_FOR_DEPLOYMENT');
    assert.strictEqual(result.testPassed, true);

    // 2. Inspect diagnostics
    const diag = orchestrator.getDiagnostics(projId);
    assert.ok(diag);
    assert.ok(diag.selectedStrategy === 'LIVE_GEMINI_SYNTHESIS' || diag.selectedStrategy === 'DYNAMIC_REQUIREMENT_SYNTHESIS');
    assert.strictEqual(diag.domain, 'ECOMMERCE');

    // 3. Inspect generated files
    const files = sandbox.listFiles(projId);
    assert.ok(files.includes('src/api.js'));
    assert.ok(files.includes('tests/api.test.js'));

    // 4. Verify domain-specific business logic in src/api.js
    const apiCode = sandbox.readFileSafely(projId, 'src/api.js');
    assert.ok(/product|item|price/i.test(apiCode), 'API must contain product concepts');
    assert.ok(/cart|order|checkout/i.test(apiCode), 'API must contain cart/order concepts');

    // 5. Verify sandboxed tests execution
    const testRun = await sandbox.executeCommand(projId, 'node --test', { timeoutMs: 15000 });
    assert.strictEqual(testRun.exitCode, 0, `Sandbox node --test must pass: ${testRun.stderr || testRun.stdout}`);
  });

  test('4. Cross-Project Uniqueness & Divergence: Proving No Generic Template Silently Replaces Generation', () => {
    const apiPlacement = sandbox.readFileSafely('proj-placement-eval', 'src/api.js');
    const apiLibrary = sandbox.readFileSafely('proj-library-eval', 'src/api.js');
    const apiEcommerce = sandbox.readFileSafely('proj-ecommerce-eval', 'src/api.js');

    // 1. Ensure files are non-identical
    assert.notStrictEqual(apiPlacement, apiLibrary, 'Placement and Library APIs must have different code');
    assert.notStrictEqual(apiPlacement, apiEcommerce, 'Placement and E-commerce APIs must have different code');
    assert.notStrictEqual(apiLibrary, apiEcommerce, 'Library and E-commerce APIs must have different code');

    // 2. Ensure domain keywords are partitioned appropriately
    assert.ok(apiPlacement.includes('student') || apiPlacement.includes('candidate'));
    assert.ok(!apiPlacement.includes('isbn'));

    assert.ok(apiLibrary.includes('book') || apiLibrary.includes('borrower'));
    assert.ok(!apiLibrary.includes('student_drives') && !apiLibrary.includes('shopping_cart'));

    assert.ok(apiEcommerce.includes('cart') || apiEcommerce.includes('product'));
    assert.ok(!apiEcommerce.includes('isbn'));

    // 3. Compare PRD and ADR files
    const prdPlacement = sandbox.readFileSafely('proj-placement-eval', 'docs/PRD.md');
    const prdLibrary = sandbox.readFileSafely('proj-library-eval', 'docs/PRD.md');
    assert.notStrictEqual(prdPlacement, prdLibrary);
  });

  test('5. Honest Error Reporting & Failure Handling in Generated Code', async () => {
    // Execute a test command in the placement workspace with a deliberate error
    const brokenRun = await sandbox.executeCommand('proj-placement-eval', 'node -e "process.exit(1)"');
    assert.strictEqual(brokenRun.exitCode, 1, 'Non-zero exit code must be honestly captured');
    assert.strictEqual(brokenRun.timedOut, false);

    // Verify sandbox isolation: attempts to access parent directories fail safely
    assert.throws(() => {
      sandbox.readFileSafely('proj-placement-eval', '../../package.json');
    }, /escapes workspace jail|Invalid relative path|Path traversal attempt detected/);
  });
});
