import { CircuitBreaker } from './circuitBreaker.js';
import { GeminiAdapter } from './adapters/geminiAdapter.js';
import { ClaudeAdapter } from './adapters/claudeAdapter.js';
import { OpenAIAdapter } from './adapters/openaiAdapter.js';
import { DeepSeekAdapter } from './adapters/deepseekAdapter.js';
import { OllamaAdapter } from './adapters/ollamaAdapter.js';
import { GeminiClient } from './geminiClient.js';
import { telemetry } from '../observability/telemetry.js';

/**
 * Enterprise Multi-Model AI Gateway
 * Provides intelligent model routing, cost-latency arbitrage, circuit-breaker fault tolerance,
 * and automated multi-provider failover cascades.
 */
export class ModelGateway {
  /**
   * @param {Object} options
   */
  constructor(options = {}) {
    this.options = options;

    // 1. Initialize Provider Adapters
    this.adapters = {
      gemini: options.geminiAdapter || new GeminiAdapter(options.gemini || {}),
      claude: options.claudeAdapter || new ClaudeAdapter(options.claude || {}),
      openai: options.openaiAdapter || new OpenAIAdapter(options.openai || {}),
      deepseek: options.deepseekAdapter || new DeepSeekAdapter(options.deepseek || {}),
      ollama: options.ollamaAdapter || new OllamaAdapter(options.ollama || {})
    };

    // 2. Initialize Circuit Breakers per provider
    this.circuitBreakers = {
      gemini: new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30000 }),
      claude: new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30000 }),
      openai: new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30000 }),
      deepseek: new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30000 }),
      ollama: new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 15000 })
    };

    // 3. Fallback Simulation Handler for offline tests
    this.simulationClient = new GeminiClient({ simulationMode: true });

    // 4. Default Cascading Routing Policy by Domain
    this.routingPolicy = {
      ARCHITECTURE: ['claude', 'gemini', 'openai'],
      CODE_GEN: ['claude', 'deepseek', 'gemini', 'openai'],
      SECURITY: ['claude', 'gemini', 'openai'],
      QA: ['claude', 'gemini', 'openai'],
      GENERAL: ['gemini', 'claude', 'deepseek', 'openai']
    };

    // Allow custom routing overrides
    if (options.routingPolicy) {
      Object.assign(this.routingPolicy, options.routingPolicy);
    }

    // Determine if any live provider has credentials
    const hasLiveKeys = Object.values(this.adapters).some(a => a.isAvailable());
    this.simulationMode = options.simulationMode !== undefined ? Boolean(options.simulationMode) : !hasLiveKeys;

    this.model = options.defaultModel || 'multi-model-gateway';
    this.fallbackModel = 'simulation';
    this.apiKey = this.adapters.gemini.apiKey || this.adapters.claude.apiKey || this.adapters.openai.apiKey;

    console.log(`[ModelGateway] V2.0 Gateway Initialized. Simulation Mode: ${this.simulationMode ? 'ON' : 'OFF'}`);
  }

  /**
   * Returns operational status of all registered providers and their circuit breakers
   */
  listProviders() {
    return Object.keys(this.adapters).map(key => {
      const adapter = this.adapters[key];
      const cb = this.circuitBreakers[key];
      return {
        id: key,
        providerType: adapter.getProviderType(),
        defaultModel: adapter.defaultModel,
        isConfigured: adapter.isAvailable(),
        circuitState: cb.getState ? cb.getState() : cb.status?.state || cb.state,
        circuitDetails: cb.getStatus()
      };
    });
  }

  getCircuitStatus() {
    const status = {};
    for (const [key, cb] of Object.entries(this.circuitBreakers)) {
      status[key] = cb.getStatus();
    }
    return status;
  }

  resetCircuits() {
    for (const cb of Object.values(this.circuitBreakers)) {
      cb.reset();
    }
  }

  setRoutingPolicy(domain, providerCascade) {
    if (!Array.isArray(providerCascade) || providerCascade.length === 0) {
      throw new Error('providerCascade must be a non-empty array of provider keys');
    }
    this.routingPolicy[domain.toUpperCase()] = providerCascade;
  }

  /**
   * Unified generation entrypoint with automated failover cascade
   */
  async generate({
    role = null,
    systemPrompt,
    userMessage,
    temperature = 0.7,
    timeoutMs = 25000,
    maxOutputTokens = 8192,
    domain = 'GENERAL',
    model = null
  }) {
    const startTime = Date.now();

    // If explicit simulation mode is requested or no keys are configured, use intelligent simulation
    if (this.simulationMode) {
      return this._executeSimulation(role, systemPrompt, userMessage, startTime);
    }

    // Determine target provider cascade based on domain
    const targetDomain = (domain || 'GENERAL').toUpperCase();
    const candidateProviders = this.routingPolicy[targetDomain] || this.routingPolicy.GENERAL;

    let lastError = null;

    for (let i = 0; i < candidateProviders.length; i++) {
      const providerKey = candidateProviders[i];
      const adapter = this.adapters[providerKey];
      const circuit = this.circuitBreakers[providerKey];

      if (!adapter || !adapter.isAvailable()) {
        continue;
      }

      if (!circuit.canExecute()) {
        console.warn(`[ModelGateway] Circuit breaker OPEN for provider "${providerKey}". Skipping in cascade.`);
        continue;
      }

      try {
        const result = await adapter.generate({
          role,
          systemPrompt,
          userMessage,
          temperature,
          timeoutMs,
          maxOutputTokens,
          model,
          domain: targetDomain
        });

        // Record circuit breaker success
        circuit.recordSuccess();

        const durationMs = Date.now() - startTime;
        return {
          ...result,
          simulated: false,
          fallbackTriggered: i > 0,
          providerKey,
          durationMs
        };
      } catch (err) {
        lastError = err;
        circuit.recordFailure(err);
        console.warn(
          `[ModelGateway] Provider "${providerKey}" failed on attempt (domain: ${targetDomain}): ${err.message}. Cascading to next candidate...`
        );
      }
    }

    // If all live providers fail or none were available, gracefully drop to simulation fallback
    console.warn(`[ModelGateway] All live model candidates in cascade exhausted (${lastError?.message || 'none available'}). Falling back to intelligent simulation.`);
    return this._executeSimulation(role, systemPrompt, userMessage, startTime, true);
  }

  _executeSimulation(role, systemPrompt, userMessage, startTime, isFallback = false) {
    const sim = this.simulationClient._simulate(systemPrompt, userMessage, role);
    const durationMs = Date.now() - startTime;

    telemetry.recordLlmGeneration({
      model: 'simulation-gateway',
      provider: isFallback ? 'simulation_fallback' : 'simulation',
      totalTokens: sim.tokensUsed || 350,
      durationSeconds: durationMs / 1000
    });

    return {
      ...sim,
      modelUsed: 'simulation-v2',
      provider: isFallback ? 'SIMULATION_FALLBACK' : 'SIMULATION',
      costUsd: 0.0,
      durationMs,
      fallbackTriggered: isFallback
    };
  }
}

