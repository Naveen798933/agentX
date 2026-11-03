import { BaseModelAdapter } from './baseAdapter.js';
import { telemetry } from '../../observability/telemetry.js';

export class OllamaAdapter extends BaseModelAdapter {
  constructor(options = {}) {
    const host = options.endpoint || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
    super({
      providerType: 'OLLAMA',
      apiKey: null,
      defaultModel: options.model || process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b',
      fallbackModel: options.fallbackModel || 'llama3.1:8b',
      endpoint: `${host.replace(/\/+$/, '')}/api/chat`,
      rateLimitRpm: Number(options.rateLimitRpm || 120)
    });
    this.host = host;
  }

  isAvailable() {
    return Boolean(process.env.OLLAMA_HOST || process.env.USE_OLLAMA === 'true');
  }

  estimateCost(inputTokens = 0, outputTokens = 0) {
    return 0.0; // Local inference has $0 API cost
  }

  async generate({ role = null, systemPrompt, userMessage, temperature = 0.7, timeoutMs = 60000, model = null }) {
    const startTime = Date.now();
    const modelToUse = model || this.defaultModel;

    const body = {
      model: modelToUse,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      options: {
        temperature
      },
      stream: false
    };

    let res;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      throw new Error(`Ollama local inference failed: ${err.message}`);
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama API error ${res.status}: ${errText}`);
    }

    this.recordRequestTimestamp();
    const data = await res.json();
    const text = data.message?.content || '';

    const durationMs = Date.now() - startTime;
    const promptTokens = data.prompt_eval_count || Math.ceil(userMessage.length / 4);
    const completionTokens = data.eval_count || Math.ceil(text.length / 4);
    const totalTokens = promptTokens + completionTokens;

    telemetry.recordLlmGeneration({
      model: modelToUse,
      provider: 'ollama',
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
      provider: 'OLLAMA',
      durationMs,
      costUsd: 0.0
    };
  }
}

