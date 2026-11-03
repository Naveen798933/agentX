-- Migration 010: Autonomous Browser QA & Interaction Testing Engine Tables
-- Version: 10
-- Description: Adds browser_qa_sessions, browser_qa_steps, and browser_qa_artifacts for autonomous UI testing and visual regression

CREATE TABLE IF NOT EXISTS browser_qa_sessions (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_name VARCHAR(150) NOT NULL,
  target_url VARCHAR(500) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'RUNNING', 'PASSED', 'FAILED', 'ERROR'
  summary TEXT,
  viewport_width INTEGER NOT NULL DEFAULT 1280,
  viewport_height INTEGER NOT NULL DEFAULT 800,
  total_steps INTEGER NOT NULL DEFAULT 0,
  passed_steps INTEGER NOT NULL DEFAULT 0,
  failed_steps INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_browser_qa_sessions_proj ON browser_qa_sessions(tenant_id, project_id, status);

CREATE TABLE IF NOT EXISTS browser_qa_steps (
  id VARCHAR(64) PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL REFERENCES browser_qa_sessions(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  action VARCHAR(50) NOT NULL, -- 'NAVIGATE', 'CLICK', 'TYPE', 'ASSERT_TEXT', 'ASSERT_ELEMENT', 'SCREENSHOT', 'A11Y_AUDIT'
  target_selector VARCHAR(255),
  payload TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'PASSED', 'FAILED', 'SKIPPED'
  error_message TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_browser_qa_steps_session ON browser_qa_steps(session_id, step_index);

CREATE TABLE IF NOT EXISTS browser_qa_artifacts (
  id VARCHAR(64) PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL REFERENCES browser_qa_sessions(id) ON DELETE CASCADE,
  step_id VARCHAR(64) REFERENCES browser_qa_steps(id) ON DELETE SET NULL,
  artifact_type VARCHAR(50) NOT NULL, -- 'SCREENSHOT', 'DIFF_IMAGE', 'DOM_SNAPSHOT', 'A11Y_REPORT', 'CONSOLE_LOGS'
  file_path VARCHAR(500),
  metadata_json TEXT DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_browser_qa_artifacts_session ON browser_qa_artifacts(session_id, artifact_type);

