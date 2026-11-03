import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { VirtualHouseServer } from '../src/server/server.js';
import { StorageEngine } from '../src/storage/db.js';
import { StructuredLogger, LogLevel, sanitizeLogData } from '../src/observability/logger.js';
import { TelemetryManager, TraceContext } from '../src/observability/telemetry.js';
import { SentryProvider } from '../src/observability/sentryProvider.js';
import { UsageMeter, QuotaExceededError, PlanTiers, DEFAULT_PLAN_LIMITS } from '../src/billing/usageMeter.js';
import { StripeBillingProvider, WebhookVerificationError } from '../src/billing/stripeBillingProvider.js';
import { MockBillingProvider } from '../src/billing/mockBillingProvider.js';

describe('Phase 7 — Observability, Usage Metering & Billing Suite', () => {
  const testDbPath = path.resolve('data/test_obs_phase7.db');
  const testWorkspacesDir = path.resolve('data/test_obs_workspaces_phase7');
  let storage;
  let server;
  let baseUrl;

  before(async () => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (!fs.existsSync(testWorkspacesDir)) fs.mkdirSync(testWorkspacesDir, { recursive: true });

    storage = new StorageEngine(testDbPath);

    server = new VirtualHouseServer({
      port: 0,
      host: '127.0.0.1',
      storage,
      dbPath: testDbPath,
      workspacesDir: testWorkspacesDir,
      authEnabled: false,
      simulationMode: true,
      useMockBilling: true,
      stripeWebhookSecret: 'whsec_test_secret_key_phase7'
    });

    await server.start();
    const addr = server.server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (server) await server.stop();
    if (storage) {
      try { storage.close(); } catch (_) {}
    }
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(testWorkspacesDir)) {
      fs.rmSync(testWorkspacesDir, { recursive: true, force: true });
    }
  });

  // Helper for HTTP requests
  function makeRequest(pathname, options = {}, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(pathname, baseUrl);
      const reqOpts = {
        method: options.method || 'GET',
        headers: options.headers || {}
      };

      const req = http.request(url, reqOpts, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
        });
      });

      req.on('error', reject);
      if (body) {
        req.write(typeof body === 'string' ? body : JSON.stringify(body));
      }
      req.end();
    });
  }

  // ── TEST 1: Structured Logging & Sensitive Secret Scrubbing ─────────────
  test('1. Structured Logging & PII/Secret Sanitization', () => {
    const logger = new StructuredLogger({
      logToConsole: false,
      defaultContext: { service: 'test-service' }
    });

    // Test secret redaction on bearer tokens, passwords, credit cards
    const rawSecret = 'sk_test_51MzXYZSecretKey12345';
    const rawBearer = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummyPayloadToken1234567';
    const rawCard = '4111-2222-3333-4444';

    logger.info('User authenticated with authorization header', {
      requestId: 'req_test_001',
      tenantId: 'tenant-test',
      apiKey: rawSecret,
      authorization: rawBearer,
      payment: {
        creditCard: rawCard,
        userEmail: 'alice@example.com'
      }
    });

    const entries = logger.getEntries();
    assert.equal(entries.length, 1);
    const log = entries[0];

    assert.equal(log.requestId, 'req_test_001');
    assert.equal(log.tenantId, 'tenant-test');
    assert.equal(log.service, 'test-service');

    // Assert sensitive fields are completely redacted
    assert.equal(log.context.apiKey, '[REDACTED]');
    assert.equal(log.context.authorization, '[REDACTED]');
    assert.equal(log.context.payment.creditCard, '[REDACTED]');
    assert.ok(!JSON.stringify(log).includes(rawSecret));
    assert.ok(!JSON.stringify(log).includes(rawBearer));
    assert.ok(!JSON.stringify(log).includes(rawCard));

    // Test inline text scrubbing
    const sanitizedMsg = sanitizeLogData(`Failed to connect using postgresql://postgres:mypassword123@db.internal:5432/main with key=${rawSecret}`);
    assert.ok(!sanitizedMsg.includes('mypassword123'));
    assert.ok(!sanitizedMsg.includes(rawSecret));
    assert.ok(sanitizedMsg.includes('[REDACTED]'));
  });

  // ── TEST 2: Healthz & Readyz Endpoints ───────────────────────────────────
  test('2. Health (/healthz) and Readiness (/readyz) Endpoints', async () => {
    // Liveness
    const healthzRes = await makeRequest('/healthz');
    assert.equal(healthzRes.status, 200);
    assert.equal(healthzRes.body.status, 'ok');
    assert.ok(healthzRes.body.timestamp);
    // Ensure no internal DB connection strings or secrets exposed
    assert.equal(healthzRes.raw.includes('password'), false);
    assert.equal(healthzRes.raw.includes('postgres://'), false);

    // Readiness
    const readyzRes = await makeRequest('/readyz');
    assert.equal(readyzRes.status, 200);
    assert.equal(readyzRes.body.status, 'ready');
    assert.equal(readyzRes.body.checks.database, 'up');
    assert.equal(readyzRes.body.checks.storage, 'up');
  });

  // ── TEST 3: OpenTelemetry Tracing & Metrics Export ───────────────────────
  test('3. OpenTelemetry Metrics & W3C TraceContext Propagation', async () => {
    const customTraceId = crypto.randomBytes(16).toString('hex');
    const customSpanId = crypto.randomBytes(8).toString('hex');
    const incomingTraceparent = `00-${customTraceId}-${customSpanId}-01`;

    const res = await makeRequest('/api/metrics?format=json', {
      headers: {
        'traceparent': incomingTraceparent,
        'x-request-id': 'req_custom_tracer'
      }
    });

    assert.equal(res.status, 200);
    assert.ok(res.headers['x-request-id']);
    assert.ok(res.headers['traceparent']);

    // Check OpenTelemetry metrics response structure
    assert.ok(res.body.metrics);
    assert.ok(res.body.metrics.httpRequests);
    assert.ok(res.body.metrics.httpRequestDuration);
    assert.ok(res.body.metrics.llmTokens);
    assert.ok(res.body.metrics.deployments);

    // Check Prometheus text format output
    const promRes = await makeRequest('/api/metrics');
    assert.equal(promRes.status, 200);
    assert.ok(promRes.raw.includes('# HELP http_requests_total'));
    assert.ok(promRes.raw.includes('# TYPE http_requests_total counter'));
    assert.ok(promRes.raw.includes('# HELP http_request_duration_seconds'));
  });

  // ── TEST 4: Sentry Error Capture Integration ────────────────────────────
  test('4. Sentry Error Tracking Integration (Safe No-Op & Captured Exceptions)', async () => {
    const captured = [];
    const sentry = new SentryProvider({
      dsn: 'https://pubKey123@o12345.ingest.sentry.io/99999',
      transport: async (evt) => { captured.push(evt); }
    });

    assert.equal(sentry.isConfigured(), true);

    const testError = new Error('Database connection reset during test query');
    testError.stack = 'Error: Database connection reset\n    at query (db.js:42:15)';

    await sentry.captureException(testError, {
      requestId: 'req_sentry_test',
      tenantId: 'tenant-omega',
      secretKey: 'super-sensitive-token-999'
    });

    assert.equal(captured.length, 1);
    const sentryEvent = captured[0];
    assert.equal(sentryEvent.level, 'error');
    assert.equal(sentryEvent.tags.requestId, 'req_sentry_test');
    assert.equal(sentryEvent.tags.tenantId, 'tenant-omega');
    assert.equal(sentryEvent.exception.values[0].value, 'Database connection reset during test query');

    // Ensure secrets are scrubbed before capture
    assert.ok(!JSON.stringify(sentryEvent).includes('super-sensitive-token-999'));

    // Safe unconfigured no-op test (without DSN)
    const noopSentry = new SentryProvider({ dsn: null });
    assert.equal(noopSentry.isConfigured(), false);
    // Should not throw or crash
    const eventId = await noopSentry.captureMessage('Diagnostic ping without DSN');
    assert.ok(eventId);
  });

  // ── TEST 5: Usage Events Recording with Idempotency Protection ───────────
  test('5. Usage Events Idempotency Protection', async () => {
    const usageMeter = new UsageMeter({ storage });
    const idempotencyKey = 'idem_llm_' + crypto.randomUUID();

    // First recording: new event created
    const res1 = await usageMeter.recordUsage({
      tenantId: 'tenant-idem-test',
      eventType: 'LLM_GENERATION',
      quantity: 1500,
      unit: 'TOKENS',
      idempotencyKey,
      metadata: { model: 'gemini-3.5-flash-lite' }
    });

    assert.equal(res1.recorded, true);
    assert.equal(res1.duplicate, false);
    assert.equal(res1.event.idempotency_key, idempotencyKey);
    assert.equal(res1.event.quantity, 1500);

    // Duplicate recording with identical idempotencyKey: must be ignored and not duplicate usage totals
    const res2 = await usageMeter.recordUsage({
      tenantId: 'tenant-idem-test',
      eventType: 'LLM_GENERATION',
      quantity: 1500,
      unit: 'TOKENS',
      idempotencyKey,
      metadata: { model: 'gemini-3.5-flash-lite' }
    });

    assert.equal(res2.recorded, false);
    assert.equal(res2.duplicate, true);
    assert.equal(res2.event.idempotency_key, idempotencyKey);

    // Verify summary only reflects 1500 tokens, not 3000 tokens
    const summary = await storage.getUsageSummary('tenant-idem-test');
    assert.equal(summary.byType.LLM_GENERATION.totalQuantity, 1500);
    assert.equal(summary.byType.LLM_GENERATION.eventCount, 1);
  });

  // ── TEST 6: Multi-Dimensional Limit Enforcement (429 Quota Exceeded) ─────
  test('6. Multi-Dimensional Limit Enforcement (Generations, Concurrency, Storage, Deployments)', async () => {
    const customLimits = {
      'tenant-restricted': {
        maxDailyGenerations: 2,
        maxConcurrentJobs: 1,
        maxDailyDeployments: 1,
        maxStorageBytes: 1024 * 1024 // 1 MB
      }
    };
    const usageMeter = new UsageMeter({ storage, customLimits });

    // 1. Generation Quota Enforcement
    await usageMeter.recordUsage({
      tenantId: 'tenant-restricted',
      eventType: 'GENERATION_JOB',
      quantity: 1,
      idempotencyKey: 'job_limit_1'
    });
    await usageMeter.recordUsage({
      tenantId: 'tenant-restricted',
      eventType: 'GENERATION_JOB',
      quantity: 1,
      idempotencyKey: 'job_limit_2'
    });

    // 3rd generation must fail
    await assert.rejects(
      async () => usageMeter.checkLimit('tenant-restricted', 'generation', 1),
      (err) => {
        assert.ok(err instanceof QuotaExceededError);
        assert.equal(err.statusCode, 429);
        assert.equal(err.details.limitType, 'generation');
        return true;
      }
    );

    // 2. Deployment Quota Enforcement
    storage.createProject({
      id: 'proj_lim',
      tenantId: 'tenant-restricted',
      name: 'Limit Test Project'
    });

    storage.db.prepare(`
      INSERT INTO project_deployments (id, tenant_id, project_id, provider, environment, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('dep_lim_1', 'tenant-restricted', 'proj_lim', 'mock', 'preview', 'DEPLOYED', new Date().toISOString(), new Date().toISOString());

    await assert.rejects(
      async () => usageMeter.checkLimit('tenant-restricted', 'deployment', 1),
      (err) => {
        assert.ok(err instanceof QuotaExceededError);
        assert.equal(err.details.limitType, 'deployment');
        return true;
      }
    );

    // 3. Storage Quota Enforcement (1MB limit exceeded by requesting 2MB)
    await assert.rejects(
      async () => usageMeter.checkLimit('tenant-restricted', 'storage', 2 * 1024 * 1024),
      (err) => {
        assert.ok(err instanceof QuotaExceededError);
        assert.equal(err.details.limitType, 'storage');
        return true;
      }
    );
  });

  // ── TEST 7: User Usage & Quota Visibility API ────────────────────────────
  test('7. Usage and Limits Transparency API (GET /api/usage & GET /api/usage/limits)', async () => {
    const tenantId = 'tenant-vis-user';

    // Record some initial events
    await storage.recordUsageEvent({
      tenantId,
      eventType: 'LLM_GENERATION',
      quantity: 500,
      unit: 'TOKENS',
      idempotencyKey: 'idem_vis_1'
    });

    const res = await makeRequest('/api/usage', {
      headers: { 'x-tenant-id': tenantId }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.tenantId, tenantId);
    assert.equal(res.body.plan, 'FREE');
    assert.ok(res.body.limits);
    assert.ok(res.body.currentUsage);
    assert.ok(res.body.percentUsed);

    const limitsRes = await makeRequest('/api/usage/limits', {
      headers: { 'x-tenant-id': tenantId }
    });

    assert.equal(limitsRes.status, 200);
    assert.equal(limitsRes.body.plan, 'FREE');
    assert.ok(limitsRes.body.limits.maxDailyGenerations);
    assert.ok(limitsRes.body.allPlanTiers.PRO);
    assert.ok(limitsRes.body.allPlanTiers.ENTERPRISE);
  });

  // ── TEST 8: Server-Side Webhook Signature Verification ───────────────────
  test('8. Stripe Webhook Verification (HMAC-SHA256 & Timestamp Window)', async () => {
    const mockBilling = new MockBillingProvider({
      storage,
      webhookSecret: 'whsec_secure_test_signature_secret'
    });

    const tenantId = 'tenant-sub-upgrade';
    const mockEvent = mockBilling.createMockWebhook('checkout.session.completed', {
      id: 'cs_test_123',
      client_reference_id: tenantId,
      customer: 'cus_stripe_123',
      subscription: 'sub_stripe_123',
      metadata: { plan: 'PRO' },
      amount_total: 4900,
      currency: 'usd'
    });

    // Valid signature must process successfully
    const result = await mockBilling.processWebhook(mockEvent.rawPayload, mockEvent.signatureHeader);
    assert.equal(result.status, 'PROCESSED');
    assert.equal(result.outcome.plan, 'PRO');

    // Verify tenant plan was upgraded in database
    const sub = await storage.getTenantSubscription(tenantId);
    assert.equal(sub.plan, 'PRO');
    assert.equal(sub.status, 'active');
    assert.equal(sub.customer_id, 'cus_stripe_123');
  });

  // ── TEST 9: Webhook Replay Attack Defense ────────────────────────────────
  test('9. Webhook Replay Attack Protection (Duplicate Event Rejected)', async () => {
    const mockBilling = new MockBillingProvider({
      storage,
      webhookSecret: 'whsec_replay_secret_key'
    });

    const eventId = 'evt_replay_' + crypto.randomUUID();
    const mockEvent = mockBilling.createMockWebhook(
      'customer.subscription.updated',
      {
        id: 'sub_replay_1',
        customer: 'cus_replay_1',
        status: 'active',
        metadata: { tenantId: 'tenant-replay-test', plan: 'PRO' }
      },
      eventId
    );

    // First attempt: processed
    const res1 = await mockBilling.processWebhook(mockEvent.rawPayload, mockEvent.signatureHeader);
    assert.equal(res1.status, 'PROCESSED');

    // Second attempt with identical event ID: must be rejected / marked as duplicate
    const res2 = await mockBilling.processWebhook(mockEvent.rawPayload, mockEvent.signatureHeader);
    assert.equal(res2.status, 'IGNORED');
    assert.equal(res2.reason, 'DUPLICATE_EVENT');
    assert.equal(res2.eventId, eventId);
  });

  // ── TEST 10: Webhook Tampering & Expired Timestamp Rejection ────────────
  test('10. Webhook Tampering & Expired Timestamp Rejection', async () => {
    const mockBilling = new MockBillingProvider({
      storage,
      webhookSecret: 'whsec_tamper_defense_key',
      toleranceSeconds: 60
    });

    const validMock = mockBilling.createMockWebhook('customer.subscription.deleted', {
      id: 'sub_tamper_1',
      customer: 'cus_tamper_1'
    });

    // 1. Tampered payload with original signature
    const tamperedPayload = validMock.rawPayload.replace('sub_tamper_1', 'sub_tampered_hacked');
    await assert.rejects(
      async () => mockBilling.processWebhook(tamperedPayload, validMock.signatureHeader),
      (err) => {
        assert.ok(err instanceof WebhookVerificationError);
        assert.ok(err.message.includes('HMAC-SHA256 mismatch'));
        return true;
      }
    );

    // 2. Expired timestamp outside tolerance window (e.g. 10 minutes ago)
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const expiredMock = mockBilling.createMockWebhook(
      'customer.subscription.deleted',
      { id: 'sub_expired_1' },
      null,
      tenMinutesAgo
    );

    await assert.rejects(
      async () => mockBilling.processWebhook(expiredMock.rawPayload, expiredMock.signatureHeader),
      (err) => {
        assert.ok(err instanceof WebhookVerificationError);
        assert.ok(err.message.includes('outside tolerance window'));
        return true;
      }
    );
  });

  // ── TEST 11: HTTP Endpoint for Billing Webhook ───────────────────────────
  test('11. HTTP POST /api/billing/webhook Endpoint Validation', async () => {
    const mockBilling = new MockBillingProvider({
      storage,
      webhookSecret: 'whsec_test_secret_key_phase7'
    });

    // Valid HTTP webhook
    const validEvent = mockBilling.createMockWebhook('checkout.session.completed', {
      id: 'cs_http_test_1',
      client_reference_id: 'tenant-http-webhook',
      customer: 'cus_http_1',
      subscription: 'sub_http_1',
      metadata: { plan: 'ENTERPRISE' }
    });

    const res = await makeRequest('/api/billing/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': validEvent.signatureHeader
      }
    }, validEvent.rawPayload);

    assert.equal(res.status, 200);
    assert.equal(res.body.received, true);
    assert.equal(res.body.result.status, 'PROCESSED');

    // Invalid signature must return HTTP 400
    const badRes = await makeRequest('/api/billing/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=12345,v1=bad_signature_hash_hex'
      }
    }, validEvent.rawPayload);

    assert.equal(badRes.status, 400);
    assert.equal(badRes.body.code, 'WEBHOOK_FAILED');
  });

  // ── TEST 12: Never Trust Client-Reported Payment Status ──────────────────
  test('12. Zero-Trust Security: Clients Cannot Self-Report Plans or Payment Status', async () => {
    // Attempt to fake a plan via project creation
    const res = await makeRequest('/api/projects', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': 'tenant-untrusted'
      }
    }, {
      title: 'Store Front',
      description: 'Online store',
      plan: 'ENTERPRISE', // Client tries to spoof plan
      billingStatus: 'paid'
    });

    assert.equal(res.status, 201);

    // Verify tenant plan remains FREE despite client payload
    const plan = await server.usageMeter.getTenantPlan('tenant-untrusted');
    assert.equal(plan, 'FREE');
  });

  // ── TEST 13: Usage Reconciliation ────────────────────────────────────────
  test('13. Usage Reconciliation (POST /api/usage/reconcile)', async () => {
    const tenantId = 'tenant-reconcile-test';

    const res = await makeRequest('/api/usage/reconcile', {
      method: 'POST',
      headers: { 'x-tenant-id': tenantId }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.tenantId, tenantId);
    assert.equal(res.body.status, 'IN_SYNC');
    assert.ok(res.body.reconciledTotals);
  });
});
