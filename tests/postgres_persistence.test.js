import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { newDb } from 'pg-mem';

import { PostgresStorageAdapter, sanitizeConnectionString } from '../src/storage/postgresAdapter.js';
import { MigrationRunner } from '../src/storage/migrations/migrationRunner.js';
import { TenantGuard, AuthorizationError } from '../src/storage/tenantGuard.js';
import { DataMigrator } from '../src/storage/dataMigrator.js';
import { StorageEngine } from '../src/storage/db.js';

/**
 * Creates an in-memory PostgreSQL test pool powered by pg-mem.
 * Handles transactions (BEGIN/COMMIT/ROLLBACK via snapshot restore)
 * and intercepts session-level tenant variables for RLS verification.
 */
function createTestPgPool() {
  const memDb = newDb({ noAstCoverageCheck: true });
  const rawPool = new (memDb.adapters.createPg()).Pool();

  const wrapClient = (client) => {
    const origQuery = client.query.bind(client);
    let snapshot = null;
    let sessionTenantId = null;

    client.query = async (sql, params = []) => {
      if (typeof sql === 'string') {
        const trimmed = sql.trim().toUpperCase();

        // Transaction management via pg-mem memory snapshots
        if (trimmed === 'BEGIN') {
          snapshot = memDb.backup();
          return { rows: [], rowCount: 0 };
        }
        if (trimmed === 'ROLLBACK') {
          if (snapshot) snapshot.restore();
          snapshot = null;
          return { rows: [], rowCount: 0 };
        }
        if (trimmed === 'COMMIT') {
          snapshot = null;
          return { rows: [], rowCount: 0 };
        }

        // Intercept session setting for app.current_tenant_id (RLS context)
        if (trimmed.startsWith('SET') && sql.includes('app.current_tenant_id')) {
          if (params.length > 0) {
            sessionTenantId = params[0];
          } else {
            const m = sql.match(/SET\s+LOCAL\s+app\.current_tenant_id\s*=\s*['"]?([^'";\s]+)['"]?/i);
            if (m) sessionTenantId = m[1];
          }
          return { rows: [], rowCount: 1 };
        }

        // Clean out pg-server specific RLS policy DDL from multi-statement strings
        if (sql.includes('ROW LEVEL SECURITY') || sql.includes('POLICY')) {
          const isRls = (stmt) => {
            const stripped = stmt.replace(/--.*$/gm, '').trim().toUpperCase();
            return (stripped.includes('ROW LEVEL SECURITY') && stripped.startsWith('ALTER TABLE')) ||
                   stripped.startsWith('CREATE POLICY') ||
                   stripped.startsWith('DROP POLICY');
          };
          const stmts = sql.split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0 && !isRls(s));
          for (const s of stmts) {
            await origQuery(s);
          }
          return { rows: [], rowCount: stmts.length };
        }
      }
      return origQuery(sql, params);
    };

    client.getSessionTenant = () => sessionTenantId;
    return client;
  };

  return {
    memDb,
    async connect() {
      const c = await rawPool.connect();
      return wrapClient(c);
    },
    async query(sql, params = []) {
      const c = await this.connect();
      try {
        return await c.query(sql, params);
      } finally {
        c.release();
      }
    },
    async end() {
      return rawPool.end();
    }
  };
}

describe('Phase 2 — PostgreSQL Persistence and Data Isolation Suite', () => {
  const tmpDir = path.resolve('tmp/test_postgres_persistence');
  let testPool;
  let adapter;
  let runner;

  before(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  after(async () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  beforeEach(async () => {
    testPool = createTestPgPool();
    runner = new MigrationRunner(testPool);
    adapter = new PostgresStorageAdapter({ pool: testPool });
  });

  // ── 1. VERSIONED DATABASE MIGRATION SYSTEM ───────────────────────────────
  describe('1. Versioned Migration Engine', () => {
    test('discovers available migration files in sequential version order', () => {
      const migrations = runner.getAvailableMigrations();
      assert.ok(migrations.length >= 3, 'Must discover at least 3 migration files');
      assert.strictEqual(migrations[0].version, 1, 'First migration is v1');
      assert.strictEqual(migrations[1].version, 2, 'Second migration is v2');
      assert.strictEqual(migrations[2].version, 3, 'Third migration is v3');

      for (const m of migrations) {
        assert.ok(m.checksum && m.checksum.length === 64, `Migration ${m.name} must have valid SHA-256 checksum`);
        assert.ok(fs.existsSync(m.fullPath), `Migration file must exist on disk: ${m.fullPath}`);
      }
    });

    test('executes migrateUp() applying all pending migrations transactionally', async () => {
      const available = runner.getAvailableMigrations();
      const totalMigrations = available.length;
      const beforeStatus = await runner.getStatus();
      assert.strictEqual(beforeStatus.appliedCount, 0, 'Initially 0 applied migrations');
      assert.strictEqual(beforeStatus.pendingCount, totalMigrations, `Initially ${totalMigrations} pending migrations`);

      const result = await runner.migrateUp();
      assert.strictEqual(result.appliedCount, totalMigrations, `All ${totalMigrations} migrations applied`);

      const afterStatus = await runner.getStatus();
      assert.strictEqual(afterStatus.appliedCount, totalMigrations, `Applied count must equal ${totalMigrations}`);
      assert.strictEqual(afterStatus.pendingCount, 0, 'Pending count must equal 0');
      assert.strictEqual(afterStatus.currentVersion, totalMigrations, `Current schema version must be ${totalMigrations}`);

      // Verify schema_migrations table records
      const appliedRows = await runner.getAppliedMigrations();
      assert.strictEqual(appliedRows.length, totalMigrations);
      for (let i = 0; i < totalMigrations; i++) {
        assert.strictEqual(appliedRows[i].version, i + 1);
      }
    });

    test('ensures migration idempotency: subsequent migrateUp() calls apply 0 migrations', async () => {
      await runner.migrateUp();
      const secondRun = await runner.migrateUp();
      assert.strictEqual(secondRun.appliedCount, 0, 'Second run must apply 0 migrations');
    });

    test('supports rollbackLast() to reverse the latest migration safely', async () => {
      const totalMigrations = runner.getAvailableMigrations().length;
      await runner.migrateUp();
      const status1 = await runner.getStatus();
      assert.strictEqual(status1.currentVersion, totalMigrations);

      const rollbackRes = await runner.rollbackLast();
      assert.strictEqual(rollbackRes.rolledBack.version, totalMigrations, `Must rollback v${totalMigrations}`);

      const status2 = await runner.getStatus();
      assert.strictEqual(status2.appliedCount, totalMigrations - 1, `Applied count reduces to ${totalMigrations - 1}`);
      assert.strictEqual(status2.pendingCount, 1, 'Pending count increases to 1');
      assert.strictEqual(status2.currentVersion, totalMigrations - 1, `Current schema version is ${totalMigrations - 1}`);
    });
  });

  // ── 2. SCHEMA DEFINITION & INTEGRITY CONSTRAINTS ──────────────────────────
  describe('2. PostgreSQL Schema Definition & Constraints', () => {
    beforeEach(async () => {
      await runner.migrateUp();
    });

    test('creates and enforces primary keys, foreign keys and cascade deletions', async () => {
      const tenant = await adapter.createTenant({ name: 'Acme Software', slug: 'acme-corp' });
      const user = await adapter.createUser({ tenantId: tenant.id, email: 'lead@acme.com', passwordHash: 'hash-abc' });
      const project = await adapter.createProject({ tenantId: tenant.id, ownerId: user.id, name: 'Core API' });
      const task = await adapter.createTask({ tenantId: tenant.id, projectId: project.id, title: 'Build auth' });
      const req = await adapter.createRequirement({
        tenantId: tenant.id,
        projectId: project.id,
        lockId: 'lock-1',
        reqId: 'REQ-AUTH-01',
        description: 'OAuth2 login',
        targetFile: 'src/auth.js',
        acceptanceCriteria: 'Passes test'
      });

      assert.ok(tenant.id && tenant.id.startsWith('tenant-'));
      assert.ok(user.id && user.id.startsWith('usr-'));
      assert.ok(project.id && project.id.startsWith('proj-'));
      assert.ok(task.id && task.id.startsWith('task-'));
      assert.ok(req.id && req.id.startsWith('req-'));

      // Test Cascade Deletion: Deleting project must delete its task and requirements
      await adapter.deleteProject(project.id);
      const deletedTask = await adapter.getTask(task.id);
      const deletedReqs = await adapter.listRequirements(project.id);

      assert.strictEqual(deletedTask, null, 'Task must be cascade deleted when project is removed');
      assert.strictEqual(deletedReqs.length, 0, 'Requirements must be cascade deleted');
    });

    test('enforces unique constraints on slug, email and composite keys', async () => {
      const tenant = await adapter.createTenant({ name: 'Unique Corp', slug: 'unique-slug' });

      // Duplicate slug must fail
      await assert.rejects(
        async () => adapter.createTenant({ name: 'Another Corp', slug: 'unique-slug' }),
        /unique/i,
        'Duplicate tenant slug must violate unique constraint'
      );

      // Duplicate email in users must fail
      await adapter.createUser({ tenantId: tenant.id, email: 'unique@corp.com', passwordHash: 'hash1' });
      await assert.rejects(
        async () => adapter.createUser({ tenantId: tenant.id, email: 'unique@corp.com', passwordHash: 'hash2' }),
        /unique/i,
        'Duplicate user email must violate unique constraint'
      );
    });

    test('enforces upsert semantics on requirements (uq_proj_req) and artifacts (uq_proj_file_version)', async () => {
      const tenant = await adapter.createTenant({ name: 'Upsert Corp', slug: 'upsert-corp' });
      const project = await adapter.createProject({ tenantId: tenant.id, name: 'Upsert Project' });

      // First insert requirement
      const req1 = await adapter.createRequirement({
        tenantId: tenant.id,
        projectId: project.id,
        lockId: 'lock-1',
        reqId: 'REQ-01',
        description: 'Original description',
        targetFile: 'src/index.js',
        acceptanceCriteria: 'v1'
      });

      // Upsert same requirement ID
      const req2 = await adapter.createRequirement({
        tenantId: tenant.id,
        projectId: project.id,
        lockId: 'lock-1',
        reqId: 'REQ-01',
        description: 'Updated description',
        targetFile: 'src/index.js',
        acceptanceCriteria: 'v2'
      });

      assert.strictEqual(req2.description, 'Updated description', 'Requirement description updated on conflict');
      const allReqs = await adapter.listRequirements(project.id);
      assert.strictEqual(allReqs.length, 1, 'Requirement count remains 1');

      // Artifact versioned upsert
      const art1 = await adapter.saveArtifact({
        tenantId: tenant.id,
        projectId: project.id,
        filePath: 'src/api.js',
        content: 'const v = 1;',
        version: 1
      });
      const art2 = await adapter.saveArtifact({
        tenantId: tenant.id,
        projectId: project.id,
        filePath: 'src/api.js',
        content: 'const v = 2;',
        version: 1
      });
      assert.strictEqual(art2.content, 'const v = 2;', 'Artifact content updated on conflict');
      const allArts = await adapter.listArtifacts(project.id);
      assert.strictEqual(allArts.length, 1, 'Artifact count remains 1');
    });

    test('enforces budget check constraints on positive budget and token balance', async () => {
      const tenant = await adapter.createTenant({ name: 'Budget Corp', slug: 'budget-corp' });

      // Negative budget constraint
      await assert.rejects(
        async () => adapter.query(
          `INSERT INTO projects (id, tenant_id, name, budget_tokens, spent_tokens) VALUES ('p-neg', $1, 'Neg', -100, 0)`,
          [tenant.id]
        ),
        /chk_positive_budget/i,
        'Cannot insert project with negative budget tokens'
      );

      // Overspent constraint at insert
      await assert.rejects(
        async () => adapter.query(
          `INSERT INTO projects (id, tenant_id, name, budget_tokens, spent_tokens) VALUES ('p-over', $1, 'Over', 100, 200)`,
          [tenant.id]
        ),
        /chk_token_balance/i,
        'Cannot insert project where spent_tokens exceeds budget_tokens'
      );
    });
  });

  // ── 3. ATOMIC MULTI-STEP TRANSACTIONS ────────────────────────────────────
  describe('3. Atomic Multi-Step Transactions', () => {
    beforeEach(async () => {
      await runner.migrateUp();
    });

    test('withTransaction commits all writes together when execution succeeds', async () => {
      const tenant = await adapter.createTenant({ name: 'Tx Tenant', slug: 'tx-tenant' });
      const project = await adapter.createProject({ tenantId: tenant.id, name: 'Tx Project' });

      await adapter.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO tasks (id, tenant_id, project_id, title, assigned_agent, status, stage, tokens_used) VALUES ($1, $2, $3, $4, 'CODER', 'DONE', 'CODING', 500)`,
          ['t-tx-1', tenant.id, project.id, 'Task 1']
        );
        await client.query(
          `UPDATE projects SET spent_tokens = spent_tokens + 500 WHERE id = $1`,
          [project.id]
        );
      });

      const task = await adapter.getTask('t-tx-1');
      const updatedProj = await adapter.getProject(project.id);

      assert.ok(task, 'Task was committed');
      assert.strictEqual(updatedProj.spent_tokens, 500, 'Project tokens was committed');
    });

    test('withTransaction rolls back all operations completely when any step fails', async () => {
      const tenant = await adapter.createTenant({ name: 'Rollback Tenant', slug: 'rb-tenant' });
      const project = await adapter.createProject({ tenantId: tenant.id, name: 'Rollback Project', budgetTokens: 10000 });

      let errorThrown = false;
      try {
        await adapter.withTransaction(async (client) => {
          await client.query(
            `INSERT INTO tasks (id, tenant_id, project_id, title, assigned_agent, status, stage) VALUES ($1, $2, $3, $4, 'TESTER', 'PENDING', 'TESTING')`,
            ['t-abort-1', tenant.id, project.id, 'Abort Task']
          );
          await client.query(
            `UPDATE projects SET name = 'Altered Name' WHERE id = $1`,
            [project.id]
          );

          // Force failure
          throw new Error('Mid-transaction simulated database error');
        });
      } catch (err) {
        errorThrown = true;
        assert.match(err.message, /Mid-transaction simulated database error/);
      }

      assert.strictEqual(errorThrown, true, 'Error must be propagated to caller');

      // Verify complete rollback: task does not exist, project name remained untouched
      const task = await adapter.getTask('t-abort-1');
      const proj = await adapter.getProject(project.id);

      assert.strictEqual(task, null, 'Rolled-back task must not exist');
      assert.strictEqual(proj.name, 'Rollback Project', 'Project name must be rolled back to original');
    });
  });

  // ── 4. CONCURRENCY & RACE-CONDITION DEFENSE ──────────────────────────────
  describe('4. Concurrency & Race-Condition Defense', () => {
    beforeEach(async () => {
      await runner.migrateUp();
    });

    test('atomic token balance deduction prevents overdraft under concurrent operations', async () => {
      const tenant = await adapter.createTenant({ name: 'Concurrency Tenant', slug: 'conc-tenant' });
      const project = await adapter.createProject({
        tenantId: tenant.id,
        name: 'Concurrent Project',
        budgetTokens: 500
      });

      // 10 concurrent requests each attempting to spend 100 tokens
      // Total demanded = 1000 tokens, but budget is only 500.
      // Exactly 5 should succeed, and 5 should fail with false.
      const attempts = Array.from({ length: 10 }, () =>
        adapter.deductTokensAtomically(project.id, 100, tenant.id)
      );

      const results = await Promise.all(attempts);
      const successes = results.filter(r => r === true).length;
      const failures = results.filter(r => r === false).length;

      assert.strictEqual(successes, 5, 'Exactly 5 transactions must succeed up to budget limit');
      assert.strictEqual(failures, 5, 'Exactly 5 transactions must be rejected to prevent overdraft');

      const finalProj = await adapter.getProject(project.id);
      assert.strictEqual(finalProj.spent_tokens, 500, 'Spent tokens strictly equals budget without overdraft');
    });
  });

  // ── 5. TENANT OWNERSHIP & AUTHORIZATION GUARD ────────────────────────────
  describe('5. Application-Layer Tenant Authorization Guard (TenantGuard)', () => {
    const tenantA = 'tenant-alpha';
    const tenantB = 'tenant-beta';

    const userA = { userId: 'usr-1', tenantId: tenantA, role: 'DEVELOPER' };
    const userB = { userId: 'usr-2', tenantId: tenantB, role: 'DEVELOPER' };
    const superAdmin = { userId: 'usr-super', tenantId: tenantA, role: 'SUPERADMIN' };

    test('allows legitimate tenant access matching caller context', () => {
      const tenant = TenantGuard.assertTenantAccess(userA, tenantA, 'Alpha Project');
      assert.strictEqual(tenant, tenantA);
    });

    test('rejects cross-tenant access with AuthorizationError (403)', () => {
      assert.throws(
        () => TenantGuard.assertTenantAccess(userA, tenantB, 'Beta Resource'),
        (err) => {
          assert.ok(err instanceof AuthorizationError);
          assert.strictEqual(err.status, 403);
          assert.match(err.message, /Cross-tenant access violation/);
          return true;
        }
      );
    });

    test('never trusts client-supplied tenant ID without authorization (anti-spoofing)', () => {
      // User A attempts to claim tenant B
      assert.throws(
        () => TenantGuard.resolveAuthorizedTenant(userA, tenantB),
        (err) => {
          assert.ok(err instanceof AuthorizationError);
          assert.strictEqual(err.status, 403);
          assert.match(err.message, /Security violation: Attempted to spoof tenant ID/);
          return true;
        }
      );

      // When client supplies matching tenant ID, resolved cleanly
      const resolved = TenantGuard.resolveAuthorizedTenant(userA, tenantA);
      assert.strictEqual(resolved, tenantA);

      // When client supplies null, defaults to caller authorized tenant
      const defaultResolved = TenantGuard.resolveAuthorizedTenant(userA, null);
      assert.strictEqual(defaultResolved, tenantA);
    });

    test('superadmin role bypasses tenant boundary check', () => {
      const resolved = TenantGuard.resolveAuthorizedTenant(superAdmin, tenantB);
      assert.strictEqual(resolved, tenantA, 'Superadmin passes without spoofing violation');

      const access = TenantGuard.assertTenantAccess(superAdmin, tenantB, 'Beta Project');
      assert.strictEqual(access, tenantA);
    });

    test('assertProjectAccess blocks user from accessing a project owned by another tenant', () => {
      const projectOfB = { id: 'proj-b-1', tenant_id: tenantB, name: 'Beta Core' };

      // User B can access their project
      assert.doesNotThrow(() => TenantGuard.assertProjectAccess(userB, projectOfB));

      // User A is blocked
      assert.throws(
        () => TenantGuard.assertProjectAccess(userA, projectOfB),
        /Cross-tenant access violation/
      );
    });
  });

  // ── 6. ROW-LEVEL SECURITY CONTEXT HANDLING ───────────────────────────────
  describe('6. PostgreSQL Row-Level Security Context Handling', () => {
    beforeEach(async () => {
      await runner.migrateUp();
    });

    test('withTransaction and withTenantContext inject app.current_tenant_id session variable', async () => {
      const tenantId = 'tenant-rls-test';
      let capturedSessionTenant = null;

      await adapter.withTransaction(async (client) => {
        capturedSessionTenant = typeof client.getSessionTenant === 'function' ? client.getSessionTenant() : null;
      }, tenantId);

      assert.strictEqual(capturedSessionTenant, tenantId, 'Must set app.current_tenant_id inside transaction');
    });

    test('adapter queries support explicit tenantId partitioning to prevent data leakage', async () => {
      const tenantA = await adapter.createTenant({ name: 'Tenant A', slug: 'tenant-a' });
      const tenantB = await adapter.createTenant({ name: 'Tenant B', slug: 'tenant-b' });

      const projA = await adapter.createProject({ tenantId: tenantA.id, name: 'Project A' });
      const projB = await adapter.createProject({ tenantId: tenantB.id, name: 'Project B' });

      // Tenant A listing projects with their tenantId
      const listA = await adapter.listProjects(tenantA.id);
      assert.strictEqual(listA.length, 1);
      assert.strictEqual(listA[0].id, projA.id);

      // Tenant B cannot see Tenant A's project when querying with tenant context
      const getFromWrongTenant = await adapter.getProject(projA.id, tenantB.id);
      assert.strictEqual(getFromWrongTenant, null, 'Cross-tenant lookup must return null');

      // Tenant B listing projects
      const listB = await adapter.listProjects(tenantB.id);
      assert.strictEqual(listB.length, 1);
      assert.strictEqual(listB[0].id, projB.id);
    });
  });

  // ── 7. SAFE SQLITE TO POSTGRESQL DATA MIGRATION ──────────────────────────
  describe('7. Safe SQLite -> PostgreSQL Data Migration (DataMigrator)', () => {
    const sqlitePath = path.join(tmpDir, 'legacy_pulse.sqlite');

    beforeEach(async () => {
      await runner.migrateUp();
      if (fs.existsSync(sqlitePath)) fs.unlinkSync(sqlitePath);

      // Create realistic SQLite database with existing historical data
      const sqlite = new DatabaseSync(sqlitePath);
      sqlite.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT, description TEXT, status TEXT, budget_usd REAL, budget_tokens INTEGER, spent_tokens INTEGER, created_at TEXT, updated_at TEXT);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, tenant_id TEXT, project_id TEXT, title TEXT, description TEXT, assigned_agent TEXT, status TEXT, stage TEXT, tokens_used INTEGER, created_at TEXT, updated_at TEXT);
        CREATE TABLE approvals (id TEXT PRIMARY KEY, tenant_id TEXT, project_id TEXT, task_id TEXT, action_type TEXT, payload TEXT, risk_level TEXT, status TEXT, reason TEXT, requested_by TEXT, resolved_by TEXT, resolved_at TEXT, notes TEXT, created_at TEXT);
        CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, project_id TEXT, agent_role TEXT, event_type TEXT, details TEXT, timestamp TEXT);
        CREATE TABLE sandbox_runs (id TEXT PRIMARY KEY, tenant_id TEXT, project_id TEXT, task_id TEXT, command TEXT, exit_code INTEGER, stdout TEXT, stderr TEXT, duration_ms INTEGER, timed_out INTEGER, created_at TEXT);
        CREATE TABLE build_runs (id TEXT PRIMARY KEY, tenant_id TEXT, project_id TEXT, instruction TEXT, feature_name TEXT, domain TEXT, status TEXT, requirements TEXT, verification TEXT, errors TEXT, report TEXT, created_at TEXT, updated_at TEXT);

        INSERT INTO projects VALUES ('proj-legacy-1', 'tenant-default', 'Legacy Project Alpha', 'Production workspace', 'COMPLETED', 25.0, 250000, 15000, '2026-03-01T10:00:00.000Z', '2026-03-01T12:00:00.000Z');
        INSERT INTO tasks VALUES ('task-legacy-1', 'tenant-default', 'proj-legacy-1', 'Setup Auth', 'Implement JWT', 'CODER', 'COMPLETED', 'IMPLEMENTATION', 2500, '2026-03-01T10:05:00.000Z', '2026-03-01T10:30:00.000Z');
        INSERT INTO approvals VALUES ('appr-legacy-1', 'tenant-default', 'proj-legacy-1', 'task-legacy-1', 'CONTAINER_RUN', '{"cmd":"npm test"}', 'LOW', 'APPROVED', 'Unit tests pass', 'AGENT_CODER', 'ADMIN', '2026-03-01T10:35:00.000Z', 'Approved', '2026-03-01T10:32:00.000Z');
        INSERT INTO audit_logs VALUES (1, 'tenant-default', 'proj-legacy-1', 'SYSTEM', 'PROJECT_CREATED', 'Project initialized', '2026-03-01T10:00:00.000Z');
        INSERT INTO sandbox_runs VALUES ('srun-legacy-1', 'tenant-default', 'proj-legacy-1', 'task-legacy-1', 'npm test', 0, '12 tests passed', '', 1420, 0, '2026-03-01T10:40:00.000Z');
        INSERT INTO build_runs VALUES ('brun-legacy-1', 'tenant-default', 'proj-legacy-1', 'Build ecommerce app', 'Auth Module', 'ECOMMERCE', 'SUCCESS', '{"REQ-1":true}', '{"passed":true}', '[]', '{"coverage":100}', '2026-03-01T11:00:00.000Z', '2026-03-01T11:30:00.000Z');
      `);
      sqlite.close();
    });

    test('creates automated pre-flight backup and transfers records without data loss', async () => {
      const migrator = new DataMigrator(sqlitePath, adapter);

      const inspection = migrator.inspectSource();
      assert.strictEqual(inspection.exists, true);
      assert.strictEqual(inspection.tables.projects, 1);
      assert.strictEqual(inspection.tables.tasks, 1);
      assert.strictEqual(inspection.tables.approvals, 1);
      assert.strictEqual(inspection.tables.audit_logs, 1);
      assert.strictEqual(inspection.tables.sandbox_runs, 1);
      assert.strictEqual(inspection.tables.build_runs, 1);

      const result = await migrator.migrateData();
      assert.strictEqual(result.migrated, true);
      assert.ok(result.backupPath && fs.existsSync(result.backupPath), 'Automated backup file must exist');
      assert.strictEqual(result.stats.projects, 1);
      assert.strictEqual(result.stats.tasks, 1);
      assert.strictEqual(result.stats.approvals, 1);
      assert.strictEqual(result.stats.logs, 1);
      assert.strictEqual(result.stats.executionRuns, 1);
      assert.strictEqual(result.stats.buildRuns, 1);

      // Verify records in PostgreSQL
      const pgProj = await adapter.getProject('proj-legacy-1');
      assert.ok(pgProj, 'Legacy project exists in PostgreSQL');
      assert.strictEqual(pgProj.name, 'Legacy Project Alpha');
      assert.strictEqual(pgProj.spent_tokens, 15000);

      const pgTask = await adapter.getTask('task-legacy-1');
      assert.ok(pgTask, 'Legacy task exists in PostgreSQL');
      assert.strictEqual(pgTask.title, 'Setup Auth');

      const pgApproval = await adapter.getApproval('appr-legacy-1');
      assert.ok(pgApproval, 'Legacy approval exists in PostgreSQL');
      assert.strictEqual(pgApproval.status, 'APPROVED');

      // Verify original SQLite database remains completely intact for rollback
      assert.ok(fs.existsSync(sqlitePath), 'Original SQLite file must not be modified or deleted');
      const verifySqlite = new DatabaseSync(sqlitePath);
      const remainingCount = verifySqlite.prepare('SELECT COUNT(*) as count FROM projects').get().count;
      verifySqlite.close();
      assert.strictEqual(remainingCount, 1, 'Original SQLite database remains 100% intact');
    });
  });

  // ── 8. SECRETS REDACTION & SENSITIVE DATA DEFENSE ────────────────────────
  describe('8. Secrets Redaction & Sensitive Data Protection', () => {
    test('sanitizeConnectionString redacts passwords, keys and secret tokens', () => {
      const urlWithPassword = 'postgres://pulse_admin:superSecretPassword123!@db.internal.net:5432/pulse_prod';
      const sanitized = sanitizeConnectionString(urlWithPassword);
      assert.strictEqual(
        sanitized,
        'postgres://pulse_admin:***@db.internal.net:5432/pulse_prod',
        'Password in connection string must be replaced with ***'
      );
      assert.doesNotMatch(sanitized, /superSecretPassword123!/);

      const urlWithKey = 'postgres://user@host:5432/db?key=sk_live_9988776655';
      const sanitizedKey = sanitizeConnectionString(urlWithKey);
      assert.strictEqual(sanitizedKey, 'postgres://user@host:5432/db?key=***');

      const paramConnStr = 'host=10.0.0.1;user=postgres;password=MySecretPassword#42;database=pulse';
      const sanitizedParam = sanitizeConnectionString(paramConnStr);
      assert.strictEqual(
        sanitizedParam,
        'host=10.0.0.1;user=postgres;password=***;database=pulse'
      );
    });

    test('PostgresStorageAdapter masks connection string in memory and error handlers', () => {
      const adapterInstance = new PostgresStorageAdapter({
        user: 'pulse_admin',
        password: 'TopSecretDbPassword!',
        host: '127.0.0.1',
        port: 5432,
        database: 'pulse_workspace'
      });

      assert.doesNotMatch(
        adapterInstance.sanitizedUrl,
        /TopSecretDbPassword!/,
        'Sanitized URL must not leak password'
      );
      assert.match(
        adapterInstance.sanitizedUrl,
        /postgres:\/\/pulse_admin:\*\*\*@127\.0\.0\.1:5432\/pulse_workspace/
      );
    });
  });

  // ── 9. DUAL-ADAPTER STORAGE ENGINE INTEGRATION ───────────────────────────
  describe('9. StorageEngine Dual Adapter Backward Compatibility', () => {
    test('StorageEngine operates in PostgreSQL mode when configured', async () => {
      await runner.migrateUp();
      const engine = new StorageEngine(null, { adapter: 'postgres', pool: testPool });
      assert.strictEqual(engine.isPostgres, true);

      const proj = await engine.createProject({ name: 'Dual Engine PG' });
      assert.ok(proj && proj.id);

      const fetched = await engine.getProject(proj.id);
      assert.strictEqual(fetched.name, 'Dual Engine PG');
    });

    test('StorageEngine operates in SQLite synchronous mode for legacy tests', () => {
      const engine = new StorageEngine(':memory:');
      assert.strictEqual(engine.isPostgres, false);

      const proj = engine.createProject({ name: 'Dual Engine SQLite' });
      assert.ok(proj && proj.id);
      assert.strictEqual(proj.name, 'Dual Engine SQLite');

      const fetched = engine.getProject(proj.id);
      assert.strictEqual(fetched.name, 'Dual Engine SQLite');
    });
  });
});
