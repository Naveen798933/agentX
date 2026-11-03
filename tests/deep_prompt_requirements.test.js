import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { RequirementParser } from '../src/audit/requirementParser.js';
import { CoverageTracker, RequirementStatus } from '../src/audit/coverageTracker.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { StorageEngine } from '../src/storage/db.js';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { VirtualHouseServer } from '../src/server/server.js';

describe('Master Engineering Requirements & Deep Prompt Specification', () => {
  const testDb = path.resolve('data/test_deep_prompt.db');
  const testWorkspaces = path.resolve('data/test_deep_workspaces');
  let storage;
  let orchestrator;

  before(() => {
    fs.mkdirSync(testWorkspaces, { recursive: true });
    storage = new StorageEngine(testDb);
    orchestrator = new Orchestrator({
      dbPath: testDb,
      workspacesDir: testWorkspaces,
      storage
    });
  });

  after(() => {
    try { fs.rmSync(testDb, { force: true }); } catch (_) {}
    try { fs.rmSync(testDb + '-wal', { force: true }); } catch (_) {}
    try { fs.rmSync(testDb + '-shm', { force: true }); } catch (_) {}
    try { fs.rmSync(testWorkspaces, { recursive: true, force: true }); } catch (_) {}
  });

  test('Acceptance 9 & 8: Build a Project UI input is empty on initial render with placeholder', () => {
    const html = fs.readFileSync(path.resolve('public/index.html'), 'utf8');

    // Quick build title input must have empty initial value
    assert.match(html, /id="quick-build-title-input"[^>]*value=""/);
    assert.doesNotMatch(html, /id="quick-build-title-input"[^>]*value="Smart E-Commerce Platform"/);

    // Modal title input must have empty initial value
    assert.match(html, /id="input-build-title"[^>]*value=""/);
    assert.doesNotMatch(html, /id="input-build-title"[^>]*value="Smart E-Commerce Platform"/);

    // Textarea must be empty inside
    assert.match(html, /<textarea[^>]*id="input-build-desc"[^>]*><\/textarea>/);
    assert.doesNotMatch(html, /<textarea[^>]*id="input-build-desc"[^>]*>Build an e-commerce website/);

    // Placeholder must guide user
    assert.match(html, /placeholder="Describe the project you want to build/);

    // Validation alert banner must exist
    assert.match(html, /id="build-validation-alert"/);
  });

  test('Acceptance 11: Empty prompt submission is validated and rejected', async () => {
    const server = new VirtualHouseServer({
      port: 0,
      storage,
      orchestrator
    });

    await new Promise(resolve => server.server.listen(0, resolve));
    const port = server.server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects/autonomous`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '', description: '' })
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /Project prompt is required/i);
    } finally {
      await server.stop();
    }
  });

  test('Acceptance 3 & 10: Custom prompt is submitted unchanged and reaches requirement analysis', async () => {
    const customPrompt = 'Hospital Patient Management: Admit patient, record pulse and temperature, alert on fever, discharge patient with SQLite persistence';
    
    const parsed = RequirementParser.parse(customPrompt, { projectId: 'test-proj-01' });

    assert.equal(parsed.instruction, customPrompt);
    assert.ok(parsed.explicitRequirements.length >= 3);
    
    // Check that custom requirements are generated dynamically with REQ IDs
    const reqIds = parsed.explicitRequirements.map(r => r.id);
    assert.ok(reqIds.some(id => /^REQ-\d{3}$/.test(id) || /^REQ-[A-Z]+-\d{2}$/.test(id)));

    // Traceability matrix exists
    assert.equal(parsed.traceabilityMatrix.length, parsed.explicitRequirements.length);
  });

  test('Acceptance 4: Requirement extraction preserves requested features with dynamic REQ IDs', () => {
    const prompt = 'IoT Sensor Fleet Monitor: Ingest temperature metrics, stream real-time chart, alert threshold notifications, export audit logs';
    const spec = RequirementParser.parse(prompt);

    assert.ok(spec.explicitRequirements.length >= 4);
    assert.ok(spec.acceptanceCriteria.length >= 4);

    // Verify each requirement has target file and acceptance criteria
    for (const req of spec.explicitRequirements) {
      assert.ok(req.id);
      assert.ok(req.text);
      assert.ok(req.targetFile);
      assert.ok(req.acceptanceCriteria);
    }
  });

  test('Acceptance 6 & 7: Requirement coverage tracks full lifecycle and verification evidence', () => {
    const spec = RequirementParser.parse('Smart Inventory Management: Scan barcode, update stock, alert low stock');
    const tracker = new CoverageTracker(spec);

    const initial = tracker.generateReport();
    assert.equal(initial.summary.verified, 0);
    assert.equal(initial.summary.pending, initial.summary.total);

    // Simulate lifecycle
    const firstReq = initial.requirements[0];
    tracker.markInProgress(firstReq.id, 'PM');
    assert.equal(tracker.get(firstReq.id).status, RequirementStatus.IN_PROGRESS);

    tracker.markImplemented(firstReq.id, 'src/api.js');
    assert.equal(tracker.get(firstReq.id).status, RequirementStatus.IMPLEMENTED);

    tracker.markTesting(firstReq.id, 'tests/api.test.js');
    assert.equal(tracker.get(firstReq.id).status, RequirementStatus.TESTING);

    tracker.markVerified(firstReq.id, 'Automated sandboxed test passed');
    assert.equal(tracker.get(firstReq.id).status, RequirementStatus.VERIFIED);
  });

  test('Acceptance 5 & 8: Orchestrator executes development loop, runs node:test in sandbox, and generates coverage', async () => {
    const projectId = 'proj-e2e-req-test';
    storage.createProject({
      id: projectId,
      name: 'Crypto Asset Portfolio Tracker',
      description: 'Track cryptocurrency holdings, fetch prices, compute total portfolio balance, with SQLite storage.',
      budgetTokens: 50000,
      budgetUsd: 10
    });

    const result = await orchestrator.buildProjectAutonomous(projectId, {
      appType: 'Analytics & Telemetry',
      fastMode: true
    });

    assert.equal(result.status, 'READY_FOR_DEPLOYMENT');
    assert.equal(result.testPassed, true);
    assert.ok(result.coverage);
    assert.equal(result.coverage.summary.isFullyVerified, true);
    assert.equal(result.coverage.summary.coveragePercentage, 100);

    // Verify persisted files
    const coverageJson = orchestrator.sandbox.readFileSafely(projectId, 'reports/requirement-coverage.json');
    assert.ok(coverageJson);
    const parsedCoverage = JSON.parse(coverageJson);
    assert.equal(parsedCoverage.summary.isFullyVerified, true);

    const coverageMd = orchestrator.sandbox.readFileSafely(projectId, 'docs/REQUIREMENT_COVERAGE.md');
    assert.ok(coverageMd.includes('Requirement Coverage & Traceability Report'));
    assert.ok(coverageMd.includes('Crypto Asset Portfolio Tracker'));
    assert.ok(coverageMd.includes('🟢 **VERIFIED**'));
  });

  test('Section 2: Deep Prompt Understanding with 15 distinct requirements across all engineering disciplines', () => {
    const prompt15 = `Hospital Intensive Care Patient Telemetry Platform:
1. Interactive clinical dashboard interface with real-time patient status cards
2. Secure User Authentication with bcrypt password hashing and session tokens
3. Role-Based Access Control distinguishing Doctors, Nurses, and Administrators
4. SQLite relational database storage with ACID transactions and WAL mode
5. RESTful API endpoints for patient admission, vitals ingestion, and discharge
6. Client-side form validation for patient vital signs with inline warning alerts
7. Real-time alert notifications for critical heart rate and temperature spikes
8. Search and filter controls to query patients by medical record number
9. Audit trail logging for all vital sign updates and medication changes
10. Data export functionality for patient history in JSON and CSV formats
11. Responsive UI design optimized for desktop workstations, tablets, and mobile devices
12. Security rate limiting and input sanitization to block SQL injection and XSS
13. Automated unit and integration test suite in tests/api.test.js
14. System health check telemetry endpoint at GET /api/health
15. Production container deployment manifest and environment configuration`;

    const parsed = RequirementParser.parse(prompt15, { projectId: 'proj-icu-telemetry' });

    // Assert complete prompt preserved
    assert.equal(parsed.instruction, prompt15);

    // Assert all 15 requirements extracted without omission or duplication
    assert.equal(parsed.explicitRequirements.length, 15);
    assert.equal(parsed.traceabilityMatrix.length, 15);

    // Assert dynamic sequential REQ IDs
    parsed.explicitRequirements.forEach((req, idx) => {
      const expectedId = `REQ-${String(idx + 1).padStart(3, '0')}`;
      assert.equal(req.id, expectedId);
      assert.ok(req.text);
      assert.ok(req.targetFile);
      assert.ok(req.acceptanceCriteria);
    });

    // Verify broad architectural coverage across categories
    const categories = new Set(parsed.explicitRequirements.map(r => r.category));
    assert.ok(categories.has('UI'));
    assert.ok(categories.has('SECURITY'));
    assert.ok(categories.has('DATABASE'));
    assert.ok(categories.has('API'));
    assert.ok(categories.has('FUNCTIONAL'));
    assert.ok(categories.has('NON_FUNCTIONAL'));
    assert.ok(categories.has('TESTING'));
    assert.ok(categories.has('DEVOPS'));
  });

  test('Section 4: Automatic Error Correction & Bounded Self-Healing on Test Failure', async () => {
    const projectId = 'proj-self-heal-test';
    storage.createProject({
      id: projectId,
      name: 'Flaky Service Subject to Self-Healing',
      description: 'Test project verifying bounded error correction and honest status reporting on failure.',
      budgetTokens: 30000,
      budgetUsd: 5
    });

    // Track events emitted during execution
    const events = [];
    const unsubscribe = orchestrator.eventBus.subscribe('*', (ev) => {
      if (ev.projectId === projectId) events.push(ev);
    });

    try {
      const result = await orchestrator.buildProjectAutonomous(projectId, {
        appType: 'Custom Business Solution',
        fastMode: true
      });

      assert.equal(result.status, 'READY_FOR_DEPLOYMENT');
      assert.equal(result.testPassed, true);

      // Now introduce an intentional controlled failure in a temporary sandbox workspace
      const failingProjectId = 'proj-controlled-failure-test';
      storage.createProject({
        id: failingProjectId,
        name: 'Uncorrectable Failing Pipeline',
        description: 'Verify orchestrator reports honest failure status and error details when tests fail.',
        budgetTokens: 30000,
        budgetUsd: 5
      });

      // Override sandbox to simulate permanent test failure
      const originalExecute = orchestrator.sandbox.executeCommand.bind(orchestrator.sandbox);
      orchestrator.sandbox.executeCommand = async (pid, cmd, opts) => {
        if (pid === failingProjectId && cmd.includes('node --test')) {
          return {
            command: cmd,
            exitCode: 1,
            stdout: '',
            stderr: 'AssertionError [ERR_ASSERTION]: Expected status 200, got 500 at tests/api.test.js:42',
            durationMs: 50
          };
        }
        return originalExecute(pid, cmd, opts);
      };

      try {
        const failureResult = await orchestrator.buildProjectAutonomous(failingProjectId, {
          appType: 'Custom Business Solution',
          fastMode: true
        });

        // Must report honesty: NOT READY_FOR_DEPLOYMENT
        assert.equal(failureResult.status, 'TESTS_FAILED');
        assert.equal(failureResult.testPassed, false);
        assert.equal(failureResult.approval, null); // Human deployment approval gate blocked

        // Coverage report must report failure details and unverified requirements
        const cov = failureResult.coverage;
        assert.equal(cov.summary.isFullyVerified, false);
        assert.ok(cov.summary.failed > 0 || cov.summary.blocked > 0);

        const testingReq = cov.requirements.find(r => r.category === 'TESTING');
        assert.ok(testingReq);
        assert.equal(testingReq.status, RequirementStatus.FAILED);
        assert.ok(testingReq.evidence.includes('AssertionError'));
      } finally {
        orchestrator.sandbox.executeCommand = originalExecute;
      }
    } finally {
      unsubscribe();
    }
  });

  test('Acceptance 2: Gemini Client handles configuration, prompt loading, and bounded timeouts', async () => {
    const client = new GeminiClient({ apiKey: 'simulated-key-test', simulationMode: true });
    assert.equal(client.simulationMode, true);

    const res = await client.generate({
      role: 'BACKEND',
      systemPrompt: 'You are a Senior Backend Engineer.',
      userMessage: 'Synthesize REST API for user sessions.'
    });

    assert.ok(res.text);
    assert.equal(res.simulated, true);
    assert.ok(res.tokensUsed > 0);
  });
});
