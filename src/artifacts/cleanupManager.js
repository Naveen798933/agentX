import fs from 'node:fs';
import path from 'node:path';

export const RetentionPolicies = {
  PERMANENT: 'PERMANENT',
  TEMPORARY_BUILD: 'TEMPORARY_BUILD',
  FAILED_BUILD: 'FAILED_BUILD',
  EXPORT_ARCHIVE: 'EXPORT_ARCHIVE'
};

export const RetentionDefaults = {
  [RetentionPolicies.PERMANENT]: null,               // Indefinite
  [RetentionPolicies.TEMPORARY_BUILD]: 7 * 86400,     // 7 days
  [RetentionPolicies.FAILED_BUILD]: 24 * 3600,       // 24 hours
  [RetentionPolicies.EXPORT_ARCHIVE]: 2 * 3600       // 2 hours
};

/**
 * Calculates the expiration timestamp for an artifact given its retention policy.
 * @param {string} policy
 * @param {Date} [fromTime=new Date()]
 * @param {number} [customTtlSeconds]
 * @returns {Date|null}
 */
export function calculateExpirationDate(policy, fromTime = new Date(), customTtlSeconds = null) {
  if (policy === RetentionPolicies.PERMANENT) return null;

  const ttlSeconds = customTtlSeconds !== null && customTtlSeconds !== undefined
    ? customTtlSeconds
    : (RetentionDefaults[policy] || RetentionDefaults[RetentionPolicies.TEMPORARY_BUILD]);

  if (!ttlSeconds) return null;
  return new Date(fromTime.getTime() + ttlSeconds * 1000);
}

/**
 * CleanupManager manages lifecycle expiration and physical deletion of artifacts
 * across storage providers and database catalogs.
 */
export class CleanupManager {
  /**
   * @param {object} options
   * @param {import('./storageProvider.js').StorageProvider} options.storageProvider
   * @param {object} options.storageEngine Database storage engine (StorageEngine or PostgresStorageAdapter)
   */
  constructor(options = {}) {
    this.storageProvider = options.storageProvider;
    this.storageEngine = options.storageEngine;
  }

  /**
   * Runs the cleanup routine to purge expired artifacts.
   * @param {object} [options]
   * @param {boolean} [options.dryRun=false]
   * @param {boolean} [options.cleanOrphanedTemps=true]
   * @returns {Promise<{ scannedCount: number, deletedCount: number, reclaimedBytes: number, errors: Array<{ id: string, error: string }> }>}
   */
  async runCleanup(options = {}) {
    const dryRun = options.dryRun || false;
    const cleanOrphanedTemps = options.cleanOrphanedTemps !== false;
    const stats = { scannedCount: 0, deletedCount: 0, reclaimedBytes: 0, errors: [] };

    // 1. Query expired artifacts from database
    let expiredArtifacts = [];
    try {
      if (typeof this.storageEngine.getExpiredArtifacts === 'function') {
        expiredArtifacts = await this.storageEngine.getExpiredArtifacts();
      }
    } catch (err) {
      stats.errors.push({ id: 'DB_QUERY', error: err.message });
      return stats;
    }

    stats.scannedCount = expiredArtifacts.length;

    // 2. Delete each expired artifact from storage and update DB
    for (const artifact of expiredArtifacts) {
      try {
        if (!dryRun) {
          // Remove from storage provider
          if (artifact.storage_key) {
            await this.storageProvider.deleteObject(artifact.storage_key);
          }

          // Mark deleted in database
          if (typeof this.storageEngine.markArtifactDeleted === 'function') {
            await this.storageEngine.markArtifactDeleted(artifact.id);
          }
        }

        stats.deletedCount++;
        stats.reclaimedBytes += parseInt(artifact.file_size_bytes || '0', 10);
      } catch (err) {
        stats.errors.push({ id: artifact.id, error: err.message });
      }
    }

    // 3. Clean orphaned .tmp-* files from local storage if applicable
    if (cleanOrphanedTemps && !dryRun && this.storageProvider.providerName === 'LOCAL' && this.storageProvider.baseDir) {
      try {
        this._cleanOrphanedLocalTemps(this.storageProvider.baseDir, 3600 * 1000); // older than 1 hour
      } catch (_) {}
    }

    return stats;
  }

  /**
   * Recursively finds and deletes abandoned .tmp-* files older than maxAgeMs.
   * @private
   */
  _cleanOrphanedLocalTemps(dir, maxAgeMs) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const now = Date.now();

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this._cleanOrphanedLocalTemps(fullPath, maxAgeMs);
      } else if (entry.isFile() && entry.name.startsWith('.tmp-')) {
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.unlinkSync(fullPath);
          }
        } catch (_) {}
      }
    }
  }
}
