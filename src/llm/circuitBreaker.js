/**
 * Circuit Breaker for Model Gateway Providers
 * Tracks failure rates and trips open to prevent cascade failures.
 */

export const CircuitState = Object.freeze({
  CLOSED: 'CLOSED',       // Normal operation
  OPEN: 'OPEN',           // Tripped; fail-fast without calling provider
  HALF_OPEN: 'HALF_OPEN'  // Probing provider with limited traffic
});

export class CircuitBreaker {
  /**
   * @param {Object} options
   * @param {number} [options.failureThreshold=3] Consecutive failures before tripping
   * @param {number} [options.resetTimeoutMs=30000] Time to wait before moving to HALF_OPEN
   * @param {number} [options.successThreshold=1] Consecutive successes in HALF_OPEN to CLOSE
   */
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 3;
    this.resetTimeoutMs = options.resetTimeoutMs || 30000;
    this.successThreshold = options.successThreshold || 1;

    this.state = CircuitState.CLOSED;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.lastStateChange = Date.now();
    this.lastFailureTime = null;
    this.lastError = null;
  }

  /**
   * Check if request should be allowed to execute
   */
  canExecute() {
    const now = Date.now();
    if (this.state === CircuitState.OPEN) {
      if (now - this.lastStateChange >= this.resetTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
        this.consecutiveSuccesses = 0;
        this.lastStateChange = now;
        return true;
      }
      return false;
    }
    return true;
  }

  /**
   * Record a successful invocation
   */
  recordSuccess() {
    this.consecutiveFailures = 0;
    if (this.state === CircuitState.HALF_OPEN) {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this.state = CircuitState.CLOSED;
        this.lastStateChange = Date.now();
      }
    }
  }

  /**
   * Record a failed invocation
   * @param {Error} [err]
   */
  recordFailure(err = null) {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    this.lastError = err ? err.message : 'Unknown error';

    if (this.state === CircuitState.HALF_OPEN || this.consecutiveFailures >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.lastStateChange = Date.now();
    }
  }

  /**
   * Current status
   */
  getStatus() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      lastFailureTime: this.lastFailureTime,
      lastError: this.lastError
    };
  }

  /**
   * Manually reset to CLOSED
   */
  reset() {
    this.state = CircuitState.CLOSED;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.lastStateChange = Date.now();
    this.lastError = null;
  }
}

