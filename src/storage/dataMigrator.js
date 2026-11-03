import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * DataMigrator
 * Safely migrates existing SQLite persistent data into PostgreSQL.
 * Preserves the original SQLite database file intact for zero-risk rollback.
 */
export class DataMigrator {
  /**
   * @param {string} sqliteDbPath - Path to existing SQLite database
   * @param {import('./postgresAdapter.js').PostgresStorageAdapter} postgresAdapter
   * @param {Object} [options]
   */
  constructor(sqliteDbPath, postgresAdapter, options = {}) {
    this.sqliteDbPath = path.resolve(sqliteDbPath);
    this.pg = postgresAdapter;
    this.defaultTenantId = options.defaultTenantId || 'tenant-default';
    this.defaultTenantName = options.defaultTenantName || 'Default Organization';
  }

  /**
   * Create an atomic filesystem backup of SQLite database before migration
   */
  createBackup() {
    if (!fs.existsSync(this.sqliteDbPath)) {
      return null;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${this.sqliteDbPath}.backup-${timestamp}`;
    fs.copyFileSync(this.sqliteDbPath, backupPath);
    return backupPath;
  }

  /**
   * Inspect existing SQLite record counts before migration
   */
  inspectSource() {
    if (!fs.existsSync(this.sqliteDbPath)) {
      return { exists: false, tables: {} };
    }

    const sqlite = new DatabaseSync(this.sqliteDbPath);
    try {
      const getCount = (table) => {
        try {
          return sqlite.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
        } catch (_) {
          return 0;
        }
      };

      return {
        exists: true,
        path: this.sqliteDbPath,
        sizeBytes: fs.statSync(this.sqliteDbPath).size,
        tables: {
          projects: getCount('projects'),
          tasks: getCount('tasks'),
          approvals: getCount('approvals'),
          audit_logs: getCount('audit_logs'),
          sandbox_runs: getCount('sandbox_runs'),
          build_runs: getCount('build_runs')
        }
      };
    } finally {
      sqlite.close();
    }
  }

  /**
   * Execute atomic data migration from SQLite to PostgreSQL
   * If any step fails, transaction rolls back and SQLite file remains untouched.
   */
  async migrateData() {
    if (!fs.existsSync(this.sqliteDbPath)) {
      return { migrated: false, reason: 'SQLite database does not exist' };
    }

    const backupPath = this.createBackup();
    const sourceInfo = this.inspectSource();
    const sqlite = new DatabaseSync(this.sqliteDbPath);

    try {
      // 1. Fetch all existing records from SQLite
      const projects = sqlite.prepare('SELECT * FROM projects').all();
      const tasks = sqlite.prepare('SELECT * FROM tasks').all();
      const approvals = sqlite.prepare('SELECT * FROM approvals').all();
      const auditLogs = sqlite.prepare('SELECT * FROM audit_logs').all();
      const sandboxRuns = sqlite.prepare('SELECT * FROM sandbox_runs').all();
      const buildRuns = sqlite.prepare('SELECT * FROM build_runs').all();

      // 2. Perform atomic insert inside a single PostgreSQL transaction
      const stats = await this.pg.withTransaction(async (client) => {
        // Ensure default tenant exists
        await client.query(`
          INSERT INTO tenants (id, name, slug, plan, status, created_at, updated_at)
          VALUES ($1, $2, 'default', 'ENTERPRISE', 'ACTIVE', NOW(), NOW())
          ON CONFLICT (id) DO NOTHING
        `, [this.defaultTenantId, this.defaultTenantName]);

        // Ensure default admin user exists
        await client.query(`
          INSERT INTO users (id, tenant_id, email, password_hash, role, created_at, updated_at)
          VALUES ('usr-admin', $1, 'admin@nexus.cloud', 'scrypt:migrated-hash', 'ADMIN', NOW(), NOW())
          ON CONFLICT (id) DO NOTHING
        `, [this.defaultTenantId]);

        let pCount = 0;
        for (const p of projects) {
          await client.query(`
            INSERT INTO projects (id, tenant_id, owner_id, name, description, status, budget_usd, budget_tokens, spent_tokens, created_at, updated_at)
            VALUES ($1, $2, 'usr-admin', $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (id) DO NOTHING
          `, [
            p.id,
            this.defaultTenantId,
            p.name,
            p.description || '',
            p.status,
            p.budget_usd || 10.0,
            p.budget_tokens || 100000,
            p.spent_tokens || 0,
            p.created_at,
            p.updated_at
          ]);
          pCount++;
        }

        let tCount = 0;
        for (const t of tasks) {
          await client.query(`
            INSERT INTO tasks (id, tenant_id, project_id, title, description, assigned_agent, status, stage, tokens_used, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (id) DO NOTHING
          `, [
            t.id,
            this.defaultTenantId,
            t.project_id,
            t.title,
            t.description || '',
            t.assigned_agent,
            t.status,
            t.stage,
            t.tokens_used || 0,
            t.created_at,
            t.updated_at
          ]);
          tCount++;
        }

        let aCount = 0;
        for (const a of approvals) {
          await client.query(`
            INSERT INTO approvals (id, tenant_id, project_id, task_id, action_type, payload, risk_level, status, reason, requested_by, resolved_by, resolved_at, notes, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT (id) DO NOTHING
          `, [
            a.id,
            this.defaultTenantId,
            a.project_id,
            a.task_id || null,
            a.action_type,
            a.payload,
            a.risk_level,
            a.status,
            a.reason || '',
            a.requested_by,
            a.resolved_by || null,
            a.resolved_at || null,
            a.notes || '',
            a.created_at
          ]);
          aCount++;
        }

        let logCount = 0;
        for (const l of auditLogs) {
          await client.query(`
            INSERT INTO logs_metadata (tenant_id, project_id, agent_role, event_type, details, created_at)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [
            this.defaultTenantId,
            l.project_id || null,
            l.agent_role || 'SYSTEM',
            l.event_type,
            l.details || '',
            l.timestamp
          ]);
          logCount++;
        }

        let runCount = 0;
        for (const s of sandboxRuns) {
          await client.query(`
            INSERT INTO execution_runs (id, tenant_id, project_id, task_id, command, backend_used, exit_code, stdout, stderr, duration_ms, timed_out, created_at)
            VALUES ($1, $2, $3, $4, $5, 'DOCKER', $6, $7, $8, $9, $10, $11)
            ON CONFLICT (id) DO NOTHING
          `, [
            s.id,
            this.defaultTenantId,
            s.project_id,
            s.task_id || null,
            s.command,
            s.exit_code,
            s.stdout || '',
            s.stderr || '',
            s.duration_ms,
            Boolean(s.timed_out),
            s.created_at
          ]);
          runCount++;
        }

        let bCount = 0;
        for (const b of buildRuns) {
          let reqs = {};
          let verif = {};
          let errs = [];
          let rep = {};
          try { reqs = JSON.parse(b.requirements); } catch (_) {}
          try { verif = JSON.parse(b.verification); } catch (_) {}
          try { errs = JSON.parse(b.errors); } catch (_) {}
          try { rep = JSON.parse(b.report); } catch (_) {}

          await client.query(`
            INSERT INTO build_runs (id, tenant_id, project_id, instruction, feature_name, domain, status, requirements, verification, errors, report, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (id) DO NOTHING
          `, [
            b.id,
            this.defaultTenantId,
            b.project_id,
            b.instruction,
            b.feature_name,
            b.domain,
            b.status,
            JSON.stringify(reqs),
            JSON.stringify(verif),
            JSON.stringify(errs),
            JSON.stringify(rep),
            b.created_at,
            b.updated_at
          ]);
          bCount++;
        }

        return {
          projects: pCount,
          tasks: tCount,
          approvals: aCount,
          logs: logCount,
          executionRuns: runCount,
          buildRuns: bCount
        };
      });

      return {
        migrated: true,
        backupPath,
        source: sourceInfo,
        stats
      };
    } finally {
      sqlite.close();
    }
  }
}
