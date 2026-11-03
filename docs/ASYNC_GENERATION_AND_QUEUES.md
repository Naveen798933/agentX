# Asynchronous AI Generation Architecture (Redis & BullMQ)

## Overview
Phase 4 upgrades the AI Virtual Software House platform from synchronous HTTP handlers to an asynchronous, resilient, multi-queue generation architecture backed by Redis and BullMQ. Project generation, code validation, automated testing, and deployment workflows execute as background jobs with guaranteed state persistence in PostgreSQL, automatic retry with exponential backoff for transient failures, fail-fast mechanics for fatal errors, bounded concurrency, cancellation support, and real-time telemetry streaming to the dashboard.

---

## 1. Queue Architecture & Separation

The platform establishes 4 dedicated BullMQ queues with distinct operational profiles:

| Queue Name | Purpose | Concurrency | Backoff Strategy | Payload Type |
|---|---|---|---|---|
| `project-generation` | Autonomous end-to-end software synthesis (PRD, Architecture, Backend, Frontend, QA, Deployment) | Bounded (default: 2) | Exponential: 1s, 2s, 4s (max 3) | `{ jobId, projectId, tenantId, title, description, appType, fastMode }` |
| `code-validation` | Static syntax checks, lint verification, and AST analysis | Bounded (default: 4) | Exponential: 1s, 2s, 4s (max 3) | `{ jobId, projectId, stageId, files }` |
| `testing` | Sandboxed test execution and automated bug fixing | Bounded (default: 2) | Exponential: 2s, 4s, 8s (max 3) | `{ jobId, projectId, testCommand, autoFix, maxFixAttempts }` |
| `deployment` | Docker packaging, artifact staging, and environment promotion | Bounded (default: 2) | Exponential: 1s, 2s, 4s (max 3) | `{ jobId, projectId, environment }` |

---

## 2. Job State Lifecycle & PostgreSQL Persistence

Every generation request creates an immutable job record in the database before being enqueued to Redis, guaranteeing zero loss of history across server crashes or Redis restarts.

```
       [ Client Request ]
               │
      (Idempotency Check)
        /             \
  [Existing]       [New Job]
      │                │
(Return State)   [ QUEUED ] ──> Persisted in PostgreSQL (`generation_jobs`)
                       │
               [ BullMQ Worker ]
                       │
                  [ RUNNING ] ──> Live progress broadcasted via SSE
                  /    │    \
                 /     │     \
       (Fatal)  /  (Success)  \ (Cancel)
               v       │       v
          [ FAILED ]   │   [ CANCELLED ]
                       v
                 [ COMPLETED ]
```

### Supported Job States:
- `QUEUED`: Enqueued into Redis queue; awaiting an available worker.
- `PENDING`: Awaiting human approval or dependent stage prerequisites.
- `RUNNING`: Actively executing inside sandboxed synthesizer or orchestrator.
- `COMPLETED`: All stages succeeded; generated files, tests, and preview URLs recorded in `result_payload`.
- `FAILED`: Unrecoverable error (budget exceeded, permission denied, invalid prompt) or retries exhausted.
- `CANCELLED`: Interrupted via user abort (`POST /api/jobs/:id/cancel`).

---

## 3. Transient vs. Fatal Failure Classification

To prevent destructive infinite retry loops or burning customer token budgets on unrecoverable errors, the `WorkerManager` classifies errors using `isTransientError`:

### Transient Failures (Automatically Retried with Backoff):
- Network socket resets (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`)
- Upstream LLM rate limiting (HTTP 429)
- Model backend overload (HTTP 503, Service Unavailable)
- Transient inference timeouts

### Non-Transient Failures (Fail Fast via `UnrecoverableError`):
- `BudgetExceededError`: Project token or USD budget depleted.
- `AuthorizationError`: Cross-tenant boundary violations or insufficient permissions.
- Input validation failures (empty title or description).
- Manual job cancellation (`Job was cancelled by user`).
- JSON parse or syntax errors in LLM configuration.

---

## 4. Idempotency & Deduplication Guard

Clients submit an `Idempotency-Key` header with generation requests (`POST /api/projects/autonomous`).
1. The `QueueManager` queries `storage.getGenerationJobByIdempotencyKey(key, tenantId)`.
2. If an existing job in `QUEUED`, `RUNNING`, or `COMPLETED` state is found:
   - The job is **not re-enqueued**.
   - No duplicate tokens or billing charges occur.
   - The server immediately returns `HTTP 201` with `deduplicated: true` and the existing `jobId`.

---

## 5. Security & Tenant Isolation

1. **Job Isolation Guard**:
   - `GET /api/jobs/:id` verifies the authenticated caller's tenant matches `job.tenant_id`.
   - Unauthorized cross-tenant queries return `403 Forbidden` (`CROSS_TENANT_FORBIDDEN`).
   - Platform administrators (`PLATFORM_ADMIN`) retain global audit inspection capability.
2. **Log & Telemetry Sanitization**:
   - Server-Sent Events (`_broadcastSSE`) automatically redacts passwords, secret tokens, API keys (`***`), and truncates sensitive raw prompts over 200 characters to prevent accidental leakage in browser consoles or public logs.
3. **Redis Credentials**:
   - `sanitizeRedisConfig` redacts Redis URLs (`redis://user:***@host:port/db`) in health check endpoints and logs.

---

## 6. Real-Time Telemetry & Fallback Polling

1. **Server-Sent Events (SSE)**:
   - The UI dashboard automatically subscribes to `/api/events`.
   - Event types: `job.queued`, `job.started`, `job.progress`, `job.completed`, `job.failed`, `job.retrying`, `job.cancelled`.
2. **Fallback Polling**:
   - If SSE disconnects, `public/app.js` runs `startJobPolling(jobId)` polling `GET /api/jobs/:id` every 1200ms until a terminal state (`COMPLETED`, `FAILED`, `CANCELLED`) is reached.

---

## 7. Crash Recovery & Worker Health Checks

1. **Interrupted Job Recovery**:
   - On server startup, `queueManager.recoverInterruptedJobs()` detects any jobs left in `RUNNING` status from a crash.
   - If `retries_count < max_retries`, the job is automatically re-enqueued with updated metadata.
   - If retries are exceeded, the job is cleanly transitioned to `FAILED`.
2. **Health Endpoints**:
   - `GET /api/workers/health`: reports Redis connection status, latency in milliseconds, waiting/active job counts per queue, and worker run states.
   - `GET /api/health`: includes overall Redis and worker subsystem health.

---

## 8. Operational & Deployment Guide

### Local Development (Zero External Dependencies):
The platform includes an embedded standalone Redis binary in `bin/redis-server`:
```bash
# Start server with async generation enabled
ASYNC_GENERATION_ENABLED=true ./bin/node src/server/server.js
```

### Production Deployment (Systemd / Docker / Kubernetes):
Configure standard Redis with authentication and TLS:
```bash
# Redis VPC connection settings
REDIS_HOST="redis.internal.vpc"
REDIS_PORT="6379"
REDIS_PASSWORD="<STRONG_VAULT_GENERATED_PASSWORD>"
REDIS_TLS="true"

# Queue concurrency and retry configuration
QUEUE_CONCURRENCY="4"
ASYNC_GENERATION_ENABLED="true"
```
