import crypto from 'node:crypto';
import { sanitizeLogData } from './logger.js';

/**
 * SentryErrorTracker
 * Error-tracking provider integration with Sentry-compatible event capture,
 * automatic credential/PII scrubbing, and graceful no-op behavior when unconfigured.
 */
export class SentryProvider {
  /**
   * @param {Object} [options]
   * @param {string} [options.dsn] - Sentry DSN string e.g. https://public@sentry.io/12345
   * @param {string} [options.environment='development']
   * @param {string} [options.release='0.1.0']
   * @param {Function} [options.transport] - Optional custom transport for test mocking
   */
  constructor(options = {}) {
    this.dsn = options.dsn || process.env.SENTRY_DSN || null;
    this.environment = options.environment || process.env.NODE_ENV || 'development';
    this.release = options.release || '0.1.0';
    this.transport = options.transport || null;
    this.breadcrumbs = [];
    this.capturedEvents = [];
    this.maxCapturedEvents = options.maxCapturedEvents || 50;

    this.parsedDsn = this._parseDsn(this.dsn);
  }

  _parseDsn(dsn) {
    if (!dsn || typeof dsn !== 'string') return null;
    try {
      const parsed = new URL(dsn);
      const publicKey = parsed.username;
      const host = parsed.host;
      const projectId = parsed.pathname.replace(/^\//, '');
      if (!publicKey || !projectId) return null;
      return { publicKey, host, projectId, protocol: parsed.protocol };
    } catch (_) {
      return null;
    }
  }

  isConfigured() {
    return Boolean(this.parsedDsn);
  }

  addBreadcrumb(breadcrumb) {
    const crumb = {
      timestamp: new Date().toISOString(),
      category: breadcrumb.category || 'default',
      message: sanitizeLogData(breadcrumb.message || ''),
      level: breadcrumb.level || 'info',
      data: sanitizeLogData(breadcrumb.data || {})
    };
    this.breadcrumbs.push(crumb);
    if (this.breadcrumbs.length > 30) {
      this.breadcrumbs.shift();
    }
  }

  /**
   * Capture an unhandled exception or error
   */
  async captureException(error, context = {}) {
    const eventId = crypto.randomUUID().replace(/-/g, '');
    const cleanContext = sanitizeLogData(context);

    const event = {
      event_id: eventId,
      timestamp: new Date().toISOString(),
      platform: 'node',
      level: 'error',
      environment: this.environment,
      release: this.release,
      exception: {
        values: [
          {
            type: error?.name || 'Error',
            value: sanitizeLogData(error?.message || String(error)),
            stacktrace: {
              frames: sanitizeLogData(error?.stack || '')
            }
          }
        ]
      },
      tags: {
        requestId: cleanContext.requestId || null,
        jobId: cleanContext.jobId || null,
        tenantId: cleanContext.tenantId || null,
        userId: cleanContext.userId || null,
        service: cleanContext.service || 'server'
      },
      extra: cleanContext.extra || {},
      breadcrumbs: [...this.breadcrumbs]
    };

    this.capturedEvents.push(event);
    if (this.capturedEvents.length > this.maxCapturedEvents) {
      this.capturedEvents.shift();
    }

    if (this.transport) {
      try {
        await this.transport(event);
      } catch (err) {
        console.warn(`[SentryProvider] Custom transport failed: ${err.message}`);
      }
    } else if (this.isConfigured()) {
      // In live production with a real DSN, post to Sentry API
      try {
        const { protocol, host, projectId, publicKey } = this.parsedDsn;
        const endpoint = `${protocol}//${host}/api/${projectId}/store/`;
        await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=pulse-sentry/0.1.0, sentry_key=${publicKey}`
          },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(3000)
        });
      } catch (postErr) {
        // Silently tolerate upstream Sentry outages without crashing caller
      }
    }

    return eventId;
  }

  /**
   * Capture a custom message
   */
  async captureMessage(message, level = 'info', context = {}) {
    const eventId = crypto.randomUUID().replace(/-/g, '');
    const cleanContext = sanitizeLogData(context);

    const event = {
      event_id: eventId,
      timestamp: new Date().toISOString(),
      platform: 'node',
      level,
      message: sanitizeLogData(message),
      environment: this.environment,
      release: this.release,
      tags: {
        requestId: cleanContext.requestId || null,
        jobId: cleanContext.jobId || null,
        tenantId: cleanContext.tenantId || null,
        userId: cleanContext.userId || null
      },
      extra: cleanContext.extra || {}
    };

    this.capturedEvents.push(event);
    return eventId;
  }

  getCapturedEvents() {
    return [...this.capturedEvents];
  }

  clear() {
    this.capturedEvents = [];
    this.breadcrumbs = [];
  }
}

export const sentryProvider = new SentryProvider();
