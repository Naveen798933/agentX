-- Migration 007: Application Deployment and Multi-Provider Cloud Release Tracking
-- Version: 7
-- Description: Adds project_deployments table for tracking build artifacts, provider deployments, health status, and rollbacks

CREATE TABLE IF NOT EXISTS project_deployments (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL DEFAULT 'tenant-default',
  project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL,
  environment VARCHAR(32) NOT NULL DEFAULT 'preview',
  status VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
  target_url VARCHAR(512),
  commit_sha VARCHAR(64),
  build_logs TEXT,
  error_message TEXT,
  env_vars JSONB,
  rollback_target_id VARCHAR(64),
  approved_by VARCHAR(128),
  approval_id VARCHAR(64),
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deployments_tenant_proj ON project_deployments(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON project_deployments(status);
CREATE INDEX IF NOT EXISTS idx_deployments_env ON project_deployments(project_id, environment, created_at DESC);
