import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class MigrationRunner {
  /**
   * @param {Object} dbClient - PostgreSQL client, pool, or adapter with .query() support
   * @param {string} [migrationsDir] - Directory where .sql migration files reside
   */
  constructor(dbClient, migrationsDir = null) {
    this.client = dbClient;
    this.migrationsDir = migrationsDir || path.resolve(__dirname);
  }

  /**
   * Calculate SHA-256 checksum of file content
   */
  _computeChecksum(content) {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * Ensure schema_migrations table exists
   */
  async ensureMigrationTable() {
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  /**
   * Discover and parse all migration files from disk in version order
   */
  getAvailableMigrations() {
    if (!fs.existsSync(this.migrationsDir)) return [];

    const files = fs.readdirSync(this.migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    return files.map(file => {
      const match = file.match(/^(\d+)_(.+)\.sql$/);
      if (!match) return null;
      const version = parseInt(match[1], 10);
      const name = match[2];
      const fullPath = path.join(this.migrationsDir, file);
      const sql = fs.readFileSync(fullPath, 'utf8');
      const checksum = this._computeChecksum(sql);

      return {
        version,
        name,
        file,
        fullPath,
        sql,
        checksum
      };
    }).filter(Boolean);
  }

  /**
   * Fetch list of already applied migrations from database
   */
  async getAppliedMigrations() {
    await this.ensureMigrationTable();
    const res = await this.client.query(`
      SELECT version, name, checksum, applied_at
      FROM schema_migrations
      ORDER BY version ASC
    `);
    return res.rows || [];
  }

  /**
   * Determine which migrations are pending execution
   */
  async getPendingMigrations() {
    const available = this.getAvailableMigrations();
    const applied = await this.getAppliedMigrations();
    const appliedMap = new Map(applied.map(a => [a.version, a]));

    // Checksum integrity check on already applied migrations
    for (const app of applied) {
      const avail = available.find(a => a.version === app.version);
      if (avail && avail.checksum !== app.checksum) {
        console.warn(`[MigrationRunner] Warning: Checksum mismatch for migration v${app.version} ("${app.name}").`);
      }
    }

    return available.filter(m => !appliedMap.has(m.version));
  }

  /**
   * Execute all pending migrations in sequential version order inside transactions
   */
  async migrateUp() {
    await this.ensureMigrationTable();
    const pending = await this.getPendingMigrations();

    if (pending.length === 0) {
      return { appliedCount: 0, applied: [] };
    }

    const appliedResults = [];

    for (const migration of pending) {
      const startTime = Date.now();
      const client = typeof this.client.connect === 'function' ? await this.client.connect() : this.client;
      try {
        // Execute migration and record inside an atomic transaction
        await client.query('BEGIN');

        // Execute raw migration statements
        await client.query(migration.sql);

        // Record applied migration in schema_migrations
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, NOW())`,
          [migration.version, migration.name, migration.checksum]
        );

        await client.query('COMMIT');

        const durationMs = Date.now() - startTime;
        appliedResults.push({
          version: migration.version,
          name: migration.name,
          durationMs,
          status: 'APPLIED'
        });
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw new Error(`Migration v${migration.version} ("${migration.name}") failed: ${err.message}`);
      } finally {
        if (typeof client.release === 'function') client.release();
      }
    }

    return {
      appliedCount: appliedResults.length,
      applied: appliedResults
    };
  }

  /**
   * Rollback the most recently applied migration
   */
  async rollbackLast() {
    await this.ensureMigrationTable();
    const applied = await this.getAppliedMigrations();
    if (applied.length === 0) {
      return { rolledBack: null, message: 'No migrations to rollback' };
    }

    const last = applied[applied.length - 1];
    const client = typeof this.client.connect === 'function' ? await this.client.connect() : this.client;

    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM schema_migrations WHERE version = $1`, [last.version]);
      await client.query('COMMIT');

      return {
        rolledBack: last,
        message: `Rolled back migration record v${last.version} (${last.name})`
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw new Error(`Failed to rollback migration v${last.version}: ${err.message}`);
    } finally {
      if (typeof client.release === 'function') client.release();
    }
  }

  /**
   * Status summary
   */
  async getStatus() {
    const available = this.getAvailableMigrations();
    const applied = await this.getAppliedMigrations();
    const pending = await this.getPendingMigrations();

    return {
      totalAvailable: available.length,
      appliedCount: applied.length,
      pendingCount: pending.length,
      currentVersion: applied.length > 0 ? applied[applied.length - 1].version : 0,
      applied,
      pending: pending.map(p => ({ version: p.version, name: p.name, file: p.file }))
    };
  }
}
