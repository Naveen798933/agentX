import { BaseModelAdapter } from './baseAdapter.js';
import { telemetry } from '../../observability/telemetry.js';

export class OpenAIAdapter extends BaseModelAdapter {
  constructor(options = {}) {
    super({
      providerType: 'OPENAI',
      apiKey: options.apiKey || process.env.OPENAI_API_KEY || null,
      defaultModel: options.model || process.env.OPENAI_MODEL || 'gpt-4o',
      fallbackModel: options.fallbackModel || 'gpt-4o-mini',
      endpoint: options.endpoint || 'https://api.openai.com/v1/chat/completions',
      rateLimitRpm: Number(options.rateLimitRpm || 60)
    });
  }

  estimateCost(inputTokens = 0, outputTokens = 0, modelName = this.defaultModel) {
    if (modelName.includes('mini')) {
      return Number(((inputTokens / 1000) * 0.00015 + (outputTokens / 1000) * 0.0006).toFixed(6));
    }
    // GPT-4o: $0.0025 / 1k input, $0.010 / 1k output
    return Number(((inputTokens / 1000) * 0.0025 + (outputTokens / 1000) * 0.01).toFixed(6));
  }

  async generate({ role = null, systemPrompt, userMessage, temperature = 0.7, timeoutMs = 25000, maxOutputTokens = 8192, model = null }) {
    const startTime = Date.now();
    const modelToUse = model || this.defaultModel;

    if (!this.apiKey) {
      throw new Error('OpenAI API key is missing. Set OPENAI_API_KEY.');
    }

    const body = {
      model: modelToUse,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature,
      max_tokens: maxOutputTokens
    };

    await this.enforceRateLimit();

    let res;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      throw new Error(`OpenAI request failed: ${this.redactSecrets(err.message)}`);
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${this.redactSecrets(errText)}`);
    }

    this.recordRequestTimestamp();
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';

    const durationMs = Date.now() - startTime;
    const promptTokens = data.usage?.prompt_tokens || 0;
    const completionTokens = data.usage?.completion_tokens || 0;
    const totalTokens = data.usage?.total_tokens || (promptTokens + completionTokens);
    const costUsd = this.estimateCost(promptTokens, completionTokens, modelToUse);

    telemetry.recordLlmGeneration({
      model: modelToUse,
      provider: 'openai',
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
      provider: 'OPENAI',
      durationMs,
      costUsd
    };
  }
}

