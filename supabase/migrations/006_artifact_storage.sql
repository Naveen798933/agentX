-- Migration 006: Project Artifact Storage and S3/R2 Abstraction
-- Version: 6
-- Description: Extends generated_artifacts with object storage keys, storage backend, content types, retention policies, and lifecycle timestamps

-- 1. Make content column nullable so file contents are kept in object storage rather than database rows
ALTER TABLE generated_artifacts ALTER COLUMN content DROP NOT NULL;

-- 2. Add object storage metadata columns
ALTER TABLE generated_artifacts ADD COLUMN IF NOT EXISTS storage_backend VARCHAR(32) NOT NULL DEFAULT 'LOCAL';
ALTER TABLE generated_artifacts ADD COLUMN IF NOT EXISTS storage_key VARCHAR(512) NOT NULL DEFAULT '';
ALTER TABLE generated_artifacts ADD COLUMN IF NOT EXISTS content_type VARCHAR(128) NOT NULL DEFAULT 'application/octet-stream';
ALTER TABLE generated_artifacts ADD COLUMN IF NOT EXISTS is_confidential BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE generated_artifacts ADD COLUMN IF NOT EXISTS retention_policy VARCHAR(64) NOT NULL DEFAULT 'TEMPORARY_BUILD';
ALTER TABLE generated_artifacts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE generated_artifacts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE generated_artifacts ADD COLUMN IF NOT EXISTS metadata JSONB;

-- 3. Indexes for artifact lookup, tenant/project grouping, and lifecycle cleanup
CREATE INDEX IF NOT EXISTS idx_artifacts_storage_key ON generated_artifacts(storage_key);
CREATE INDEX IF NOT EXISTS idx_artifacts_retention_expires ON generated_artifacts(retention_policy, expires_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_tenant_proj ON generated_artifacts(tenant_id, project_id);
