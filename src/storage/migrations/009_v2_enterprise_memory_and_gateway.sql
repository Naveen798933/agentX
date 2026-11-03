-- Migration 009: Organizational Vector Memory, Memory Associations & Model Gateway Tables
-- Version: 9
-- Description: Adds organizational_memories with vector embeddings, memory_associations, model_providers, and model_routing_policies

-- 1. Optional pgvector extension setup
-- Note: On hosted PostgreSQL or Supabase with pgvector enabled, run CREATE EXTENSION IF NOT EXISTS vector


-- 2. Model Providers Table
CREATE TABLE IF NOT EXISTS model_providers (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_type VARCHAR(50) NOT NULL, -- 'GEMINI', 'ANTHROPIC', 'OPENAI', 'DEEPSEEK', 'OLLAMA'
  display_name VARCHAR(100) NOT NULL,
  api_endpoint VARCHAR(255),
  encrypted_api_key TEXT,
  rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
  rate_limit_tpm INTEGER NOT NULL DEFAULT 100000,
  cost_per_1k_input_tokens NUMERIC(10, 6) NOT NULL DEFAULT 0.0015,
  cost_per_1k_output_tokens NUMERIC(10, 6) NOT NULL DEFAULT 0.002,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_providers_tenant ON model_providers(tenant_id, is_active);

-- 3. Model Routing Policies Table
CREATE TABLE IF NOT EXISTS model_routing_policies (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_domain VARCHAR(64) NOT NULL, -- 'ARCHITECTURE', 'CODE_GEN', 'SECURITY', 'QA', 'GENERAL'
  primary_provider_id VARCHAR(64) NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,
  primary_model_name VARCHAR(100) NOT NULL,
  fallback_provider_id VARCHAR(64) REFERENCES model_providers(id) ON DELETE SET NULL,
  fallback_model_name VARCHAR(100),
  max_output_tokens INTEGER NOT NULL DEFAULT 8192,
  temperature NUMERIC(3, 2) NOT NULL DEFAULT 0.70,
  priority_weight INTEGER NOT NULL DEFAULT 10,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tenant_routing_domain UNIQUE (tenant_id, task_domain)
);

CREATE INDEX IF NOT EXISTS idx_model_routing_policies ON model_routing_policies(tenant_id, task_domain);

-- 4. Organizational Memories Table
CREATE TABLE IF NOT EXISTS organizational_memories (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id VARCHAR(64) REFERENCES projects(id) ON DELETE SET NULL,
  memory_type VARCHAR(50) NOT NULL, -- 'ADR', 'PRD', 'BUG_FIX', 'CODING_STANDARD', 'SECURITY_RULE'
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding_json TEXT, -- Portable JSON string for vector fallback across PostgreSQL/SQLite
  source_file VARCHAR(255),
  confidence_score NUMERIC(4, 3) NOT NULL DEFAULT 1.000,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_memories_tenant ON organizational_memories(tenant_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_org_memories_project ON organizational_memories(project_id);

-- 5. Memory Associations Table
CREATE TABLE IF NOT EXISTS memory_associations (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_memory_id VARCHAR(64) NOT NULL REFERENCES organizational_memories(id) ON DELETE CASCADE,
  target_memory_id VARCHAR(64) NOT NULL REFERENCES organizational_memories(id) ON DELETE CASCADE,
  relationship_type VARCHAR(50) NOT NULL, -- 'SUPERSEDES', 'RESOLVES', 'REFERENCES', 'CONFLICTS_WITH'
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_memory_assoc UNIQUE (source_memory_id, target_memory_id, relationship_type)
);

CREATE INDEX IF NOT EXISTS idx_mem_assoc_source ON memory_associations(source_memory_id);
CREATE INDEX IF NOT EXISTS idx_mem_assoc_target ON memory_associations(target_memory_id);

-- 6. Row Level Security (RLS)
ALTER TABLE model_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_routing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizational_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_associations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_model_providers ON model_providers;
CREATE POLICY tenant_isolation_model_providers ON model_providers
  FOR ALL USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_model_routing_policies ON model_routing_policies;
CREATE POLICY tenant_isolation_model_routing_policies ON model_routing_policies
  FOR ALL USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_org_memories ON organizational_memories;
CREATE POLICY tenant_isolation_org_memories ON organizational_memories
  FOR ALL USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

DROP POLICY IF EXISTS tenant_isolation_mem_assoc ON memory_associations;
CREATE POLICY tenant_isolation_mem_assoc ON memory_associations
  FOR ALL USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

