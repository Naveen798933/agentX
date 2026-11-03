/**
 * Base Adapter Contract for AI Model Providers
 * Standardizes multi-model invocation, token metering, and secret redaction.
 */

export class BaseModelAdapter {
  /**
   * @param {Object} options
   * @param {string} options.providerType - e.g. 'GEMINI', 'ANTHROPIC', 'OPENAI', 'DEEPSEEK', 'OLLAMA'
   * @param {string} [options.apiKey]
   * @param {string} [options.defaultModel]
   * @param {string} [options.fallbackModel]
   * @param {string} [options.endpoint]
   * @param {number} [options.rateLimitRpm=60]
   */
  constructor(options = {}) {
    this.providerType = options.providerType || 'CUSTOM';
    this.apiKey = options.apiKey || null;
    this.defaultModel = options.defaultModel || 'default';
    this.fallbackModel = options.fallbackModel || null;
    this.endpoint = options.endpoint || null;
    this.rateLimitRpm = Number(options.rateLimitRpm || 60);

    this.requestTimestamps = [];
  }

  getProviderType() {
    return this.providerType;
  }

  isAvailable() {
    return Boolean(this.apiKey) || this.providerType === 'OLLAMA';
  }

  redactSecrets(msg) {
    if (!msg || typeof msg !== 'string' || !this.apiKey) return msg || '';
    const escaped = this.apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return msg.replace(new RegExp(escaped, 'g'), '[REDACTED]');
  }

  /**
   * Sliding window rate limiter
   */
  async enforceRateLimit() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    this.requestTimestamps = this.requestTimestamps.filter(ts => ts > oneMinuteAgo);
    if (this.requestTimestamps.length >= this.rateLimitRpm) {
      const oldest = this.requestTimestamps[0];
      const waitTime = Math.max(100, (oldest + 60000) - now + 250);
      if (waitTime <= 8000) {
        console.log(`[LLM ${this.providerType}] Rate-limiter: Approaching ${this.rateLimitRpm} RPM limit. Throttling request by ${waitTime}ms...`);
        await new Promise(r => setTimeout(r, waitTime));
      }
    }
  }

  recordRequestTimestamp() {
    this.requestTimestamps.push(Date.now());
  }

  /**
   * Estimate cost in USD based on input and output tokens
   */
  estimateCost(inputTokens = 0, outputTokens = 0, modelName = this.defaultModel) {
    // Default rate: $0.0015 / 1k input, $0.002 / 1k output
    const cost = (inputTokens / 1000) * 0.0015 + (outputTokens / 1000) * 0.002;
    return Number(cost.toFixed(6));
  }

  /**
   * Unified generation entrypoint
   * @param {Object} params
   * @returns {Promise<{ text: string, tokensUsed: number, promptTokens: number, completionTokens: number, modelUsed: string, provider: string, durationMs: number, costUsd: number }>}
   */
  async generate(params) {
    throw new Error('Method generate() must be implemented by provider adapter');
  }
}

