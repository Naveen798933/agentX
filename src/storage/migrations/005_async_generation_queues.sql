-- Migration 005: Asynchronous Generation Queues and BullMQ Integration
-- Version: 5
-- Description: Extends generation_jobs with queue management, BullMQ IDs, idempotency keys, progress tracking, and retries

-- 1. Add queue-related columns to generation_jobs
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS queue_name VARCHAR(64) NOT NULL DEFAULT 'project-generation';
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS bullmq_job_id VARCHAR(128);
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128);
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS created_by VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS progress_pct INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS progress_stage VARCHAR(64);
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS progress_message TEXT;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS retries_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 3;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS result_payload JSONB;

-- 2. Constraints and Indexes for fast queue and idempotency lookup
CREATE UNIQUE INDEX IF NOT EXISTS uq_generation_jobs_idempotency ON generation_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_generation_jobs_bullmq ON generation_jobs(bullmq_job_id);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_queue_status ON generation_jobs(queue_name, status);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_created_by ON generation_jobs(created_by);
