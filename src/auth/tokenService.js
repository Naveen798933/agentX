import crypto from 'node:crypto';

const DEFAULT_ACCESS_TOKEN_EXPIRY_SEC = 15 * 60; // 15 minutes
const DEFAULT_REFRESH_TOKEN_EXPIRY_SEC = 7 * 24 * 60 * 60; // 7 days

function base64UrlEncode(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
  return buf.toString('base64url');
}

function base64UrlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

/**
 * TokenService
 * Handles cryptographic generation, verification, and rotation of
 * short-lived access tokens (JWT) and secure refresh tokens.
 */
export class TokenService {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.jwtSecret] - HMAC secret key
   * @param {number} [options.accessTokenExpirySec=900]
   * @param {number} [options.refreshTokenExpirySec=604800]
   * @param {boolean} [options.secureCookies=false]
   */
  constructor(options = {}) {
    this.jwtSecret = options.jwtSecret || process.env.JWT_SECRET || process.env.AUTH_SECRET;
    if (!this.jwtSecret) {
      // In development or test if not set, generate an ephemeral random secret
      this.jwtSecret = crypto.randomBytes(32).toString('hex');
    }
    this.accessTokenExpirySec = options.accessTokenExpirySec || DEFAULT_ACCESS_TOKEN_EXPIRY_SEC;
    this.refreshTokenExpirySec = options.refreshTokenExpirySec || DEFAULT_REFRESH_TOKEN_EXPIRY_SEC;
    this.secureCookies = options.secureCookies !== undefined ? options.secureCookies : (process.env.NODE_ENV === 'production');
  }

  /**
   * Creates an HMAC-SHA256 signature
   * @private
   */
  _sign(data) {
    return crypto.createHmac('sha256', this.jwtSecret).update(data).digest('base64url');
  }

  /**
   * Generates a short-lived signed JWT access token
   * @param {Object} payload - User context: { sub, tenantId, role, email, [name] }
   * @param {number} [expiresInSec] - Custom expiration in seconds
   * @returns {string} JWT token string
   */
  generateAccessToken(payload, expiresInSec = null) {
    let duration = this.accessTokenExpirySec;
    if (typeof expiresInSec === 'number' && Number.isFinite(expiresInSec)) {
      duration = expiresInSec;
    } else if (typeof expiresInSec === 'object' && expiresInSec !== null) {
      const customSec = expiresInSec.expiresInSec !== undefined ? expiresInSec.expiresInSec : expiresInSec.expiresInSeconds;
      if (typeof customSec === 'number' && Number.isFinite(customSec)) {
        duration = customSec;
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const exp = now + duration;

    const header = {
      alg: 'HS256',
      typ: 'JWT'
    };

    const fullPayload = {
      ...payload,
      iat: now,
      exp,
      type: 'access'
    };

    const encodedHeader = base64UrlEncode(header);
    const encodedPayload = base64UrlEncode(fullPayload);
    const signature = this._sign(`${encodedHeader}.${encodedPayload}`);

    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }

  /**
   * Verifies and decodes a JWT access token
   * @param {string} token - The raw JWT string
   * @returns {{ valid: boolean, payload?: Object, error?: string, expired?: boolean }}
   */
  verifyAccessToken(token) {
    if (typeof token !== 'string' || !token) {
      return { valid: false, error: 'Token is missing or empty' };
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Malformed token structure' };
    }

    const [encodedHeader, encodedPayload, signature] = parts;
    const expectedSignature = this._sign(`${encodedHeader}.${encodedPayload}`);

    const sigBuf = Buffer.from(signature);
    const expectedSigBuf = Buffer.from(expectedSignature);

    if (sigBuf.length !== expectedSigBuf.length || !crypto.timingSafeEqual(sigBuf, expectedSigBuf)) {
      return { valid: false, error: 'Invalid token signature' };
    }

    let payload;
    try {
      payload = JSON.parse(base64UrlDecode(encodedPayload));
    } catch {
      return { valid: false, error: 'Failed to parse token payload' };
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      return { valid: false, error: 'Token missing or invalid expiration claim' };
    }

    if (payload.exp <= now) {
      return { valid: false, error: 'Token expired', expired: true };
    }

    return { valid: true, payload };
  }

  /**
   * Generates a cryptographically random raw refresh token and its SHA-256 hash
   * @returns {{ rawToken: string, tokenHash: string, expiresAt: Date }}
   */
  generateRefreshToken() {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashRefreshToken(rawToken);
    const expiresAt = new Date(Date.now() + this.refreshTokenExpirySec * 1000);

    return {
      rawToken,
      tokenHash,
      expiresAt
    };
  }

  /**
   * Hashes a raw refresh token using SHA-256 for secure database storage
   * @param {string} rawToken
   * @returns {string} SHA-256 hex string
   */
  hashRefreshToken(rawToken) {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  /**
   * Formats a secure HttpOnly Set-Cookie header for the refresh token
   * @param {string} rawRefreshToken
   * @param {Object} [options={}]
   * @returns {string} Set-Cookie header value
   */
  createRefreshCookie(rawRefreshToken, options = {}) {
    const maxAge = options.maxAge !== undefined ? options.maxAge : this.refreshTokenExpirySec;
    const secureFlag = options.secure !== undefined ? options.secure : this.secureCookies;
    const sameSite = options.sameSite || 'Strict';
    const path = options.path || '/api/auth';

    let cookie = `pulse_refresh_token=${rawRefreshToken}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=${sameSite}`;
    if (secureFlag) {
      cookie += '; Secure';
    }
    return cookie;
  }

  /**
   * Formats a Set-Cookie header that clears the refresh token cookie
   * @param {Object} [options={}]
   * @returns {string} Set-Cookie header value
   */
  createClearRefreshCookie(options = {}) {
    const path = options.path || '/api/auth';
    const sameSite = options.sameSite || 'Strict';
    let cookie = `pulse_refresh_token=; Path=${path}; Max-Age=0; HttpOnly; SameSite=${sameSite}`;
    if (options.secure !== undefined ? options.secure : this.secureCookies) {
      cookie += '; Secure';
    }
    return cookie;
  }

  /**
   * Extracts a specific cookie from a Cookie header string
   * @param {string} cookieHeader
   * @param {string} name
   * @returns {string|null}
   */
  static extractCookie(cookieHeader, name) {
    if (!cookieHeader || typeof cookieHeader !== 'string') return null;
    const pairs = cookieHeader.split(';');
    for (const rawPair of pairs) {
      const pair = rawPair.trim();
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const k = pair.slice(0, eqIdx).trim();
      const v = pair.slice(eqIdx + 1).trim();
      if (k === name) {
        return decodeURIComponent(v);
      }
    }
    return null;
  }
}
