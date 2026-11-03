import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { Orchestrator } from '../src/core/orchestrator.js';
import { StorageEngine } from '../src/storage/db.js';
import { SandboxExecutor } from '../src/sandbox/sandboxExecutor.js';
import { SoftwareSynthesizer } from '../src/core/softwareSynthesizer.js';
import { RequirementParser } from '../src/audit/requirementParser.js';

describe('Prompt-Driven Software Generation & Pipeline Disconnect Fix Suite', () => {
  const testDbDir = path.resolve('tmp/test_prompt_driven');
  const testDbPath = path.join(testDbDir, 'test.db');
  const testWorkspacesDir = path.join(testDbDir, 'workspaces');

  let orchestrator;
  let storage;
  let sandbox;
  let synthesizer;
  let lastProjIdA;
  let lastProjIdB;

  before(() => {
    fs.mkdirSync(testWorkspacesDir, { recursive: true });
    storage = new StorageEngine(testDbPath);
    sandbox = new SandboxExecutor(testWorkspacesDir, storage, { defaultTimeoutMs: 15000 });
    synthesizer = new SoftwareSynthesizer();
    orchestrator = new Orchestrator({
      storage,
      sandbox,
      dbPath: testDbPath,
      workspacesDir: testWorkspacesDir
    });
  });

  after(() => {
    try {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    } catch (_) {}
  });

  // TEST A: Student Placement Management System
  test('TEST A: builds genuine Student Placement Management System matching prompt', async () => {
    const promptA = 'Build a Student Placement Management System with student records, company management, job eligibility, placement applications, interview status tracking, branch-wise reports, and persistent SQLite storage.';
    const projIdA = 'proj-placement-' + crypto.randomUUID().slice(0, 6);
    lastProjIdA = projIdA;

    const project = storage.createProject({
      id: projIdA,
      name: 'Student Placement Management System',
      description: promptA,
      budgetTokens: 100000,
      budgetUsd: 10.0
    });

    const result = await orchestrator.buildProjectAutonomous(projIdA, {
      prompt: promptA,
      appType: 'Web Application',
      fastMode: true
    });

    // 1. Pipeline Status & Test Execution Assertions
    assert.equal(result.status, 'READY_FOR_DEPLOYMENT', 'Project should reach READY_FOR_DEPLOYMENT');
    assert.equal(result.testPassed, true, 'Automated sandboxed test assertions must pass (exit 0)');

    // 2. Workspace File Containment Assertions
    const files = sandbox.listFiles(projIdA);
    assert.ok(files.includes('src/api.js'), 'Must contain src/api.js');
    assert.ok(files.includes('tests/api.test.js'), 'Must contain tests/api.test.js');
    assert.ok(files.includes('public/index.html'), 'Must contain public/index.html');
    assert.ok(files.includes('reports/pipeline-diagnostics.json'), 'Must contain reports/pipeline-diagnostics.json');

    // 3. Backend Model & Logic Domain Assertions (MUST NOT BE GENERIC LOGIN OR E-COMMERCE)
    const backendCode = sandbox.readFileSafely(projIdA, 'src/api.js');
    assert.match(backendCode, /students/i, 'Backend must define students table/schema');
    assert.match(backendCode, /companies/i, 'Backend must define companies table/schema');
    assert.match(backendCode, /applications/i, 'Backend must define placement applications schema');
    assert.match(backendCode, /eligib/i, 'Backend must export eligibility checking logic');
    assert.match(backendCode, /appl/i, 'Backend must export placement application logic');
    assert.match(backendCode, /interview|status/i, 'Backend must export interview status tracking');
    assert.match(backendCode, /branch|report/i, 'Backend must export branch report logic');

    // Strict Anti-Generic Guard: MUST NOT be generic headphones or login page
    assert.doesNotMatch(backendCode, /Wireless Headphones/i, 'Must not default to e-commerce headphone store');
    assert.doesNotMatch(backendCode, /revokeSession/i, 'Must not be a generic auth-only gateway');

    // 4. Frontend UI Assertions (MUST HAVE REAL PLACEMENT UI, NOT 3 STATIC CARDS)
    const indexHtml = sandbox.readFileSafely(projIdA, 'public/index.html');
    assert.match(indexHtml, /Student Placement|Placement Portal|PlacementPro/i, 'UI must feature Placement header');
    assert.match(indexHtml, /Student Records|Student Directory|Students/i, 'UI must render Student section');
    assert.match(indexHtml, /Companies|Company Placement/i, 'UI must render Company section');
    assert.match(indexHtml, /Eligibility|Job/i, 'UI must render Eligibility Verification section');
    assert.match(indexHtml, /Interview|Application/i, 'UI must render Applications / Interview Tracker section');
    assert.match(indexHtml, /Branch|Report/i, 'UI must render Branch Reports section');
    assert.doesNotMatch(indexHtml, /Autonomous Core Engine.*Sandboxed Security.*Automated QA Rig/s, 'Must not be the 3 static generic cards layout');

    // 5. Diagnostics Record Assertions
    const diagnostics = orchestrator.getDiagnostics(projIdA);
    assert.ok(diagnostics, 'Diagnostics record must exist');
    assert.equal(diagnostics.projectId, projIdA);
    assert.equal(diagnostics.domain, 'PLACEMENT');
    assert.ok(diagnostics.extractedRequirementCount >= 5, 'Must extract at least 5 requirements');
    assert.equal(diagnostics.testExitCode, 0, 'Test exit code must be 0');
    assert.ok(diagnostics.filesCreated.length >= 4, 'Must have recorded created files');
  });

  // TEST B: Library Inventory Management System
  test('TEST B: builds genuine Library Inventory Management System matching prompt', async () => {
    const promptB = 'Build a Library Inventory Management System with books, authors, ISBN search, borrowing, returns, overdue fines, member records, and persistent SQLite storage.';
    const projIdB = 'proj-library-' + crypto.randomUUID().slice(0, 6);
    lastProjIdB = projIdB;

    const project = storage.createProject({
      id: projIdB,
      name: 'Library Inventory Management System',
      description: promptB,
      budgetTokens: 100000,
      budgetUsd: 10.0
    });

    const result = await orchestrator.buildProjectAutonomous(projIdB, {
      prompt: promptB,
      appType: 'Web Application',
      fastMode: true
    });

    // 1. Pipeline Status & Test Execution Assertions
    assert.equal(result.status, 'READY_FOR_DEPLOYMENT', 'Project should reach READY_FOR_DEPLOYMENT');
    assert.equal(result.testPassed, true, 'Automated sandboxed test assertions must pass (exit 0)');

    // 2. Workspace File Containment Assertions
    const files = sandbox.listFiles(projIdB);
    assert.ok(files.includes('src/api.js'), 'Must contain src/api.js');
    assert.ok(files.includes('tests/api.test.js'), 'Must contain tests/api.test.js');
    assert.ok(files.includes('public/index.html'), 'Must contain public/index.html');
    assert.ok(files.includes('reports/pipeline-diagnostics.json'), 'Must contain reports/pipeline-diagnostics.json');

    // 3. Backend Model & Logic Domain Assertions (MUST NOT BE GENERIC LOGIN OR PLACEMENT)
    const backendCode = sandbox.readFileSafely(projIdB, 'src/api.js');
    assert.match(backendCode, /books/i, 'Backend must define books table/schema');
    assert.match(backendCode, /members/i, 'Backend must define members table/schema');
    assert.match(backendCode, /borrowings|transactions|borrow/i, 'Backend must define borrowings or transactions schema');
    assert.match(backendCode, /isbn/i, 'Backend must support ISBN lookup or search');
    assert.match(backendCode, /borrow/i, 'Backend must export book borrowing logic');
    assert.match(backendCode, /return/i, 'Backend must export book return logic');
    assert.match(backendCode, /fine/i, 'Backend must export overdue fine calculation logic');

    // Strict Anti-Generic Guard: MUST NOT be placement or generic login
    assert.doesNotMatch(backendCode, /placement_applications|interview_status/i, 'Must not contain placement tables');
    assert.doesNotMatch(backendCode, /revokeSession/i, 'Must not be a generic auth-only gateway');
    assert.doesNotMatch(backendCode, /Wireless Headphones/i, 'Must not default to e-commerce headphone store');

    // 4. Frontend UI Assertions (MUST HAVE REAL LIBRARY UI)
    const indexHtml = sandbox.readFileSafely(projIdB, 'public/index.html');
    assert.match(indexHtml, /Library Inventory/i, 'UI must feature Library Inventory header');
    assert.match(indexHtml, /ISBN Search|Book Catalog|Books/i, 'UI must render Book Catalog & ISBN search');
    assert.match(indexHtml, /Members|Library Patrons/i, 'UI must render Members section');
    assert.match(indexHtml, /Circulation|Borrow|Issue Book/i, 'UI must render Circulation Desk section');
    assert.match(indexHtml, /Overdue Fines|Fines|Return/i, 'UI must render Returns & Overdue Fines section');

    // 5. Diagnostics Record Assertions
    const diagnostics = orchestrator.getDiagnostics(projIdB);
    assert.ok(diagnostics, 'Diagnostics record must exist');
    assert.equal(diagnostics.projectId, projIdB);
    assert.equal(diagnostics.domain, 'LIBRARY');
    assert.ok(diagnostics.extractedRequirementCount >= 5, 'Must extract at least 5 requirements');
    assert.equal(diagnostics.testExitCode, 0, 'Test exit code must be 0');
  });

  // TEST C: Differentiation & Non-Collision Verification
  test('TEST C: Project A and Project B produce genuinely different models, routes, and schemas', async () => {
    assert.ok(lastProjIdA, 'Test A project ID must exist');
    assert.ok(lastProjIdB, 'Test B project ID must exist');

    const codeA = sandbox.readFileSafely(lastProjIdA, 'src/api.js');
    const codeB = sandbox.readFileSafely(lastProjIdB, 'src/api.js');

    // Model differentiation
    assert.match(codeA, /students/i, 'Placement must contain students');
    assert.match(codeA, /companies/i, 'Placement must contain companies');
    assert.doesNotMatch(codeA, /books/i, 'Placement must not contain books');

    assert.match(codeB, /books/i, 'Library must contain books');
    assert.match(codeB, /borrowings|transactions|borrow/i, 'Library must contain borrowings or transactions');
    assert.doesNotMatch(codeB, /students/i, 'Library must not contain students');

    // Schema and logic non-collision
    assert.notEqual(codeA, codeB, 'Generated backend code for Placement and Library must be distinct');

    // UI differentiation
    const htmlA = sandbox.readFileSafely(lastProjIdA, 'public/index.html');
    const htmlB = sandbox.readFileSafely(lastProjIdB, 'public/index.html');
    assert.match(htmlA, /Placement/i);
    assert.doesNotMatch(htmlA, /ISBN Search/i);

    assert.match(htmlB, /Library Inventory/i);
    assert.doesNotMatch(htmlB, /Campus Recruitment/i);

    // Verify domain detector does not hijack library or placement
    assert.equal(synthesizer.detectDomain('Student Placement Management System', 'placement drives'), 'PLACEMENT');
    assert.equal(synthesizer.detectDomain('Library Inventory Management System', 'books and isbn fines'), 'LIBRARY');
    assert.notEqual(synthesizer.detectDomain('Student Placement System'), synthesizer.detectDomain('Library Inventory System'));
  });

  // TEST D: Diagnostics API returns stored diagnostics record
  test('TEST D: getDiagnostics returns execution diagnostics with prompt integrity', async () => {
    const projects = storage.listProjects();
    const placementProj = projects.find(p => p.id.startsWith('proj-placement'));
    assert.ok(placementProj, 'Placement project should be in database');

    const diag = orchestrator.getDiagnostics(placementProj.id);
    assert.ok(diag, 'Diagnostics record should be available');
    assert.equal(diag.projectId, placementProj.id);
    assert.ok(diag.promptHash, 'Must contain promptHash');
    assert.ok(diag.promptLength > 0, 'Must contain promptLength');
    assert.ok(Array.isArray(diag.requirementIds), 'Must contain requirementIds array');
    assert.ok(diag.pipelineStages['STAGE_INTAKE'], 'Must record STAGE_INTAKE');
    assert.ok(diag.pipelineStages['STAGE_ARCHITECTURE'], 'Must record STAGE_ARCHITECTURE');
    assert.ok(diag.pipelineStages['STAGE_BACKEND'], 'Must record STAGE_BACKEND');
    assert.ok(diag.pipelineStages['STAGE_FRONTEND'], 'Must record STAGE_FRONTEND');
    assert.ok(diag.pipelineStages['STAGE_QA'], 'Must record STAGE_QA');
    assert.ok(diag.pipelineStages['STAGE_DEPLOY_REQUEST'], 'Must record STAGE_DEPLOY_REQUEST');
  });
});
