import crypto from 'node:crypto';

export const LogLevel = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40
};

const LogLevelNames = {
  10: 'DEBUG',
  20: 'INFO',
  30: 'WARN',
  40: 'ERROR'
};

/**
 * Regex patterns for redacting sensitive credentials and personal data
 */
const SECRET_PATTERNS = [
  // Bearer tokens & JWTs
  { pattern: /(?:Bearer\s+)[A-Za-z0-9_\-\.]{10,}/gi, replacement: 'Bearer [REDACTED]' },
  // API keys and secrets in query strings or headers (e.g. key=..., apiKey=..., token=...)
  { pattern: /((?:api[_-]?key|api[_-]?secret|key|secret|token|client[_-]?secret|webhook[_-]?secret|password|passwd|jwt)=)[^&\s;,]+/gi, replacement: '$1[REDACTED]' },
  // Standalone secret keys (Stripe, Google Gemini, OpenAI, etc.)
  { pattern: /\b(?:sk_live|sk_test|pk_live|pk_test|whsec)_[A-Za-z0-9_]{10,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g, replacement: '[REDACTED]' },
  // Credit card numbers (13-19 digits formatted)
  { pattern: /\b(?:\d[ -]*?){13,19}\b/g, replacement: '[CARD_REDACTED]' },
  // Database connection passwords
  { pattern: /(postgres(?:ql)?:\/\/[^:]+:)[^@]+(@)/gi, replacement: '$1[REDACTED]$2' }
];

const SENSITIVE_KEY_REGEX = /^(?:password|secret|token|apiKey|api_key|apiKeySecret|authorization|privateKey|private_key|webhookSecret|webhook_secret|cookie|creditCard|card_number|cvv|ssn)$/i;

/**
 * Deep scrubber for sanitizing nested objects, strings, and errors
 */
export function sanitizeLogData(data, depth = 0, seen = new WeakSet()) {
  if (depth > 6) return '[TRUNCATED_DEPTH]';
  if (data === null || data === undefined) return data;

  if (typeof data === 'string') {
    let sanitized = data;
    for (const { pattern, replacement } of SECRET_PATTERNS) {
      sanitized = sanitized.replace(pattern, replacement);
    }
    // Sensitive prompts truncation if massive
    if (sanitized.length > 1000 && (sanitized.includes('PROMPT') || sanitized.includes('INSTRUCTION'))) {
      sanitized = sanitized.slice(0, 500) + '... [PROMPT_CONTENT_TRUNCATED]';
    }
    return sanitized;
  }

  if (typeof data === 'number' || typeof data === 'boolean') {
    return data;
  }

  if (data instanceof Error) {
    return {
      name: data.name,
      message: sanitizeLogData(data.message, depth + 1, seen),
      stack: sanitizeLogData(data.stack, depth + 1, seen)
    };
  }

  if (typeof data === 'object') {
    if (seen.has(data)) return '[CIRCULAR]';
    seen.add(data);

    if (Array.isArray(data)) {
      return data.map(item => sanitizeLogData(item, depth + 1, seen));
    }

    const clean = {};
    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        clean[key] = '[REDACTED]';
      } else {
        clean[key] = sanitizeLogData(value, depth + 1, seen);
      }
    }
    return clean;
  }

  return String(data);
}

/**
 * StructuredLogger
 * JSON-formatted logger with contextual fields (requestId, jobId, tenantId)
 * and automatic redaction of credentials and PII.
 */
export class StructuredLogger {
  /**
   * @param {Object} [options]
   * @param {number|string} [options.level='INFO']
   * @param {string} [options.service='server']
   * @param {Object} [options.defaultContext={}]
   * @param {boolean} [options.logToConsole=true]
   */
  constructor(options = {}) {
    this.service = options.service || options.defaultContext?.service || 'server';
    this.defaultContext = options.defaultContext || {};
    this.logToConsole = options.logToConsole !== undefined ? options.logToConsole : (process.env.NODE_ENV !== 'test');
    this.buffer = []; // Memory buffer for tests and audit inspections
    this.maxBufferSize = options.maxBufferSize || 500;

    const levelStr = (options.level || process.env.LOG_LEVEL || 'INFO').toUpperCase();
    this.minLevel = LogLevel[levelStr] || LogLevel.INFO;
  }

  _log(levelNum, message, meta = {}) {
    if (levelNum < this.minLevel) return;

    const timestamp = new Date().toISOString();
    const level = LogLevelNames[levelNum] || 'INFO';

    // Merge default context with call context
    const merged = { ...this.defaultContext, ...meta };

    const entry = {
      timestamp,
      level,
      service: merged.service || this.service,
      message: sanitizeLogData(message),
      requestId: merged.requestId || null,
      jobId: merged.jobId || null,
      tenantId: merged.tenantId || null,
      userId: merged.userId || null,
      projectId: merged.projectId || null
    };

    if (merged.durationMs !== undefined) {
      entry.durationMs = Number(merged.durationMs);
    }
    if (merged.error) {
      entry.error = sanitizeLogData(merged.error);
    }

    // Remaining non-standard fields go into context
    const standardKeys = new Set(['requestId', 'jobId', 'tenantId', 'userId', 'projectId', 'durationMs', 'error']);
    const context = {};
    for (const [k, v] of Object.entries(merged)) {
      if (!standardKeys.has(k)) {
        if (SENSITIVE_KEY_REGEX.test(k)) {
          context[k] = '[REDACTED]';
        } else {
          context[k] = sanitizeLogData(v);
        }
      }
    }
    if (Object.keys(context).length > 0) {
      entry.context = context;
    }

    // Retain in memory buffer for testing
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }

    if (this.logToConsole) {
      const line = JSON.stringify(entry);
      if (levelNum >= LogLevel.ERROR) {
        console.error(line);
      } else if (levelNum >= LogLevel.WARN) {
        console.warn(line);
      } else {
        console.log(line);
      }
    }

    return entry;
  }

  debug(message, meta) {
    return this._log(LogLevel.DEBUG, message, meta);
  }

  info(message, meta) {
    return this._log(LogLevel.INFO, message, meta);
  }

  warn(message, meta) {
    return this._log(LogLevel.WARN, message, meta);
  }

  error(message, errorOrMeta, extraMeta = {}) {
    let meta = {};
    if (errorOrMeta instanceof Error) {
      meta = { error: errorOrMeta, ...extraMeta };
    } else if (typeof errorOrMeta === 'object' && errorOrMeta !== null) {
      meta = { ...errorOrMeta, ...extraMeta };
    }
    return this._log(LogLevel.ERROR, message, meta);
  }

  /**
   * Create a scoped child logger with permanent context bindings
   */
  child(extraContext = {}) {
    return new StructuredLogger({
      level: LogLevelNames[this.minLevel],
      service: extraContext.service || this.service,
      defaultContext: { ...this.defaultContext, ...extraContext },
      logToConsole: this.logToConsole,
      maxBufferSize: this.maxBufferSize
    });
  }

  getEntries() {
    return [...this.buffer];
  }

  clearBuffer() {
    this.buffer = [];
  }
}

// Global default logger singleton
export const rootLogger = new StructuredLogger({
  service: 'pulse-platform',
  logToConsole: process.env.NODE_ENV !== 'test'
});
