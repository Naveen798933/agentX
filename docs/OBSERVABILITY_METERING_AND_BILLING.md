# Phase 7 — Observability, Usage Metering & Billing Architecture

This document specifies the operational observability, telemetry, usage metering, and server-side payment billing architecture for the autonomous multi-agent platform.

---

## 1. Executive Summary & Architecture Overview

The Phase 7 upgrade equips the organization platform with enterprise-grade operational transparency, usage accounting, and secure server-side billing guardrails:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Client / User / Ingestion HTTP Request                │
│             Headers: X-Request-Id, traceparent (W3C), X-Tenant-Id          │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          HTTP Server & Middleware                           │
│  - Generates/extracts X-Request-Id (req_...)                                │
│  - Starts OpenTelemetry Span (W3C TraceContext injection)                   │
│  - Sanitizes & redacts secrets/PII from all request logs                    │
│  - Enforces per-tenant quotas via UsageMeter (429 QuotaExceededError)       │
└──────┬───────────────────────────────┬───────────────────────────────┬──────┘
       │                               │                               │
       ▼                               ▼                               ▼
┌──────────────┐               ┌──────────────┐               ┌──────────────┐
│  /healthz    │               │  /readyz     │               │ /api/metrics │
│ (Liveness)   │               │ (Readiness)  │               │ (Prometheus) │
└──────────────┘               └──────────────┘               └──────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│               Observability & Error Tracking Subsystems                     │
│  - StructuredLogger: JSON output with requestId, jobId, tenantId            │
│  - TelemetryManager: Histograms, Counters, Gauges for Prometheus & JSON     │
│  - SentryProvider: Exception capture with redacted context & safe no-op     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│              Usage Accounting & Idempotent Metering                         │
│  - Idempotency protection on usage_events (UNIQUE idempotency_key)          │
│  - Multi-dimensional limits: Generations, Concurrency, Storage, Deployments │
│  - Real-time limit visibility via /api/usage and /api/usage/limits          │
│  - Periodic usage reconciliation (/api/usage/reconcile)                     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 Verified Server-Side Payment Provider                       │
│  - Stripe / Mock provider with HMAC-SHA256 signature verification           │
│  - Clock drift tolerance window (300s) to prevent delayed replay attacks    │
│  - Replay protection via processed_webhooks audit ledger                    │
│  - Zero-Trust: Clients can NEVER report their own subscription or payment   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Structured Logging & Secret/PII Redaction

### 2.1 Format & Standards
All server and background worker logs are emitted as single-line, parseable JSON objects.
Standard attributes:
- `timestamp`: ISO-8601 UTC timestamp.
- `level`: `DEBUG`, `INFO`, `WARN`, or `ERROR`.
- `service`: `api-server`, `worker`, `usage-meter`, or `stripe-billing`.
- `message`: Sanitized human-readable log summary.
- `requestId`: Associated HTTP request ID (`req_...`).
- `jobId`: Associated BullMQ worker job ID (`job_...`).
- `tenantId`: Tenant identifier for multi-tenant partition tracking.
- `durationMs`: High-precision duration in milliseconds.
- `context`: Additional metadata with scrubbed parameters.

### 2.2 Redaction Engine & Security Guardrails
All logs pass through `sanitizeLogData` before serialization:
- **Bearer Tokens / JWTs**: `Bearer [a-zA-Z0-9_\-\.]+` $\rightarrow$ `Bearer [REDACTED]`
- **API Keys & Secrets**: Regex matching `key=`, `secret=`, `token=`, `password=`, `jwt=`, and standalone provider key prefixes (`sk_live_`, `sk_test_`, `pk_test_`, `whsec_`, `AIza...`) $\rightarrow$ `[REDACTED]`
- **Credit Card Numbers**: Luhn-pattern 13-19 digit card numbers $\rightarrow$ `[CARD_REDACTED]`
- **Database Connection Strings**: Passwords in `postgres://user:password@host` $\rightarrow$ `postgres://user:[REDACTED]@host`
- **Sensitive Prompts**: Truncated to 500 characters and scrubbed of embedded key patterns.

---

## 3. OpenTelemetry Metrics & Health Endpoints

### 3.1 Health & Readiness Probes
- `GET /healthz`: Fast liveness check. Confirms process event loop is active and accepting socket connections.
  ```json
  { "status": "ok", "timestamp": "2026-10-27T18:00:00.000Z" }
  ```
- `GET /readyz`: Deep readiness check without leaking infrastructure secrets, credentials, or paths:
  ```json
  {
    "status": "ready",
    "checks": {
      "database": "up",
      "storage": "up",
      "queue": "up"
    },
    "timestamp": "2026-10-27T18:00:00.000Z"
  }
  ```
  Returns HTTP `503 Service Unavailable` if database, storage, or Redis queues are unresponsive.

### 3.2 OpenTelemetry Metrics Registry (`/api/metrics`)
Available in Prometheus text format (default) or structured JSON (`?format=json`).

| Metric Name | Type | Labels | Description |
| :--- | :--- | :--- | :--- |
| `http_requests_total` | Counter | `method`, `path`, `status` | Total incoming HTTP requests |
| `http_request_duration_seconds` | Histogram | `method`, `path`, `status` | HTTP request latency distribution |
| `llm_tokens_total` | Counter | `tenant_id`, `model`, `type` | Total LLM tokens consumed (prompt/completion/total) |
| `llm_generation_duration_seconds` | Histogram | `tenant_id`, `model` | LLM inference latency distribution |
| `queue_jobs_total` | Counter | `queue`, `status` | Total BullMQ queue jobs processed |
| `queue_job_duration_seconds` | Histogram | `queue`, `status` | Background worker job execution duration |
| `sandbox_runs_total` | Counter | `outcome` | Sandbox execution outcomes (`success`, `failure`, `timeout`) |
| `deployments_total` | Counter | `provider`, `environment`, `status` | Cloud deployment attempts and outcomes |
| `usage_events_total` | Counter | `tenant_id`, `event_type` | Total usage events recorded |
| `active_previews_count` | Gauge | — | Currently active preview servers |
| `active_concurrent_jobs` | Gauge | `tenant_id` | Active running generation jobs per tenant |

---

## 4. Usage Metering & Multi-Dimensional Limit Guardrails

### 4.1 Plan Tiers & Configurable Limits
The platform defines three standard tiers, fully overridable per-tenant via server configuration:

```javascript
export const DEFAULT_PLAN_LIMITS = {
  FREE: {
    maxDailyGenerations: 10,
    maxConcurrentJobs: 1,
    maxStorageBytes: 100 * 1024 * 1024,      // 100 MB
    maxDailyDeployments: 5,
    maxTokensPerMonth: 100_000
  },
  PRO: {
    maxDailyGenerations: 100,
    maxConcurrentJobs: 5,
    maxStorageBytes: 5 * 1024 * 1024 * 1024, // 5 GB
    maxDailyDeployments: 50,
    maxTokensPerMonth: 2_000_000
  },
  ENTERPRISE: {
    maxDailyGenerations: 1000,
    maxConcurrentJobs: 20,
    maxStorageBytes: 50 * 1024 * 1024 * 1024,// 50 GB
    maxDailyDeployments: 500,
    maxTokensPerMonth: 50_000_000
  }
};
```

### 4.2 Idempotent Usage Event Recording
Usage is tracked in the `usage_events` table with a `UNIQUE(idempotency_key)` constraint.
- If a client or worker retries an operation with an existing `idempotencyKey`, the duplicate event is logged and ignored without double-charging or artificially inflating usage totals.
- When an operation breaches a quota limit, `UsageMeter.checkLimit` raises a `QuotaExceededError` returning HTTP `429 Too Many Requests` with full breakdown details.

### 4.3 User Visibility Endpoints
- `GET /api/usage`: Returns caller's tenant current usage, percentage used across all dimensions, and subscription status.
- `GET /api/usage/limits`: Returns plan definitions and current tenant quota limits.
- `POST /api/usage/reconcile`: Audits recorded database usage events against active stored artifacts on disk, identifying and reporting any discrepancies.

---

## 5. Server-Side Payment Provider & Webhook Verification

### 5.1 Zero-Trust Payment Architecture
Clients can **never** self-report payment status, credit card charges, or plan upgrades. All subscription transitions occur strictly via verified server-side webhooks.

### 5.2 Cryptographic Webhook Validation
The webhook endpoint (`POST /api/billing/webhook`) enforces Stripe-standard cryptographic security:
1. **Header Parsing**: Extracts timestamp `t` and signature `v1` from `Stripe-Signature` header.
2. **Clock Drift Tolerance**: Verifies $|t_{\text{current}} - t| \le 300\text{ seconds}$ (5 minutes). Rejects expired timestamps to prevent replay attacks.
3. **HMAC-SHA256 Verification**: Computes HMAC-SHA256 signature of `${timestamp}.${rawBody}` using the server-side `STRIPE_WEBHOOK_SECRET`.
4. **Timing-Safe Comparison**: Compares signatures using `crypto.timingSafeEqual` to eliminate side-channel timing attacks.
5. **Replay Defense Ledger**: Queries `processed_webhooks` table for `(provider, event_id)`. If previously processed, the request is safely acknowledged and ignored (`IGNORED / DUPLICATE_EVENT`).

### 5.3 Handled Webhook Events
- `checkout.session.completed`: Maps checkout session to tenant ID, activates purchased plan (`PRO` or `ENTERPRISE`).
- `customer.subscription.created` & `updated`: Synchronizes subscription status (`active`, `past_due`, `trialing`) and billing period dates.
- `customer.subscription.deleted`: Marks subscription as canceled and safely downgrades tenant plan back to `FREE`.
- `invoice.payment_failed`: Marks status as `past_due` without abrupt data deletion.

---

## 6. Database Migration Schema (Migration 008)

Migration `008_observability_and_metering.sql` introduces three dedicated tables:

```sql
-- Idempotent usage events
CREATE TABLE IF NOT EXISTS usage_events (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id VARCHAR(64),
  project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE,
  event_type VARCHAR(64) NOT NULL,
  quantity NUMERIC(14, 4) NOT NULL,
  unit VARCHAR(32) NOT NULL,
  idempotency_key VARCHAR(128) UNIQUE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Replay attack defense ledger
CREATE TABLE IF NOT EXISTS processed_webhooks (
  id VARCHAR(64) PRIMARY KEY,
  provider VARCHAR(32) NOT NULL,
  event_id VARCHAR(128) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload_summary TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_processed_webhooks UNIQUE (provider, event_id)
);

-- Server-verified tenant subscriptions
CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL DEFAULT 'stripe',
  customer_id VARCHAR(128),
  subscription_id VARCHAR(128),
  plan VARCHAR(32) NOT NULL DEFAULT 'FREE',
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT false,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tenant_subscription_provider UNIQUE (tenant_id, provider)
);
```

---

## 7. Operational Runbook, Alerts & Incident Response

### 7.1 Alert Thresholds

| Alert Name | Condition | Severity | Action |
| :--- | :--- | :--- | :--- |
| **HighErrorRate** | HTTP 5xx rate > 5% for 5 mins | P1 / Critical | Inspect Sentry exceptions, check DB pool saturation |
| **ReadinessProbeFailing** | `/readyz` returning 503 for 2 mins | P1 / Critical | Investigate DB connectivity and storage mount accessibility |
| **LLMLatencySpike** | LLM p95 latency > 15s for 10 mins | P2 / Major | Check Gemini API quotas, verify automatic fallback engagement |
| **QueueBacklogHigh** | BullMQ waiting jobs > 50 for 10 mins | P2 / Major | Scale background worker instances |
| **WebhookSignatureFailures** | > 3 signature failures per minute | P2 / Major | Check for webhook secret rotation mismatch or active replay attack |
| **StorageQuotaApproaching** | Tenant storage consumption > 85% | P3 / Warning | Trigger user notification to clean builds or upgrade plan |

### 7.2 Data Retention Policies
- **Hot Application Logs**: Retained for 14 days in log aggregator (Grafana Loki or CloudWatch).
- **Usage Events**: Retained for 365 days for financial audit, then rolled into monthly aggregate totals.
- **Processed Webhooks Ledger**: Retained for 90 days (sufficient to block any replay attempt).
- **Temporary Build Artifacts**: Automatically pruned after 24 hours per Phase 5 retention policy.

### 7.3 Backup & Disaster Recovery
- **Daily Automated Backup**: Scheduled `pg_dump` of PostgreSQL schema and data at 02:00 UTC.
- **Point-in-Time Recovery (PITR)**: Continuous WAL segment archiving enabled with 7-day retention.
- **SQLite Disaster Recovery**: WAL checkpointing triggered before periodic snapshot creation.
- **Restoration Validation**: Test restoration automated weekly in isolated staging environment.

### 7.4 Incident Response Procedures
1. **Sev-1: Service Outage / Readiness Failure**:
   - Check `/healthz` and `/readyz` response payloads.
   - Verify PostgreSQL connectivity: `pg_isready -h $POSTGRES_HOST -p $POSTGRES_PORT`.
   - Verify Redis connectivity: `redis-cli -h $REDIS_HOST PING`.
   - If storage volume full: execute `POST /api/artifacts/cleanup` to purge expired temporary builds.
2. **Sev-2: Webhook Outage / Stripe Interruption**:
   - Stripe automatically retries failed webhook deliveries with exponential backoff for up to 72 hours.
   - The platform will process retried events idempotently as soon as connectivity resumes.
   - Never manually mutate tenant plans via direct database edits without filing an audit ticket.
3. **Sev-3: LLM Rate Limit Throttling (429)**:
   - The platform's client-side rate limiter and exponential backoff retry system throttle requests automatically.
   - When primary Gemini models experience high demand, the system engages fallback models (`gemini-flash-latest`) and intelligent requirement simulation without failing user requests.

---

## 8. Deployment & Verification Checklist

- [x] Database Migration 008 applied cleanly (`usage_events`, `processed_webhooks`, `tenant_subscriptions`).
- [x] Structured JSON logger active with request ID, job ID, and secret/PII redaction.
- [x] OpenTelemetry metrics and W3C traceparent propagation verified.
- [x] `/healthz` (liveness) and `/readyz` (readiness) responsive without secret leakage.
- [x] Sentry error tracking integrated with safe fallback when unconfigured.
- [x] Idempotency keys enforced on usage events to prevent duplicate counting.
- [x] Multi-dimensional limits enforced (generations, concurrency, storage, deployments) returning HTTP 429.
- [x] Usage transparency endpoints (`/api/usage`, `/api/usage/limits`) operational.
- [x] Stripe webhook signature verification (HMAC-SHA256 and 300s timestamp window) verified.
- [x] Webhook replay attacks blocked via `processed_webhooks` unique ledger.
- [x] Zero-trust billing verified: client-reported payment statuses rejected.
- [x] 100% of test suites passing across all phases (Phases 3, 4, 5, 6, 7).
