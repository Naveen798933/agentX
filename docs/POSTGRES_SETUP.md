# PostgreSQL Persistence, Multi-Tenant Isolation & Migration Guide

## 1. Overview & Architecture

PULSE Collaborative Workspace / AI Virtual Software House implements a **production-grade PostgreSQL persistence layer** that replaces ephemeral file-based SQLite storage for multi-user production deployments while maintaining backward-compatible SQLite support for lightweight offline development and existing test suites.

### Core Architectural Guarantees
- **Dual-Adapter Storage Engine (`StorageEngine`)**: Seamlessly switches between PostgreSQL (production) and SQLite (embedded/offline fallback) without application-code refactoring.
- **Strict Multi-Tenancy**: Data is partitioned by `tenant_id` at both the **application layer** (`TenantGuard`) and the **database engine layer** (PostgreSQL Row-Level Security).
- **Anti-Spoofing Tenant Guard**: Client-supplied tenant identifiers are never trusted blindly; caller authorization context is strictly verified, rejecting unauthorized cross-tenant attempts with HTTP 403 / `AuthorizationError`.
- **Atomic Concurrency Protection**: High-frequency financial and balance operations (such as token usage deductions) execute as atomic `UPDATE` operations with constraint checks to prevent race condition overdrafts.
- **Versioned Migration Engine**: SQL migrations are tracked in `schema_migrations` with SHA-256 checksum validation, transactional execution, and rollback capability.
- **Secrets Redaction**: All connection strings, passwords, and sensitive keys are masked (`postgres://user:***@host:port/db`) in memory and error logs.

---

## 2. Configuration & Environment Variables

Store credentials securely using `.env` files (for local development) or a cloud secrets manager (e.g., AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager).

### Supported Environment Variables

| Variable | Description | Default | Example |
|---|---|---|---|
| `DATABASE_ADAPTER` | Storage driver to use: `postgres` or `sqlite` | `sqlite` | `postgres` |
| `DATABASE_URL` | Full PostgreSQL connection URI (takes precedence) | `undefined` | `postgres://pulse_admin:secret@127.0.0.1:5432/pulse_workspace` |
| `POSTGRES_HOST` | Database server hostname / IP | `127.0.0.1` | `db.pulse.internal` |
| `POSTGRES_PORT` | PostgreSQL TCP port | `5432` | `5432` |
| `POSTGRES_DB` | Database name | `pulse_workspace` | `pulse_prod` |
| `POSTGRES_USER` | Database role username | `postgres` | `pulse_app` |
| `POSTGRES_PASSWORD` | Database user password | `""` | `StrongRandomP@ssw0rd!` |
| `POSTGRES_POOL_MAX` | Maximum concurrent connections in `pg.Pool` | `10` | `25` |
| `POSTGRES_SSL` | Enable TLS/SSL connection encryption (`true`/`false`) | `false` | `true` |

> [!IMPORTANT]
> Raw connection strings and database passwords are **never logged**. The `sanitizeConnectionString` utility replaces passwords with `***` prior to emitting error logs or diagnostics.

---

## 3. Local Development Setup

### Option A: Running PostgreSQL via Docker (Recommended)

Run PostgreSQL 16 with a persistent volume:

```bash
docker run -d \
  --name pulse-postgres \
  -e POSTGRES_DB=pulse_workspace \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=pulse_secret_dev \
  -p 5432:5432 \
  -v pulse_pgdata:/var/lib/postgresql/data \
  postgres:16-alpine
```

### Option B: Local Native PostgreSQL (macOS Homebrew)

```bash
# Install and start PostgreSQL service
brew install postgresql@16
brew services start postgresql@16

# Create application database and user
createuser -s postgres
createdb pulse_workspace -U postgres
```

Configure `.env`:
```env
DATABASE_ADAPTER=postgres
DATABASE_URL=postgres://postgres:pulse_secret_dev@127.0.0.1:5432/pulse_workspace
```

---

## 4. Versioned Database Migration System

Database migrations are located in `src/storage/migrations/`:
1. `001_initial_schema.sql`: Core identities (`schema_migrations`, `tenants`, `users`, `projects`, `tasks`, `approvals`).
2. `002_generation_and_runs.sql`: Project artifacts (`requirements`, `generation_jobs`, `generated_artifacts`, `execution_runs`, `build_runs`).
3. `003_logs_usage_and_rls.sql`: Telemetry & billing (`logs_metadata`, `usage_records`) and PostgreSQL Row-Level Security policies.

### Programmatic Migration Execution

```javascript
import { MigrationRunner } from './src/storage/migrations/migrationRunner.js';
import { PostgresStorageAdapter } from './src/storage/postgresAdapter.js';

const adapter = new PostgresStorageAdapter();
const runner = new MigrationRunner(adapter.pool);

// Check pending migrations
const status = await runner.getStatus();
console.log(`Current version: v${status.currentVersion}, Pending: ${status.pendingCount}`);

// Apply pending migrations inside atomic transactions
const result = await runner.migrateUp();
console.log(`Successfully applied ${result.appliedCount} migrations.`);
```

### Rollback Last Applied Migration

```javascript
const rollback = await runner.rollbackLast();
console.log(rollback.message);
```

---

## 5. Multi-Tenant Isolation & Row-Level Security (RLS)

### Application-Layer Guard (`TenantGuard`)
Before any storage operation executes, `TenantGuard` verifies caller context:
- `TenantGuard.assertTenantAccess(userContext, requestedTenantId)`: Throws `AuthorizationError` (403) if a non-superadmin caller attempts cross-tenant access.
- `TenantGuard.resolveAuthorizedTenant(userContext, clientSuppliedTenantId)`: Prevents client-supplied tenant ID spoofing by locking the tenant to the authenticated token identity.
- `TenantGuard.assertProjectAccess(userContext, project)`: Verifies that the target project is owned by the caller's tenant.

### Engine-Level Row-Level Security (RLS)
PostgreSQL RLS ensures that even if application logic misses a `WHERE tenant_id = ...` filter, the database engine prohibits leaking records across tenants.

Within a transactional session:
```sql
BEGIN;
SET LOCAL app.current_tenant_id = 'tenant-xyz';

-- The RLS policy automatically evaluates:
-- USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
SELECT * FROM projects; 
COMMIT;
```

---

## 6. Safe Data Migration Strategy (SQLite -> PostgreSQL)

To safely migrate existing project, task, approval, build, and audit data without service interruption or data loss:

### 1. Pre-Flight Automatic Backup
`DataMigrator` automatically creates a timestamped copy of the source SQLite database:
`pulse.sqlite.backup-YYYY-MM-DDTHH-mm-ss-sssZ`

### 2. Transactional Record Transfer
All source records are read and written to PostgreSQL inside a single atomic transaction (`withTransaction`):
- Projects and token balances
- Tasks, assigned agents, and stages
- Governance approvals, risk levels, and resolution notes
- Audit logs and telemetry events
- Execution runs and container exit codes
- Autonomous build runs and verification reports

### 3. Preserved Rollback Safety
The original SQLite database file is **never deleted or truncated**. If any PostgreSQL error occurs during the migration:
- The PostgreSQL transaction automatically rolls back (`ROLLBACK`).
- The SQLite file remains 100% active and unmodified.
- The platform can immediately continue reading from SQLite by setting `DATABASE_ADAPTER=sqlite`.

### Executing Data Migration

```javascript
import { DataMigrator } from './src/storage/dataMigrator.js';
import { PostgresStorageAdapter } from './src/storage/postgresAdapter.js';

const pgAdapter = new PostgresStorageAdapter();
const migrator = new DataMigrator('pulse.sqlite', pgAdapter);

// Inspect record counts
const sourceInfo = migrator.inspectSource();
console.log('Source SQLite counts:', sourceInfo.tables);

// Run migration
const result = await migrator.migrateData();
console.log('Migration successful:', result.stats);
```

---

## 7. Backup and Restore Instructions

### Automated PostgreSQL Dump (`pg_dump`)

Export complete schema and data in compressed custom format:
```bash
pg_dump \
  -h 127.0.0.1 \
  -p 5432 \
  -U postgres \
  -F c \
  -b \
  -v \
  -f "pulse_backup_$(date +%Y%m%d_%H%M%S).dump" \
  pulse_workspace
```

Export schema only (excluding rows):
```bash
pg_dump -h 127.0.0.1 -U postgres --schema-only pulse_workspace > schema_only.sql
```

### Restoring from Backup (`pg_restore`)

Restore to a fresh or existing database:
```bash
# 1. Terminate active application connections
psql -h 127.0.0.1 -U postgres -d postgres -c "
  SELECT pg_terminate_backend(pid) 
  FROM pg_stat_activity 
  WHERE datname = 'pulse_workspace' AND pid <> pg_backend_pid();
"

# 2. Re-create clean database
dropdb -h 127.0.0.1 -U postgres --if-exists pulse_workspace
createdb -h 127.0.0.1 -U postgres pulse_workspace

# 3. Restore dump archive
pg_restore \
  -h 127.0.0.1 \
  -p 5432 \
  -U postgres \
  -d pulse_workspace \
  -v \
  "pulse_backup_20261026_120000.dump"
```

---

## 8. Production Cutover & Rollback Plan

### Production Cutover Checklist
1. Deploy updated codebase with `pg` dependency and migration files.
2. Ensure target PostgreSQL instance is provisioned, accessible via network, and TLS is enabled (`POSTGRES_SSL=true`).
3. Run `MigrationRunner.migrateUp()` to initialize all 10 tables, constraints, indexes, and RLS policies.
4. Run `DataMigrator.migrateData()` to transfer existing SQLite state into PostgreSQL.
5. Validate record count parity between SQLite and PostgreSQL.
6. Switch server environment variable: `DATABASE_ADAPTER=postgres`.
7. Restart application service and verify health checks (`/health` and project listings).

### Rollback Procedure (Emergency Reversal)
If any critical failure occurs in PostgreSQL post-cutover:
1. Set `DATABASE_ADAPTER=sqlite` in `.env`.
2. Point SQLite path to the verified pre-flight backup: `pulse.sqlite.backup-YYYY-MM-DD...`.
3. Restart server (`npm run dev` or service daemon).
4. System immediately resumes operation using local SQLite without data corruption.
