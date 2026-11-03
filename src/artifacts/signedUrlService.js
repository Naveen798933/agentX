import crypto from 'node:crypto';

export class SignedUrlError extends Error {
  constructor(message, code = 'SIGNED_URL_ERROR') {
    super(message);
    this.name = 'SignedUrlError';
    this.code = code;
  }
}

/**
 * Service for generating and validating short-lived signed download tokens
 * and coordinating secure time-limited artifact access.
 */
export class SignedUrlService {
  /**
   * @param {object} options
   * @param {string} [options.secret] HMAC signing secret (minimum 32 chars recommended)
   * @param {number} [options.defaultExpiresInSeconds=900] 15 minutes default
   * @param {string} [options.baseUrl] Base URL for local download links, e.g. http://127.0.0.1:3000
   */
  constructor(options = {}) {
    this.secret = options.secret || process.env.STORAGE_SIGNING_SECRET || crypto.randomBytes(32).toString('hex');
    this.defaultExpiresInSeconds = options.defaultExpiresInSeconds || 900; // 15 mins
    this.baseUrl = options.baseUrl || process.env.PUBLIC_API_URL || '';
  }

  /**
   * Generates a signed token for an artifact download.
   * @param {object} params
   * @param {string} params.artifactId
   * @param {string} params.storageKey
   * @param {string} params.tenantId
   * @param {string} params.projectId
   * @param {number} [params.expiresInSeconds]
   * @param {string} [params.action='download']
   * @returns {string} Base64url-encoded signed token
   */
  createToken({ artifactId, storageKey, tenantId, projectId, expiresInSeconds, action = 'download' }) {
    const ttl = expiresInSeconds || this.defaultExpiresInSeconds;
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;

    const payload = {
      sub: artifactId,
      key: storageKey,
      tid: tenantId,
      pid: projectId,
      act: action,
      exp: expiresAt,
      iat: Math.floor(Date.now() / 1000),
      nonce: crypto.randomBytes(8).toString('hex')
    };

    const payloadStr = JSON.stringify(payload);
    const payloadB64 = Buffer.from(payloadStr, 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', this.secret).update(payloadB64).digest('base64url');

    return `${payloadB64}.${signature}`;
  }

  /**
   * Generates a full download URL for local artifacts.
   * @param {object} params
   * @returns {string} URL string
   */
  createLocalDownloadUrl(params) {
    const token = this.createToken(params);
    const prefix = this.baseUrl.replace(/\/+$/, '');
    return `${prefix}/api/artifacts/download?token=${encodeURIComponent(token)}`;
  }

  /**
   * Validates a signed download token.
   * @param {string} token
   * @param {object} [constraints]
   * @param {string} [constraints.tenantId]
   * @param {string} [constraints.projectId]
   * @param {string} [constraints.action='download']
   * @returns {object} Decoded payload
   */
  verifyToken(token, constraints = {}) {
    if (!token || typeof token !== 'string') {
      throw new SignedUrlError('Missing or invalid token', 'INVALID_TOKEN');
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
      throw new SignedUrlError('Malformed signed token format', 'MALFORMED_TOKEN');
    }

    const [payloadB64, signature] = parts;

    // Verify HMAC signature in constant time
    const expectedSig = crypto.createHmac('sha256', this.secret).update(payloadB64).digest('base64url');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSig);

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new SignedUrlError('Invalid token signature or token has been tampered with', 'SIGNATURE_MISMATCH');
    }

    // Decode and parse payload
    let payload;
    try {
      const decoded = Buffer.from(payloadB64, 'base64url').toString('utf8');
      payload = JSON.parse(decoded);
    } catch (_) {
      throw new SignedUrlError('Failed to parse token payload', 'MALFORMED_PAYLOAD');
    }

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) {
      throw new SignedUrlError('Download token has expired', 'TOKEN_EXPIRED');
    }

    // Validate expected action
    const expectedAction = constraints.action || 'download';
    if (payload.act !== expectedAction) {
      throw new SignedUrlError(`Invalid token action: expected "${expectedAction}"`, 'INVALID_ACTION');
    }

    // Tenant isolation check
    if (constraints.tenantId && payload.tid !== constraints.tenantId) {
      throw new SignedUrlError('Token tenant identifier mismatch', 'TENANT_MISMATCH');
    }

    // Project isolation check
    if (constraints.projectId && payload.pid !== constraints.projectId) {
      throw new SignedUrlError('Token project identifier mismatch', 'PROJECT_MISMATCH');
    }

    return payload;
  }
}
