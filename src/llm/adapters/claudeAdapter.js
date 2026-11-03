import { BaseModelAdapter } from './baseAdapter.js';
import { telemetry } from '../../observability/telemetry.js';

export class ClaudeAdapter extends BaseModelAdapter {
  constructor(options = {}) {
    super({
      providerType: 'ANTHROPIC',
      apiKey: options.apiKey || process.env.ANTHROPIC_API_KEY || null,
      defaultModel: options.model || process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
      fallbackModel: options.fallbackModel || 'claude-3-5-haiku-20241022',
      endpoint: options.endpoint || 'https://api.anthropic.com/v1/messages',
      rateLimitRpm: Number(options.rateLimitRpm || 50)
    });
  }

  estimateCost(inputTokens = 0, outputTokens = 0, modelName = this.defaultModel) {
    if (modelName.includes('haiku')) {
      return Number(((inputTokens / 1000) * 0.0008 + (outputTokens / 1000) * 0.004).toFixed(6));
    }
    // Sonnet rates: $0.003 / 1k input, $0.015 / 1k output
    return Number(((inputTokens / 1000) * 0.003 + (outputTokens / 1000) * 0.015).toFixed(6));
  }

  async generate({ role = null, systemPrompt, userMessage, temperature = 0.7, timeoutMs = 25000, maxOutputTokens = 8192, model = null }) {
    const startTime = Date.now();
    const modelToUse = model || this.defaultModel;

    if (!this.apiKey) {
      throw new Error('Anthropic API key is missing. Set ANTHROPIC_API_KEY.');
    }

    const body = {
      model: modelToUse,
      max_tokens: Math.min(maxOutputTokens, 8192),
      temperature,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userMessage
        }
      ]
    };

    await this.enforceRateLimit();

    let res;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      throw new Error(`Claude request failed: ${this.redactSecrets(err.message)}`);
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${this.redactSecrets(errText)}`);
    }

    this.recordRequestTimestamp();
    const data = await res.json();
    const text = (data.content || [])
      .filter(item => item && item.type === 'text')
      .map(item => item.text || '')
      .join('\n');

    const durationMs = Date.now() - startTime;
    const promptTokens = data.usage?.input_tokens || 0;
    const completionTokens = data.usage?.output_tokens || 0;
    const totalTokens = promptTokens + completionTokens;
    const costUsd = this.estimateCost(promptTokens, completionTokens, modelToUse);

    telemetry.recordLlmGeneration({
      model: modelToUse,
      provider: 'anthropic',
      promptTokens,
      completionTokens,
      totalTokens,
      durationSeconds: durationMs / 1000
    });

    return {
      text,
      tokensUsed: totalTokens,
      promptTokens,
      completionTokens,
      modelUsed: modelToUse,
      provider: 'ANTHROPIC',
      durationMs,
      costUsd
    };
  }
}

