-- Migration 008: Observability, Usage Metering, and Server-Side Billing
-- Version: 8
-- Description: Adds usage_events with idempotency protection, processed_webhooks for replay defense, and tenant_subscriptions

CREATE TABLE IF NOT EXISTS usage_events (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id VARCHAR(64),
  project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE,
  event_type VARCHAR(64) NOT NULL,
  quantity NUMERIC(14, 4) NOT NULL,
  unit VARCHAR(32) NOT NULL,
  idempotency_key VARCHAR(128) UNIQUE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_time ON usage_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_type ON usage_events(tenant_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_idempotency ON usage_events(idempotency_key);

CREATE TABLE IF NOT EXISTS processed_webhooks (
  id VARCHAR(64) PRIMARY KEY,
  provider VARCHAR(32) NOT NULL,
  event_id VARCHAR(128) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload_summary TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_processed_webhooks UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_processed_webhooks_lookup ON processed_webhooks(provider, event_id);

CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL DEFAULT 'stripe',
  customer_id VARCHAR(128),
  subscription_id VARCHAR(128),
  plan VARCHAR(32) NOT NULL DEFAULT 'FREE',
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT false,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tenant_subscription_provider UNIQUE (tenant_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_tenant ON tenant_subscriptions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_customer ON tenant_subscriptions(customer_id);

-- Enable RLS for usage events
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_usage_events ON usage_events;
CREATE POLICY tenant_isolation_usage_events ON usage_events
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));
