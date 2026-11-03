-- Migration 011: Enterprise Security, Cryptographic Tamper-Evident Audit Log & SSO Configuration
-- Version: 11
-- Description: Adds tamper_evident_audit_log with SHA-256 hash chaining and enterprise_sso_configs

CREATE TABLE IF NOT EXISTS tamper_evident_audit_log (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence_number BIGINT NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  actor VARCHAR(150) NOT NULL,
  payload_json TEXT NOT NULL,
  previous_hash VARCHAR(64) NOT NULL,
  current_hash VARCHAR(64) NOT NULL,
  signature VARCHAR(128) NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tenant_audit_sequence UNIQUE (tenant_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS idx_tamper_audit_tenant_seq ON tamper_evident_audit_log(tenant_id, sequence_number ASC);
CREATE INDEX IF NOT EXISTS idx_tamper_audit_current_hash ON tamper_evident_audit_log(current_hash);

CREATE TABLE IF NOT EXISTS enterprise_sso_configs (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_type VARCHAR(32) NOT NULL, -- 'OIDC', 'SAML2'
  idp_entity_id VARCHAR(255) NOT NULL,
  idp_sso_url VARCHAR(500) NOT NULL,
  idp_certificate TEXT,
  client_id VARCHAR(255),
  client_secret_encrypted TEXT,
  issuer_url VARCHAR(500),
  default_role VARCHAR(32) NOT NULL DEFAULT 'DEVELOPER',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tenant_sso UNIQUE (tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_sso_configs_tenant ON enterprise_sso_configs(tenant_id, is_active);

