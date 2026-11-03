-- Migration 002: Requirements, Generation Jobs, Generated Artifacts, Execution Runs, Build Runs
-- Version: 2
-- Description: AI synthesis jobs, artifacts versioning, and execution tracking

CREATE TABLE IF NOT EXISTS requirements (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lock_id VARCHAR(64) NOT NULL,
  req_id VARCHAR(64) NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'FUNCTIONAL',
  description TEXT NOT NULL,
  target_file VARCHAR(255) NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_proj_req UNIQUE (project_id, req_id)
);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'QUEUED',
  instruction TEXT NOT NULL,
  model_used VARCHAR(100),
  tokens_used INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS generated_artifacts (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id VARCHAR(64) REFERENCES generation_jobs(id) ON DELETE SET NULL,
  file_path VARCHAR(255) NOT NULL,
  file_type VARCHAR(50) NOT NULL,
  file_hash VARCHAR(64) NOT NULL,
  file_size_bytes INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_proj_file_version UNIQUE (project_id, file_path, version)
);

CREATE TABLE IF NOT EXISTS execution_runs (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id VARCHAR(64),
  command TEXT NOT NULL,
  backend_used VARCHAR(50) NOT NULL DEFAULT 'DOCKER',
  container_name VARCHAR(128),
  exit_code INTEGER,
  stdout TEXT,
  stderr TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  timed_out BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS build_runs (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  instruction TEXT NOT NULL,
  feature_name VARCHAR(255) NOT NULL,
  domain VARCHAR(50) NOT NULL DEFAULT 'GENERAL',
  status VARCHAR(50) NOT NULL DEFAULT 'BUILDING',
  requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
  verification JSONB NOT NULL DEFAULT '{}'::jsonb,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  report JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for requirements, jobs, artifacts, and runs
CREATE INDEX IF NOT EXISTS idx_requirements_proj ON requirements(project_id, status);
CREATE INDEX IF NOT EXISTS idx_requirements_tenant ON requirements(tenant_id);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_proj ON generation_jobs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_tenant ON generation_jobs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_proj_path ON generated_artifacts(project_id, file_path);
CREATE INDEX IF NOT EXISTS idx_artifacts_tenant ON generated_artifacts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_execution_runs_proj ON execution_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_runs_tenant ON execution_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_build_runs_proj ON build_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_build_runs_tenant ON build_runs(tenant_id);
