import crypto from 'node:crypto';
import { BillingProvider } from './billingProvider.js';
import { rootLogger } from '../observability/logger.js';

export class WebhookVerificationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.details = details;
    this.statusCode = 400;
  }
}

/**
 * StripeBillingProvider
 * Production payment and subscription provider implementing Stripe's exact
 * HMAC-SHA256 signature verification, timestamp tolerance window, and replay protection.
 */
export class StripeBillingProvider extends BillingProvider {
  /**
   * @param {Object} options
   * @param {import('../storage/db.js').StorageEngine} options.storage
   * @param {string} [options.webhookSecret] - Stripe webhook endpoint signing secret (whsec_...)
   * @param {string} [options.apiKey] - Stripe secret API key (sk_...)
   * @param {number} [options.toleranceSeconds=300] - Maximum allowable clock drift (5 minutes)
   * @param {boolean} [options.enabled=true]
   */
  constructor(options = {}) {
    super({ name: 'stripe', storage: options.storage, enabled: options.enabled });
    this.webhookSecret = options.webhookSecret || process.env.STRIPE_WEBHOOK_SECRET || null;
    this.apiKey = options.apiKey || process.env.STRIPE_API_KEY || null;
    this.toleranceSeconds = options.toleranceSeconds || 300; // 5 minutes default
    this.logger = options.logger || rootLogger.child({ service: 'stripe-billing' });
  }

  /**
   * Parse Stripe-Signature header
   * Format: t=1614000000,v1=52576c3e5...,v0=...
   */
  _parseSignatureHeader(header = '') {
    if (!header || typeof header !== 'string') return null;
    const items = header.split(',');
    let timestamp = null;
    const signatures = [];

    for (const item of items) {
      const [key, value] = item.trim().split('=');
      if (key === 't') {
        timestamp = parseInt(value, 10);
      } else if (key === 'v1') {
        signatures.push(value);
      }
    }

    if (!timestamp || signatures.length === 0) return null;
    return { timestamp, signatures };
  }

  /**
   * Verify HMAC-SHA256 signature using constant-time comparison
   */
  verifyWebhookSignature(rawPayload, signatureHeader) {
    if (!this.webhookSecret) {
      throw new WebhookVerificationError('Stripe webhook secret is not configured on server');
    }

    const parsed = this._parseSignatureHeader(signatureHeader);
    if (!parsed) {
      throw new WebhookVerificationError('Malformed or missing Stripe-Signature header');
    }

    const { timestamp, signatures } = parsed;
    const now = Math.floor(Date.now() / 1000);

    // Timestamp tolerance check (protects against replay attacks)
    if (Math.abs(now - timestamp) > this.toleranceSeconds) {
      throw new WebhookVerificationError(
        `Webhook timestamp outside tolerance window (${Math.abs(now - timestamp)}s > ${this.toleranceSeconds}s)`,
        { timestamp, currentTimestamp: now, tolerance: this.toleranceSeconds }
      );
    }

    // Construct signed payload: `${timestamp}.${rawPayload}`
    const payloadStr = typeof rawPayload === 'string' ? rawPayload : rawPayload.toString('utf8');
    const signedPayload = `${timestamp}.${payloadStr}`;

    const expectedSignature = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(signedPayload, 'utf8')
      .digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    // Verify against provided v1 signatures using constant-time comparison
    let matches = false;
    for (const sig of signatures) {
      const sigBuffer = Buffer.from(sig, 'utf8');
      if (sigBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
        matches = true;
        break;
      }
    }

    if (!matches) {
      throw new WebhookVerificationError('Invalid webhook signature. HMAC-SHA256 mismatch.');
    }

    return { valid: true, timestamp };
  }

  /**
   * Handle incoming raw webhook request:
   * 1. Validate signature & timestamp tolerance
   * 2. Defend against replay attacks via processed_webhooks table
   * 3. Dispatch event and persist verified subscription changes
   */
  async processWebhook(rawPayload, signatureHeader) {
    // 1. Verify signature
    this.verifyWebhookSignature(rawPayload, signatureHeader);

    // Parse JSON
    const payloadStr = typeof rawPayload === 'string' ? rawPayload : rawPayload.toString('utf8');
    let event;
    try {
      event = JSON.parse(payloadStr);
    } catch (parseErr) {
      throw new WebhookVerificationError(`Invalid JSON payload: ${parseErr.message}`);
    }

    const eventId = event.id;
    const eventType = event.type;

    if (!eventId || !eventType) {
      throw new WebhookVerificationError('Missing event id or type in webhook payload');
    }

    // 2. Replay Protection: Check if already processed
    const alreadyProcessed = await this.storage.hasProcessedWebhook('stripe', eventId);
    if (alreadyProcessed) {
      this.logger.warn('Duplicate Stripe webhook event ignored (replay defense)', {
        provider: 'stripe',
        eventId,
        eventType
      });
      return {
        status: 'IGNORED',
        reason: 'DUPLICATE_EVENT',
        eventId,
        eventType
      };
    }

    // 3. Dispatch & handle event
    const outcome = await this.handleWebhookEvent(event);

    // 4. Record as processed in DB to prevent any future replay
    await this.storage.recordProcessedWebhook({
      provider: 'stripe',
      eventId,
      eventType,
      payloadSummary: JSON.stringify({
        tenantId: outcome?.tenantId || null,
        plan: outcome?.plan || null,
        status: outcome?.status || null
      })
    });

    this.logger.info('Stripe webhook processed successfully', {
      eventId,
      eventType,
      tenantId: outcome?.tenantId,
      plan: outcome?.plan
    });

    return {
      status: 'PROCESSED',
      eventId,
      eventType,
      outcome
    };
  }

  /**
   * Core event handler for subscription lifecycle
   */
  async handleWebhookEvent(event) {
    const dataObject = event.data?.object || {};
    const eventType = event.type;

    switch (eventType) {
      case 'checkout.session.completed': {
        const tenantId = dataObject.client_reference_id || dataObject.metadata?.tenantId;
        if (!tenantId) {
          this.logger.warn('checkout.session.completed missing tenantId reference', { objectId: dataObject.id });
          return { status: 'NO_TENANT_REF' };
        }

        const plan = (dataObject.metadata?.plan || 'PRO').toUpperCase();
        const customerId = dataObject.customer || null;
        const subscriptionId = dataObject.subscription || null;

        await this.storage.upsertTenantSubscription({
          tenantId,
          provider: 'stripe',
          customerId,
          subscriptionId,
          plan,
          status: 'active',
          metadata: {
            checkoutSessionId: dataObject.id,
            amountTotal: dataObject.amount_total,
            currency: dataObject.currency
          }
        });

        return { tenantId, plan, status: 'active', action: 'SUBSCRIPTION_ACTIVATED' };
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const tenantId = dataObject.metadata?.tenantId;
        const customerId = dataObject.customer;
        const subscriptionId = dataObject.id;
        const stripeStatus = dataObject.status; // 'active', 'past_due', 'canceled', 'trialing'
        const plan = (dataObject.metadata?.plan || (dataObject.items?.data?.[0]?.price?.lookup_key) || 'PRO').toUpperCase();

        const currentPeriodStart = dataObject.current_period_start
          ? new Date(dataObject.current_period_start * 1000).toISOString()
          : null;
        const currentPeriodEnd = dataObject.current_period_end
          ? new Date(dataObject.current_period_end * 1000).toISOString()
          : null;
        const cancelAtPeriodEnd = Boolean(dataObject.cancel_at_period_end);

        // Find tenant by tenantId or customerId
        let targetTenantId = tenantId;
        if (!targetTenantId) {
          // If metadata missing, look up existing subscription by customerId
          if (this.storage.isPostgres) {
            const res = await this.storage.query(
              'SELECT tenant_id FROM tenant_subscriptions WHERE customer_id = $1 LIMIT 1',
              [customerId]
            );
            targetTenantId = res.rows[0]?.tenant_id;
          } else if (this.storage.db) {
            const row = this.storage.db.prepare(
              'SELECT tenant_id FROM tenant_subscriptions WHERE customer_id = ? LIMIT 1'
            ).get(customerId);
            targetTenantId = row?.tenant_id;
          }
        }

        if (!targetTenantId) {
          this.logger.warn('Subscription event could not resolve target tenantId', { subscriptionId, customerId });
          return { status: 'TENANT_NOT_FOUND' };
        }

        await this.storage.upsertTenantSubscription({
          tenantId: targetTenantId,
          provider: 'stripe',
          customerId,
          subscriptionId,
          plan,
          status: stripeStatus,
          currentPeriodStart,
          currentPeriodEnd,
          cancelAtPeriodEnd,
          metadata: { stripeStatus }
        });

        return { tenantId: targetTenantId, plan, status: stripeStatus, action: 'SUBSCRIPTION_UPDATED' };
      }

      case 'customer.subscription.deleted': {
        const subscriptionId = dataObject.id;
        const customerId = dataObject.customer;

        let targetTenantId = dataObject.metadata?.tenantId;
        if (!targetTenantId) {
          if (this.storage.isPostgres) {
            const res = await this.storage.query(
              'SELECT tenant_id FROM tenant_subscriptions WHERE customer_id = $1 OR subscription_id = $2 LIMIT 1',
              [customerId, subscriptionId]
            );
            targetTenantId = res.rows[0]?.tenant_id;
          } else if (this.storage.db) {
            const row = this.storage.db.prepare(
              'SELECT tenant_id FROM tenant_subscriptions WHERE customer_id = ? OR subscription_id = ? LIMIT 1'
            ).get(customerId, subscriptionId);
            targetTenantId = row?.tenant_id;
          }
        }

        if (targetTenantId) {
          // Downgrade to FREE
          await this.storage.upsertTenantSubscription({
            tenantId: targetTenantId,
            provider: 'stripe',
            customerId,
            subscriptionId,
            plan: 'FREE',
            status: 'canceled',
            cancelAtPeriodEnd: false
          });
          return { tenantId: targetTenantId, plan: 'FREE', status: 'canceled', action: 'SUBSCRIPTION_CANCELLED' };
        }
        return { status: 'TENANT_NOT_FOUND' };
      }

      case 'invoice.payment_succeeded': {
        const customerId = dataObject.customer;
        const subscriptionId = dataObject.subscription;
        // Keep active
        return { action: 'PAYMENT_SUCCEEDED', customerId, subscriptionId };
      }

      case 'invoice.payment_failed': {
        const customerId = dataObject.customer;
        const subscriptionId = dataObject.subscription;
        // Mark past_due
        return { action: 'PAYMENT_FAILED', customerId, subscriptionId };
      }

      default:
        return { action: 'IGNORED_EVENT_TYPE', eventType };
    }
  }

  /**
   * Helper utility to create a signed mock Stripe webhook payload for testing
   */
  static generateSignature(rawPayload, secret, timestamp = Math.floor(Date.now() / 1000)) {
    const payloadStr = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);
    const signedPayload = `${timestamp}.${payloadStr}`;
    const v1Signature = crypto
      .createHmac('sha256', secret)
      .update(signedPayload, 'utf8')
      .digest('hex');
    return `t=${timestamp},v1=${v1Signature}`;
  }
}
