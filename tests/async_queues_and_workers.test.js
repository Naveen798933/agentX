import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';

import {
  EmbeddedRedisServer,
  QueueManager,
  QueueNames,
  JobStates,
  WorkerManager,
  isTransientError,
  createRedisClient,
  checkRedisHealth,
  sanitizeRedisConfig
} from '../src/queue/index.js';
import { StorageEngine } from '../src/storage/db.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { VirtualHouseServer } from '../src/server/server.js';
import { BudgetExceededError } from '../src/budget/budgetManager.js';
import { AuthorizationError } from '../src/storage/tenantGuard.js';
import { TokenService } from '../src/auth/tokenService.js';
import { AuthManager } from '../src/auth/authManager.js';
import { SystemRoles, Permissions } from '../src/auth/rbac.js';

process.env.NODE_ENV = 'test';

test('Phase 4 — Reliable Asynchronous AI Generation Suite', async (t) => {
  const REDIS_TEST_PORT = 6396;
  const redisServer = new EmbeddedRedisServer({ port: REDIS_TEST_PORT, password: 'testAuthPassword456' });
  await redisServer.start();

  const redisConfig = {
    host: '127.0.0.1',
    port: REDIS_TEST_PORT,
    password: 'testAuthPassword456'
  };

  t.after(async () => {
    await redisServer.stop();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Redis Connection, Authentication & Health
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('1. Redis Authentication, Private Network Config & Health Checks', async () => {
    const client = createRedisClient(redisConfig);
    const health = await checkRedisHealth(client);

    assert.strictEqual(health.ok, true, 'Redis health check ping must succeed');
    assert.strictEqual(health.status, 'HEALTHY');
    assert.strictEqual(typeof health.latencyMs, 'number');

    // Secrets redaction
    const sanitizedUrl = sanitizeRedisConfig('redis://app_worker:SuperSecretKey99@redis.vpc.internal:6379/1');
    assert.ok(!sanitizedUrl.includes('SuperSecretKey99'), 'Sanitized URL must not contain plain password');
    assert.ok(sanitizedUrl.includes('***'), 'Sanitized URL must contain mask ***');

    const sanitizedObj = sanitizeRedisConfig({ host: '127.0.0.1', port: 6379, password: 'MyPassword123' });
    assert.strictEqual(sanitizedObj.password, '***');

    await client.quit();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Queue Separation & Enqueueing
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('2. Multi-Queue Architecture (Generation, Validation, Testing, Deployment)', async () => {
    const storage = new StorageEngine(':memory:');
    const queueManager = new QueueManager({ storage, redisConfig, prefix: 'test-q2' });

    assert.ok(queueManager.getQueue(QueueNames.PROJECT_GENERATION), 'Generation queue initialized');
    assert.ok(queueManager.getQueue(QueueNames.CODE_VALIDATION), 'Validation queue initialized');
    assert.ok(queueManager.getQueue(QueueNames.TESTING), 'Testing queue initialized');
    assert.ok(queueManager.getQueue(QueueNames.DEPLOYMENT), 'Deployment queue initialized');

    const project = storage.createProject({ id: 'proj-multi-queue', name: 'Multi Queue App' });

    // Enqueue Validation Job
    const valRes = await queueManager.enqueueValidation({
      projectId: project.id,
      stageId: 'STAGE_ARCHITECTURE',
      files: ['docs/PRD.md', 'docs/ADR-001.md']
    });
    assert.strictEqual(valRes.status, JobStates.QUEUED);
    assert.strictEqual(valRes.job.queue_name, QueueNames.CODE_VALIDATION);

    // Enqueue Testing Job
    const testRes = await queueManager.enqueueTesting({
      projectId: project.id,
      testCommand: 'node --test'
    });
    assert.strictEqual(testRes.status, JobStates.QUEUED);
    assert.strictEqual(testRes.job.queue_name, QueueNames.TESTING);

    // Enqueue Deployment Job
    const depRes = await queueManager.enqueueDeployment({
      projectId: project.id,
      environment: 'STAGING'
    });
    assert.strictEqual(depRes.status, JobStates.QUEUED);
    assert.strictEqual(depRes.job.queue_name, QueueNames.DEPLOYMENT);

    const metrics = await queueManager.getQueueMetrics();
    assert.ok(metrics[QueueNames.CODE_VALIDATION].waiting >= 1);
    assert.ok(metrics[QueueNames.TESTING].waiting >= 1);
    assert.ok(metrics[QueueNames.DEPLOYMENT].waiting >= 1);

    await queueManager.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Transient vs. Fatal Failure Classification & Exponential Backoff
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('3. Transient Failure Classification vs. Non-Transient Fail-Fast', () => {
    // Transient errors (Eligible for retry with backoff)
    assert.strictEqual(isTransientError(new Error('Rate limit exceeded (429)')), true);
    assert.strictEqual(isTransientError(new Error('connect ECONNREFUSED 127.0.0.1')), true);
    assert.strictEqual(isTransientError(new Error('HTTP 503 Service Unavailable')), true);
    assert.strictEqual(isTransientError(new Error('Request timed out after 15000ms')), true);

    // Non-transient errors (Must fail immediately to prevent infinite retry loops)
    assert.strictEqual(isTransientError(new BudgetExceededError('Monthly budget exceeded')), false);
    assert.strictEqual(isTransientError(new AuthorizationError('Tenant access denied')), false);
    assert.strictEqual(isTransientError(new Error('Project prompt is required')), false);
    assert.strictEqual(isTransientError(new Error('Job was cancelled by user')), false);
    assert.strictEqual(isTransientError(new SyntaxError('Unexpected token in JSON')), false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Idempotency & Deduplication Guard
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('4. Idempotency Guard (Prevents Duplicate Projects & Billing)', async () => {
    const storage = new StorageEngine(':memory:');
    const queueManager = new QueueManager({ storage, redisConfig, prefix: 'test-q4' });

    const project = storage.createProject({ id: 'proj-idemp', name: 'Idempotent Project' });
    const idempotencyKey = 'idemp-token-xyz-100';

    // First submission
    const firstSub = await queueManager.enqueueGeneration({
      projectId: project.id,
      title: 'Idempotent Project',
      description: 'First submission',
      idempotencyKey
    });

    assert.strictEqual(firstSub.deduplicated, false, 'First submission is not deduplicated');
    assert.strictEqual(firstSub.status, JobStates.QUEUED);

    // Second submission with identical idempotencyKey
    const secondSub = await queueManager.enqueueGeneration({
      projectId: project.id,
      title: 'Idempotent Project',
      description: 'Duplicate submission attempt',
      idempotencyKey
    });

    assert.strictEqual(secondSub.deduplicated, true, 'Second submission must be deduplicated');
    assert.strictEqual(secondSub.job.id, firstSub.job.id, 'Must return identical job ID');

    await queueManager.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Worker Processing, Progress Tracking & PostgreSQL/SQLite Persistence
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('5. End-to-End Worker Processing, Progress Tracking & DB State Transitions', async () => {
    const storage = new StorageEngine(':memory:');
    const orchestrator = new Orchestrator({ storage });
    orchestrator.llm.simulationMode = true;
    const queueManager = new QueueManager({ storage, redisConfig, prefix: 'test-q5' });
    const workerManager = new WorkerManager({ storage, orchestrator, redisConfig, prefix: 'test-q5', concurrency: 2 });

    const project = storage.createProject({ id: 'proj-worker-exec', name: 'Worker App', budgetTokens: 100000 });

    const { job } = await queueManager.enqueueGeneration({
      projectId: project.id,
      title: 'Worker App',
      description: 'Full stack autonomous project',
      fastMode: true,
      maxRetries: 3
    });

    // Check initial queued state
    let state = await queueManager.getJobStatus(job.id);
    assert.strictEqual(state.status, JobStates.QUEUED);
    assert.strictEqual(state.progressPct, 0);

    // Poll until completed or running
    let finalJob = null;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 400));
      const cur = await queueManager.getJobStatus(job.id);
      if (cur.status === JobStates.COMPLETED || cur.status === JobStates.FAILED) {
        finalJob = cur;
        break;
      }
    }

    assert.ok(finalJob, 'Worker must complete execution');
    assert.strictEqual(finalJob.status, JobStates.COMPLETED);
    assert.strictEqual(finalJob.progressPct, 100);
    assert.ok(finalJob.resultPayload, 'Job must store resultPayload');
    assert.ok(Array.isArray(finalJob.resultPayload.filesCreated), 'resultPayload contains filesCreated');

    // Verify DB persistence
    const dbRecord = storage.getGenerationJob(job.id);
    assert.strictEqual(dbRecord.status, JobStates.COMPLETED);
    assert.strictEqual(dbRecord.tokens_used > 0, true);

    await workerManager.close();
    await queueManager.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Job Cancellation Handling
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('6. Job Cancellation & Pipeline Abort', async () => {
    const storage = new StorageEngine(':memory:');
    const queueManager = new QueueManager({ storage, redisConfig, prefix: 'test-q6' });

    const project = storage.createProject({ id: 'proj-cancel-test', name: 'Cancel App' });
    const { job } = await queueManager.enqueueGeneration({
      projectId: project.id,
      title: 'Cancel App',
      description: 'Will be aborted'
    });

    // Abort job
    const cancelled = await queueManager.cancelJob(job.id, 'User manually cancelled');
    assert.strictEqual(cancelled.status, JobStates.CANCELLED);

    const state = await queueManager.getJobStatus(job.id);
    assert.strictEqual(state.status, JobStates.CANCELLED);
    assert.strictEqual(state.errorMessage, 'User manually cancelled');

    await queueManager.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Crash Recovery: Interrupted Jobs Detection
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('7. Interrupted Job Recovery After Simulated Server Restart', async () => {
    const storage = new StorageEngine(':memory:');
    storage.createProject({ id: 'proj-crash', name: 'Crash Project' });

    // Simulate an interrupted job left in RUNNING status when server crashed
    const crashedJob = storage.createGenerationJob({
      id: 'job-crashed-1',
      projectId: 'proj-crash',
      status: JobStates.RUNNING,
      instruction: 'Interrupted project build',
      retriesCount: 0,
      maxRetries: 3
    });

    const queueManager = new QueueManager({ storage, redisConfig, prefix: 'test-q7' });
    const recovered = await queueManager.recoverInterruptedJobs();

    assert.strictEqual(recovered.length, 1);
    assert.strictEqual(recovered[0].id, 'job-crashed-1');
    assert.strictEqual(recovered[0].action, 'RE_ENQUEUED');
    assert.strictEqual(recovered[0].attempt, 1);

    const updated = storage.getGenerationJob('job-crashed-1');
    assert.strictEqual(updated.status, JobStates.QUEUED);
    assert.strictEqual(updated.retries_count, 1);

    await queueManager.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8. HTTP Server REST API, Job Polling & Cross-Tenant Security Isolation
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('8. HTTP Server Endpoints: Polling, Cancellation & Tenant Isolation Guard', async () => {
    const storage = new StorageEngine(':memory:');
    const tokenService = new TokenService({ jwtSecret: 'super-secret-key-for-test-suite-32-chars!' });
    const authManager = new AuthManager({ storage, tokenService });

    // Seed platform admin, tenant A user, tenant B user
    const admin = await authManager.register({
      email: 'admin@platform.org',
      password: 'AdminPassword123!',
      tenantId: 'tenant-admin',
      role: SystemRoles.PLATFORM_ADMIN
    });
    const userA = await authManager.register({
      email: 'devA@tenanta.org',
      password: 'DevPassword123!',
      tenantId: 'tenant-a',
      role: SystemRoles.PROJECT_MANAGER
    });
    const userB = await authManager.register({
      email: 'devB@tenantb.org',
      password: 'DevPassword123!',
      tenantId: 'tenant-b',
      role: SystemRoles.PROJECT_MANAGER
    });

    const adminToken = tokenService.generateAccessToken({ sub: admin.id, id: admin.id, email: admin.email, tenantId: admin.tenantId, role: admin.role });
    const userAToken = tokenService.generateAccessToken({ sub: userA.id, id: userA.id, email: userA.email, tenantId: userA.tenantId, role: userA.role });
    const userBToken = tokenService.generateAccessToken({ sub: userB.id, id: userB.id, email: userB.email, tenantId: userB.tenantId, role: userB.role });

    const queueManager = new QueueManager({ storage, redisConfig, prefix: 'test-q8' });
    const server = new VirtualHouseServer({
      port: 0,
      storage,
      authEnabled: true,
      tokenService,
      authManager,
      queueManager,
      redisConfig,
      prefix: 'test-q8',
      asyncEnabled: true
    });
    server.orchestrator.llm.simulationMode = true;

    let serverUrl;
    try {
      serverUrl = await server.start();

      // 8.1 Enqueue Job via POST /api/projects/autonomous with Idempotency Key
      const createRes = await fetch(`${serverUrl}/api/projects/autonomous`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${userAToken}`,
          'Idempotency-Key': 'idemp-http-test-1'
        },
        body: JSON.stringify({
          title: 'Tenant A Secured Project',
          description: 'Microservice API',
          fastMode: true
        })
      });

      assert.strictEqual(createRes.status, 201);
      const createData = await createRes.json();
      assert.strictEqual(createData.success, true);
      assert.ok(createData.jobId, 'Must return jobId to UI');
      assert.strictEqual(createData.status, JobStates.QUEUED);

      const jobId = createData.jobId;
      const projectId = createData.projectId;

      // 8.2 Verify Idempotent Duplicate Call returns deduplicated: true
      const dupRes = await fetch(`${serverUrl}/api/projects/autonomous`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${userAToken}`,
          'Idempotency-Key': 'idemp-http-test-1'
        },
        body: JSON.stringify({
          title: 'Tenant A Secured Project',
          description: 'Duplicate attempt'
        })
      });
      const dupData = await dupRes.json();
      assert.strictEqual(dupData.deduplicated, true);
      assert.strictEqual(dupData.jobId, jobId);

      // 8.3 Job Polling Endpoint: User A can poll their job
      const pollRes = await fetch(`${serverUrl}/api/jobs/${jobId}`, {
        headers: { 'Authorization': `Bearer ${userAToken}` }
      });
      assert.strictEqual(pollRes.status, 200);
      const pollData = await pollRes.json();
      assert.strictEqual(pollData.ok, true);
      assert.strictEqual(pollData.job.id, jobId);
      assert.strictEqual(pollData.job.tenantId, 'tenant-a');

      // 8.4 Cross-Tenant Security Isolation: User B from Tenant B CANNOT access User A's job
      const crossTenantRes = await fetch(`${serverUrl}/api/jobs/${jobId}`, {
        headers: { 'Authorization': `Bearer ${userBToken}` }
      });
      assert.strictEqual(crossTenantRes.status, 403, 'Cross-tenant job access must be denied with 403 Forbidden');

      // 8.5 Platform Admin can inspect any job across tenants
      const adminPollRes = await fetch(`${serverUrl}/api/jobs/${jobId}`, {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      assert.strictEqual(adminPollRes.status, 200, 'Platform admin can inspect any tenant job');

      // 8.6 Worker Health Endpoint
      const healthRes = await fetch(`${serverUrl}/api/workers/health`, {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      assert.strictEqual(healthRes.status, 200);
      const healthData = await healthRes.json();
      assert.strictEqual(healthData.enabled, true);
      assert.strictEqual(healthData.health.status, 'HEALTHY');

      // 8.7 Cancel Job via POST /api/jobs/:id/cancel
      const cancelRes = await fetch(`${serverUrl}/api/jobs/${jobId}/cancel`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${userAToken}` }
      });
      assert.strictEqual(cancelRes.status, 200);
      const cancelData = await cancelRes.json();
      assert.strictEqual(cancelData.status, 'CANCELLED');

      const verifyCancelRes = await fetch(`${serverUrl}/api/jobs/${jobId}`, {
        headers: { 'Authorization': `Bearer ${userAToken}` }
      });
      const verifyCancelData = await verifyCancelRes.json();
      assert.strictEqual(verifyCancelData.job.status, JobStates.CANCELLED);
    } catch (err) {
      console.error('TEST 8 FAILED WITH ERROR:', err);
      throw err;
    } finally {
      await server.stop();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 9. Redis Restarts & Automatic Client Reconnection Recovery
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('9. Redis Restart & Connection Recovery', async () => {
    const RESTART_PORT = 6394;
    const restartServer = new EmbeddedRedisServer({ port: RESTART_PORT, password: 'restartPass123' });
    await restartServer.start();

    const restartConfig = { host: '127.0.0.1', port: RESTART_PORT, password: 'restartPass123' };
    const client = createRedisClient(restartConfig);
    let healthBefore = null;
    for (let i = 0; i < 15; i++) {
      healthBefore = await checkRedisHealth(client);
      if (healthBefore.ok) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.strictEqual(healthBefore.ok, true, 'Initial Redis ping succeeds');

    // Simulate Redis restart: stop server
    await restartServer.stop();
    await new Promise(r => setTimeout(r, 400));

    const healthDuringStop = await checkRedisHealth(client);
    assert.strictEqual(healthDuringStop.ok, false, 'Ping fails while Redis is stopped');
    assert.strictEqual(healthDuringStop.status, 'UNAVAILABLE');

    // Restart Redis server on same port & password
    await restartServer.start();

    // Verify client auto-recovers connection
    let recovered = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      const h = await checkRedisHealth(client);
      if (h.ok) {
        recovered = true;
        break;
      }
    }

    assert.strictEqual(recovered, true, 'Redis client automatically reconnects after server restart');
    client.disconnect();
    await restartServer.stop();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 10. Failed Model Calls & Non-Infinite Retry Guarantee
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('10. Failed Model Call Handling & Non-Infinite Retries', async () => {
    const storage = new StorageEngine(':memory:');
    const orchestrator = new Orchestrator({ storage });

    // Mock an unrecoverable model failure (e.g. fatal prompt error)
    orchestrator.buildProjectAutonomous = async () => {
      throw new Error('Fatal model inference error: prompt rejected by safety filter');
    };

    const queueManager = new QueueManager({ storage, redisConfig, prefix: 'test-q10' });
    const workerManager = new WorkerManager({ storage, orchestrator, redisConfig, prefix: 'test-q10', concurrency: 1 });

    const project = storage.createProject({ id: 'proj-fail-model', name: 'Failed Model App' });
    const { job } = await queueManager.enqueueGeneration({
      projectId: project.id,
      title: 'Failed Model App',
      description: 'Trigger intentional failure'
    });

    let failedState = null;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 250));
      const s = await queueManager.getJobStatus(job.id);
      if (s && s.status === JobStates.FAILED) {
        failedState = s;
        break;
      }
    }

    assert.ok(failedState, 'Job must transition to FAILED without infinite retry');
    assert.strictEqual(failedState.status, JobStates.FAILED);
    assert.ok(failedState.errorMessage.includes('safety filter'), 'Error message recorded in DB');

    await workerManager.close();
    await queueManager.close();
  });
});
