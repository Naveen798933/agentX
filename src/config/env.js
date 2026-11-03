// Centralized, safe environment loader for AI Virtual Software House
import fs from 'node:fs';
import path from 'node:path';

let isLoaded = false;

export function loadEnvironment() {
  if (isLoaded) return;
  isLoaded = true;

  if (typeof process.loadEnvFile === 'function') {
    const candidates = [
      path.resolve(process.cwd(), '.env'),
      path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../.env'),
      path.resolve(path.dirname(new URL(import.meta.url).pathname), '../.env')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          process.loadEnvFile(p);
          break;
        } catch (_) {}
      }
    }
  }
}

// Auto-run on import
loadEnvironment();

export function getLlmConfig() {
  loadEnvironment();
  const rawKey = process.env.GEMINI_API_KEY;
  const isPresent = Boolean(rawKey && !rawKey.startsWith('mock_'));
  const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith('mock_'));
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.startsWith('mock_'));
  const hasDeepSeek = Boolean(process.env.DEEPSEEK_API_KEY && !process.env.DEEPSEEK_API_KEY.startsWith('mock_'));
  const hasOllama = Boolean(process.env.OLLAMA_HOST || process.env.USE_OLLAMA === 'true');

  const anyLiveKey = isPresent || hasClaude || hasOpenAI || hasDeepSeek;

  return {
    hasKey: isPresent,
    hasClaude,
    hasOpenAI,
    hasDeepSeek,
    hasOllama,
    anyLiveKey,
    v2GatewayEnabled: process.env.ENABLE_V2_MULTI_MODEL_GATEWAY === 'true',
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash',
    simulationMode: process.env.SIMULATION_MODE === 'true' || !anyLiveKey
  };
}
