import { BaseModelAdapter } from './baseAdapter.js';
import { telemetry } from '../../observability/telemetry.js';

export class GeminiAdapter extends BaseModelAdapter {
  constructor(options = {}) {
    super({
      providerType: 'GEMINI',
      apiKey: options.apiKey || process.env.GEMINI_API_KEY || null,
      defaultModel: options.model || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
      fallbackModel: options.fallbackModel || process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash',
      endpoint: options.endpoint || 'https://generativelanguage.googleapis.com/v1beta/models',
      rateLimitRpm: Number(options.rateLimitRpm || process.env.GEMINI_RPM_LIMIT || 14)
    });
  }

  estimateCost(inputTokens = 0, outputTokens = 0, modelName = this.defaultModel) {
    // Gemini 1.5/2.0/3.5 Flash: ~$0.000075 / 1k input, $0.0003 / 1k output
    const cost = (inputTokens / 1000) * 0.000075 + (outputTokens / 1000) * 0.0003;
    return Number(cost.toFixed(6));
  }

  async generate({ role = null, systemPrompt, userMessage, temperature = 0.7, timeoutMs = 15000, maxOutputTokens = 8192, model = null }) {
    const startTime = Date.now();
    const modelToUse = model || this.defaultModel;

    if (!this.apiKey) {
      throw new Error('Gemini API key is missing. Set GEMINI_API_KEY.');
    }

    const url = `${this.endpoint}/${modelToUse}:generateContent?key=${this.apiKey}`;
    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemPrompt}\n\n---\n\n${userMessage}` }]
        }
      ],
      generationConfig: {
        temperature,
        maxOutputTokens
      }
    };

    await this.enforceRateLimit();

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      throw new Error(`Gemini request failed: ${this.redactSecrets(err.message)}`);
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${this.redactSecrets(errText)}`);
    }

    this.recordRequestTimestamp();
    const data = await res.json();
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const text = parts.map(p => p.text || '').filter(Boolean).join('\n');
    const usage = data.usageMetadata || {};

    const durationMs = Date.now() - startTime;
    const promptTokens = usage.promptTokenCount || 0;
    const completionTokens = usage.candidatesTokenCount || 0;
    const totalTokens = promptTokens + completionTokens;
    const costUsd = this.estimateCost(promptTokens, completionTokens, modelToUse);

    telemetry.recordLlmGeneration({
      model: modelToUse,
      provider: 'google',
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
      provider: 'GEMINI',
      durationMs,
      costUsd
    };
  }
}

