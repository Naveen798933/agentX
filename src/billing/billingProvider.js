/**
 * BillingProvider (Abstract Interface)
 * Enforces server-side signature verification and replay protection.
 */
export class BillingProvider {
  constructor(options = {}) {
    this.name = options.name || 'base';
    this.storage = options.storage;
    this.enabled = options.enabled !== undefined ? options.enabled : true;
  }

  /**
   * Verify cryptographic signature of the webhook request
   * @param {string|Buffer} rawPayload
   * @param {string} signatureHeader
   * @returns {{ valid: boolean, error?: string, timestamp?: number }}
   */
  verifyWebhookSignature(rawPayload, signatureHeader) {
    throw new Error('verifyWebhookSignature must be implemented by billing provider subclass');
  }

  /**
   * Process verified webhook event payload
   * @param {Object} event
   */
  async handleWebhookEvent(event) {
    throw new Error('handleWebhookEvent must be implemented by billing provider subclass');
  }
}
