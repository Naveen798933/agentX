import crypto from 'node:crypto';
import { StripeBillingProvider } from './stripeBillingProvider.js';

/**
 * MockBillingProvider
 * Test and staging provider for validating subscription webhooks,
 * plan transitions, and idempotency protection without live Stripe credentials.
 */
export class MockBillingProvider extends StripeBillingProvider {
  constructor(options = {}) {
    const mockSecret = options.webhookSecret || 'whsec_mock_test_secret_key_12345';
    super({
      storage: options.storage,
      webhookSecret: mockSecret,
      apiKey: options.apiKey || 'sk_test_mock_12345',
      toleranceSeconds: options.toleranceSeconds || 300,
      enabled: options.enabled !== undefined ? options.enabled : true
    });
    this.name = 'mock';
  }

  /**
   * Helper to craft a signed mock Stripe webhook request
   */
  createMockWebhook(eventType, data = {}, customId = null, timestamp = Math.floor(Date.now() / 1000)) {
    const eventId = customId || 'evt_' + crypto.randomUUID().slice(0, 16);
    const event = {
      id: eventId,
      object: 'event',
      api_version: '2024-04-10',
      created: timestamp,
      type: eventType,
      data: {
        object: data
      }
    };

    const rawPayload = JSON.stringify(event);
    const signature = StripeBillingProvider.generateSignature(rawPayload, this.webhookSecret, timestamp);

    return {
      eventId,
      event,
      rawPayload,
      signatureHeader: signature
    };
  }
}
