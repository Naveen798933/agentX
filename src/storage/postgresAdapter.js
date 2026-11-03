import pg from 'pg';
import crypto from 'node:crypto';

const { Pool } = pg;

/**
 * Redact passwords and credentials from connection strings and logs
 */
export function sanitizeConnectionString(connStr = '') {
  if (!connStr || typeof connStr !== 'string') return '';
  return connStr
    .replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+(@)/gi, '$1***$2')
    .replace(/(password=)[^&; ]+/gi, '$1***')
    .replace(/(key=)[^&; ]+/gi, '$1***');
}

/**
 * PostgresStorageAdapter
 * Production PostgreSQL driver supporting connection pooling, parameterized queries,
 * atomic transactions, multi-tenant isolation, and Row-Level Security (RLS) contexts.
 */
export class PostgresStorageAdapter {
  /**
   * @param {Object|string} config - Connection string (DATABASE_URL) or pg.Pool options
   */
  constructor(config = {}) {
    const cfg = config || {};
    let poolConfig = {};

    if (typeof cfg === 'string') {
      poolConfig = { connectionString: cfg };
    } else if (cfg.connectionString) {
      poolConfig = { ...cfg };
    } else {
      poolConfig = {
        connectionString: process.env.DATABASE_URL || undefined,
        host: cfg.host || process.env.POSTGRES_HOST || '127.0.0.1',
        port: Number(cfg.port || process.env.POSTGRES_PORT || 5432),
        database: cfg.database || process.env.POSTGRES_DB || 'pulse_workspace',
        user: cfg.user || process.env.POSTGRES_USER || 'postgres',
        password: cfg.password || process.env.POSTGRES_PASSWORD || '',
        max: Number(cfg.maxConnections || process.env.POSTGRES_POOL_MAX || 10),
        idleTimeoutMillis: Number(cfg.idleTimeoutMillis || 30000),
        connectionTimeoutMillis: Number(cfg.connectionTimeoutMillis || 5000),
        ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false
      };
    }

    this.rawConfig = poolConfig;
    const userPass = poolConfig.password
      ? `${poolConfig.user}:${poolConfig.password}`
      : `${poolConfig.user}`;
    this.sanitizedUrl = sanitizeConnectionString(
      poolConfig.connectionString || `postgres://${userPass}@${poolConfig.host}:${poolConfig.port}/${poolConfig.database}`
    );

    // If a custom pool or client mock is provided (e.g. pg-mem for testing)
    if (cfg.pool) {
      this.pool = cfg.pool;
    } else {
      this.pool = new Pool(poolConfig);
      this.pool.on('error', (err) => {
        console.error(`[PostgreSQL Pool Error]: ${err.message}`);
      });
    }
  }

  /**
   * Execute single parameterized query against the connection pool
   */
  async query(text, params = []) {
    return this.pool.query(text, params);
  }

  /**
   * Execute callback within an atomic transaction, with optional tenant RLS context
   * Multi-step updates succeed together or roll back completely on failure.
   */
  async withTransaction(callback, tenantId = null) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (tenantId) {
        await client.query(`SET LOCAL app.current_tenant_id = $1`, [tenantId]);
      }
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Execute callback inside a tenant-scoped connection with RLS context
   */
  async withTenantContext(tenantId, callback) {
    if (!tenantId) throw new Error('Tenant context requires a non-empty tenantId');
    const client = await this.pool.connect();
    try {
      await client.query(`SET LOCAL app.current_tenant_id = $1`, [tenantId]);
      return await callback(client);
    } finally {
      client.release();
    }
  }

  // ── TENANTS ──────────────────────────────────────────────────────────────
  async createTenant({ id, name, slug, plan = 'FREE' }) {
    const tenantId = id || `tenant-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO tenants (id, name, slug, plan, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5)
      RETURNING *
    `;
    const res = await this.query(sql, [tenantId, name, slug, plan, now]);
    return res.rows[0];
  }

  async getTenant(id) {
    const res = await this.query(`SELECT * FROM tenants WHERE id = $1`, [id]);
    return res.rows[0] || null;
  }

  async getTenantBySlug(slug) {
    const res = await this.query(`SELECT * FROM tenants WHERE slug = $1`, [slug]);
    return res.rows[0] || null;
  }

  // ── USERS ────────────────────────────────────────────────────────────────
  async createUser({ id, tenantId, email, passwordHash, role = 'DEVELOPER' }) {
    const userId = id || `usr-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO users (id, tenant_id, email, password_hash, role, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $6)
      RETURNING id, tenant_id, email, role, created_at, updated_at
    `;
    const res = await this.query(sql, [userId, tenantId, email, passwordHash, role, now]);
    return res.rows[0];
  }

  async getUser(id) {
    const res = await this.query(`SELECT id, tenant_id, email, role, created_at, updated_at FROM users WHERE id = $1`, [id]);
    return res.rows[0] || null;
  }

  async getUserByEmail(email) {
    const res = await this.query(`SELECT * FROM users WHERE email = $1`, [email]);
    return res.rows[0] || null;
  }

  // ── PROJECTS & ATOMIC TOKEN BALANCE ──────────────────────────────────────
  async createProject({ id, tenantId = 'tenant-default', ownerId = null, name, description = '', budgetUsd = 10.0, budgetTokens = 100000 }) {
    const projectId = id || `proj-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO projects (id, tenant_id, owner_id, name, description, status, budget_usd, budget_tokens, spent_tokens, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 'CREATED', $6, $7, 0, $8, $8)
      RETURNING *
    `;
    const res = await this.query(sql, [projectId, tenantId, ownerId, name, description ?? '', budgetUsd, budgetTokens, now]);
    await this.logAuditEvent(tenantId, projectId, 'SYSTEM', 'PROJECT_CREATED', `Project "${name}" created with ${budgetTokens} tokens`);
    return res.rows[0];
  }

  async getProject(id, tenantId = null) {
    if (tenantId) {
      const res = await this.query(`SELECT * FROM projects WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
      return res.rows[0] || null;
    }
    const res = await this.query(`SELECT * FROM projects WHERE id = $1`, [id]);
    return res.rows[0] || null;
  }

  async listProjects(tenantId = null) {
    if (tenantId) {
      const res = await this.query(`SELECT * FROM projects WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
      return res.rows;
    }
    const res = await this.query(`SELECT * FROM projects ORDER BY created_at DESC`);
    return res.rows;
  }

  async updateProject(id, updates, tenantId = null) {
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
    let idx = 1;

    for (const [rawKey, val] of Object.entries(updates)) {
      const key = keyMap[rawKey] || rawKey;
      fields.push(`${key} = $${idx++}`);
      values.push(val ?? null);
    }
    fields.push(`updated_at = $${idx++}`);
    values.push(now);

    values.push(id);
    let sql = `UPDATE projects SET ${fields.join(', ')} WHERE id = $${idx++}`;
    if (tenantId) {
      sql += ` AND tenant_id = $${idx++}`;
      values.push(tenantId);
    }
    sql += ` RETURNING *`;

    const res = await this.query(sql, values);
    return res.rows[0] || null;
  }

  async deleteProject(id, tenantId = null) {
    let sql = `DELETE FROM projects WHERE id = $1`;
    const params = [id];
    if (tenantId) {
      sql += ` AND tenant_id = $2`;
      params.push(tenantId);
    }
    const res = await this.query(sql, params);
    return res.rowCount > 0;
  }

  /**
   * Atomic token balance deduction (race condition safe under concurrency)
   * Prevents overdrafts using atomic PostgreSQL UPDATE condition
   */
  async deductTokensAtomically(projectId, tokens, tenantId = null) {
    const now = new Date().toISOString();
    let sql = `
      UPDATE projects
      SET spent_tokens = spent_tokens + $1, updated_at = $2
      WHERE id = $3 AND (spent_tokens + $1) <= budget_tokens
    `;
    const params = [tokens, now, projectId];
    if (tenantId) {
      sql += ` AND tenant_id = $4`;
      params.push(tenantId);
    }
    sql += ` RETURNING *`;

    const res = await this.query(sql, params);
    return res.rowCount > 0;
  }

  // ── TASKS ────────────────────────────────────────────────────────────────
  async createTask({ id, tenantId = 'tenant-default', projectId, title, description = '', assignedAgent = 'SYSTEM', stage = 'PLANNING' }) {
    const taskId = id || `task-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO tasks (id, tenant_id, project_id, title, description, assigned_agent, status, stage, tokens_used, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, 0, $8, $8)
      RETURNING *
    `;
    const res = await this.query(sql, [taskId, tenantId, projectId, title, description ?? '', assignedAgent, stage, now]);
    await this.logAuditEvent(tenantId, projectId, assignedAgent, 'TASK_CREATED', `Task "${title}" created`);
    return res.rows[0];
  }

  async getTask(id, tenantId = null) {
    if (tenantId) {
      const res = await this.query(`SELECT * FROM tasks WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
      return res.rows[0] || null;
    }
    const res = await this.query(`SELECT * FROM tasks WHERE id = $1`, [id]);
    return res.rows[0] || null;
  }

  async listTasks(projectId, tenantId = null) {
    if (tenantId) {
      const res = await this.query(`SELECT * FROM tasks WHERE project_id = $1 AND tenant_id = $2 ORDER BY created_at ASC`, [projectId, tenantId]);
      return res.rows;
    }
    const res = await this.query(`SELECT * FROM tasks WHERE project_id = $1 ORDER BY created_at ASC`, [projectId]);
    return res.rows;
  }

  // ── APPROVALS ────────────────────────────────────────────────────────────
  async createApproval({ id, tenantId = 'tenant-default', projectId, taskId = null, actionType, payload = '', riskLevel = 'MEDIUM', reason = '', requestedBy }) {
    const approvalId = id || `appr-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO approvals (id, tenant_id, project_id, task_id, action_type, payload, risk_level, status, reason, requested_by, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10)
      RETURNING *
    `;
    const res = await this.query(sql, [
      approvalId,
      tenantId,
      projectId,
      taskId,
      actionType,
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      riskLevel,
      reason ?? '',
      requestedBy,
      now
    ]);
    await this.logAuditEvent(tenantId, projectId, requestedBy, 'APPROVAL_REQUESTED', `Approval requested for ${actionType}`);
    return res.rows[0];
  }

  async getApproval(id, tenantId = null) {
    if (tenantId) {
      const res = await this.query(`SELECT * FROM approvals WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
      return res.rows[0] || null;
    }
    const res = await this.query(`SELECT * FROM approvals WHERE id = $1`, [id]);
    return res.rows[0] || null;
  }

  async listApprovals(projectId, status = null, tenantId = null) {
    let sql = `SELECT * FROM approvals WHERE project_id = $1`;
    const params = [projectId];
    let idx = 2;

    if (status) {
      sql += ` AND status = $${idx++}`;
      params.push(status);
    }
    if (tenantId) {
      sql += ` AND tenant_id = $${idx++}`;
      params.push(tenantId);
    }
    sql += ` ORDER BY created_at DESC`;
    const res = await this.query(sql, params);
    return res.rows;
  }

  async updateApproval(id, { status, resolvedBy, notes = '' }, tenantId = null) {
    const now = new Date().toISOString();
    let sql = `
      UPDATE approvals
      SET status = $1, resolved_by = $2, resolved_at = $3, notes = $4
      WHERE id = $5
    `;
    const params = [status, resolvedBy || 'OPERATOR', now, notes ?? '', id];
    if (tenantId) {
      sql += ` AND tenant_id = $6`;
      params.push(tenantId);
    }
    sql += ` RETURNING *`;
    const res = await this.query(sql, params);
    const row = res.rows[0];
    if (row) {
      await this.logAuditEvent(row.tenant_id, row.project_id, resolvedBy || 'OPERATOR', `APPROVAL_${status}`, `Approval ${id} resolved`);
    }
    return row || null;
  }

  // ── REQUIREMENTS ─────────────────────────────────────────────────────────
  async createRequirement({ id, tenantId = 'tenant-default', projectId, lockId, reqId, category = 'FUNCTIONAL', description, targetFile, acceptanceCriteria, status = 'PENDING' }) {
    const rId = id || `req-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO requirements (id, tenant_id, project_id, lock_id, req_id, category, description, target_file, acceptance_criteria, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
      ON CONFLICT (project_id, req_id) DO UPDATE SET
        description = EXCLUDED.description,
        acceptance_criteria = EXCLUDED.acceptance_criteria,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at
      RETURNING *
    `;
    const res = await this.query(sql, [rId, tenantId, projectId, lockId, reqId, category, description, targetFile, acceptanceCriteria, status, now]);
    return res.rows[0];
  }

  async listRequirements(projectId, tenantId = null) {
    let sql = `SELECT * FROM requirements WHERE project_id = $1`;
    const params = [projectId];
    if (tenantId) {
      sql += ` AND tenant_id = $2`;
      params.push(tenantId);
    }
    sql += ` ORDER BY req_id ASC`;
    const res = await this.query(sql, params);
    return res.rows;
  }

  // ── GENERATION JOBS & ARTIFACTS ──────────────────────────────────────────
  async createGenerationJob({
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
    const jobId = id || `job-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const startedAt = (status === 'RUNNING') ? now : null;
    const sql = `
      INSERT INTO generation_jobs (
        id, tenant_id, project_id, stage, status, instruction, model_used,
        queue_name, bullmq_job_id, idempotency_key, created_by, max_retries,
        progress_pct, progress_stage, progress_message,
        started_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
      RETURNING *
    `;
    const res = await this.query(sql, [
      jobId, tenantId, projectId, stage, status, instruction, modelUsed,
      queueName, bullmqJobId, idempotencyKey, createdBy, maxRetries,
      progressPct, progressStage, progressMessage,
      startedAt, now
    ]);
    return res.rows[0];
  }

  async getGenerationJob(id, tenantId = null) {
    let sql = `SELECT * FROM generation_jobs WHERE id = $1`;
    const params = [id];
    if (tenantId) {
      sql += ` AND tenant_id = $2`;
      params.push(tenantId);
    }
    const res = await this.query(sql, params);
    return res.rows[0] || null;
  }

  async getGenerationJobByIdempotencyKey(key, tenantId = null) {
    if (!key) return null;
    let sql = `SELECT * FROM generation_jobs WHERE idempotency_key = $1`;
    const params = [key];
    if (tenantId) {
      sql += ` AND tenant_id = $2`;
      params.push(tenantId);
    }
    const res = await this.query(sql, params);
    return res.rows[0] || null;
  }

  async updateGenerationJob(id, updates = {}, tenantId = null) {
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
    let idx = 1;

    for (const [key, col] of Object.entries(fieldMap)) {
      if (updates[key] !== undefined) {
        let val = updates[key];
        if (key === 'resultPayload' && val !== null && typeof val === 'object') {
          val = JSON.stringify(val);
        }
        sets.push(`${col} = $${idx++}`);
        params.push(val);
      }
    }

    sets.push(`updated_at = $${idx++}`);
    params.push(now);

    params.push(id);
    let sql = `UPDATE generation_jobs SET ${sets.join(', ')} WHERE id = $${idx++}`;

    if (tenantId) {
      sql += ` AND tenant_id = $${idx++}`;
      params.push(tenantId);
    }

    sql += ` RETURNING *`;
    const res = await this.query(sql, params);
    return res.rows[0] || null;
  }

  async listGenerationJobs({ projectId = null, tenantId = null, queueName = null, status = null, limit = 50 } = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (projectId) {
      conditions.push(`project_id = $${idx++}`);
      params.push(projectId);
    }
    if (tenantId) {
      conditions.push(`tenant_id = $${idx++}`);
      params.push(tenantId);
    }
    if (queueName) {
      conditions.push(`queue_name = $${idx++}`);
      params.push(queueName);
    }
    if (status) {
      conditions.push(`status = $${idx++}`);
      params.push(status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const sql = `SELECT * FROM generation_jobs ${where} ORDER BY created_at DESC LIMIT $${idx}`;
    const res = await this.query(sql, params);
    return res.rows;
  }

  async getInterruptedGenerationJobs() {
    const sql = `
      SELECT * FROM generation_jobs
      WHERE status IN ('RUNNING', 'ACTIVE')
      ORDER BY created_at ASC
    `;
    const res = await this.query(sql);
    return res.rows;
  }

  async completeGenerationJob(id, { tokensUsed = 0, errorMessage = null, status = 'COMPLETED', resultPayload = null }, tenantId = null) {
    const now = new Date().toISOString();
    let sql = `
      UPDATE generation_jobs
      SET status = $1, tokens_used = $2, error_message = $3, completed_at = $4, updated_at = $4,
          progress_pct = CASE WHEN $1 = 'COMPLETED' THEN 100 ELSE progress_pct END,
          result_payload = $5
      WHERE id = $6
    `;
    const payloadStr = (resultPayload && typeof resultPayload === 'object') ? JSON.stringify(resultPayload) : (resultPayload || null);
    const params = [status, tokensUsed, errorMessage, now, payloadStr, id];
    if (tenantId) {
      sql += ` AND tenant_id = $7`;
      params.push(tenantId);
    }
    sql += ` RETURNING *`;
    const res = await this.query(sql, params);
    return res.rows[0] || null;
  }

  // ── ARTIFACT STORAGE & METADATA ──────────────────────────────────────────
  async saveArtifactRecord({
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
    const artifactId = id || `art-${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    const hash = fileHash || (content ? crypto.createHash('sha256').update(content, 'utf8').digest('hex') : '');
    const size = fileSizeBytes || (content ? Buffer.byteLength(content, 'utf8') : 0);

    const sql = `
      INSERT INTO generated_artifacts (
        id, tenant_id, project_id, job_id, file_path, file_type, file_hash,
        file_size_bytes, content, storage_backend, storage_key, content_type,
        is_confidential, retention_policy, expires_at, metadata, version,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18)
      ON CONFLICT (project_id, file_path, version) DO UPDATE SET
        file_hash = EXCLUDED.file_hash,
        file_size_bytes = EXCLUDED.file_size_bytes,
        content = EXCLUDED.content,
        storage_backend = EXCLUDED.storage_backend,
        storage_key = EXCLUDED.storage_key,
        content_type = EXCLUDED.content_type,
        is_confidential = EXCLUDED.is_confidential,
        retention_policy = EXCLUDED.retention_policy,
        expires_at = EXCLUDED.expires_at,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at
      RETURNING *
    `;

    const res = await this.query(sql, [
      artifactId, tenantId, projectId, jobId, filePath, fileType, hash,
      size, content, storageBackend, storageKey, contentType,
      isConfidential, retentionPolicy, expiresAt, metadata ? JSON.stringify(metadata) : null, version, now
    ]);
    return this._normalizeArtifact(res.rows[0]);
  }

  async saveArtifact(options) {
    return this.saveArtifactRecord(options);
  }

  async getArtifactRecord(id) {
    const sql = `SELECT * FROM generated_artifacts WHERE id = $1`;
    const res = await this.query(sql, [id]);
    return this._normalizeArtifact(res.rows[0]);
  }

  async listArtifactRecords(projectId, tenantId = null, filters = {}) {
    let sql = `SELECT * FROM generated_artifacts WHERE project_id = $1 AND deleted_at IS NULL`;
    const params = [projectId];
    let idx = 2;

    if (tenantId) {
      sql += ` AND tenant_id = $${idx++}`;
      params.push(tenantId);
    }
    if (filters.fileType) {
      sql += ` AND file_type = $${idx++}`;
      params.push(filters.fileType);
    }
    if (filters.retentionPolicy) {
      sql += ` AND retention_policy = $${idx++}`;
      params.push(filters.retentionPolicy);
    }
    sql += ` ORDER BY created_at DESC`;

    const res = await this.query(sql, params);
    return res.rows.map(r => this._normalizeArtifact(r));
  }

  async listArtifacts(projectId, tenantId = null) {
    return this.listArtifactRecords(projectId, tenantId);
  }

  async deleteArtifactRecord(id) {
    const sql = `DELETE FROM generated_artifacts WHERE id = $1`;
    const res = await this.query(sql, [id]);
    return res.rowCount > 0;
  }

  async markArtifactDeleted(id) {
    const now = new Date().toISOString();
    const sql = `UPDATE generated_artifacts SET deleted_at = $1, updated_at = $1 WHERE id = $2`;
    const res = await this.query(sql, [now, id]);
    return res.rowCount > 0;
  }

  async getExpiredArtifacts(nowIso = new Date().toISOString()) {
    const sql = `
      SELECT * FROM generated_artifacts
      WHERE expires_at IS NOT NULL
        AND expires_at <= $1
        AND deleted_at IS NULL
      ORDER BY expires_at ASC
    `;
    const res = await this.query(sql, [nowIso]);
    return res.rows.map(r => this._normalizeArtifact(r));
  }

  async cleanupExpiredArtifacts(nowIso = new Date().toISOString()) {
    const now = new Date().toISOString();
    const sql = `
      UPDATE generated_artifacts
      SET deleted_at = $1, updated_at = $1
      WHERE expires_at IS NOT NULL
        AND expires_at <= $2
        AND deleted_at IS NULL
    `;
    const res = await this.query(sql, [now, nowIso]);
    return res.rowCount;
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

  // ── AUDIT LOGS, EXECUTION RUNS, USAGE RECORDS ────────────────────────────
  async logAuditEvent(tenantId = 'tenant-default', projectId, agentRole, eventType, details = '') {
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO logs_metadata (tenant_id, project_id, agent_role, event_type, details, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const res = await this.query(sql, [tenantId, projectId, agentRole, eventType, details ?? '', now]);
    return res.rows[0];
  }

  async getAuditLogs(projectId, limit = 100, tenantId = null) {
    let sql = `SELECT * FROM logs_metadata WHERE project_id = $1`;
    const params = [projectId];
    let idx = 2;
    if (tenantId) {
      sql += ` AND tenant_id = $${idx++}`;
      params.push(tenantId);
    }
    sql += ` ORDER BY created_at DESC LIMIT $${idx++}`;
    params.push(limit);
    const res = await this.query(sql, params);
    return res.rows;
  }

  async recordExecutionRun({ id, tenantId = 'tenant-default', projectId, taskId = null, command, backendUsed = 'DOCKER', containerName = null, exitCode, stdout = '', stderr = '', durationMs = 0, timedOut = false }) {
    const runId = id || `run-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO execution_runs (id, tenant_id, project_id, task_id, command, backend_used, container_name, exit_code, stdout, stderr, duration_ms, timed_out, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `;
    const res = await this.query(sql, [
      runId,
      tenantId,
      projectId,
      taskId,
      command,
      backendUsed,
      containerName,
      exitCode ?? 0,
      stdout ?? '',
      stderr ?? '',
      durationMs,
      timedOut,
      now
    ]);
    return res.rows[0];
  }

  async recordUsage({ id, tenantId = 'tenant-default', projectId, tokensConsumed, costUsd = 0, agentRole, operation }) {
    const usageId = id || `usg-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO usage_records (id, tenant_id, project_id, tokens_consumed, cost_usd, agent_role, operation, recorded_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    const res = await this.query(sql, [usageId, tenantId, projectId, tokensConsumed, costUsd, agentRole, operation, now]);
    return res.rows[0];
  }

  // ── BUILD RUNS (Audit Compatibility) ─────────────────────────────────────
  async createBuildRun({ id, tenantId = 'tenant-default', projectId, instruction, featureName, domain = 'GENERAL', status = 'BUILDING', requirements = {}, verification = {}, errors = [], report = {} }) {
    const runId = id || `brun-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO build_runs (id, tenant_id, project_id, instruction, feature_name, domain, status, requirements, verification, errors, report, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
      RETURNING *
    `;
    const res = await this.query(sql, [
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
      now
    ]);
    return res.rows[0];
  }

  // ── AUTH, USERS & RBAC PERSISTENCE ──────────────────────────────────────
  async createUser({ id, tenantId = 'tenant-default', email, passwordHash, role = 'DEVELOPER', name = '', isEmailVerified = false, status = 'ACTIVE' }) {
    const userId = id || `usr-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO users (id, tenant_id, email, password_hash, role, name, is_email_verified, status, failed_login_attempts, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $9)
      RETURNING *
    `;
    const res = await this.query(sql, [userId, tenantId, email.toLowerCase().trim(), passwordHash, role, name, isEmailVerified, status, now]);
    return res.rows[0];
  }

  async getUserById(id) {
    const res = await this.query(`SELECT * FROM users WHERE id = $1`, [id]);
    return res.rows[0] || null;
  }

  async getUserByEmail(email) {
    if (!email) return null;
    const res = await this.query(`SELECT * FROM users WHERE LOWER(email) = LOWER($1)`, [email.trim()]);
    return res.rows[0] || null;
  }

  async updateUser(id, updates = {}) {
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
    let idx = 1;

    for (const [key, col] of Object.entries(allowedFields)) {
      if (updates[key] !== undefined) {
        setClauses.push(`${col} = $${idx++}`);
        values.push(updates[key]);
      }
    }

    setClauses.push(`updated_at = $${idx++}`);
    values.push(new Date().toISOString());

    values.push(id);
    const sql = `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`;
    const res = await this.query(sql, values);
    return res.rows[0] || null;
  }

  async createTenant({ id, name, slug, plan = 'FREE', status = 'ACTIVE' }) {
    const tenantId = id || `tenant-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO tenants (id, name, slug, plan, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $6)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, plan = EXCLUDED.plan, updated_at = EXCLUDED.updated_at
      RETURNING *
    `;
    const res = await this.query(sql, [tenantId, name, slug, plan, status, now]);
    return res.rows[0];
  }

  async getTenantById(id) {
    const res = await this.query(`SELECT * FROM tenants WHERE id = $1`, [id]);
    return res.rows[0] || null;
  }

  async createRefreshToken({ id, userId, tenantId = 'tenant-default', tokenHash, expiresAt, userAgent = null, ipAddress = null }) {
    const tokenId = id || `tok-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO refresh_tokens (id, user_id, tenant_id, token_hash, expires_at, user_agent, ip_address, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    const res = await this.query(sql, [tokenId, userId, tenantId, tokenHash, expiresAt, userAgent, ipAddress, now]);
    return res.rows[0];
  }

  async getRefreshTokenByHash(tokenHash) {
    const res = await this.query(`SELECT * FROM refresh_tokens WHERE token_hash = $1`, [tokenHash]);
    return res.rows[0] || null;
  }

  async revokeRefreshToken(tokenHash) {
    const res = await this.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 RETURNING *`, [tokenHash]);
    return res.rows[0] || null;
  }

  async revokeAllUserRefreshTokens(userId) {
    await this.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  }

  async createPasswordReset({ id, userId, tokenHash, expiresAt }) {
    const resetId = id || `rst-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const res = await this.query(sql, [resetId, userId, tokenHash, expiresAt, now]);
    return res.rows[0];
  }

  async getPasswordResetByHash(tokenHash) {
    const res = await this.query(`SELECT * FROM password_resets WHERE token_hash = $1`, [tokenHash]);
    return res.rows[0] || null;
  }

  async markPasswordResetUsed(tokenHash) {
    const res = await this.query(`UPDATE password_resets SET used_at = NOW() WHERE token_hash = $1 RETURNING *`, [tokenHash]);
    return res.rows[0] || null;
  }

  async createEmailVerification({ id, userId, tokenHash, expiresAt }) {
    const verifId = id || `ver-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO email_verifications (id, user_id, token_hash, expires_at, created_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const res = await this.query(sql, [verifId, userId, tokenHash, expiresAt, now]);
    return res.rows[0];
  }

  async getEmailVerificationByHash(tokenHash) {
    const res = await this.query(`SELECT * FROM email_verifications WHERE token_hash = $1`, [tokenHash]);
    return res.rows[0] || null;
  }

  async markEmailVerificationUsed(tokenHash) {
    const res = await this.query(`UPDATE email_verifications SET verified_at = NOW() WHERE token_hash = $1 RETURNING *`, [tokenHash]);
    return res.rows[0] || null;
  }

  async addProjectMember({ id, tenantId = 'tenant-default', projectId, userId, role = 'DEVELOPER' }) {
    const memberId = id || `pmem-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO project_members (id, tenant_id, project_id, user_id, role, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $6)
      ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = EXCLUDED.updated_at
      RETURNING *
    `;
    const res = await this.query(sql, [memberId, tenantId, projectId, userId, role, now]);
    return res.rows[0];
  }

  async getProjectMember(projectId, userId) {
    const res = await this.query(`SELECT * FROM project_members WHERE project_id = $1 AND user_id = $2`, [projectId, userId]);
    return res.rows[0] || null;
  }

  async listProjectMembers(projectId) {
    const res = await this.query(`
      SELECT pm.*, u.email, u.name, u.role as system_role
      FROM project_members pm
      JOIN users u ON pm.user_id = u.id
      WHERE pm.project_id = $1
      ORDER BY pm.created_at ASC
    `, [projectId]);
    return res.rows;
  }

  async removeProjectMember(projectId, userId) {
    const res = await this.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2 RETURNING *`, [projectId, userId]);
    return res.rows[0] || null;
  }

  async recordAuthAudit({ tenantId = 'tenant-default', userId = null, action, ipAddress = null, userAgent = null, details = null }) {
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO auth_audit_logs (tenant_id, user_id, action, ip_address, user_agent, details, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;
    const res = await this.query(sql, [
      tenantId,
      userId,
      action,
      ipAddress,
      userAgent,
      typeof details === 'object' && details !== null ? JSON.stringify(details) : details,
      now
    ]);
    return res.rows[0];
  }

  async listAuthAuditLogs({ tenantId = null, userId = null, limit = 50 } = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (tenantId) {
      conditions.push(`tenant_id = $${idx++}`);
      params.push(tenantId);
    }
    if (userId) {
      conditions.push(`user_id = $${idx++}`);
      params.push(userId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const sql = `SELECT * FROM auth_audit_logs ${where} ORDER BY created_at DESC LIMIT $${idx}`;
    const res = await this.query(sql, params);
    return res.rows;
  }

  async createDeployment(deployment) {
    const id = deployment.id || `dep_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const envVars = deployment.env_vars && typeof deployment.env_vars === 'object'
      ? JSON.stringify(deployment.env_vars)
      : (deployment.env_vars || null);
    const metadata = deployment.metadata && typeof deployment.metadata === 'object'
      ? JSON.stringify(deployment.metadata)
      : (deployment.metadata || null);

    const sql = `
      INSERT INTO project_deployments (
        id, tenant_id, project_id, provider, environment,
        status, target_url, commit_sha, build_logs, error_message,
        env_vars, rollback_target_id, approved_by, approval_id, metadata,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *
    `;
    const res = await this.query(sql, [
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
      envVars,
      deployment.rollback_target_id || deployment.rollbackTargetId || null,
      deployment.approved_by || deployment.approvedBy || null,
      deployment.approval_id || deployment.approvalId || null,
      metadata,
      deployment.created_at || now,
      deployment.updated_at || now
    ]);
    return this._normalizeDeployment(res.rows[0]);
  }

  async getDeployment(deploymentId, tenantId = null) {
    let sql = `SELECT * FROM project_deployments WHERE id = $1`;
    const params = [deploymentId];
    if (tenantId) {
      sql += ` AND tenant_id = $2`;
      params.push(tenantId);
    }
    const res = await this.query(sql, params);
    return this._normalizeDeployment(res.rows[0]);
  }

  async listDeployments(projectId = null, tenantId = null) {
    const conditions = [];
    const params = [];
    let idx = 1;
    if (projectId) {
      conditions.push(`project_id = $${idx++}`);
      params.push(projectId);
    }
    if (tenantId) {
      conditions.push(`tenant_id = $${idx++}`);
      params.push(tenantId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM project_deployments ${where} ORDER BY created_at DESC`;
    const res = await this.query(sql, params);
    return res.rows.map(r => this._normalizeDeployment(r));
  }

  async updateDeploymentStatus(deploymentId, updates = {}, tenantId = null) {
    const current = await this.getDeployment(deploymentId, tenantId);
    if (!current) return null;

    const setClauses = ['updated_at = NOW()'];
    const params = [];
    let idx = 1;

    if (updates.status !== undefined) {
      setClauses.push(`status = $${idx++}`);
      params.push(updates.status);
    }
    if (updates.target_url !== undefined || updates.targetUrl !== undefined) {
      setClauses.push(`target_url = $${idx++}`);
      params.push(updates.target_url ?? updates.targetUrl);
    }
    if (updates.commit_sha !== undefined || updates.commitSha !== undefined) {
      setClauses.push(`commit_sha = $${idx++}`);
      params.push(updates.commit_sha ?? updates.commitSha);
    }
    if (updates.build_logs !== undefined || updates.buildLogs !== undefined) {
      setClauses.push(`build_logs = $${idx++}`);
      params.push(updates.build_logs ?? updates.buildLogs);
    }
    if (updates.error_message !== undefined || updates.errorMessage !== undefined) {
      setClauses.push(`error_message = $${idx++}`);
      params.push(updates.error_message ?? updates.errorMessage);
    }
    if (updates.rollback_target_id !== undefined || updates.rollbackTargetId !== undefined) {
      setClauses.push(`rollback_target_id = $${idx++}`);
      params.push(updates.rollback_target_id ?? updates.rollbackTargetId);
    }
    if (updates.approved_by !== undefined || updates.approvedBy !== undefined) {
      setClauses.push(`approved_by = $${idx++}`);
      params.push(updates.approved_by ?? updates.approvedBy);
    }
    if (updates.approval_id !== undefined || updates.approvalId !== undefined) {
      setClauses.push(`approval_id = $${idx++}`);
      params.push(updates.approval_id ?? updates.approvalId);
    }

    params.push(deploymentId);
    let sql = `UPDATE project_deployments SET ${setClauses.join(', ')} WHERE id = $${idx++}`;
    if (tenantId) {
      sql += ` AND tenant_id = $${idx++}`;
      params.push(tenantId);
    }
    sql += ` RETURNING *`;
    const res = await this.query(sql, params);
    return this._normalizeDeployment(res.rows[0]);
  }

  async deleteDeployment(deploymentId, tenantId = null) {
    let sql = `DELETE FROM project_deployments WHERE id = $1`;
    const params = [deploymentId];
    if (tenantId) {
      sql += ` AND tenant_id = $2`;
      params.push(tenantId);
    }
    const res = await this.query(sql, params);
    return res.rowCount > 0;
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
  async recordUsageEvent(eventData) {
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

    if (idempotencyKey) {
      const existing = await this.query('SELECT * FROM usage_events WHERE idempotency_key = $1', [idempotencyKey]);
      if (existing.rows[0]) {
        return { isDuplicate: true, event: this._normalizeUsageEvent(existing.rows[0]) };
      }
    }

    const metaStr = metadata ? (typeof metadata === 'object' ? JSON.stringify(metadata) : metadata) : null;

    try {
      const sql = `
        INSERT INTO usage_events (id, tenant_id, user_id, project_id, event_type, quantity, unit, idempotency_key, metadata, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *
      `;
      const res = await this.query(sql, [id, tenantId, userId, projectId, eventType, Number(quantity), unit, idempotencyKey, metaStr]);
      if (res.rows[0]) {
        return { isDuplicate: false, event: this._normalizeUsageEvent(res.rows[0]) };
      }
      // If conflict hit
      const raceExisting = await this.query('SELECT * FROM usage_events WHERE idempotency_key = $1', [idempotencyKey]);
      return { isDuplicate: true, event: this._normalizeUsageEvent(raceExisting.rows[0]) };
    } catch (err) {
      if (idempotencyKey && err.code === '23505') { // unique_violation
        const raceExisting = await this.query('SELECT * FROM usage_events WHERE idempotency_key = $1', [idempotencyKey]);
        return { isDuplicate: true, event: this._normalizeUsageEvent(raceExisting.rows[0]) };
      }
      throw err;
    }
  }

  async getUsageEvents(tenantId, options = {}) {
    const conditions = ['tenant_id = $1'];
    const params = [tenantId || 'tenant-default'];
    let idx = 2;

    if (options.eventType) {
      conditions.push(`event_type = $${idx++}`);
      params.push(options.eventType);
    }
    if (options.projectId) {
      conditions.push(`project_id = $${idx++}`);
      params.push(options.projectId);
    }
    if (options.since) {
      conditions.push(`created_at >= $${idx++}`);
      params.push(options.since);
    }

    const limit = Math.max(1, Math.min(500, parseInt(options.limit, 10) || 100));
    params.push(limit);
    const sql = `SELECT * FROM usage_events WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${idx++}`;
    const res = await this.query(sql, params);
    return res.rows.map(r => this._normalizeUsageEvent(r));
  }

  async getUsageSummary(tenantId, options = {}) {
    const conditions = ['tenant_id = $1'];
    const params = [tenantId || 'tenant-default'];
    let idx = 2;

    if (options.since) {
      conditions.push(`created_at >= $${idx++}`);
      params.push(options.since);
    }

    const sql = `
      SELECT event_type, unit, SUM(quantity) as total_quantity, COUNT(*) as event_count
      FROM usage_events
      WHERE ${conditions.join(' AND ')}
      GROUP BY event_type, unit
    `;
    const res = await this.query(sql, params);

    const summary = {
      tenantId: tenantId || 'tenant-default',
      since: options.since || null,
      byType: {},
      totalEvents: 0
    };

    for (const r of res.rows) {
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
  async hasProcessedWebhook(provider, eventId) {
    const res = await this.query('SELECT 1 FROM processed_webhooks WHERE provider = $1 AND event_id = $2', [provider, eventId]);
    return res.rows.length > 0;
  }

  async recordProcessedWebhook({ id = 'pwh_' + crypto.randomUUID().slice(0, 12), provider, eventId, eventType, payloadSummary = null }) {
    const res = await this.query(`
      INSERT INTO processed_webhooks (id, provider, event_id, event_type, payload_summary, processed_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *
    `, [id, provider, eventId, eventType, payloadSummary]);
    return res.rows[0];
  }

  // ── Tenant Subscriptions & Billing ────────────────────────────────────────
  async getTenantSubscription(tenantId, provider = 'stripe') {
    const res = await this.query('SELECT * FROM tenant_subscriptions WHERE tenant_id = $1 AND provider = $2', [tenantId, provider]);
    return this._normalizeSubscription(res.rows[0]);
  }

  async upsertTenantSubscription(data) {
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

    const metaStr = metadata ? (typeof metadata === 'object' ? JSON.stringify(metadata) : metadata) : null;

    const sql = `
      INSERT INTO tenant_subscriptions
        (id, tenant_id, provider, customer_id, subscription_id, plan, status, current_period_start, current_period_end, cancel_at_period_end, metadata, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
      ON CONFLICT (tenant_id, provider) DO UPDATE
      SET customer_id = COALESCE(EXCLUDED.customer_id, tenant_subscriptions.customer_id),
          subscription_id = COALESCE(EXCLUDED.subscription_id, tenant_subscriptions.subscription_id),
          plan = EXCLUDED.plan,
          status = EXCLUDED.status,
          current_period_start = EXCLUDED.current_period_start,
          current_period_end = EXCLUDED.current_period_end,
          cancel_at_period_end = EXCLUDED.cancel_at_period_end,
          metadata = COALESCE(EXCLUDED.metadata, tenant_subscriptions.metadata),
          updated_at = NOW()
      RETURNING *
    `;

    const res = await this.query(sql, [
      id, tenantId, provider, customerId, subscriptionId, plan, status,
      currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd, metaStr
    ]);

    const tenantPlan = (status === 'active' || status === 'trialing') ? plan : 'FREE';
    try {
      await this.query('UPDATE tenants SET plan = $1, updated_at = NOW() WHERE id = $2', [tenantPlan, tenantId]);
    } catch (_) {}

    return this._normalizeSubscription(res.rows[0]);
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

  async close() {
    if (this.pool && typeof this.pool.end === 'function') {
      await this.pool.end();
    }
  }
}
