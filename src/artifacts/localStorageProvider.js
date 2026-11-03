import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StorageProvider } from './storageProvider.js';
import { resolveSafePath, validateRelativePath } from './pathValidator.js';
import { SignedUrlService } from './signedUrlService.js';

export class StorageError extends Error {
  constructor(message, code = 'STORAGE_ERROR', statusCode = 500) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Local Filesystem Storage Provider.
 * Stores artifacts in a sandboxed directory with atomic writes and path traversal protection.
 */
export class LocalStorageProvider extends StorageProvider {
  /**
   * @param {object} [options]
   * @param {string} [options.baseDir] Base directory for storage (default: 'data/artifacts')
   * @param {SignedUrlService} [options.signedUrlService]
   * @param {number} [options.maxSizeBytes] Default maximum artifact size (50MB)
   */
  constructor(options = {}) {
    super('LOCAL');
    this.baseDir = path.resolve(options.baseDir || path.join(process.cwd(), 'data', 'artifacts'));
    this.signedUrlService = options.signedUrlService || new SignedUrlService();
    this.maxSizeBytes = options.maxSizeBytes || 50 * 1024 * 1024; // 50MB

    // Ensure root storage directory exists
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Writes an object atomically to local storage.
   * Handles streams, buffers, and strings; validates SHA-256 integrity and size bounds.
   */
  async putObject(key, data, options = {}) {
    const safeKey = validateRelativePath(key);
    const targetPath = resolveSafePath(this.baseDir, safeKey);
    const targetDir = path.dirname(targetPath);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const tempFilename = `.tmp-${crypto.randomUUID()}`;
    const tempPath = path.join(targetDir, tempFilename);

    let sizeBytes = 0;
    const hasher = crypto.createHash('sha256');
    const maxSize = options.maxSizeBytes || this.maxSizeBytes;

    try {
      if (typeof data === 'string' || Buffer.isBuffer(data) || data instanceof Uint8Array) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        sizeBytes = buf.length;

        if (sizeBytes > maxSize) {
          throw new StorageError(
            `Artifact size (${sizeBytes} bytes) exceeds limit of ${maxSize} bytes`,
            'PAYLOAD_TOO_LARGE',
            413
          );
        }

        hasher.update(buf);
        const hashSha256 = hasher.digest('hex');

        if (options.expectedHash && options.expectedHash.toLowerCase() !== hashSha256) {
          throw new StorageError(
            `Integrity check failed: expected ${options.expectedHash}, calculated ${hashSha256}`,
            'INTEGRITY_CHECK_FAILED',
            400
          );
        }

        // Atomic write: write to temp file then rename
        fs.writeFileSync(tempPath, buf);
        fs.renameSync(tempPath, targetPath);

        return {
          key: safeKey,
          sizeBytes,
          hashSha256,
          etag: `"${hashSha256.slice(0, 32)}"`,
          storageBackend: 'LOCAL'
        };
      } else if (data && typeof data.pipe === 'function') {
        // Stream write
        await new Promise((resolve, reject) => {
          const writeStream = fs.createWriteStream(tempPath);

          data.on('data', (chunk) => {
            sizeBytes += chunk.length;
            if (sizeBytes > maxSize) {
              data.destroy(new StorageError(`Artifact exceeds maximum size of ${maxSize} bytes`, 'PAYLOAD_TOO_LARGE', 413));
            } else {
              hasher.update(chunk);
            }
          });

          data.pipe(writeStream);
          writeStream.on('finish', resolve);
          writeStream.on('error', reject);
          data.on('error', reject);
        });

        const hashSha256 = hasher.digest('hex');

        if (options.expectedHash && options.expectedHash.toLowerCase() !== hashSha256) {
          throw new StorageError(
            `Integrity check failed: expected ${options.expectedHash}, calculated ${hashSha256}`,
            'INTEGRITY_CHECK_FAILED',
            400
          );
        }

        fs.renameSync(tempPath, targetPath);

        return {
          key: safeKey,
          sizeBytes,
          hashSha256,
          etag: `"${hashSha256.slice(0, 32)}"`,
          storageBackend: 'LOCAL'
        };
      } else {
        throw new StorageError('Invalid data type: must be Buffer, string, or Readable stream', 'INVALID_DATA');
      }
    } catch (err) {
      // Ensure partial / temp file is deleted on failure
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch (_) {}
      }
      throw err;
    }
  }

  /**
   * Reads an object from local storage.
   */
  async getObject(key) {
    const safeKey = validateRelativePath(key);
    const targetPath = resolveSafePath(this.baseDir, safeKey);

    if (!fs.existsSync(targetPath)) {
      throw new StorageError(`Artifact not found: ${safeKey}`, 'NOT_FOUND', 404);
    }

    return fs.readFileSync(targetPath);
  }

  /**
   * Returns a readable stream for an object.
   */
  async getObjectStream(key) {
    const safeKey = validateRelativePath(key);
    const targetPath = resolveSafePath(this.baseDir, safeKey);

    if (!fs.existsSync(targetPath)) {
      throw new StorageError(`Artifact not found: ${safeKey}`, 'NOT_FOUND', 404);
    }

    return fs.createReadStream(targetPath);
  }

  /**
   * Returns metadata for an object without loading the file body.
   */
  async headObject(key) {
    const safeKey = validateRelativePath(key);
    const targetPath = resolveSafePath(this.baseDir, safeKey);

    if (!fs.existsSync(targetPath)) {
      return null;
    }

    const stat = fs.statSync(targetPath);
    return {
      key: safeKey,
      sizeBytes: stat.size,
      lastModified: stat.mtime,
      etag: `"${stat.size}-${stat.mtimeMs.toString(16)}"`
    };
  }

  /**
   * Deletes an object from local storage.
   */
  async deleteObject(key) {
    const safeKey = validateRelativePath(key);
    const targetPath = resolveSafePath(this.baseDir, safeKey);

    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);

      // Clean up empty parent directories up to baseDir
      let currentDir = path.dirname(targetPath);
      while (currentDir !== this.baseDir && currentDir.startsWith(this.baseDir)) {
        try {
          const files = fs.readdirSync(currentDir);
          if (files.length === 0) {
            fs.rmdirSync(currentDir);
            currentDir = path.dirname(currentDir);
          } else {
            break;
          }
        } catch (_) {
          break;
        }
      }

      return true;
    }
    return false;
  }

  /**
   * Lists objects under a prefix.
   */
  async listObjects(prefix = '') {
    const results = [];
    const safePrefix = prefix ? validateRelativePath(prefix) : '';
    const startDir = path.join(this.baseDir, safePrefix);

    const scan = (dir, rel) => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.tmp-')) continue; // Skip active temp files
        const full = path.join(dir, entry.name);
        const itemRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          scan(full, itemRel);
        } else if (entry.isFile()) {
          const stat = fs.statSync(full);
          results.push({
            key: itemRel,
            sizeBytes: stat.size,
            lastModified: stat.mtime,
            etag: `"${stat.size}-${stat.mtimeMs.toString(16)}"`
          });
        }
      }
    };

    scan(startDir, safePrefix);
    return results;
  }

  /**
   * Generates a signed download URL using SignedUrlService.
   */
  async getSignedUrl(key, options = {}) {
    return this.signedUrlService.createLocalDownloadUrl({
      storageKey: key,
      artifactId: options.artifactId || key,
      tenantId: options.tenantId || 'tenant-default',
      projectId: options.projectId || 'proj-default',
      expiresInSeconds: options.expiresInSeconds || 900
    });
  }
}
