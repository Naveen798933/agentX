import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

import { PostgresStorageAdapter, sanitizeConnectionString } from './postgresAdapter.js';
import { TenantGuard, AuthorizationError } from './tenantGuard.js';
import { DataMigrator } from './dataMigrator.js';
import { MigrationRunner } from './migrations/migrationRunner.js';

export {
  PostgresStorageAdapter,
  sanitizeConnectionString,
  TenantGuard,
  AuthorizationError,
  DataMigrator,
  MigrationRunner
};

/**
 * StorageEngine
 * Unified storage engine supporting both PostgreSQL (for durable production persistence,
 * multi-tenant partitioning, RLS, and transaction safety) and SQLite (for zero-dependency
 * embedded local storage and backward compatibility).
 */
export class StorageEngine {
  /**
   * @param {string|Object} [dbPathOrConfig=':memory:']
   * @param {Object} [options={}]
   */
  constructor(dbPathOrConfig = ':memory:', options = {}) {
    this.options = options;
    const isExplicitPgObject = typeof dbPathOrConfig === 'object' && dbPathOrConfig !== null &&
      Boolean(dbPathOrConfig.adapter === 'postgres' || dbPathOrConfig.pool || dbPathOrConfig.connectionString || dbPathOrConfig.host || dbPathOrConfig.database);

    const isExplicitPgString = typeof dbPathOrConfig === 'string' &&
      (dbPathOrConfig.startsWith('postgres://') || dbPathOrConfig.startsWith('postgresql://'));

    const isPostgres = options.adapter === 'postgres' ||
      process.env.DATABASE_ADAPTER === 'postgres' ||
      isExplicitPgObject ||
      isExplicitPgString;

    if (isPostgres) {
      this.isPostgres = true;
      let pgConfig;
      if (typeof dbPathOrConfig === 'object' && dbPathOrConfig !== null) {
        pgConfig = { ...options, ...dbPathOrConfig };
      } else if (isExplicitPgString) {
        pgConfig = dbPathOrConfig;
      } else {
        // If dbPathOrConfig is a SQLite file path or :memory:, ignore the file path and use PostgreSQL options/env
        pgConfig = options;
      }
      this.pg = new PostgresStorageAdapter(pgConfig);
    } else {
      this.isPostgres = false;
      this.dbPath = typeof dbPathOrConfig === 'string' ? dbPathOrConfig : ':memory:';
      if (this.dbPath !== ':memory:') {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }
      this.db = new DatabaseSync(this.dbPath);
      this.initSchema();
    }
  }

  initSchema() {
    if (this.isPostgres) return;
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'CREATED',
        budget_usd REAL NOT NULL DEFAULT 10.0,
        budget_tokens INTEGER NOT NULL DEFAULT 100000,
        spent_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        assigned_agent TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        stage TEXT NOT NULL DEFAULT 'PLANNING',
        tokens_used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        project_id TEXT NOT NULL,
        task_id TEXT,
        action_type TEXT NOT NULL,
        payload TEXT,
        risk_level TEXT NOT NULL DEFAULT 'MEDIUM',
        status TEXT NOT NULL DEFAULT 'PENDING',
        reason TEXT,
        requested_by TEXT NOT NULL,
        resolved_by TEXT,
        resolved_at TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        project_id TEXT,
        agent_role TEXT,
        event_type TEXT NOT NULL,
        details TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sandbox_runs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        project_id TEXT NOT NULL,
        task_id TEXT,
        command TEXT NOT NULL,
        exit_code INTEGER,
        stdout TEXT,
        stderr TEXT,
        duration_ms INTEGER NOT NULL,
        timed_out INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS build_runs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        project_id TEXT NOT NULL,
        instruction TEXT NOT NULL,
        feature_name TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'GENERAL',
        status TEXT NOT NULL DEFAULT 'BUILDING',
        requirements TEXT NOT NULL,
        verification TEXT NOT NULL,
        errors TEXT NOT NULL,
        report TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        plan TEXT NOT NULL DEFAULT 'FREE',
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'DEVELOPER',
        name TEXT DEFAULT '',
        is_email_verified INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        failed_login_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_members (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'DEVELOPER',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, user_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        user_agent TEXT,
        ip_address TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS password_resets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS email_verifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        verified_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS auth_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT,
        user_id TEXT,
        action TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        details TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS generation_jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        project_id TEXT NOT NULL,
        queue_name TEXT NOT NULL DEFAULT 'project-generation',
        bullmq_job_id TEXT,
        idempotency_key TEXT UNIQUE,
        created_by TEXT,
        stage TEXT NOT NULL DEFAULT 'STAGE_INTAKE',
        status TEXT NOT NULL DEFAULT 'QUEUED',
        instruction TEXT NOT NULL,
        model_used TEXT,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        progress_pct INTEGER NOT NULL DEFAULT 0,
        progress_stage TEXT,
        progress_message TEXT,
        retries_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        error_message TEXT,
        cancelled_at TEXT,
        result_payload TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS generated_artifacts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        project_id TEXT NOT NULL,
        job_id TEXT,
        file_path TEXT NOT NULL,
        file_type TEXT NOT NULL DEFAULT 'CODE',
        file_hash TEXT NOT NULL,
        file_size_bytes INTEGER NOT NULL DEFAULT 0,
        content TEXT,
        storage_backend TEXT NOT NULL DEFAULT 'LOCAL',
        storage_key TEXT NOT NULL DEFAULT '',
        content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        is_confidential INTEGER NOT NULL DEFAULT 1,
        retention_policy TEXT NOT NULL DEFAULT 'TEMPORARY_BUILD',
        expires_at TEXT,
        deleted_at TEXT,
        metadata TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, file_path, version),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS project_deployments (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        project_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        environment TEXT NOT NULL DEFAULT 'preview',
        status TEXT NOT NULL DEFAULT 'QUEUED',
        target_url TEXT,
        commit_sha TEXT,
        build_logs TEXT,
        error_message TEXT,
        env_vars TEXT,
        rollback_target_id TEXT,
        approved_by TEXT,
        approval_id TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        user_id TEXT,
        project_id TEXT,
        event_type TEXT NOT NULL,
        quantity REAL NOT NULL,
        unit TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        metadata TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS processed_webhooks (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_summary TEXT,
        processed_at TEXT NOT NULL,
        UNIQUE(provider, event_id)
      );

      CREATE TABLE IF NOT EXISTS tenant_subscriptions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'stripe',
        customer_id TEXT,
        subscription_id TEXT,
        plan TEXT NOT NULL DEFAULT 'FREE',
        status TEXT NOT NULL DEFAULT 'active',
        current_period_start TEXT,
        current_period_end TEXT,
        cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(tenant_id, provider)
      );

      CREATE TABLE IF NOT EXISTS agent_conversations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        project_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        initiator_role TEXT NOT NULL,
        target_role TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'STAGE_ARCHITECTURE',
        status TEXT NOT NULL DEFAULT 'OPEN',
        review_rounds INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        conversation_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        from_role TEXT NOT NULL,
        to_role TEXT NOT NULL,
        intent TEXT NOT NULL,
        content TEXT NOT NULL,
        artifacts_attached TEXT NOT NULL DEFAULT '[]',
        critiques TEXT NOT NULL DEFAULT '[]',
        sequence_number INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_critiques (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        message_id TEXT,
        thread_id TEXT,
        reviewer_role TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line_number INTEGER,
        severity TEXT NOT NULL DEFAULT 'WARNING',
        issue_description TEXT NOT NULL,
        suggested_fix TEXT,
        is_resolved INTEGER NOT NULL DEFAULT 0,
        resolved_at TEXT,
        resolution_note TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS organizational_memories (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        project_id TEXT,
        memory_type TEXT NOT NULL DEFAULT 'GENERAL',
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT DEFAULT '{}',
        embedding_json TEXT,
        source_file TEXT,
        confidence_score REAL NOT NULL DEFAULT 1.0,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_associations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        source_memory_id TEXT NOT NULL,
        target_memory_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL DEFAULT 'REFERENCES',
        notes TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(source_memory_id, target_memory_id, relationship_type)
      );

      CREATE TABLE IF NOT EXISTS browser_qa_sessions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        project_id TEXT NOT NULL,
        session_name TEXT NOT NULL,
        target_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        summary TEXT,
        viewport_width INTEGER NOT NULL DEFAULT 1280,
        viewport_height INTEGER NOT NULL DEFAULT 800,
        total_steps INTEGER NOT NULL DEFAULT 0,
        passed_steps INTEGER NOT NULL DEFAULT 0,
        failed_steps INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS browser_qa_steps (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        action TEXT NOT NULL,
        target_selector TEXT,
        payload TEXT,
        status TEXT NOT NULL DEFAULT 'PENDING',
        error_message TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES browser_qa_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS browser_qa_artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        step_id TEXT,
        artifact_type TEXT NOT NULL,
        file_path TEXT,
        metadata_json TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES browser_qa_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tamper_evident_audit_log (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'tenant-default',
        sequence_number INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        current_hash TEXT NOT NULL,
        signature TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        UNIQUE(tenant_id, sequence_number)
      );

      CREATE TABLE IF NOT EXISTS enterprise_sso_configs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT UNIQUE NOT NULL,
        provider_type TEXT NOT NULL,
        idp_entity_id TEXT NOT NULL,
        idp_sso_url TEXT NOT NULL,
        idp_certificate TEXT,
        client_id TEXT,
        client_secret_encrypted TEXT,
        issuer_url TEXT,
        default_role TEXT NOT NULL DEFAULT 'DEVELOPER',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Concurrency and query optimization indexes
      CREATE INDEX IF NOT EXISTS idx_audit_proj_time ON audit_logs(project_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_proj_stage ON tasks(project_id, stage);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(project_id, status);
      CREATE INDEX IF NOT EXISTS idx_sandbox_proj ON sandbox_runs(project_id);
      CREATE INDEX IF NOT EXISTS idx_build_runs_proj ON build_runs(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_project_members_proj ON project_members(project_id);
      CREATE INDEX IF NOT EXISTS idx_gen_jobs_proj ON generation_jobs(project_id, status);
      CREATE INDEX IF NOT EXISTS idx_gen_jobs_queue ON generation_jobs(queue_name, status);
      CREATE INDEX IF NOT EXISTS idx_gen_jobs_idempotency ON generation_jobs(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_gen_jobs_created_by ON generation_jobs(created_by);
      CREATE INDEX IF NOT EXISTS idx_artifacts_proj_path ON generated_artifacts(project_id, file_path);
      CREATE INDEX IF NOT EXISTS idx_artifacts_tenant_proj ON generated_artifacts(tenant_id, project_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_storage_key ON generated_artifacts(storage_key);
      CREATE INDEX IF NOT EXISTS idx_artifacts_retention_expires ON generated_artifacts(retention_policy, expires_at);
      CREATE INDEX IF NOT EXISTS idx_deployments_tenant_proj ON project_deployments(tenant_id, project_id);
      CREATE INDEX IF NOT EXISTS idx_deployments_status ON project_deployments(status);
      CREATE INDEX IF NOT EXISTS idx_deployments_env ON project_deployments(project_id, environment, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_time ON usage_events(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_events_type ON usage_events(tenant_id, event_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_events_idempotency ON usage_events(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_processed_webhooks_lookup ON processed_webhooks(provider, event_id);
      CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_tenant ON tenant_subscriptions(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_customer ON tenant_subscriptions(customer_id);
      CREATE INDEX IF NOT EXISTS idx_browser_qa_sessions_proj ON browser_qa_sessions(tenant_id, project_id, status);
      CREATE INDEX IF NOT EXISTS idx_browser_qa_steps_session ON browser_qa_steps(session_id, step_index);
      CREATE INDEX IF NOT EXISTS idx_browser_qa_artifacts_session ON browser_qa_artifacts(session_id, artifact_type);
      CREATE INDEX IF NOT EXISTS idx_tamper_audit_tenant_seq ON tamper_evident_audit_log(tenant_id, sequence_number ASC);
      CREATE INDEX IF NOT EXISTS idx_sso_configs_tenant ON enterprise_sso_configs(tenant_id, is_active);
    `);

    // Ensure tenant_id column exists on legacy tables if migrated
    const legacyTables = ['projects', 'tasks', 'approvals', 'audit_logs', 'sandbox_runs', 'build_runs'];
    for (const table of legacyTables) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant-default'`);
      } catch (_) {}
    }
  }

  // Atomic token balance deduction (race condition safe under concurrency)
  deductTokensAtomically(projectId, tokens, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.deductTokensAtomically(projectId, tokens, tenantId);
    }
    const stmt = this.db.prepare(`
      UPDATE projects
      SET spent_tokens = spent_tokens + ?, updated_at = ?
      WHERE id = ? AND (spent_tokens + ?) <= budget_tokens
    `);
    const now = new Date().toISOString();
    const res = stmt.run(tokens, now, projectId, tokens);
    return res.changes > 0;
  }

  // Projects
  createProject({ id, tenantId = 'tenant-default', name, description = '', budgetUsd = 10.0, budgetTokens = 100000 }) {
    if (this.isPostgres) {
      return this.pg.createProject({ id, tenantId, name, description, budgetUsd, budgetTokens });
    }
    const projectId = id || `proj-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO projects (id, tenant_id, name, description, status, budget_usd, budget_tokens, spent_tokens, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'CREATED', ?, ?, 0, ?, ?)
    `);
    stmt.run(projectId, tenantId, name, description ?? '', budgetUsd, budgetTokens, now, now);
    this.logAuditEvent(projectId, 'SYSTEM', 'PROJECT_CREATED', `Project ${name} created with ${budgetTokens} tokens`);
    return this.getProject(projectId);
  }

  getProject(id, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.getProject(id, tenantId);
    }
    const stmt = this.db.prepare(`SELECT * FROM projects WHERE id = ?`);
    return stmt.get(id);
  }

  listProjects(tenantId = null) {
    if (this.isPostgres) {
      return this.pg.listProjects(tenantId);
    }
    const stmt = this.db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`);
    return stmt.all();
  }

  updateProject(id, updates, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.updateProject(id, updates, tenantId);
    }
    const keyMap = {
      budgetTokens: 'budget_tokens',
      budgetUsd: 'budget_usd',
      spentTokens: 'spent_tokens',
      createdAt: 'created_at',
      updatedAt: 'updated_at'
    };
    const now = new Date().toISOString();
    const fields = [];
    const values = [];

    for (const [rawKey, val] of Object.entries(updates)) {
      const key = keyMap[rawKey] || rawKey;
      fields.push(`${key} = ?`);
      values.push(val ?? null);
    }
    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    const sql = `UPDATE projects SET ${fields.join(', ')} WHERE id = ?`;
    const stmt = this.db.prepare(sql);
    stmt.run(...values);
    return this.getProject(id);
  }

  deleteProject(id, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.deleteProject(id, tenantId);
    }
    const stmt = this.db.prepare(`DELETE FROM projects WHERE id = ?`);
    const res = stmt.run(id);
    this.logAuditEvent(id, 'SYSTEM', 'PROJECT_DELETED', `Project ${id} deleted`);
    return res.changes > 0;
  }

  // Tasks
  createTask({ id, tenantId = 'tenant-default', projectId, title, description = '', assignedAgent = 'SYSTEM', stage = 'PLANNING' }) {
    if (this.isPostgres) {
      return this.pg.createTask({ id, tenantId, projectId, title, description, assignedAgent, stage });
    }
    const taskId = id || `task-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, tenant_id, project_id, title, description, assigned_agent, status, stage, tokens_used, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, 0, ?, ?)
    `);
    stmt.run(taskId, tenantId, projectId, title, description ?? '', assignedAgent, stage, now, now);
    this.logAuditEvent(projectId, assignedAgent, 'TASK_CREATED', `Task "${title}" created`);
    return this.getTask(taskId);
  }

  getTask(id, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.getTask(id, tenantId);
    }
    const stmt = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`);
    return stmt.get(id);
  }

  listTasks(projectId, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.listTasks(projectId, tenantId);
    }
    const stmt = this.db.prepare(`SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC`);
    return stmt.all(projectId);
  }

  updateTask(id, updates, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.updateTask(id, updates, tenantId);
    }
    const keyMap = {
      projectId: 'project_id',
      assignedAgent: 'assigned_agent',
      tokensUsed: 'tokens_used',
      createdAt: 'created_at',
      updatedAt: 'updated_at'
    };
    const now = new Date().toISOString();
    const fields = [];
    const values = [];

    for (const [rawKey, val] of Object.entries(updates)) {
      const key = keyMap[rawKey] || rawKey;
      fields.push(`${key} = ?`);
      values.push(val ?? null);
    }
    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    const sql = `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`;
    const stmt = this.db.prepare(sql);
    stmt.run(...values);
    return this.getTask(id);
  }

  deleteTask(id, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.deleteTask(id, tenantId);
    }
    const stmt = this.db.prepare(`DELETE FROM tasks WHERE id = ?`);
    const res = stmt.run(id);
    return res.changes > 0;
  }

  // Approvals
  createApproval({ id, tenantId = 'tenant-default', projectId, taskId = null, actionType, payload = '', riskLevel = 'MEDIUM', reason = '', requestedBy = 'OPERATOR' }) {
    if (this.isPostgres) {
      return this.pg.createApproval({ id, tenantId, projectId, taskId, actionType, payload, riskLevel, reason, requestedBy });
    }
    const now = new Date().toISOString();
    const reqBy = requestedBy || 'OPERATOR';
    const stmt = this.db.prepare(`
      INSERT INTO approvals (id, tenant_id, project_id, task_id, action_type, payload, risk_level, status, reason, requested_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
    `);
    stmt.run(
      id,
      tenantId,
      projectId,
      taskId ?? null,
      actionType,
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      riskLevel,
      reason ?? '',
      reqBy,
      now
    );
    this.logAuditEvent(projectId, requestedBy, 'APPROVAL_REQUESTED', `Approval requested for ${actionType} (${riskLevel} risk)`);
    return this.getApproval(id);
  }

  getApproval(id, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.getApproval(id, tenantId);
    }
    const stmt = this.db.prepare(`SELECT * FROM approvals WHERE id = ?`);
    return stmt.get(id);
  }

  listApprovals(projectId, status = null, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.listApprovals(projectId, status, tenantId);
    }
    if (status) {
      const stmt = this.db.prepare(`SELECT * FROM approvals WHERE project_id = ? AND status = ? ORDER BY created_at DESC`);
      return stmt.all(projectId, status);
    }
    const stmt = this.db.prepare(`SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at DESC`);
    return stmt.all(projectId);
  }

  updateApproval(id, { status, resolvedBy, notes = '' }, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.updateApproval(id, { status, resolvedBy, notes }, tenantId);
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE approvals
      SET status = ?, resolved_by = ?, resolved_at = ?, notes = ?
      WHERE id = ?
    `);
    stmt.run(status, resolvedBy ?? 'OPERATOR', now, notes ?? '', id);
    const approval = this.getApproval(id);
    this.logAuditEvent(approval.project_id, resolvedBy || 'OPERATOR', `APPROVAL_${status}`, `Approval ${id} marked ${status}`);
    return approval;
  }

  // Audit Logs
  logAuditEvent(projectId, agentRole, eventType, details = '', tenantId = 'tenant-default') {
    if (this.isPostgres) {
      return this.pg.logAuditEvent(tenantId, projectId, agentRole, eventType, details);
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (tenant_id, project_id, agent_role, event_type, details, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(tenantId, projectId, agentRole, eventType, details ?? '', now);
  }

  getAuditLogs(projectId, limit = 100, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.getAuditLogs(projectId, limit, tenantId);
    }
    const stmt = this.db.prepare(`
      SELECT * FROM audit_logs
      WHERE project_id = ?
      ORDER BY id DESC
      LIMIT ?
    `);
    return stmt.all(projectId, limit);
  }

  // Sandbox Runs
  recordSandboxRun({ id, tenantId = 'tenant-default', projectId, taskId = null, command, exitCode, stdout = '', stderr = '', durationMs = 0, timedOut = 0 }) {
    if (this.isPostgres) {
      return this.pg.recordExecutionRun({
        id,
        tenantId,
        projectId,
        taskId,
        command,
        exitCode,
        stdout,
        stderr,
        durationMs,
        timedOut: Boolean(timedOut)
      });
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sandbox_runs (id, tenant_id, project_id, task_id, command, exit_code, stdout, stderr, duration_ms, timed_out, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      tenantId,
      projectId,
      taskId ?? null,
      command,
      exitCode ?? 0,
      stdout ?? '',
      stderr ?? '',
      durationMs,
      timedOut ? 1 : 0,
      now
    );
  }

  // Build Runs & Persistent Audit Reports
  createBuildRun({ id, tenantId = 'tenant-default', projectId, instruction, featureName, domain = 'GENERAL', status = 'BUILDING', requirements = {}, verification = {}, errors = [], report = {} }) {
    if (this.isPostgres) {
      return this.pg.createBuildRun({ id, tenantId, projectId, instruction, featureName, domain, status, requirements, verification, errors, report });
    }
    const runId = id || `run-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO build_runs (id, tenant_id, project_id, instruction, feature_name, domain, status, requirements, verification, errors, report, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      runId,
      tenantId,
      projectId,
      instruction,
      featureName,
      domain,
      status,
      JSON.stringify(requirements),
      JSON.stringify(verification),
      JSON.stringify(errors),
      JSON.stringify(report),
      now,
      now
    );
    return this.getBuildRun(runId);
  }

  updateBuildRun(id, updates = {}) {
    if (this.isPostgres) return this.pg.updateBuildRun(id, updates);
    const existing = this.getBuildRun(id);
    if (!existing) throw new Error(`Build run ${id} not found`);

    const now = new Date().toISOString();
    const status = updates.status !== undefined ? updates.status : existing.status;
    const requirements = updates.requirements !== undefined ? JSON.stringify(updates.requirements) : existing.requirementsRaw;
    const verification = updates.verification !== undefined ? JSON.stringify(updates.verification) : existing.verificationRaw;
    const errors = updates.errors !== undefined ? JSON.stringify(updates.errors) : existing.errorsRaw;
    const report = updates.report !== undefined ? JSON.stringify(updates.report) : existing.reportRaw;

    const stmt = this.db.prepare(`
      UPDATE build_runs
      SET status = ?, requirements = ?, verification = ?, errors = ?, report = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(status, requirements, verification, errors, report, now, id);
    return this.getBuildRun(id);
  }

  getBuildRun(id) {
    if (this.isPostgres) return this.pg.getBuildRun(id);
    const stmt = this.db.prepare(`SELECT * FROM build_runs WHERE id = ?`);
    const row = stmt.get(id);
    if (!row) return null;
    return this._formatBuildRun(row);
  }

  listBuildRuns(projectId, limit = 20) {
    if (this.isPostgres) return this.pg.listBuildRuns(projectId, limit);
    const safeLimit = Math.max(1, Math.min(200, parseInt(limit, 10) || 20));
    const stmt = this.db.prepare(`
      SELECT * FROM build_runs
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(projectId, safeLimit);
    return rows.map(r => this._formatBuildRun(r));
  }

  getLatestBuildRun(projectId) {
    if (this.isPostgres) return this.pg.getLatestBuildRun(projectId);
    const stmt = this.db.prepare(`
      SELECT * FROM build_runs
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(projectId);
    if (!row) return null;
    return this._formatBuildRun(row);
  }

  _formatBuildRun(row) {
    let requirements = {};
    let verification = {};
    let errors = [];
    let report = {};
    try { requirements = JSON.parse(row.requirements); } catch (_) {}
    try { verification = JSON.parse(row.verification); } catch (_) {}
    try { errors = JSON.parse(row.errors); } catch (_) {}
    try { report = JSON.parse(row.report); } catch (_) {}

    return {
      id: row.id,
      projectId: row.project_id,
      tenantId: row.tenant_id,
      instruction: row.instruction,
      featureName: row.feature_name,
      domain: row.domain,
      status: row.status,
      requirements,
      verification,
      errors,
      report,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      requirementsRaw: row.requirements,
      verificationRaw: row.verification,
      errorsRaw: row.errors,
      reportRaw: row.report
    };
  }

  // ── AUTH, USERS & RBAC PERSISTENCE ──────────────────────────────────────
  createUser({ id, tenantId = 'tenant-default', email, passwordHash, role = 'DEVELOPER', name = '', isEmailVerified = false, status = 'ACTIVE' }) {
    if (this.isPostgres) {
      return this.pg.createUser({ id, tenantId, email, passwordHash, role, name, isEmailVerified, status });
    }
    const userId = id || `usr-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO users (id, tenant_id, email, password_hash, role, name, is_email_verified, status, failed_login_attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);
    stmt.run(userId, tenantId, email.toLowerCase().trim(), passwordHash, role, name, isEmailVerified ? 1 : 0, status, now, now);
    return this.getUserById(userId);
  }

  getUserById(id) {
    if (this.isPostgres) {
      return this.pg.getUserById(id);
    }
    const stmt = this.db.prepare(`SELECT * FROM users WHERE id = ?`);
    const row = stmt.get(id);
    if (!row) return null;
    return {
      ...row,
      isEmailVerified: Boolean(row.is_email_verified),
      failedLoginAttempts: row.failed_login_attempts,
      lockedUntil: row.locked_until
    };
  }

  getUserByEmail(email) {
    if (!email) return null;
    if (this.isPostgres) {
      return this.pg.getUserByEmail(email);
    }
    const stmt = this.db.prepare(`SELECT * FROM users WHERE LOWER(email) = LOWER(?)`);
    const row = stmt.get(email.trim());
    if (!row) return null;
    return {
      ...row,
      isEmailVerified: Boolean(row.is_email_verified),
      failedLoginAttempts: row.failed_login_attempts,
      lockedUntil: row.locked_until
    };
  }

  updateUser(id, updates = {}) {
    if (this.isPostgres) {
      return this.pg.updateUser(id, updates);
    }
    const allowedFields = {
      passwordHash: 'password_hash',
      role: 'role',
      name: 'name',
      isEmailVerified: 'is_email_verified',
      status: 'status',
      failedLoginAttempts: 'failed_login_attempts',
      lockedUntil: 'locked_until'
    };

    const setClauses = [];
    const values = [];

    for (const [key, col] of Object.entries(allowedFields)) {
      if (updates[key] !== undefined) {
        setClauses.push(`${col} = ?`);
        let val = updates[key];
        if (typeof val === 'boolean') val = val ? 1 : 0;
        values.push(val);
      }
    }

    setClauses.push(`updated_at = ?`);
    values.push(new Date().toISOString());
    values.push(id);

    const sql = `UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`;
    const stmt = this.db.prepare(sql);
    stmt.run(...values);
    return this.getUserById(id);
  }

  createTenant({ id, name, slug, plan = 'FREE', status = 'ACTIVE' }) {
    if (this.isPostgres) {
      return this.pg.createTenant({ id, name, slug, plan, status });
    }
    const tenantId = id || `tenant-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO tenants (id, name, slug, plan, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(tenantId, name, slug, plan, status, now, now);
    return this.getTenantById(tenantId);
  }

  getTenantById(id) {
    if (this.isPostgres) {
      return this.pg.getTenantById(id);
    }
    const stmt = this.db.prepare(`SELECT * FROM tenants WHERE id = ?`);
    return stmt.get(id) || null;
  }

  getTenant(id) {
    return this.getTenantById(id);
  }

  createRefreshToken({ id, userId, tenantId = 'tenant-default', tokenHash, expiresAt, userAgent = null, ipAddress = null }) {
    if (this.isPostgres) {
      return this.pg.createRefreshToken({ id, userId, tenantId, tokenHash, expiresAt, userAgent, ipAddress });
    }
    const tokenId = id || `tok-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const expStr = expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt;
    const stmt = this.db.prepare(`
      INSERT INTO refresh_tokens (id, user_id, tenant_id, token_hash, expires_at, user_agent, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(tokenId, userId, tenantId, tokenHash, expStr, userAgent, ipAddress, now);
    return this.getRefreshTokenByHash(tokenHash);
  }

  getRefreshTokenByHash(tokenHash) {
    if (this.isPostgres) {
      return this.pg.getRefreshTokenByHash(tokenHash);
    }
    const stmt = this.db.prepare(`SELECT * FROM refresh_tokens WHERE token_hash = ?`);
    return stmt.get(tokenHash) || null;
  }

  revokeRefreshToken(tokenHash) {
    if (this.isPostgres) {
      return this.pg.revokeRefreshToken(tokenHash);
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?`);
    stmt.run(now, tokenHash);
    return this.getRefreshTokenByHash(tokenHash);
  }

  revokeAllUserRefreshTokens(userId) {
    if (this.isPostgres) {
      return this.pg.revokeAllUserRefreshTokens(userId);
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`);
    stmt.run(now, userId);
  }

  createPasswordReset({ id, userId, tokenHash, expiresAt }) {
    if (this.isPostgres) {
      return this.pg.createPasswordReset({ id, userId, tokenHash, expiresAt });
    }
    const resetId = id || `rst-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const expStr = expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt;
    const stmt = this.db.prepare(`
      INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(resetId, userId, tokenHash, expStr, now);
    return this.getPasswordResetByHash(tokenHash);
  }

  getPasswordResetByHash(tokenHash) {
    if (this.isPostgres) {
      return this.pg.getPasswordResetByHash(tokenHash);
    }
    const stmt = this.db.prepare(`SELECT * FROM password_resets WHERE token_hash = ?`);
    return stmt.get(tokenHash) || null;
  }

  markPasswordResetUsed(tokenHash) {
    if (this.isPostgres) {
      return this.pg.markPasswordResetUsed(tokenHash);
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`UPDATE password_resets SET used_at = ? WHERE token_hash = ?`);
    stmt.run(now, tokenHash);
    return this.getPasswordResetByHash(tokenHash);
  }

  createEmailVerification({ id, userId, tokenHash, expiresAt }) {
    if (this.isPostgres) {
      return this.pg.createEmailVerification({ id, userId, tokenHash, expiresAt });
    }
    const verifId = id || `ver-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const expStr = expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt;
    const stmt = this.db.prepare(`
      INSERT INTO email_verifications (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(verifId, userId, tokenHash, expStr, now);
    return this.getEmailVerificationByHash(tokenHash);
  }

  getEmailVerificationByHash(tokenHash) {
    if (this.isPostgres) {
      return this.pg.getEmailVerificationByHash(tokenHash);
    }
    const stmt = this.db.prepare(`SELECT * FROM email_verifications WHERE token_hash = ?`);
    return stmt.get(tokenHash) || null;
  }

  markEmailVerificationUsed(tokenHash) {
    if (this.isPostgres) {
      return this.pg.markEmailVerificationUsed(tokenHash);
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`UPDATE email_verifications SET verified_at = ? WHERE token_hash = ?`);
    stmt.run(now, tokenHash);
    return this.getEmailVerificationByHash(tokenHash);
  }

  addProjectMember({ id, tenantId = 'tenant-default', projectId, userId, role = 'DEVELOPER' }) {
    if (this.isPostgres) {
      return this.pg.addProjectMember({ id, tenantId, projectId, userId, role });
    }
    const memberId = id || `pmem-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO project_members (id, tenant_id, project_id, user_id, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at
    `);
    stmt.run(memberId, tenantId, projectId, userId, role, now, now);
    return this.getProjectMember(projectId, userId);
  }

  getProjectMember(projectId, userId) {
    if (this.isPostgres) {
      return this.pg.getProjectMember(projectId, userId);
    }
    const stmt = this.db.prepare(`SELECT * FROM project_members WHERE project_id = ? AND user_id = ?`);
    return stmt.get(projectId, userId) || null;
  }

  listProjectMembers(projectId) {
    if (this.isPostgres) {
      return this.pg.listProjectMembers(projectId);
    }
    const stmt = this.db.prepare(`
      SELECT pm.*, u.email, u.name, u.role as system_role
      FROM project_members pm
      JOIN users u ON pm.user_id = u.id
      WHERE pm.project_id = ?
      ORDER BY pm.created_at ASC
    `);
    return stmt.all(projectId);
  }

  removeProjectMember(projectId, userId) {
    if (this.isPostgres) {
      return this.pg.removeProjectMember(projectId, userId);
    }
    const stmt = this.db.prepare(`DELETE FROM project_members WHERE project_id = ? AND user_id = ?`);
    const res = stmt.run(projectId, userId);
    return res.changes > 0;
  }

  recordAuthAudit({ tenantId = 'tenant-default', userId = null, action, ipAddress = null, userAgent = null, details = null }) {
    if (this.isPostgres) {
      return this.pg.recordAuthAudit({ tenantId, userId, action, ipAddress, userAgent, details });
    }
    const now = new Date().toISOString();
    const detailsStr = typeof details === 'object' && details !== null ? JSON.stringify(details) : details;
    const stmt = this.db.prepare(`
      INSERT INTO auth_audit_logs (tenant_id, user_id, action, ip_address, user_agent, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(tenantId, userId, action, ipAddress, userAgent, detailsStr, now);
    return { id: res.lastInsertRowid, tenantId, userId, action, createdAt: now };
  }

  listAuthAuditLogs({ tenantId = null, userId = null, limit = 50 } = {}) {
    if (this.isPostgres) {
      return this.pg.listAuthAuditLogs({ tenantId, userId, limit });
    }
    const conditions = [];
    const params = [];

    if (tenantId) {
      conditions.push(`tenant_id = ?`);
      params.push(tenantId);
    }
    if (userId) {
      conditions.push(`user_id = ?`);
      params.push(userId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const stmt = this.db.prepare(`SELECT * FROM auth_audit_logs ${where} ORDER BY created_at DESC LIMIT ?`);
    return stmt.all(...params);
  }

  // Generation Jobs (Async BullMQ & Persistence)
  createGenerationJob({
    id,
    tenantId = 'tenant-default',
    projectId,
    stage = 'STAGE_INTAKE',
    status = 'QUEUED',
    instruction = '',
    modelUsed = null,
    queueName = 'project-generation',
    bullmqJobId = null,
    idempotencyKey = null,
    createdBy = null,
    maxRetries = 3,
    progressPct = 0,
    progressStage = null,
    progressMessage = null
  }) {
    if (this.isPostgres) {
      return this.pg.createGenerationJob({
        id, tenantId, projectId, stage, status, instruction, modelUsed,
        queueName, bullmqJobId, idempotencyKey, createdBy, maxRetries,
        progressPct, progressStage, progressMessage
      });
    }
    const jobId = id || `job-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const startedAt = (status === 'RUNNING') ? now : null;

    const stmt = this.db.prepare(`
      INSERT INTO generation_jobs (
        id, tenant_id, project_id, stage, status, instruction, model_used,
        queue_name, bullmq_job_id, idempotency_key, created_by, max_retries,
        progress_pct, progress_stage, progress_message,
        started_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      jobId, tenantId, projectId, stage, status, instruction, modelUsed,
      queueName, bullmqJobId, idempotencyKey, createdBy, maxRetries,
      progressPct, progressStage, progressMessage,
      startedAt, now, now
    );

    return this.getGenerationJob(jobId);
  }

  getGenerationJob(id, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.getGenerationJob(id, tenantId);
    }
    let sql = `SELECT * FROM generation_jobs WHERE id = ?`;
    const params = [id];
    if (tenantId) {
      sql += ` AND tenant_id = ?`;
      params.push(tenantId);
    }
    const stmt = this.db.prepare(sql);
    const job = stmt.get(...params);
    if (!job) return null;
    return this._normalizeJob(job);
  }

  getGenerationJobByIdempotencyKey(key, tenantId = null) {
    if (!key) return null;
    if (this.isPostgres) {
      return this.pg.getGenerationJobByIdempotencyKey(key, tenantId);
    }
    let sql = `SELECT * FROM generation_jobs WHERE idempotency_key = ?`;
    const params = [key];
    if (tenantId) {
      sql += ` AND tenant_id = ?`;
      params.push(tenantId);
    }
    const stmt = this.db.prepare(sql);
    const job = stmt.get(...params);
    if (!job) return null;
    return this._normalizeJob(job);
  }

  updateGenerationJob(id, updates = {}, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.updateGenerationJob(id, updates, tenantId);
    }
    const now = new Date().toISOString();
    const fieldMap = {
      status: 'status',
      stage: 'stage',
      modelUsed: 'model_used',
      tokensUsed: 'tokens_used',
      progressPct: 'progress_pct',
      progressStage: 'progress_stage',
      progressMessage: 'progress_message',
      retriesCount: 'retries_count',
      errorMessage: 'error_message',
      bullmqJobId: 'bullmq_job_id',
      cancelledAt: 'cancelled_at',
      startedAt: 'started_at',
      completedAt: 'completed_at',
      resultPayload: 'result_payload'
    };

    const sets = [];
    const params = [];

    for (const [key, col] of Object.entries(fieldMap)) {
      if (updates[key] !== undefined) {
        let val = updates[key];
        if (key === 'resultPayload' && val !== null && typeof val === 'object') {
          val = JSON.stringify(val);
        }
        sets.push(`${col} = ?`);
        params.push(val);
      }
    }

    sets.push('updated_at = ?');
    params.push(now);

    params.push(id);
    let sql = `UPDATE generation_jobs SET ${sets.join(', ')} WHERE id = ?`;

    if (tenantId) {
      sql += ` AND tenant_id = ?`;
      params.push(tenantId);
    }

    const stmt = this.db.prepare(sql);
    stmt.run(...params);
    return this.getGenerationJob(id);
  }

  listGenerationJobs({ projectId = null, tenantId = null, queueName = null, status = null, limit = 50 } = {}) {
    if (this.isPostgres) {
      return this.pg.listGenerationJobs({ projectId, tenantId, queueName, status, limit });
    }
    const conditions = [];
    const params = [];

    if (projectId) {
      conditions.push('project_id = ?');
      params.push(projectId);
    }
    if (tenantId) {
      conditions.push('tenant_id = ?');
      params.push(tenantId);
    }
    if (queueName) {
      conditions.push('queue_name = ?');
      params.push(queueName);
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const sql = `SELECT * FROM generation_jobs ${where} ORDER BY created_at DESC LIMIT ?`;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);
    return rows.map(r => this._normalizeJob(r));
  }

  getInterruptedGenerationJobs() {
    if (this.isPostgres) {
      return this.pg.getInterruptedGenerationJobs();
    }
    const stmt = this.db.prepare(`
      SELECT * FROM generation_jobs
      WHERE status IN ('RUNNING', 'ACTIVE')
      ORDER BY created_at ASC
    `);
    const rows = stmt.all();
    return rows.map(r => this._normalizeJob(r));
  }

  completeGenerationJob(id, { tokensUsed = 0, errorMessage = null, status = 'COMPLETED', resultPayload = null }, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.completeGenerationJob(id, { tokensUsed, errorMessage, status, resultPayload }, tenantId);
    }
    const now = new Date().toISOString();
    const payloadStr = (resultPayload && typeof resultPayload === 'object') ? JSON.stringify(resultPayload) : (resultPayload || null);
    let sql = `
      UPDATE generation_jobs
      SET status = ?, tokens_used = ?, error_message = ?, completed_at = ?, updated_at = ?,
          progress_pct = CASE WHEN ? = 'COMPLETED' THEN 100 ELSE progress_pct END,
          result_payload = ?
      WHERE id = ?
    `;
    const params = [status, tokensUsed, errorMessage, now, now, status, payloadStr, id];
    if (tenantId) {
      sql += ` AND tenant_id = ?`;
      params.push(tenantId);
    }
    const stmt = this.db.prepare(sql);
    stmt.run(...params);
    return this.getGenerationJob(id);
  }

  _normalizeJob(job) {
    if (!job) return null;
    const copy = { ...job };
    if (copy.result_payload && typeof copy.result_payload === 'string') {
      try { copy.resultPayload = JSON.parse(copy.result_payload); } catch (_) { copy.resultPayload = copy.result_payload; }
    } else if (copy.result_payload) {
      copy.resultPayload = copy.result_payload;
    }
    return copy;
  }

  // ── ARTIFACT STORAGE & METADATA ──────────────────────────────────────────
  saveArtifactRecord({
    id,
    tenantId = 'tenant-default',
    projectId,
    jobId = null,
    filePath,
    fileType = 'CODE',
    fileHash,
    fileSizeBytes = 0,
    content = null,
    storageBackend = 'LOCAL',
    storageKey = '',
    contentType = 'application/octet-stream',
    isConfidential = true,
    retentionPolicy = 'TEMPORARY_BUILD',
    expiresAt = null,
    metadata = null,
    version = 1
  }) {
    if (this.isPostgres) {
      return this.pg.saveArtifactRecord({
        id, tenantId, projectId, jobId, filePath, fileType, fileHash,
        fileSizeBytes, content, storageBackend, storageKey, contentType,
        isConfidential, retentionPolicy, expiresAt, metadata, version
      });
    }

    const artifactId = id || `art-${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    const metaStr = (metadata && typeof metadata === 'object') ? JSON.stringify(metadata) : (metadata || null);
    const confidentialInt = isConfidential ? 1 : 0;

    const stmt = this.db.prepare(`
      INSERT INTO generated_artifacts (
        id, tenant_id, project_id, job_id, file_path, file_type, file_hash,
        file_size_bytes, content, storage_backend, storage_key, content_type,
        is_confidential, retention_policy, expires_at, metadata, version,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, file_path, version) DO UPDATE SET
        file_hash = excluded.file_hash,
        file_size_bytes = excluded.file_size_bytes,
        content = excluded.content,
        storage_backend = excluded.storage_backend,
        storage_key = excluded.storage_key,
        content_type = excluded.content_type,
        is_confidential = excluded.is_confidential,
        retention_policy = excluded.retention_policy,
        expires_at = excluded.expires_at,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      artifactId, tenantId, projectId, jobId, filePath, fileType, fileHash,
      fileSizeBytes, content, storageBackend, storageKey, contentType,
      confidentialInt, retentionPolicy, expiresAt, metaStr, version, now, now
    );

    return this.getArtifactRecord(artifactId);
  }

  saveArtifact(options) {
    return this.saveArtifactRecord(options);
  }

  getArtifactRecord(id) {
    if (this.isPostgres) {
      return this.pg.getArtifactRecord(id);
    }
    const stmt = this.db.prepare(`
      SELECT * FROM generated_artifacts WHERE id = ?
    `);
    const row = stmt.get(id);
    return this._normalizeArtifact(row);
  }

  listArtifactRecords(projectId, tenantId = null, filters = {}) {
    if (this.isPostgres) {
      return this.pg.listArtifactRecords(projectId, tenantId, filters);
    }
    let sql = `
      SELECT * FROM generated_artifacts
      WHERE project_id = ? AND deleted_at IS NULL
    `;
    const params = [projectId];
    if (tenantId) {
      sql += ` AND tenant_id = ?`;
      params.push(tenantId);
    }
    if (filters.fileType) {
      sql += ` AND file_type = ?`;
      params.push(filters.fileType);
    }
    if (filters.retentionPolicy) {
      sql += ` AND retention_policy = ?`;
      params.push(filters.retentionPolicy);
    }
    sql += ` ORDER BY created_at DESC`;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);
    return rows.map(r => this._normalizeArtifact(r));
  }

  listArtifacts(projectId, tenantId = null) {
    return this.listArtifactRecords(projectId, tenantId);
  }

  deleteArtifactRecord(id) {
    if (this.isPostgres) {
      return this.pg.deleteArtifactRecord(id);
    }
    const stmt = this.db.prepare(`
      DELETE FROM generated_artifacts WHERE id = ?
    `);
    const info = stmt.run(id);
    return info.changes > 0;
  }

  markArtifactDeleted(id) {
    if (this.isPostgres) {
      return this.pg.markArtifactDeleted(id);
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE generated_artifacts
      SET deleted_at = ?, updated_at = ?
      WHERE id = ?
    `);
    const info = stmt.run(now, now, id);
    return info.changes > 0;
  }

  getExpiredArtifacts(nowIso = new Date().toISOString()) {
    if (this.isPostgres) {
      return this.pg.getExpiredArtifacts(nowIso);
    }
    const stmt = this.db.prepare(`
      SELECT * FROM generated_artifacts
      WHERE expires_at IS NOT NULL
        AND expires_at <= ?
        AND deleted_at IS NULL
      ORDER BY expires_at ASC
    `);
    const rows = stmt.all(nowIso);
    return rows.map(r => this._normalizeArtifact(r));
  }

  cleanupExpiredArtifacts(nowIso = new Date().toISOString()) {
    if (this.isPostgres) {
      return this.pg.cleanupExpiredArtifacts(nowIso);
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE generated_artifacts
      SET deleted_at = ?, updated_at = ?
      WHERE expires_at IS NOT NULL
        AND expires_at <= ?
        AND deleted_at IS NULL
    `);
    const info = stmt.run(now, now, nowIso);
    return info.changes;
  }

  _normalizeArtifact(row) {
    if (!row) return null;
    const copy = { ...row };
    copy.is_confidential = Boolean(copy.is_confidential);
    copy.isConfidential = copy.is_confidential;
    if (copy.metadata && typeof copy.metadata === 'string') {
      try { copy.metadata = JSON.parse(copy.metadata); } catch (_) {}
    }
    return copy;
  }

  createDeployment(deployment) {
    if (this.isPostgres) {
      return this.pg.createDeployment(deployment);
    }
    const id = deployment.id || `dep_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO project_deployments (
        id, tenant_id, project_id, provider, environment,
        status, target_url, commit_sha, build_logs, error_message,
        env_vars, rollback_target_id, approved_by, approval_id, metadata,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const envVarsStr = deployment.env_vars && typeof deployment.env_vars === 'object'
      ? JSON.stringify(deployment.env_vars)
      : (deployment.env_vars || null);
    const metaStr = deployment.metadata && typeof deployment.metadata === 'object'
      ? JSON.stringify(deployment.metadata)
      : (deployment.metadata || null);

    stmt.run(
      id,
      deployment.tenant_id || deployment.tenantId || 'tenant-default',
      deployment.project_id || deployment.projectId,
      deployment.provider,
      deployment.environment || 'preview',
      deployment.status || 'QUEUED',
      deployment.target_url || deployment.targetUrl || null,
      deployment.commit_sha || deployment.commitSha || null,
      deployment.build_logs || deployment.buildLogs || '',
      deployment.error_message || deployment.errorMessage || null,
      envVarsStr,
      deployment.rollback_target_id || deployment.rollbackTargetId || null,
      deployment.approved_by || deployment.approvedBy || null,
      deployment.approval_id || deployment.approvalId || null,
      metaStr,
      deployment.created_at || now,
      deployment.updated_at || now
    );
    return this.getDeployment(id);
  }

  getDeployment(deploymentId, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.getDeployment(deploymentId, tenantId);
    }
    let query = `SELECT * FROM project_deployments WHERE id = ?`;
    const params = [deploymentId];
    if (tenantId) {
      query += ` AND tenant_id = ?`;
      params.push(tenantId);
    }
    const stmt = this.db.prepare(query);
    const row = stmt.get(...params);
    return this._normalizeDeployment(row);
  }

  listDeployments(projectId = null, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.listDeployments(projectId, tenantId);
    }
    const conditions = [];
    const params = [];
    if (projectId) {
      conditions.push('project_id = ?');
      params.push(projectId);
    }
    if (tenantId) {
      conditions.push('tenant_id = ?');
      params.push(tenantId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `SELECT * FROM project_deployments ${where} ORDER BY created_at DESC`;
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params);
    return rows.map(r => this._normalizeDeployment(r));
  }

  updateDeploymentStatus(deploymentId, updates = {}, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.updateDeploymentStatus(deploymentId, updates, tenantId);
    }
    const current = this.getDeployment(deploymentId, tenantId);
    if (!current) return null;

    const now = new Date().toISOString();
    const setClauses = ['updated_at = ?'];
    const params = [now];

    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      params.push(updates.status);
    }
    if (updates.target_url !== undefined || updates.targetUrl !== undefined) {
      setClauses.push('target_url = ?');
      params.push(updates.target_url ?? updates.targetUrl);
    }
    if (updates.commit_sha !== undefined || updates.commitSha !== undefined) {
      setClauses.push('commit_sha = ?');
      params.push(updates.commit_sha ?? updates.commitSha);
    }
    if (updates.build_logs !== undefined || updates.buildLogs !== undefined) {
      setClauses.push('build_logs = ?');
      params.push(updates.build_logs ?? updates.buildLogs);
    }
    if (updates.error_message !== undefined || updates.errorMessage !== undefined) {
      setClauses.push('error_message = ?');
      params.push(updates.error_message ?? updates.errorMessage);
    }
    if (updates.rollback_target_id !== undefined || updates.rollbackTargetId !== undefined) {
      setClauses.push('rollback_target_id = ?');
      params.push(updates.rollback_target_id ?? updates.rollbackTargetId);
    }
    if (updates.approved_by !== undefined || updates.approvedBy !== undefined) {
      setClauses.push('approved_by = ?');
      params.push(updates.approved_by ?? updates.approvedBy);
    }
    if (updates.approval_id !== undefined || updates.approvalId !== undefined) {
      setClauses.push('approval_id = ?');
      params.push(updates.approval_id ?? updates.approvalId);
    }

    params.push(deploymentId);
    let query = `UPDATE project_deployments SET ${setClauses.join(', ')} WHERE id = ?`;
    if (tenantId) {
      query += ` AND tenant_id = ?`;
      params.push(tenantId);
    }
    this.db.prepare(query).run(...params);
    return this.getDeployment(deploymentId, tenantId);
  }

  deleteDeployment(deploymentId, tenantId = null) {
    if (this.isPostgres) {
      return this.pg.deleteDeployment(deploymentId, tenantId);
    }
    let query = `DELETE FROM project_deployments WHERE id = ?`;
    const params = [deploymentId];
    if (tenantId) {
      query += ` AND tenant_id = ?`;
      params.push(tenantId);
    }
    const info = this.db.prepare(query).run(...params);
    return info.changes > 0;
  }

  _normalizeDeployment(row) {
    if (!row) return null;
    const copy = { ...row };
    if (copy.env_vars && typeof copy.env_vars === 'string') {
      try { copy.env_vars = JSON.parse(copy.env_vars); } catch (_) {}
    }
    if (copy.metadata && typeof copy.metadata === 'string') {
      try { copy.metadata = JSON.parse(copy.metadata); } catch (_) {}
    }
    return copy;
  }

  // ── Usage Events & Metering (Idempotent) ──────────────────────────────────
  recordUsageEvent(eventData) {
    if (this.isPostgres) {
      return this.pg.recordUsageEvent(eventData);
    }
    const {
      id = 'use_' + crypto.randomUUID().slice(0, 12),
      tenantId = 'tenant-default',
      userId = null,
      projectId = null,
      eventType,
      quantity = 1,
      unit = 'COUNT',
      idempotencyKey = null,
      metadata = null
    } = eventData;

    if (!eventType) throw new Error('eventType is required for recordUsageEvent');

    // Idempotency check: prevent duplicate counting of same operation
    if (idempotencyKey) {
      const existing = this.db.prepare('SELECT * FROM usage_events WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) {
        return { isDuplicate: true, event: this._normalizeUsageEvent(existing) };
      }
    }

    const now = new Date().toISOString();
    const metaStr = metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null;

    try {
      this.db.prepare(`
        INSERT INTO usage_events (id, tenant_id, user_id, project_id, event_type, quantity, unit, idempotency_key, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, tenantId, userId, projectId, eventType, Number(quantity), unit, idempotencyKey, metaStr, now);

      const created = this.db.prepare('SELECT * FROM usage_events WHERE id = ?').get(id);
      return { isDuplicate: false, event: this._normalizeUsageEvent(created) };
    } catch (err) {
      // Handle race condition on UNIQUE(idempotency_key)
      if (idempotencyKey && (err.message.includes('UNIQUE') || err.message.includes('constraint'))) {
        const raceExisting = this.db.prepare('SELECT * FROM usage_events WHERE idempotency_key = ?').get(idempotencyKey);
        if (raceExisting) {
          return { isDuplicate: true, event: this._normalizeUsageEvent(raceExisting) };
        }
      }
      throw err;
    }
  }

  getUsageEvents(tenantId, options = {}) {
    if (this.isPostgres) {
      return this.pg.getUsageEvents(tenantId, options);
    }
    const conditions = ['tenant_id = ?'];
    const params = [tenantId || 'tenant-default'];

    if (options.eventType) {
      conditions.push('event_type = ?');
      params.push(options.eventType);
    }
    if (options.projectId) {
      conditions.push('project_id = ?');
      params.push(options.projectId);
    }
    if (options.since) {
      conditions.push('created_at >= ?');
      params.push(options.since);
    }

    const limit = Math.max(1, Math.min(500, parseInt(options.limit, 10) || 100));
    params.push(limit);
    const sql = `SELECT * FROM usage_events WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params);
    return rows.map(r => this._normalizeUsageEvent(r));
  }

  getUsageSummary(tenantId, options = {}) {
    if (this.isPostgres) {
      return this.pg.getUsageSummary(tenantId, options);
    }
    const conditions = ['tenant_id = ?'];
    const params = [tenantId || 'tenant-default'];

    if (options.since) {
      conditions.push('created_at >= ?');
      params.push(options.since);
    }

    const sql = `
      SELECT event_type, unit, SUM(quantity) as total_quantity, COUNT(*) as event_count
      FROM usage_events
      WHERE ${conditions.join(' AND ')}
      GROUP BY event_type, unit
    `;
    const rows = this.db.prepare(sql).all(...params);

    const summary = {
      tenantId: tenantId || 'tenant-default',
      since: options.since || null,
      byType: {},
      totalEvents: 0
    };

    for (const r of rows) {
      summary.byType[r.event_type] = {
        totalQuantity: Number(r.total_quantity || 0),
        unit: r.unit,
        eventCount: Number(r.event_count || 0)
      };
      summary.totalEvents += Number(r.event_count || 0);
    }

    return summary;
  }

  _normalizeUsageEvent(row) {
    if (!row) return null;
    const copy = { ...row };
    if (copy.metadata && typeof copy.metadata === 'string') {
      try { copy.metadata = JSON.parse(copy.metadata); } catch (_) {}
    }
    return copy;
  }

  // ── Webhook Replay Protection ─────────────────────────────────────────────
  hasProcessedWebhook(provider, eventId) {
    if (this.isPostgres) {
      return this.pg.hasProcessedWebhook(provider, eventId);
    }
    const row = this.db.prepare('SELECT 1 FROM processed_webhooks WHERE provider = ? AND event_id = ?').get(provider, eventId);
    return Boolean(row);
  }

  recordProcessedWebhook({ id = 'pwh_' + crypto.randomUUID().slice(0, 12), provider, eventId, eventType, payloadSummary = null }) {
    if (this.isPostgres) {
      return this.pg.recordProcessedWebhook({ id, provider, eventId, eventType, payloadSummary });
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO processed_webhooks (id, provider, event_id, event_type, payload_summary, processed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, provider, eventId, eventType, payloadSummary, now);
    return { id, provider, eventId, eventType, processedAt: now };
  }

  // ── Tenant Subscriptions & Billing ────────────────────────────────────────
  getTenantSubscription(tenantId, provider = 'stripe') {
    if (this.isPostgres) {
      return this.pg.getTenantSubscription(tenantId, provider);
    }
    const row = this.db.prepare('SELECT * FROM tenant_subscriptions WHERE tenant_id = ? AND provider = ?').get(tenantId, provider);
    return this._normalizeSubscription(row);
  }

  upsertTenantSubscription(data) {
    if (this.isPostgres) {
      return this.pg.upsertTenantSubscription(data);
    }
    const {
      id = 'sub_' + crypto.randomUUID().slice(0, 12),
      tenantId,
      provider = 'stripe',
      customerId = null,
      subscriptionId = null,
      plan = 'FREE',
      status = 'active',
      currentPeriodStart = null,
      currentPeriodEnd = null,
      cancelAtPeriodEnd = false,
      metadata = null
    } = data;

    if (!tenantId) throw new Error('tenantId is required for upsertTenantSubscription');

    const now = new Date().toISOString();
    const metaStr = metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null;

    const existing = this.db.prepare('SELECT id FROM tenant_subscriptions WHERE tenant_id = ? AND provider = ?').get(tenantId, provider);

    if (existing) {
      this.db.prepare(`
        UPDATE tenant_subscriptions
        SET customer_id = COALESCE(?, customer_id),
            subscription_id = COALESCE(?, subscription_id),
            plan = ?,
            status = ?,
            current_period_start = ?,
            current_period_end = ?,
            cancel_at_period_end = ?,
            metadata = COALESCE(?, metadata),
            updated_at = ?
        WHERE tenant_id = ? AND provider = ?
      `).run(
        customerId,
        subscriptionId,
        plan,
        status,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd ? 1 : 0,
        metaStr,
        now,
        tenantId,
        provider
      );
    } else {
      this.db.prepare(`
        INSERT INTO tenant_subscriptions
          (id, tenant_id, provider, customer_id, subscription_id, plan, status, current_period_start, current_period_end, cancel_at_period_end, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        tenantId,
        provider,
        customerId,
        subscriptionId,
        plan,
        status,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd ? 1 : 0,
        metaStr,
        now,
        now
      );
    }

    // Keep tenant table's plan column synchronized with verified subscription status
    const tenantPlan = (status === 'active' || status === 'trialing') ? plan : 'FREE';
    try {
      this.db.prepare('UPDATE tenants SET plan = ?, updated_at = ? WHERE id = ?').run(tenantPlan, now, tenantId);
    } catch (_) {}

    return this.getTenantSubscription(tenantId, provider);
  }

  _normalizeSubscription(row) {
    if (!row) return null;
    const copy = { ...row };
    copy.cancel_at_period_end = Boolean(copy.cancel_at_period_end);
    if (copy.metadata && typeof copy.metadata === 'string') {
      try { copy.metadata = JSON.parse(copy.metadata); } catch (_) {}
    }
    return copy;
  }

  // ── Agent-to-Agent (A2A) Threads & Critiques ────────────────────────────

  createAgentConversation(conv) {
    if (this.isPostgres) {
      if (typeof this.pg.createAgentConversation === 'function') {
        return this.pg.createAgentConversation(conv);
      }
      return conv;
    }
    const stmt = this.db.prepare(`
      INSERT INTO agent_conversations (
        id, tenant_id, project_id, topic, initiator_role, target_role, stage, status, review_rounds, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      conv.id,
      conv.tenantId || 'tenant-default',
      conv.projectId,
      conv.topic,
      conv.initiatorRole,
      conv.targetRole || 'ALL',
      conv.stage || 'STAGE_ARCHITECTURE',
      conv.status || 'OPEN',
      conv.reviewRounds || 0,
      conv.createdAt || new Date().toISOString(),
      conv.updatedAt || new Date().toISOString()
    );
    return this.getAgentConversation(conv.id);
  }

  getAgentConversation(id) {
    if (this.isPostgres) {
      if (typeof this.pg.getAgentConversation === 'function') {
        return this.pg.getAgentConversation(id);
      }
      return null;
    }
    const row = this.db.prepare('SELECT * FROM agent_conversations WHERE id = ?').get(id);
    return row || null;
  }

  listAgentConversations(projectId) {
    if (this.isPostgres) {
      if (typeof this.pg.listAgentConversations === 'function') {
        return this.pg.listAgentConversations(projectId);
      }
      return [];
    }
    return this.db.prepare('SELECT * FROM agent_conversations WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
  }

  createAgentMessage(msg) {
    if (this.isPostgres) {
      if (typeof this.pg.createAgentMessage === 'function') {
        return this.pg.createAgentMessage(msg);
      }
      return msg;
    }
    const stmt = this.db.prepare(`
      INSERT INTO agent_messages (
        id, tenant_id, conversation_id, project_id, from_role, to_role, intent, content, artifacts_attached, critiques, sequence_number, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      msg.id,
      msg.tenantId || 'tenant-default',
      msg.threadId || msg.conversationId,
      msg.projectId,
      msg.fromRole,
      msg.toRole,
      msg.intent,
      msg.content,
      JSON.stringify(msg.artifactsAttached || []),
      JSON.stringify(msg.critiques || []),
      msg.sequenceNumber || 1,
      msg.createdAt || new Date().toISOString()
    );
    return msg;
  }

  listAgentMessages(conversationId) {
    if (this.isPostgres) {
      if (typeof this.pg.listAgentMessages === 'function') {
        return this.pg.listAgentMessages(conversationId);
      }
      return [];
    }
    const rows = this.db.prepare('SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY sequence_number ASC').all(conversationId);
    return rows.map(r => {
      const copy = { ...r };
      try { copy.artifacts_attached = JSON.parse(copy.artifacts_attached); } catch (_) {}
      try { copy.critiques = JSON.parse(copy.critiques); } catch (_) {}
      return copy;
    });
  }

  createAgentCritique(crit) {
    if (this.isPostgres) {
      if (typeof this.pg.createAgentCritique === 'function') {
        return this.pg.createAgentCritique(crit);
      }
      return crit;
    }
    const stmt = this.db.prepare(`
      INSERT INTO agent_critiques (
        id, tenant_id, message_id, thread_id, reviewer_role, file_path, line_number, severity, issue_description, suggested_fix, is_resolved, resolved_at, resolution_note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      crit.id,
      crit.tenantId || 'tenant-default',
      crit.messageId || null,
      crit.threadId || null,
      crit.reviewerRole,
      crit.filePath,
      crit.lineNumber || null,
      crit.severity || 'WARNING',
      crit.issueDescription,
      crit.suggestedFix || null,
      crit.isResolved ? 1 : 0,
      crit.resolvedAt || null,
      crit.resolutionNote || null,
      crit.createdAt || new Date().toISOString()
    );
    return crit;
  }

  resolveAgentCritique(id, { resolutionNote = '', resolvedAt = new Date().toISOString() } = {}) {
    if (this.isPostgres) {
      if (typeof this.pg.resolveAgentCritique === 'function') {
        return this.pg.resolveAgentCritique(id, { resolutionNote, resolvedAt });
      }
      return null;
    }
    this.db.prepare(`
      UPDATE agent_critiques
      SET is_resolved = 1, resolution_note = ?, resolved_at = ?
      WHERE id = ?
    `).run(resolutionNote, resolvedAt, id);
    return this.db.prepare('SELECT * FROM agent_critiques WHERE id = ?').get(id);
  }

  listAgentCritiques(threadId) {
    if (this.isPostgres) {
      if (typeof this.pg.listAgentCritiques === 'function') {
        return this.pg.listAgentCritiques(threadId);
      }
      return [];
    }
    return this.db.prepare('SELECT * FROM agent_critiques WHERE thread_id = ? ORDER BY created_at ASC').all(threadId);
  }

  // ── Organizational Vector Memory ────────────────────────────────────────

  createOrganizationalMemory(record) {
    if (this.isPostgres) {
      if (typeof this.pg.createOrganizationalMemory === 'function') {
        return this.pg.createOrganizationalMemory(record);
      }
      return record;
    }
    const stmt = this.db.prepare(`
      INSERT INTO organizational_memories (
        id, tenant_id, project_id, memory_type, title, content, metadata, embedding_json, source_file, confidence_score, access_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.id,
      record.tenantId || 'tenant-default',
      record.projectId || null,
      record.memoryType || 'GENERAL',
      record.title,
      record.content,
      typeof record.metadata === 'object' ? JSON.stringify(record.metadata) : (record.metadata || '{}'),
      record.embeddingJson || null,
      record.sourceFile || null,
      record.confidenceScore || 1.0,
      record.accessCount || 0,
      record.createdAt || new Date().toISOString(),
      record.updatedAt || new Date().toISOString()
    );
    return record;
  }

  getOrganizationalMemory(id) {
    if (this.isPostgres) {
      if (typeof this.pg.getOrganizationalMemory === 'function') {
        return this.pg.getOrganizationalMemory(id);
      }
      return null;
    }
    return this.db.prepare('SELECT * FROM organizational_memories WHERE id = ?').get(id) || null;
  }

  listOrganizationalMemories(tenantId = 'tenant-default', { memoryType = null, limit = 50 } = {}) {
    if (this.isPostgres) {
      if (typeof this.pg.listOrganizationalMemories === 'function') {
        return this.pg.listOrganizationalMemories(tenantId, { memoryType, limit });
      }
      return [];
    }
    if (memoryType) {
      return this.db.prepare('SELECT * FROM organizational_memories WHERE tenant_id = ? AND memory_type = ? ORDER BY created_at DESC LIMIT ?')
        .all(tenantId, memoryType, limit);
    }
    return this.db.prepare('SELECT * FROM organizational_memories WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(tenantId, limit);
  }

  createMemoryAssociation(assoc) {
    if (this.isPostgres) {
      if (typeof this.pg.createMemoryAssociation === 'function') {
        return this.pg.createMemoryAssociation(assoc);
      }
      return assoc;
    }
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO memory_associations (
        id, tenant_id, source_memory_id, target_memory_id, relationship_type, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      assoc.id || `assoc_${crypto.randomUUID().slice(0, 10)}`,
      assoc.tenantId || 'tenant-default',
      assoc.sourceMemoryId,
      assoc.targetMemoryId,
      assoc.relationshipType || 'REFERENCES',
      assoc.notes || null,
      assoc.createdAt || new Date().toISOString()
    );
    return assoc;
  }

  listMemoryAssociations(memoryId) {
    if (this.isPostgres) {
      if (typeof this.pg.listMemoryAssociations === 'function') {
        return this.pg.listMemoryAssociations(memoryId);
      }
      return [];
    }
    return this.db.prepare('SELECT * FROM memory_associations WHERE source_memory_id = ? OR target_memory_id = ?')
      .all(memoryId, memoryId);
  }

  // --- Browser QA Sessions & Artifacts ---

  createBrowserQASession(session) {
    if (this.isPostgres) {
      if (typeof this.pg.createBrowserQASession === 'function') {
        return this.pg.createBrowserQASession(session);
      }
      return session;
    }
    const id = session.id || `bqa_${crypto.randomUUID().slice(0, 10)}`;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO browser_qa_sessions (
        id, tenant_id, project_id, session_name, target_url, status,
        summary, viewport_width, viewport_height, total_steps, passed_steps,
        failed_steps, duration_ms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      session.tenantId || 'tenant-default',
      session.projectId,
      session.sessionName || 'Autonomous Browser QA Run',
      session.targetUrl,
      session.status || 'PENDING',
      session.summary || null,
      session.viewportWidth || 1280,
      session.viewportHeight || 800,
      session.totalSteps || 0,
      session.passedSteps || 0,
      session.failedSteps || 0,
      session.durationMs || 0,
      session.createdAt || now,
      session.updatedAt || now
    );
    return { ...session, id };
  }

  getBrowserQASession(id) {
    if (this.isPostgres) {
      if (typeof this.pg.getBrowserQASession === 'function') {
        return this.pg.getBrowserQASession(id);
      }
      return null;
    }
    return this.db.prepare('SELECT * FROM browser_qa_sessions WHERE id = ?').get(id) || null;
  }

  updateBrowserQASession(id, updates = {}) {
    if (this.isPostgres) {
      if (typeof this.pg.updateBrowserQASession === 'function') {
        return this.pg.updateBrowserQASession(id, updates);
      }
      return updates;
    }
    const current = this.getBrowserQASession(id);
    if (!current) return null;

    const merged = {
      status: updates.status !== undefined ? updates.status : current.status,
      summary: updates.summary !== undefined ? updates.summary : current.summary,
      total_steps: updates.totalSteps !== undefined ? updates.totalSteps : current.total_steps,
      passed_steps: updates.passedSteps !== undefined ? updates.passedSteps : current.passed_steps,
      failed_steps: updates.failedSteps !== undefined ? updates.failedSteps : current.failed_steps,
      duration_ms: updates.durationMs !== undefined ? updates.durationMs : current.duration_ms,
      updated_at: new Date().toISOString()
    };

    const stmt = this.db.prepare(`
      UPDATE browser_qa_sessions
      SET status = ?, summary = ?, total_steps = ?, passed_steps = ?,
          failed_steps = ?, duration_ms = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(
      merged.status,
      merged.summary,
      merged.total_steps,
      merged.passed_steps,
      merged.failed_steps,
      merged.duration_ms,
      merged.updated_at,
      id
    );
    return this.getBrowserQASession(id);
  }

  listBrowserQASessions(projectId, { tenantId = 'tenant-default', limit = 20 } = {}) {
    if (this.isPostgres) {
      if (typeof this.pg.listBrowserQASessions === 'function') {
        return this.pg.listBrowserQASessions(projectId, { tenantId, limit });
      }
      return [];
    }
    return this.db.prepare(`
      SELECT * FROM browser_qa_sessions
      WHERE project_id = ? AND tenant_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(projectId, tenantId, limit);
  }

  recordBrowserQAStep(step) {
    if (this.isPostgres) {
      if (typeof this.pg.recordBrowserQAStep === 'function') {
        return this.pg.recordBrowserQAStep(step);
      }
      return step;
    }
    const id = step.id || `bstep_${crypto.randomUUID().slice(0, 10)}`;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO browser_qa_steps (
        id, session_id, step_index, action, target_selector,
        payload, status, error_message, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      step.sessionId,
      step.stepIndex || 0,
      step.action,
      step.targetSelector || null,
      typeof step.payload === 'object' ? JSON.stringify(step.payload) : (step.payload || null),
      step.status || 'PENDING',
      step.errorMessage || null,
      step.durationMs || 0,
      step.createdAt || now
    );
    return { ...step, id };
  }

  listBrowserQASteps(sessionId) {
    if (this.isPostgres) {
      if (typeof this.pg.listBrowserQASteps === 'function') {
        return this.pg.listBrowserQASteps(sessionId);
      }
      return [];
    }
    return this.db.prepare(`
      SELECT * FROM browser_qa_steps
      WHERE session_id = ?
      ORDER BY step_index ASC
    `).all(sessionId);
  }

  recordBrowserQAArtifact(artifact) {
    if (this.isPostgres) {
      if (typeof this.pg.recordBrowserQAArtifact === 'function') {
        return this.pg.recordBrowserQAArtifact(artifact);
      }
      return artifact;
    }
    const id = artifact.id || `bqa_art_${crypto.randomUUID().slice(0, 10)}`;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO browser_qa_artifacts (
        id, session_id, step_id, artifact_type, file_path, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      artifact.sessionId,
      artifact.stepId || null,
      artifact.artifactType,
      artifact.filePath || null,
      typeof artifact.metadata === 'object' ? JSON.stringify(artifact.metadata) : (artifact.metadataJson || '{}'),
      artifact.createdAt || now
    );
    return { ...artifact, id };
  }

  listBrowserQAArtifacts(sessionId) {
    if (this.isPostgres) {
      if (typeof this.pg.listBrowserQAArtifacts === 'function') {
        return this.pg.listBrowserQAArtifacts(sessionId);
      }
      return [];
    }
    return this.db.prepare(`
      SELECT * FROM browser_qa_artifacts
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId);
  }

  // --- Cryptographic Tamper-Evident Audit Log ---

  appendTamperAuditLog(entry) {
    if (this.isPostgres) {
      if (typeof this.pg.appendTamperAuditLog === 'function') {
        return this.pg.appendTamperAuditLog(entry);
      }
      return entry;
    }
    const id = entry.id || `taudit_${crypto.randomUUID().slice(0, 10)}`;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO tamper_evident_audit_log (
        id, tenant_id, sequence_number, event_type, actor,
        payload_json, previous_hash, current_hash, signature, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      entry.tenantId || 'tenant-default',
      entry.sequenceNumber,
      entry.eventType,
      entry.actor,
      typeof entry.payload === 'object' ? JSON.stringify(entry.payload) : (entry.payloadJson || '{}'),
      entry.previousHash,
      entry.currentHash,
      entry.signature,
      entry.timestamp || now
    );
    return { ...entry, id };
  }

  getLatestTamperAuditLog(tenantId = 'tenant-default') {
    if (this.isPostgres) {
      if (typeof this.pg.getLatestTamperAuditLog === 'function') {
        return this.pg.getLatestTamperAuditLog(tenantId);
      }
      return null;
    }
    return this.db.prepare(`
      SELECT * FROM tamper_evident_audit_log
      WHERE tenant_id = ?
      ORDER BY sequence_number DESC
      LIMIT 1
    `).get(tenantId) || null;
  }

  listTamperAuditLogs(tenantId = 'tenant-default', { limit = 100, offset = 0 } = {}) {
    if (this.isPostgres) {
      if (typeof this.pg.listTamperAuditLogs === 'function') {
        return this.pg.listTamperAuditLogs(tenantId, { limit, offset });
      }
      return [];
    }
    return this.db.prepare(`
      SELECT * FROM tamper_evident_audit_log
      WHERE tenant_id = ?
      ORDER BY sequence_number ASC
      LIMIT ? OFFSET ?
    `).all(tenantId, limit, offset);
  }

  // --- Enterprise SSO Configs ---

  upsertSSOConfig(config) {
    if (this.isPostgres) {
      if (typeof this.pg.upsertSSOConfig === 'function') {
        return this.pg.upsertSSOConfig(config);
      }
      return config;
    }
    const id = config.id || `sso_${crypto.randomUUID().slice(0, 10)}`;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO enterprise_sso_configs (
        id, tenant_id, provider_type, idp_entity_id, idp_sso_url,
        idp_certificate, client_id, client_secret_encrypted, issuer_url,
        default_role, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        provider_type = excluded.provider_type,
        idp_entity_id = excluded.idp_entity_id,
        idp_sso_url = excluded.idp_sso_url,
        idp_certificate = excluded.idp_certificate,
        client_id = excluded.client_id,
        client_secret_encrypted = excluded.client_secret_encrypted,
        issuer_url = excluded.issuer_url,
        default_role = excluded.default_role,
        is_active = excluded.is_active,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      id,
      config.tenantId || 'tenant-default',
      config.providerType || 'OIDC',
      config.idpEntityId,
      config.idpSsoUrl,
      config.idpCertificate || null,
      config.clientId || null,
      config.clientSecretEncrypted || null,
      config.issuerUrl || null,
      config.defaultRole || 'DEVELOPER',
      config.isActive !== false ? 1 : 0,
      config.createdAt || now,
      config.updatedAt || now
    );
    return this.getSSOConfig(config.tenantId || 'tenant-default');
  }

  getSSOConfig(tenantId = 'tenant-default') {
    if (this.isPostgres) {
      if (typeof this.pg.getSSOConfig === 'function') {
        return this.pg.getSSOConfig(tenantId);
      }
      return null;
    }
    return this.db.prepare('SELECT * FROM enterprise_sso_configs WHERE tenant_id = ?').get(tenantId) || null;
  }

  close() {
    if (this.isPostgres) {
      return this.pg.close();
    }
    if (this.db) {
      try {
        this.db.close();
      } catch (_) {}
    }
  }
}
