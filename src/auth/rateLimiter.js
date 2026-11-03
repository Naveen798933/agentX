/**
 * RateLimiter & Brute-Force Defense
 * In-memory sliding window rate limiter with account lockout protection.
 */
export class RateLimiter {
  /**
   * @param {Object} [options={}]
   * @param {number} [options.maxLoginAttempts=5] - Consecutive failures before lockout
   * @param {number} [options.lockoutDurationSec=900] - 15 minutes lockout
   * @param {number} [options.cleanupIntervalMs=60000] - Garbage collection interval
   */
  constructor(options = {}) {
    this.maxLoginAttempts = options.maxLoginAttempts || 5;
    this.lockoutDurationSec = options.lockoutDurationSec || 15 * 60; // 15 mins
    this.cleanupIntervalMs = options.cleanupIntervalMs || 60000;

    // Track request counts: Map<key, Array<timestamp>>
    this.windows = new Map();

    // Track locked accounts/IPs: Map<key, { lockedUntil: number, failures: number }>
    this.lockouts = new Map();

    // Start cleanup timer
    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  destroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Check and consume rate limit point using a sliding window
   * @param {string} key - Identifier (e.g. IP or IP+Endpoint)
   * @param {number} maxRequests - Max requests allowed in window
   * @param {number} windowSec - Window size in seconds
   * @returns {{ allowed: boolean, remaining: number, retryAfterSec: number, total: number }}
   */
  consume(key, maxRequests, windowSec) {
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const cutoff = now - windowMs;

    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Filter out timestamps outside current sliding window
    timestamps = timestamps.filter(t => t > cutoff);
    this.windows.set(key, timestamps);

    if (timestamps.length >= maxRequests) {
      const oldestInWindow = timestamps[0];
      const retryAfterSec = Math.ceil((oldestInWindow + windowMs - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, retryAfterSec),
        total: timestamps.length
      };
    }

    timestamps.push(now);
    return {
      allowed: true,
      remaining: maxRequests - timestamps.length,
      retryAfterSec: 0,
      total: timestamps.length
    };
  }

  /**
   * Checks if an email or IP is currently locked out due to repeated failures
   * @param {string} identifier - e.g. email or ip
   * @returns {{ locked: boolean, retryAfterSec: number }}
   */
  isLocked(identifier) {
    const normalized = identifier.toLowerCase().trim();
    const record = this.lockouts.get(normalized);
    if (!record) return { locked: false, retryAfterSec: 0 };

    const now = Date.now();
    if (record.lockedUntil > now) {
      const retryAfterSec = Math.ceil((record.lockedUntil - now) / 1000);
      return { locked: true, retryAfterSec };
    }

    // Lockout expired
    if (record.lockedUntil <= now && record.lockedUntil > 0) {
      this.lockouts.delete(normalized);
    }

    return { locked: false, retryAfterSec: 0 };
  }

  /**
   * Record a failed login attempt for an identifier
   * Locks out when threshold is reached
   * @param {string} identifier - email or IP
   * @returns {{ locked: boolean, failures: number, retryAfterSec: number }}
   */
  recordFailure(identifier) {
    const normalized = identifier.toLowerCase().trim();
    const now = Date.now();
    const record = this.lockouts.get(normalized) || { failures: 0, lockedUntil: 0 };

    record.failures += 1;

    if (record.failures >= this.maxLoginAttempts) {
      record.lockedUntil = now + (this.lockoutDurationSec * 1000);
      this.lockouts.set(normalized, record);
      return {
        locked: true,
        failures: record.failures,
        retryAfterSec: this.lockoutDurationSec
      };
    }

    this.lockouts.set(normalized, record);
    return {
      locked: false,
      failures: record.failures,
      retryAfterSec: 0
    };
  }

  /**
   * Reset failed attempts after a successful authentication
   * @param {string} identifier - email or IP
   */
  recordSuccess(identifier) {
    const normalized = identifier.toLowerCase().trim();
    this.lockouts.delete(normalized);
  }

  /**
   * Prune expired window records and lockouts
   */
  cleanup() {
    const now = Date.now();

    // Clean up windows
    for (const [key, timestamps] of this.windows.entries()) {
      const active = timestamps.filter(t => (now - t) < 3600000); // 1 hr max
      if (active.length === 0) {
        this.windows.delete(key);
      } else {
        this.windows.set(key, active);
      }
    }

    // Clean up expired lockouts
    for (const [key, record] of this.lockouts.entries()) {
      if (record.lockedUntil > 0 && record.lockedUntil <= now) {
        this.lockouts.delete(key);
      }
    }
  }
}
