import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ModelGateway,
  CircuitBreaker,
  CircuitState,
  BaseModelAdapter,
  GeminiAdapter,
  ClaudeAdapter,
  OpenAIAdapter,
  DeepSeekAdapter,
  OllamaAdapter
} from '../src/llm/index.js';

describe('V2.0 — Multi-Model AI Gateway & Resilient Fallback Suite', () => {

  describe('1. Circuit Breaker Fault-Tolerance Engine', () => {
    test('starts in CLOSED state and allows execution', () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
      assert.strictEqual(cb.state, CircuitState.CLOSED);
      assert.strictEqual(cb.canExecute(), true);
    });

    test('trips to OPEN state after reaching failure threshold and blocks execution', () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
      cb.recordFailure(new Error('HTTP 429'));
      assert.strictEqual(cb.state, CircuitState.CLOSED);
      assert.strictEqual(cb.canExecute(), true);

      cb.recordFailure(new Error('HTTP 429'));
      assert.strictEqual(cb.state, CircuitState.CLOSED);

      cb.recordFailure(new Error('HTTP 500'));
      assert.strictEqual(cb.state, CircuitState.OPEN);
      assert.strictEqual(cb.canExecute(), false);
      assert.strictEqual(cb.getStatus().lastError, 'HTTP 500');
    });

    test('moves to HALF_OPEN after reset timeout and closes on success', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 50, successThreshold: 1 });
      cb.recordFailure(new Error('Err 1'));
      cb.recordFailure(new Error('Err 2'));
      assert.strictEqual(cb.state, CircuitState.OPEN);
      assert.strictEqual(cb.canExecute(), false);

      // Wait for resetTimeoutMs
      await new Promise(r => setTimeout(r, 60));
      assert.strictEqual(cb.canExecute(), true);
      assert.strictEqual(cb.state, CircuitState.HALF_OPEN);

      // Success in HALF_OPEN closes circuit
      cb.recordSuccess();
      assert.strictEqual(cb.state, CircuitState.CLOSED);
      assert.strictEqual(cb.canExecute(), true);
    });

    test('manual reset() restores CLOSED state', () => {
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      cb.recordFailure(new Error('Fatal'));
      assert.strictEqual(cb.state, CircuitState.OPEN);

      cb.reset();
      assert.strictEqual(cb.state, CircuitState.CLOSED);
      assert.strictEqual(cb.canExecute(), true);
    });
  });

  describe('2. Provider Adapters & Secret Redaction', () => {
    test('BaseModelAdapter redacts API keys including regex special characters', () => {
      const adapter = new BaseModelAdapter({
        providerType: 'TEST',
        apiKey: 'sk-proj+test.key$123'
      });
      const rawError = 'Request failed with key sk-proj+test.key$123 on host';
      const redacted = adapter.redactSecrets(rawError);
      assert.strictEqual(redacted, 'Request failed with key [REDACTED] on host');
      assert.ok(!redacted.includes('sk-proj+test.key$123'));
    });

    test('GeminiAdapter, ClaudeAdapter, OpenAIAdapter, DeepSeekAdapter, and OllamaAdapter instantiate correctly', () => {
      const gemini = new GeminiAdapter({ apiKey: 'gem_123', model: 'gemini-3.5-flash' });
      assert.strictEqual(gemini.getProviderType(), 'GEMINI');
      assert.strictEqual(gemini.defaultModel, 'gemini-3.5-flash');
      assert.strictEqual(gemini.isAvailable(), true);
      assert.ok(gemini.estimateCost(1000, 2000) > 0);

      const claude = new ClaudeAdapter({ apiKey: 'claude_123', model: 'claude-3-5-sonnet' });
      assert.strictEqual(claude.getProviderType(), 'ANTHROPIC');
      assert.strictEqual(claude.defaultModel, 'claude-3-5-sonnet');
      assert.strictEqual(claude.isAvailable(), true);
      assert.ok(claude.estimateCost(1000, 1000) > 0);

      const openai = new OpenAIAdapter({ apiKey: 'openai_123', model: 'gpt-4o' });
      assert.strictEqual(openai.getProviderType(), 'OPENAI');
      assert.strictEqual(openai.defaultModel, 'gpt-4o');
      assert.strictEqual(openai.isAvailable(), true);

      const deepseek = new DeepSeekAdapter({ apiKey: 'deepseek_123', model: 'deepseek-chat' });
      assert.strictEqual(deepseek.getProviderType(), 'DEEPSEEK');
      assert.strictEqual(deepseek.defaultModel, 'deepseek-chat');
      assert.strictEqual(deepseek.isAvailable(), true);

      const ollama = new OllamaAdapter({ endpoint: 'http://localhost:11434' });
      assert.strictEqual(ollama.getProviderType(), 'OLLAMA');
      assert.strictEqual(ollama.estimateCost(5000, 5000), 0.0);
    });
  });

  describe('3. ModelGateway Routing, Failover Cascade & Simulation', () => {
    test('initializes and lists all registered providers and circuit states', () => {
      const gateway = new ModelGateway({ simulationMode: true });
      const providers = gateway.listProviders();
      assert.strictEqual(providers.length, 5);

      const providerTypes = providers.map(p => p.providerType);
      assert.ok(providerTypes.includes('GEMINI'));
      assert.ok(providerTypes.includes('ANTHROPIC'));
      assert.ok(providerTypes.includes('OPENAI'));
      assert.ok(providerTypes.includes('DEEPSEEK'));
      assert.ok(providerTypes.includes('OLLAMA'));

      for (const p of providers) {
        assert.strictEqual(p.circuitDetails.state, CircuitState.CLOSED);
      }
    });

    test('generates valid response in simulation mode conforming to GeminiClient contract', async () => {
      const gateway = new ModelGateway({ simulationMode: true });
      const result = await gateway.generate({
        role: 'BACKEND',
        systemPrompt: 'You are a Senior Backend Engineer...',
        userMessage: 'Create an Express API for project tasks',
        domain: 'CODE_GEN'
      });

      assert.ok(result.text, 'Must produce response text');
      assert.ok(result.tokensUsed > 0, 'Must meter tokens');
      assert.strictEqual(result.simulated, true);
      assert.strictEqual(result.provider, 'SIMULATION');
      assert.ok(typeof result.durationMs === 'number');
    });

    test('executes automatic fallback cascade when primary provider fails', async () => {
      // Mock primary adapter that fails with 429
      let primaryCalls = 0;
      const mockPrimary = {
        getProviderType: () => 'MOCK_PRIMARY',
        isAvailable: () => true,
        defaultModel: 'mock-primary',
        generate: async () => {
          primaryCalls++;
          throw new Error('HTTP 429: Rate limit exceeded');
        }
      };

      // Mock secondary adapter that succeeds
      let secondaryCalls = 0;
      const mockSecondary = {
        getProviderType: () => 'MOCK_SECONDARY',
        isAvailable: () => true,
        defaultModel: 'mock-secondary',
        generate: async () => {
          secondaryCalls++;
          return {
            text: 'export function success() { return true; }',
            tokensUsed: 120,
            promptTokens: 40,
            completionTokens: 80,
            modelUsed: 'mock-secondary',
            provider: 'MOCK_SECONDARY',
            costUsd: 0.0005
          };
        }
      };

      const gateway = new ModelGateway({
        simulationMode: false,
        claudeAdapter: mockPrimary,
        geminiAdapter: mockSecondary,
        routingPolicy: {
          CODE_GEN: ['claude', 'gemini']
        }
      });

      const res = await gateway.generate({
        role: 'BACKEND',
        systemPrompt: 'Generate code',
        userMessage: 'Build feature',
        domain: 'CODE_GEN'
      });

      assert.strictEqual(primaryCalls, 1, 'Primary model must be called first');
      assert.strictEqual(secondaryCalls, 1, 'Secondary model must be called in fallback cascade');
      assert.strictEqual(res.fallbackTriggered, true, 'Result must flag fallbackTriggered');
      assert.strictEqual(res.provider, 'MOCK_SECONDARY');
      assert.strictEqual(res.simulated, false);
      assert.ok(res.text.includes('success'));

      // Check circuit breaker status on primary
      const status = gateway.getCircuitStatus();
      assert.strictEqual(status.claude.consecutiveFailures, 1);
      assert.strictEqual(status.gemini.consecutiveFailures, 0);
    });

    test('drops safely to simulation fallback if all cascade candidates fail', async () => {
      const mockFailing1 = {
        getProviderType: () => 'MOCK_1',
        isAvailable: () => true,
        generate: async () => { throw new Error('Provider 1 down'); }
      };
      const mockFailing2 = {
        getProviderType: () => 'MOCK_2',
        isAvailable: () => true,
        generate: async () => { throw new Error('Provider 2 down'); }
      };

      const gateway = new ModelGateway({
        simulationMode: false,
        claudeAdapter: mockFailing1,
        geminiAdapter: mockFailing2,
        routingPolicy: {
          SECURITY: ['claude', 'gemini']
        }
      });

      const res = await gateway.generate({
        role: 'SECURITY',
        systemPrompt: 'Perform security audit',
        userMessage: 'Check SQL injection defense',
        domain: 'SECURITY'
      });

      assert.strictEqual(res.fallbackTriggered, true);
      assert.strictEqual(res.provider, 'SIMULATION_FALLBACK');
      assert.ok(res.text, 'Must provide simulated fallback text without throwing fatal exception');
    });

    test('circuit breaker trips open on consecutive failures and skips provider', async () => {
      let callCount = 0;
      const mockFailing = {
        getProviderType: () => 'MOCK_FAIL',
        isAvailable: () => true,
        generate: async () => {
          callCount++;
          throw new Error('API outage 500');
        }
      };

      const gateway = new ModelGateway({
        simulationMode: false,
        claudeAdapter: mockFailing,
        routingPolicy: {
          GENERAL: ['claude']
        }
      });

      // Threshold is 3
      await gateway.generate({ systemPrompt: 'p', userMessage: 'm', domain: 'GENERAL' });
      await gateway.generate({ systemPrompt: 'p', userMessage: 'm', domain: 'GENERAL' });
      await gateway.generate({ systemPrompt: 'p', userMessage: 'm', domain: 'GENERAL' });

      assert.strictEqual(callCount, 3);
      assert.strictEqual(gateway.circuitBreakers.claude.state, CircuitState.OPEN);

      // 4th call should be skipped by circuit breaker without invoking adapter
      const res4 = await gateway.generate({ systemPrompt: 'p', userMessage: 'm', domain: 'GENERAL' });
      assert.strictEqual(callCount, 3, 'Adapter must NOT be called when circuit breaker is OPEN');
      assert.strictEqual(res4.fallbackTriggered, true);
    });
  });
});

