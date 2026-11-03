import { Redis } from 'ioredis';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Sanitize Redis connection URL or config object to mask passwords/tokens.
 */
export function sanitizeRedisConfig(configOrUrl) {
  if (typeof configOrUrl === 'string') {
    return configOrUrl.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
  }
  if (typeof configOrUrl === 'object' && configOrUrl !== null) {
    const copy = { ...configOrUrl };
    if (copy.password) copy.password = '***';
    if (copy.url) copy.url = sanitizeRedisConfig(copy.url);
    return copy;
  }
  return configOrUrl;
}

/**
 * Build Redis connection options from environment variables or custom config.
 */
export function getRedisConfig(options = {}) {
  const url = options.url || process.env.REDIS_URL;
  if (url) {
    return {
      url,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
      connectTimeout: options.connectTimeout || 10000,
      retryStrategy(times) {
        return Math.min(times * 150, 3000);
      }
    };
  }

  const host = options.host || process.env.REDIS_HOST || '127.0.0.1';
  const port = parseInt(options.port || process.env.REDIS_PORT || '6379', 10);
  const password = options.password !== undefined ? options.password : (process.env.REDIS_PASSWORD || undefined);
  const username = options.username || process.env.REDIS_USERNAME || undefined;
  const db = parseInt(options.db || process.env.REDIS_DB || '0', 10);
  const tls = options.tls !== undefined
    ? options.tls
    : (process.env.REDIS_TLS === 'true' ? {} : undefined);

  return {
    host,
    port,
    password,
    username,
    db,
    tls,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    connectTimeout: options.connectTimeout || 10000,
    retryStrategy(times) {
      return Math.min(times * 150, 3000);
    }
  };
}

/**
 * Create a resilient ioredis client instance.
 */
export function createRedisClient(options = {}) {
  const config = getRedisConfig(options);
  const client = config.url ? new Redis(config.url, config) : new Redis(config);

  client.on('error', (err) => {
    // Avoid uncaught exception spam during expected disconnects or retries
    if (process.env.NODE_ENV !== 'test') {
      console.error(`[Redis] Connection error: ${err.message}`);
    }
  });

  return client;
}

/**
 * Check Redis health and return latency & status.
 */
export async function checkRedisHealth(client, timeoutMs = 800) {
  const start = Date.now();
  try {
    if (client.status === 'end' || client.status === 'close') {
      return {
        ok: false,
        status: 'UNAVAILABLE',
        latencyMs: 0,
        error: `Client status: ${client.status}`
      };
    }

    const pingPromise = client.ping();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Redis ping timeout')), timeoutMs)
    );

    const reply = await Promise.race([pingPromise, timeoutPromise]);
    const latencyMs = Date.now() - start;
    const isOk = reply === 'PONG';
    return {
      ok: isOk,
      status: isOk ? 'HEALTHY' : 'DEGRADED',
      latencyMs,
      error: null
    };
  } catch (err) {
    return {
      ok: false,
      status: 'UNAVAILABLE',
      latencyMs: Date.now() - start,
      error: err.message
    };
  }
}

/**
 * Embedded Redis manager for testing and self-contained zero-dependency local runs.
 * Spawns the compiled bin/redis-server executable.
 */
export class EmbeddedRedisServer {
  constructor(options = {}) {
    this.port = options.port || 6399;
    this.password = options.password || null;
    this.process = null;
    this.running = false;
  }

  async start() {
    if (this.running) return;

    const binPath = path.resolve(__dirname, '../../bin/redis-server');
    if (!fs.existsSync(binPath)) {
      throw new Error(`redis-server binary not found at ${binPath}`);
    }

    const args = [
      '--port', String(this.port),
      '--save', '',
      '--appendonly', 'no',
      '--daemonize', 'no',
      '--protected-mode', this.password ? 'yes' : 'no'
    ];

    if (this.password) {
      args.push('--requirepass', this.password);
    }

    this.process = spawn(binPath, args, { stdio: 'pipe' });

    await new Promise((resolve, reject) => {
      let started = false;
      let errOutput = '';
      const timeout = setTimeout(() => {
        if (!started) reject(new Error('Embedded Redis startup timed out: ' + errOutput));
      }, 5000);

      this.process.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        errOutput += text;
        if (text.includes('Ready to accept connections') || text.includes('The server is now ready')) {
          started = true;
          clearTimeout(timeout);
          this.running = true;
          resolve();
        }
      });

      this.process.stderr.on('data', (chunk) => {
        errOutput += chunk.toString();
      });

      this.process.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.process.on('exit', (code) => {
        this.running = false;
        if (!started) {
          clearTimeout(timeout);
          reject(new Error(`Embedded Redis exited prematurely with code ${code}: ${errOutput}`));
        }
      });
    });
  }

  async stop() {
    if (!this.process || !this.running) return;

    return new Promise((resolve) => {
      this.process.once('exit', () => {
        this.running = false;
        this.process = null;
        resolve();
      });
      this.process.kill('SIGTERM');
      // Force kill after 2s if still hanging
      setTimeout(() => {
        if (this.process) {
          try { this.process.kill('SIGKILL'); } catch (_) {}
          this.running = false;
          this.process = null;
          resolve();
        }
      }, 2000);
    });
  }
}
