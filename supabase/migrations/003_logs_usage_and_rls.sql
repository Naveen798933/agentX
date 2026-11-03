-- Migration 003: Logs Metadata, Usage Records, and PostgreSQL Row-Level Security (RLS)
-- Version: 3
-- Description: Audit telemetry, financial tracking, and engine-level multi-tenant RLS policies

CREATE TABLE IF NOT EXISTS logs_metadata (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_role VARCHAR(50),
  event_type VARCHAR(100) NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage_records (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tokens_consumed INTEGER NOT NULL,
  cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  agent_role VARCHAR(50) NOT NULL,
  operation VARCHAR(100) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Time-series & billing analytics indexes
CREATE INDEX IF NOT EXISTS idx_logs_proj_time ON logs_metadata(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_tenant ON logs_metadata(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_proj_time ON usage_records(project_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_tenant ON usage_records(tenant_id, recorded_at DESC);

-- ── ROW LEVEL SECURITY (RLS) POLICIES ──────────────────────────────────────
-- Enable RLS on all tenant-isolated tables
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE generated_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE build_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;

-- Create Tenant Isolation Policies checking local session setting 'app.current_tenant_id'
DROP POLICY IF EXISTS tenant_isolation_projects ON projects;
CREATE POLICY tenant_isolation_projects ON projects
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_tasks ON tasks;
CREATE POLICY tenant_isolation_tasks ON tasks
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_approvals ON approvals;
CREATE POLICY tenant_isolation_approvals ON approvals
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_requirements ON requirements;
CREATE POLICY tenant_isolation_requirements ON requirements
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_generation_jobs ON generation_jobs;
CREATE POLICY tenant_isolation_generation_jobs ON generation_jobs
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_generated_artifacts ON generated_artifacts;
CREATE POLICY tenant_isolation_generated_artifacts ON generated_artifacts
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_execution_runs ON execution_runs;
CREATE POLICY tenant_isolation_execution_runs ON execution_runs
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_build_runs ON build_runs;
CREATE POLICY tenant_isolation_build_runs ON build_runs
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_logs_metadata ON logs_metadata;
CREATE POLICY tenant_isolation_logs_metadata ON logs_metadata
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_usage_records ON usage_records;
CREATE POLICY tenant_isolation_usage_records ON usage_records
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));
