/**
 * Abstract Base Storage Provider Interface
 * All storage backends (Local, S3, Cloudflare R2, MinIO) implement this interface.
 */
export class StorageProvider {
  /**
   * @param {string} providerName Name of provider ('LOCAL', 'S3', 'R2')
   */
  constructor(providerName = 'UNKNOWN') {
    this.providerName = providerName;
  }

  /**
   * Writes an object to storage atomically.
   * @param {string} key Canonical storage key
   * @param {Buffer|Uint8Array|string|import('node:stream').Readable} data
   * @param {object} [options]
   * @param {string} [options.contentType]
   * @param {string} [options.expectedHash]
   * @param {object} [options.metadata]
   * @returns {Promise<{ key: string, sizeBytes: number, hashSha256: string, etag: string, storageBackend: string }>}
   */
  async putObject(key, data, options = {}) {
    throw new Error('StorageProvider.putObject must be implemented by subclass');
  }

  /**
   * Reads an object from storage.
   * @param {string} key Canonical storage key
   * @returns {Promise<Buffer>}
   */
  async getObject(key) {
    throw new Error('StorageProvider.getObject must be implemented by subclass');
  }

  /**
   * Reads an object as a Readable stream.
   * @param {string} key
   * @returns {Promise<import('node:stream').Readable>}
   */
  async getObjectStream(key) {
    throw new Error('StorageProvider.getObjectStream must be implemented by subclass');
  }

  /**
   * Checks metadata of an object without downloading content.
   * @param {string} key
   * @returns {Promise<{ key: string, sizeBytes: number, contentType: string, lastModified: Date, etag: string, metadata?: object } | null>}
   */
  async headObject(key) {
    throw new Error('StorageProvider.headObject must be implemented by subclass');
  }

  /**
   * Deletes a single object from storage.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async deleteObject(key) {
    throw new Error('StorageProvider.deleteObject must be implemented by subclass');
  }

  /**
   * Deletes multiple objects in bulk.
   * @param {string[]} keys
   * @returns {Promise<{ deleted: string[], errors: Array<{ key: string, error: string }> }>}
   */
  async deleteObjects(keys) {
    const results = { deleted: [], errors: [] };
    for (const key of keys) {
      try {
        const deleted = await this.deleteObject(key);
        if (deleted) results.deleted.push(key);
      } catch (err) {
        results.errors.push({ key, error: err.message });
      }
    }
    return results;
  }

  /**
   * Lists objects with a given key prefix.
   * @param {string} prefix
   * @param {object} [options]
   * @returns {Promise<Array<{ key: string, sizeBytes: number, lastModified: Date, etag?: string }>>}
   */
  async listObjects(prefix = '', options = {}) {
    throw new Error('StorageProvider.listObjects must be implemented by subclass');
  }

  /**
   * Generates a short-lived signed URL for reading/downloading or uploading an object.
   * @param {string} key
   * @param {object} [options]
   * @param {'getObject'|'putObject'} [options.operation='getObject']
   * @param {number} [options.expiresInSeconds=900]
   * @returns {Promise<string>}
   */
  async getSignedUrl(key, options = {}) {
    throw new Error('StorageProvider.getSignedUrl must be implemented by subclass');
  }
}
