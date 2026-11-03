import crypto from 'node:crypto';
import { StorageProvider } from './storageProvider.js';
import { validateRelativePath } from './pathValidator.js';
import { StorageError } from './localStorageProvider.js';

/**
 * AWS Signature Version 4 Helper
 * Implements pure Node.js AWS SigV4 signing without external SDK dependencies.
 */
function hmac(key, string) {
  return crypto.createHmac('sha256', key).update(string).digest();
}

function hashSha256(stringOrBuffer) {
  return crypto.createHash('sha256').update(stringOrBuffer).digest('hex');
}

function getSigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * S3 and Cloudflare R2 Compatible Storage Provider.
 * Communicates directly with S3 API endpoints using SigV4 signed HTTP requests.
 */
export class S3StorageProvider extends StorageProvider {
  /**
   * @param {object} options
   * @param {string} options.bucket S3 Bucket Name
   * @param {string} [options.endpoint] S3 Endpoint (e.g. 'https://<account-id>.r2.cloudflarestorage.com' or 'https://s3.amazonaws.com')
   * @param {string} [options.region='us-east-1'] AWS Region or 'auto' for R2
   * @param {string} options.accessKeyId Provider Access Key
   * @param {string} options.secretAccessKey Provider Secret Access Key
   * @param {boolean} [options.forcePathStyle=false] Path-style URLs (http://endpoint/bucket/key) for MinIO
   * @param {number} [options.maxSizeBytes=52428800] 50MB
   */
  constructor(options = {}) {
    super(options.endpoint?.includes('cloudflarestorage.com') ? 'R2' : 'S3');

    this.bucket = options.bucket || process.env.STORAGE_S3_BUCKET;
    this.endpoint = (options.endpoint || process.env.STORAGE_S3_ENDPOINT || 'https://s3.amazonaws.com').replace(/\/+$/, '');
    this.region = options.region || process.env.STORAGE_S3_REGION || 'us-east-1';
    this.accessKeyId = options.accessKeyId || process.env.STORAGE_S3_ACCESS_KEY_ID;
    this.secretAccessKey = options.secretAccessKey || process.env.STORAGE_S3_SECRET_ACCESS_KEY;
    this.forcePathStyle = options.forcePathStyle !== undefined ? options.forcePathStyle : (process.env.STORAGE_S3_FORCE_PATH_STYLE === 'true');
    this.maxSizeBytes = options.maxSizeBytes || 50 * 1024 * 1024; // 50MB

    if (!this.bucket) {
      throw new StorageError('S3StorageProvider requires a bucket name', 'CONFIG_ERROR');
    }
  }

  /**
   * Resolves the canonical URL and Host header for a given object key.
   * @private
   */
  _resolveUrlAndHost(key) {
    const url = new URL(this.endpoint);
    let pathname = '';
    let host = url.host;

    if (this.forcePathStyle) {
      pathname = `/${this.bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
    } else {
      // Virtual-host style (bucket.s3.region.amazonaws.com or bucket.endpoint)
      host = `${this.bucket}.${url.host}`;
      pathname = `/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
    }

    const fullUrl = `${url.protocol}//${host}${pathname}`;
    return { url: fullUrl, host, pathname };
  }

  /**
   * Generates AWS SigV4 Headers for REST requests.
   * @private
   */
  _signRequest({ method, pathname, host, headers = {}, payloadHash = 'UNSIGNED-PAYLOAD' }) {
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new StorageError('Missing S3 credentials for request signing', 'CREDENTIALS_MISSING');
    }

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    headers['host'] = host;
    headers['x-amz-date'] = amzDate;
    headers['x-amz-content-sha256'] = payloadHash;

    const sortedHeaderKeys = Object.keys(headers).map(k => k.toLowerCase()).sort();
    const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${headers[k].trim()}\n`).join('');
    const signedHeaders = sortedHeaderKeys.join(';');

    const canonicalRequest = [
      method,
      pathname,
      '', // query string
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      hashSha256(canonicalRequest)
    ].join('\n');

    const signingKey = getSigningKey(this.secretAccessKey, dateStamp, this.region, 's3');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return headers;
  }

  /**
   * Puts an object into S3/R2.
   */
  async putObject(key, data, options = {}) {
    const safeKey = validateRelativePath(key);
    let bodyBuffer;
    if (Buffer.isBuffer(data)) {
      bodyBuffer = data;
    } else if (typeof data === 'string') {
      bodyBuffer = Buffer.from(data, 'utf8');
    } else if (data instanceof Uint8Array) {
      bodyBuffer = Buffer.from(data);
    } else {
      throw new StorageError('S3 putObject requires Buffer or string data', 'INVALID_DATA');
    }

    if (bodyBuffer.length > (options.maxSizeBytes || this.maxSizeBytes)) {
      throw new StorageError(
        `Artifact size (${bodyBuffer.length} bytes) exceeds limit of ${options.maxSizeBytes || this.maxSizeBytes} bytes`,
        'PAYLOAD_TOO_LARGE',
        413
      );
    }

    const hashSha256Str = hashSha256(bodyBuffer);
    if (options.expectedHash && options.expectedHash.toLowerCase() !== hashSha256Str) {
      throw new StorageError(
        `Integrity check failed: expected ${options.expectedHash}, calculated ${hashSha256Str}`,
        'INTEGRITY_CHECK_FAILED',
        400
      );
    }

    const { url, host, pathname } = this._resolveUrlAndHost(safeKey);
    const contentType = options.contentType || 'application/octet-stream';

    const reqHeaders = {
      'content-type': contentType,
      'content-length': bodyBuffer.length.toString()
    };

    if (options.isConfidential !== false) {
      // Never expose public read ACL for confidential items
      reqHeaders['x-amz-acl'] = 'private';
    }

    const signedHeaders = this._signRequest({
      method: 'PUT',
      pathname,
      host,
      headers: reqHeaders,
      payloadHash: hashSha256Str
    });

    const response = await fetch(url, {
      method: 'PUT',
      headers: signedHeaders,
      body: bodyBuffer
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new StorageError(`S3 PUT failed with status ${response.status}: ${errText.slice(0, 200)}`, 'S3_PUT_FAILED', response.status);
    }

    const etag = response.headers.get('etag') || `"${hashSha256Str.slice(0, 32)}"`;

    return {
      key: safeKey,
      sizeBytes: bodyBuffer.length,
      hashSha256: hashSha256Str,
      etag,
      storageBackend: this.providerName
    };
  }

  /**
   * Retrieves an object from S3/R2 as a Buffer.
   */
  async getObject(key) {
    const safeKey = validateRelativePath(key);
    const { url, host, pathname } = this._resolveUrlAndHost(safeKey);

    const signedHeaders = this._signRequest({
      method: 'GET',
      pathname,
      host,
      headers: {},
      payloadHash: hashSha256('')
    });

    const response = await fetch(url, {
      method: 'GET',
      headers: signedHeaders
    });

    if (response.status === 404) {
      throw new StorageError(`Artifact not found in S3: ${safeKey}`, 'NOT_FOUND', 404);
    }
    if (!response.ok) {
      throw new StorageError(`S3 GET failed with status ${response.status}`, 'S3_GET_FAILED', response.status);
    }

    const arrayBuf = await response.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  /**
   * Checks metadata of an object in S3/R2 without downloading body.
   */
  async headObject(key) {
    const safeKey = validateRelativePath(key);
    const { url, host, pathname } = this._resolveUrlAndHost(safeKey);

    const signedHeaders = this._signRequest({
      method: 'HEAD',
      pathname,
      host,
      headers: {},
      payloadHash: hashSha256('')
    });

    const response = await fetch(url, {
      method: 'HEAD',
      headers: signedHeaders
    });

    if (response.status === 404) return null;
    if (!response.ok) return null;

    return {
      key: safeKey,
      sizeBytes: parseInt(response.headers.get('content-length') || '0', 10),
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      lastModified: new Date(response.headers.get('last-modified') || Date.now()),
      etag: response.headers.get('etag') || ''
    };
  }

  /**
   * Deletes an object from S3/R2.
   */
  async deleteObject(key) {
    const safeKey = validateRelativePath(key);
    const { url, host, pathname } = this._resolveUrlAndHost(safeKey);

    const signedHeaders = this._signRequest({
      method: 'DELETE',
      pathname,
      host,
      headers: {},
      payloadHash: hashSha256('')
    });

    const response = await fetch(url, {
      method: 'DELETE',
      headers: signedHeaders
    });

    return response.ok || response.status === 404;
  }

  /**
   * Generates a standard AWS SigV4 pre-signed URL for direct download or upload.
   */
  async getSignedUrl(key, options = {}) {
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new StorageError('Missing credentials for pre-signed URL generation', 'CREDENTIALS_MISSING');
    }

    const safeKey = validateRelativePath(key);
    const method = (options.operation || 'getObject') === 'putObject' ? 'PUT' : 'GET';
    const expiresIn = Math.min(Math.max(options.expiresInSeconds || 900, 1), 604800); // 1 sec to 7 days

    const { host, pathname } = this._resolveUrlAndHost(safeKey);

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;

    const queryParams = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': expiresIn.toString(),
      'X-Amz-SignedHeaders': 'host'
    };

    const sortedQuery = Object.keys(queryParams)
      .sort()
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
      .join('&');

    const canonicalHeaders = `host:${host}\n`;
    const signedHeaders = 'host';

    const canonicalRequest = [
      method,
      pathname,
      sortedQuery,
      canonicalHeaders,
      signedHeaders,
      'UNSIGNED-PAYLOAD'
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      hashSha256(canonicalRequest)
    ].join('\n');

    const signingKey = getSigningKey(this.secretAccessKey, dateStamp, this.region, 's3');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    const finalQuery = `${sortedQuery}&X-Amz-Signature=${signature}`;
    const urlObj = new URL(this.endpoint);
    return `${urlObj.protocol}//${host}${pathname}?${finalQuery}`;
  }
}
