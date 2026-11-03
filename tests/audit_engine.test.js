import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { StorageEngine } from '../src/storage/db.js';
import { SandboxExecutor } from '../src/sandbox/sandboxExecutor.js';
import { EventBus } from '../src/core/eventBus.js';
import { PreviewManager } from '../src/server/previewManager.js';
import { VirtualHouseServer } from '../src/server/server.js';
import { AuditEngine } from '../src/audit/auditEngine.js';
import { RequirementParser } from '../src/audit/requirementParser.js';

describe('Requirement-Accurate Self-Auditing AI Software Builder Suite', () => {
  const testDb = path.resolve('data/test_audit_suite.db');
  const testWorkspaces = path.resolve('data/test_audit_workspaces');
  const testReports = path.resolve('data/test_audit_workspaces/reports');

  let storage;
  let sandbox;
  let eventBus;
  let previewManager;
  let server;
  let serverUrl;
  let auditEngine;

  beforeEach(async () => {
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
    if (fs.existsSync(testWorkspaces)) fs.rmSync(testWorkspaces, { recursive: true, force: true });

    server = new VirtualHouseServer({
      port: 0,
      dbPath: testDb,
      workspacesDir: testWorkspaces
    });
    serverUrl = await server.start();

    storage = server.storage;
    sandbox = server.sandbox;
    eventBus = server.eventBus;
    previewManager = server.previewManager;
    auditEngine = server.auditEngine;
  });

  afterEach(async () => {
    await server.stop();
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
    if (fs.existsSync(testWorkspaces)) fs.rmSync(testWorkspaces, { recursive: true, force: true });
  });

  test('Scenario A: Request "Build a Login and Signup page" builds Authentication UI and NEVER a Shopping Cart', async () => {
    const projId = 'proj-auth-test';
    storage.createProject({ id: projId, name: 'Auth Portal App', budgetTokens: 100000 });

    const instruction = 'Build a Login and Signup page.';
    const result = await auditEngine.executeFeatureBuild(projId, instruction, {
      maxIterations: 3,
      autoFix: true
    });

    assert.equal(result.success, true, 'Feature build must succeed');
    assert.equal(result.domain, 'AUTH', 'Must correctly identify AUTH domain');
    assert.match(result.featureName, /Login & Signup/i);

    // 1. Check generated files
    const htmlContent = sandbox.readFileSafely(projId, 'public/index.html');
    assert.match(htmlContent, /form-login/i, 'Must contain login form');
    assert.match(htmlContent, /toggle-.*pass/i, 'Must contain password toggle button');

    // 2. Strict Prohibition Assertion: Shopping cart or checkout elements MUST NOT exist
    assert.doesNotMatch(htmlContent, /shopping-cart/i, 'Strict Scope: Shopping cart must NOT be generated');
    assert.doesNotMatch(htmlContent, /checkout-button/i, 'Strict Scope: Checkout button must NOT be generated');
    assert.doesNotMatch(htmlContent, /stripe-payment/i, 'Strict Scope: Stripe payment must NOT be generated');

    // 3. Real Browser Test Verification
    assert.equal(result.browserTest.passed, true, 'Browser test must pass');
    const noCartAssertion = result.browserTest.assertions.find(a => a.id === 'ASSERT-NO-ROGUE-CART');
    assert.ok(noCartAssertion, 'ASSERT-NO-ROGUE-CART assertion must be present');
    assert.equal(noCartAssertion.passed, true, 'ASSERT-NO-ROGUE-CART must be TRUE');

    // 4. Honest 12-Dimension Verification Matrix check
    assert.equal(result.verification.requirements, 'Passed');
    assert.equal(result.verification.browserTests, 'Passed');
    assert.equal(result.verification.runtimeConsole, 'Clean');
    assert.equal(result.verification.productionBuild, 'Passed');
    assert.equal(result.verification.previewHealth, 'Healthy');
  });

  test('Scenario B: Request "Build a Shopping Cart" correctly builds Cart & Checkout', async () => {
    const projId = 'proj-cart-test';
    storage.createProject({ id: projId, name: 'Commerce Portal', budgetTokens: 100000 });

    const instruction = 'Build a Shopping Cart with item management and checkout button';
    const result = await auditEngine.executeFeatureBuild(projId, instruction, {
      maxIterations: 3,
      autoFix: true
    });

    assert.equal(result.success, true);
    assert.equal(result.domain, 'ECOMMERCE');
    assert.match(result.featureName, /Shopping Cart/i);

    const htmlContent = sandbox.readFileSafely(projId, 'public/index.html');
    assert.match(htmlContent, /cart-items/i, 'Must contain cart items container');
    assert.match(htmlContent, /btn-checkout/i, 'Must contain checkout button');
  });

  test('Scenario C: Controlled compilation/syntax error is detected and fixed by self-auditing loop', async () => {
    const projId = 'proj-heal-test';
    storage.createProject({ id: projId, name: 'Heal Test App', budgetTokens: 100000 });

    // Seed broken syntax file
    sandbox.writeFileSafely(projId, 'public/index.html', '<!DOCTYPE html><html><body><div id="form-login"></div><script>function broken( { syntax error</script></body></html>');

    const instruction = 'Build a Login and Signup page.';
    const result = await auditEngine.executeFeatureBuild(projId, instruction, {
      maxIterations: 3,
      autoFix: true
    });

    assert.equal(result.success, true, 'Self-healing loop must recover and produce valid build');
    assert.ok(result.iterationCount >= 1, 'Must record iterations executed');
    const healedContent = sandbox.readFileSafely(projId, 'public/index.html');
    assert.doesNotMatch(healedContent, /function broken\(/, 'Syntax error must be eliminated');
    assert.match(healedContent, /form-login/, 'Valid login form must be synthesized');
  });

  test('Scenario D: Controlled assertion failure is reported honestly without fake passes', async () => {
    const projId = 'proj-falsify-test';
    storage.createProject({ id: projId, name: 'Honest Report App', budgetTokens: 100000 });

    // Seed missing HTML
    sandbox.writeFileSafely(projId, 'public/index.html', '<div>Empty page with zero required forms</div>');

    const spec = RequirementParser.parse('Build a Login and Signup page.', { projectId: projId });
    const browserResult = await auditEngine.browserTester.verifyBrowserExecution(projId, spec, {
      sandbox,
      previewUrl: `${serverUrl}/api/projects/${projId}/preview/`
    });

    assert.equal(browserResult.passed, false, 'Browser test MUST fail when required elements are absent');
    const failedAssertions = browserResult.assertions.filter(a => !a.passed);
    assert.ok(failedAssertions.length > 0, 'Must have recorded failed assertions');
    const loginFormAssertion = browserResult.assertions.find(a => a.id === 'ASSERT-LOGIN-FORM');
    assert.ok(loginFormAssertion, 'ASSERT-LOGIN-FORM must exist');
    assert.equal(loginFormAssertion.passed, false, 'ASSERT-LOGIN-FORM must fail honestly');
  });

  test('Scenario E: Build status, logs, and audit report persist to SQLite and filesystem', async () => {
    const projId = 'proj-persist-test';
    storage.createProject({ id: projId, name: 'Persistence App', budgetTokens: 100000 });

    const instruction = 'Build a Login and Signup page.';
    const result = await auditEngine.executeFeatureBuild(projId, instruction);

    // 1. Verify in SQLite
    const latestDbRun = storage.getLatestBuildRun(projId);
    assert.ok(latestDbRun, 'Build run must exist in SQLite database');
    assert.equal(latestDbRun.id, result.runId);
    assert.equal(latestDbRun.status, 'VERIFIED');
    assert.equal(latestDbRun.domain, 'AUTH');

    // 2. Verify on Filesystem
    const reportPath = path.join(testWorkspaces, projId, 'reports', `audit-${result.runId}.json`);
    assert.ok(fs.existsSync(reportPath), 'Persistent audit report must exist on filesystem');

    const diskReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(diskReport.runId, result.runId);
    assert.equal(diskReport.success, true);
    assert.equal(diskReport.verificationDashboard.browserTests, 'Passed');
  });

  test('Scenario F: A failed build cannot be marked as successful', async () => {
    const projId = 'proj-fail-test';
    storage.createProject({ id: projId, name: 'Fail Gate App', budgetTokens: 100000 });

    // Run feature build with autoFix disabled and invalid pre-existing code
    sandbox.writeFileSafely(projId, 'public/index.html', '<div>Bad content with illegal shopping cart <div id="shopping-cart">Cart</div></div>');

    // Force an unhealable state with autoFix = false and skipSynthesis = true
    const result = await auditEngine.executeFeatureBuild(projId, 'Build a Login and Signup page.', {
      maxIterations: 1,
      autoFix: false,
      skipSynthesis: true
    });

    // When autoFix is false and forbidden cart is present, build CANNOT be marked VERIFIED or success: true
    assert.equal(result.success, false, 'Failed build must have success: false');
    assert.notEqual(result.status, 'VERIFIED', 'Failed build must NOT be marked VERIFIED');
  });

  test('Scenario G: Stale preview cannot be reported as latest successful build', async () => {
    const projId = 'proj-stale-test';
    storage.createProject({ id: projId, name: 'Stale Preview App', budgetTokens: 100000 });

    // 1. First run creates build 1
    const run1 = await auditEngine.executeFeatureBuild(projId, 'Build a Login and Signup page.');
    assert.equal(run1.success, true);

    // 2. Modify files with an uncommitted breaking change
    sandbox.writeFileSafely(projId, 'public/index.html', '<html><body>Broken stale preview content</body></html>');

    // 3. Inspection of workspace must identify revision changes
    const inspection = auditEngine.inspector.inspect(sandbox, projId);
    assert.ok(inspection.hasIndexHtml);

    // 4. Verification must reflect the current source revision, not run 1
    const spec = RequirementParser.parse('Build a Login and Signup page.', { projectId: projId });
    const browserCheck = await auditEngine.browserTester.verifyBrowserExecution(projId, spec, {
      sandbox,
      previewUrl: `${serverUrl}/api/projects/${projId}/preview/`
    });
    assert.equal(browserCheck.passed, false, 'Stale modified content must fail fresh browser verification');
  });

  test('Scenario H: Unrelated project files and existing features are preserved non-destructively', async () => {
    const projId = 'proj-preserve-test';
    storage.createProject({ id: projId, name: 'Preserve App', budgetTokens: 100000 });

    // Seed unrelated user files
    const customReadme = '# Important Custom Notes\nDo not overwrite this file.';
    const customUtil = 'export function customMath(a, b) { return a * b + 42; }';
    sandbox.writeFileSafely(projId, 'README.md', customReadme);
    sandbox.writeFileSafely(projId, 'src/customUtils.js', customUtil);

    // Run feature build
    const result = await auditEngine.executeFeatureBuild(projId, 'Build a Login and Signup page.');
    assert.equal(result.success, true);

    // Verify unrelated files are intact
    const afterReadme = sandbox.readFileSafely(projId, 'README.md');
    const afterUtil = sandbox.readFileSafely(projId, 'src/customUtils.js');

    assert.equal(afterReadme, customReadme, 'README.md must be preserved intact');
    assert.equal(afterUtil, customUtil, 'customUtils.js must be preserved intact');
  });

  test('Scenario I: Request "Build a Real-Time Team Chat Room" builds Chat UI and NEVER a Shopping Cart', async () => {
    const projId = 'proj-chat-test';
    storage.createProject({ id: projId, name: 'Team Chat App', budgetTokens: 100000 });

    const instruction = 'Build a Real-Time Team Chat Room with channels and message composer';
    const result = await auditEngine.executeFeatureBuild(projId, instruction);

    assert.equal(result.success, true);
    assert.equal(result.domain, 'CHAT');
    assert.match(result.featureName, /Team Messaging/i);

    const htmlContent = sandbox.readFileSafely(projId, 'public/index.html');
    assert.match(htmlContent, /channel-list/i, 'Must contain channel list');
    assert.match(htmlContent, /chat-input/i, 'Must contain chat input');
    assert.doesNotMatch(htmlContent, /cart-drawer/i, 'Strict Scope: Shopping cart must NOT be generated');

    const noCart = result.browserTest.assertions.find(a => a.id === 'ASSERT-NO-ROGUE-CART');
    assert.ok(noCart, 'ASSERT-NO-ROGUE-CART must be present');
    assert.equal(noCart.passed, true);
  });

  test('Scenario J: Request "Build an Executive Analytics Telemetry Dashboard" builds Analytics UI and NEVER a Shopping Cart', async () => {
    const projId = 'proj-analytics-test';
    storage.createProject({ id: projId, name: 'Executive Analytics', budgetTokens: 100000 });

    const instruction = 'Build an Executive Analytics Telemetry Dashboard with KPI cards and charts';
    const result = await auditEngine.executeFeatureBuild(projId, instruction);

    assert.equal(result.success, true);
    assert.equal(result.domain, 'ANALYTICS');

    const htmlContent = sandbox.readFileSafely(projId, 'public/index.html');
    assert.match(htmlContent, /kpi-revenue|kpi-card/i, 'Must contain KPI metric cards');
    assert.match(htmlContent, /analytics-chart|<canvas/i, 'Must contain chart canvas');
    assert.doesNotMatch(htmlContent, /btn-checkout/i, 'Strict Scope: Shopping cart must NOT be generated');

    const noCart = result.browserTest.assertions.find(a => a.id === 'ASSERT-NO-ROGUE-CART');
    assert.ok(noCart, 'ASSERT-NO-ROGUE-CART must be present');
    assert.equal(noCart.passed, true);
  });

  test('Scenario K: Request "Build an Interactive Kanban Task Board" builds Workflow UI and NEVER a Shopping Cart', async () => {
    const projId = 'proj-kanban-test';
    storage.createProject({ id: projId, name: 'Task Board App', budgetTokens: 100000 });

    const instruction = 'Build an Interactive Kanban Task Board with stage columns and task cards';
    const result = await auditEngine.executeFeatureBuild(projId, instruction);

    assert.equal(result.success, true);
    assert.equal(result.domain, 'WORKFLOW');

    const htmlContent = sandbox.readFileSafely(projId, 'public/index.html');
    assert.match(htmlContent, /kanban-col/i, 'Must contain Kanban stage columns');
    assert.match(htmlContent, /btn-add-task/i, 'Must contain add task action');
    assert.doesNotMatch(htmlContent, /cart-items/i, 'Strict Scope: Shopping cart must NOT be generated');

    const noCart = result.browserTest.assertions.find(a => a.id === 'ASSERT-NO-ROGUE-CART');
    assert.ok(noCart, 'ASSERT-NO-ROGUE-CART must be present');
    assert.equal(noCart.passed, true);
  });
});

