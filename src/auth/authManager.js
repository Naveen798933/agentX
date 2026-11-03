import crypto from 'node:crypto';
import { PasswordHasher } from './passwordHasher.js';
import { TokenService } from './tokenService.js';
import { RateLimiter } from './rateLimiter.js';
import { MemoryEmailProvider, EmailProvider } from './emailProvider.js';
import { SystemRoles, normalizeRole } from './rbac.js';

export class AuthError extends Error {
  constructor(message, statusCode = 400, code = 'AUTH_ERROR') {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * AuthManager
 * High-level authentication and identity orchestrator.
 */
export class AuthManager {
  /**
   * @param {Object} options
   * @param {Object} options.storage - StorageEngine instance
   * @param {TokenService} [options.tokenService]
   * @param {RateLimiter} [options.rateLimiter]
   * @param {EmailProvider} [options.emailProvider]
   */
  constructor(options = {}) {
    if (!options.storage) throw new Error('AuthManager requires storage engine');
    this.storage = options.storage;
    this.tokenService = options.tokenService || new TokenService(options);
    this.rateLimiter = options.rateLimiter || new RateLimiter();
    this.emailProvider = options.emailProvider || new MemoryEmailProvider();
    this.baseUrl = options.baseUrl || 'http://localhost:3000';
  }

  _sanitizeUser(user) {
    if (!user) return null;
    const { password_hash, passwordHash, ...clean } = user;
    return {
      id: clean.id,
      tenantId: clean.tenant_id || clean.tenantId,
      email: clean.email,
      name: clean.name || '',
      role: normalizeRole(clean.role),
      status: clean.status,
      isEmailVerified: Boolean(clean.is_email_verified ?? clean.isEmailVerified),
      createdAt: clean.created_at || clean.createdAt,
      updatedAt: clean.updated_at || clean.updatedAt
    };
  }

  /**
   * Register a new user account
   */
  async register({ email, password, name = '', tenantId = 'tenant-default', role = SystemRoles.DEVELOPER, ipAddress = null, userAgent = null }) {
    if (!email || typeof email !== 'string') {
      throw new AuthError('Valid email address is required', 400, 'INVALID_EMAIL');
    }
    const normalizedEmail = email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new AuthError('Invalid email format', 400, 'INVALID_EMAIL_FORMAT');
    }

    const complexity = PasswordHasher.validateComplexity(password);
    if (!complexity.valid) {
      throw new AuthError(complexity.reason, 400, 'WEAK_PASSWORD');
    }

    // Rate limit registration requests by IP
    if (ipAddress) {
      const rl = this.rateLimiter.consume(`register:${ipAddress}`, 15, 3600);
      if (!rl.allowed) {
        throw new AuthError(`Too many registration attempts. Please retry in ${rl.retryAfterSec} seconds.`, 429, 'RATE_LIMITED');
      }
    }

    // Check if user already exists
    const existing = await this.storage.getUserByEmail(normalizedEmail);
    if (existing) {
      throw new AuthError('An account with this email already exists', 409, 'EMAIL_EXISTS');
    }

    // Ensure tenant exists
    let tenant = await this.storage.getTenantById(tenantId);
    if (!tenant) {
      tenant = await this.storage.createTenant({
        id: tenantId,
        name: tenantId === 'tenant-default' ? 'Default Organization' : tenantId,
        slug: tenantId.toLowerCase().replace(/[^a-z0-9]/g, '-')
      });
    }

    const passwordHash = await PasswordHasher.hash(password);
    const user = await this.storage.createUser({
      tenantId: tenant.id,
      email: normalizedEmail,
      passwordHash,
      role: normalizeRole(role),
      name,
      isEmailVerified: false,
      status: 'ACTIVE'
    });

    await this.storage.recordAuthAudit({
      tenantId: tenant.id,
      userId: user.id,
      action: 'USER_REGISTERED',
      ipAddress,
      userAgent,
      details: { email: normalizedEmail, role: user.role }
    });

    return this._sanitizeUser(user);
  }

  /**
   * Login with email & password, returns access token and refresh token
   */
  async login({ email, password, ipAddress = null, userAgent = null }) {
    if (!email || !password) {
      throw new AuthError('Email and password are required', 400, 'MISSING_CREDENTIALS');
    }
    const normalizedEmail = email.toLowerCase().trim();

    // Check brute-force lockout
    const lockCheck = this.rateLimiter.isLocked(normalizedEmail);
    if (lockCheck.locked) {
      throw new AuthError(
        `Account temporarily locked due to too many failed attempts. Try again in ${lockCheck.retryAfterSec} seconds.`,
        429,
        'ACCOUNT_LOCKED'
      );
    }

    const user = await this.storage.getUserByEmail(normalizedEmail);

    if (!user) {
      this.rateLimiter.recordFailure(normalizedEmail);
      await this.storage.recordAuthAudit({
        tenantId: 'tenant-default',
        action: 'LOGIN_FAILED',
        ipAddress,
        userAgent,
        details: { email: normalizedEmail, reason: 'USER_NOT_FOUND' }
      });
      throw new AuthError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    if (user.status !== 'ACTIVE') {
      throw new AuthError('Account is suspended or inactive', 403, 'ACCOUNT_INACTIVE');
    }

    // Check DB-level lockout if present
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      const waitSec = Math.ceil((new Date(user.lockedUntil).getTime() - Date.now()) / 1000);
      throw new AuthError(`Account locked. Try again in ${waitSec} seconds.`, 429, 'ACCOUNT_LOCKED');
    }

    const isValid = await PasswordHasher.verify(password, user.password_hash || user.passwordHash);

    if (!isValid) {
      const failResult = this.rateLimiter.recordFailure(normalizedEmail);
      const newFailCount = (user.failed_login_attempts || user.failedLoginAttempts || 0) + 1;
      const updates = { failedLoginAttempts: newFailCount };

      if (failResult.locked || newFailCount >= this.rateLimiter.maxLoginAttempts) {
        updates.lockedUntil = new Date(Date.now() + this.rateLimiter.lockoutDurationSec * 1000).toISOString();
      }

      await this.storage.updateUser(user.id, updates);

      await this.storage.recordAuthAudit({
        tenantId: user.tenant_id || user.tenantId,
        userId: user.id,
        action: 'LOGIN_FAILED',
        ipAddress,
        userAgent,
        details: { email: normalizedEmail, reason: 'BAD_PASSWORD', failures: newFailCount }
      });

      if (failResult.locked) {
        throw new AuthError(
          `Account locked due to 5 consecutive failed attempts. Please retry in ${this.rateLimiter.lockoutDurationSec} seconds.`,
          429,
          'ACCOUNT_LOCKED'
        );
      }

      throw new AuthError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    // Success: clear failures
    this.rateLimiter.recordSuccess(normalizedEmail);
    if ((user.failed_login_attempts || user.failedLoginAttempts || 0) > 0 || user.lockedUntil) {
      await this.storage.updateUser(user.id, { failedLoginAttempts: 0, lockedUntil: null });
    }

    const sanitized = this._sanitizeUser(user);

    // Short-lived JWT Access Token
    const accessToken = this.tokenService.generateAccessToken({
      sub: sanitized.id,
      tenantId: sanitized.tenantId,
      role: sanitized.role,
      email: sanitized.email,
      name: sanitized.name
    });

    // Refresh Token with single-use rotation
    const { rawToken, tokenHash, expiresAt } = this.tokenService.generateRefreshToken();
    await this.storage.createRefreshToken({
      userId: sanitized.id,
      tenantId: sanitized.tenantId,
      tokenHash,
      expiresAt,
      userAgent,
      ipAddress
    });

    const refreshCookie = this.tokenService.createRefreshCookie(rawToken);

    await this.storage.recordAuthAudit({
      tenantId: sanitized.tenantId,
      userId: sanitized.id,
      action: 'LOGIN_SUCCESS',
      ipAddress,
      userAgent,
      details: { email: normalizedEmail }
    });

    return {
      user: sanitized,
      accessToken,
      refreshToken: rawToken,
      refreshCookie,
      expiresIn: this.tokenService.accessTokenExpirySec
    };
  }

  /**
   * Rotate refresh token and issue fresh access token
   */
  async refreshSession(rawRefreshToken, { ipAddress = null, userAgent = null } = {}) {
    if (!rawRefreshToken || typeof rawRefreshToken !== 'string') {
      throw new AuthError('Refresh token is required', 401, 'MISSING_REFRESH_TOKEN');
    }

    const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
    const record = await this.storage.getRefreshTokenByHash(tokenHash);

    if (!record) {
      throw new AuthError('Invalid refresh token', 401, 'INVALID_REFRESH_TOKEN');
    }

    // Check expiration
    if (new Date(record.expires_at || record.expiresAt) <= new Date()) {
      throw new AuthError('Refresh token has expired. Please login again.', 401, 'TOKEN_EXPIRED');
    }

    // Reuse detection: If token was already revoked, token theft may have occurred!
    const revokedAt = record.revoked_at || record.revokedAt;
    if (revokedAt) {
      const userId = record.user_id || record.userId;
      // Invalidate all tokens for this user family
      await this.storage.revokeAllUserRefreshTokens(userId);
      await this.storage.recordAuthAudit({
        tenantId: record.tenant_id || record.tenantId,
        userId,
        action: 'REFRESH_TOKEN_REUSE_DETECTED',
        ipAddress,
        userAgent,
        details: { tokenHash }
      });
      throw new AuthError('Suspicious session activity detected. All sessions revoked. Please log in again.', 401, 'TOKEN_REUSED');
    }

    // Invalidate current refresh token (single-use rotation)
    await this.storage.revokeRefreshToken(tokenHash);

    const userId = record.user_id || record.userId;
    const user = await this.storage.getUserById(userId);
    if (!user || user.status !== 'ACTIVE') {
      throw new AuthError('User account is invalid or inactive', 403, 'USER_INACTIVE');
    }

    const sanitized = this._sanitizeUser(user);

    // Generate new Access Token
    const newAccessToken = this.tokenService.generateAccessToken({
      sub: sanitized.id,
      tenantId: sanitized.tenantId,
      role: sanitized.role,
      email: sanitized.email,
      name: sanitized.name
    });

    // Generate new rotated Refresh Token
    const nextRefresh = this.tokenService.generateRefreshToken();
    await this.storage.createRefreshToken({
      userId: sanitized.id,
      tenantId: sanitized.tenantId,
      tokenHash: nextRefresh.tokenHash,
      expiresAt: nextRefresh.expiresAt,
      userAgent,
      ipAddress
    });

    const refreshCookie = this.tokenService.createRefreshCookie(nextRefresh.rawToken);

    await this.storage.recordAuthAudit({
      tenantId: sanitized.tenantId,
      userId: sanitized.id,
      action: 'TOKEN_REFRESHED',
      ipAddress,
      userAgent
    });

    return {
      user: sanitized,
      accessToken: newAccessToken,
      refreshToken: nextRefresh.rawToken,
      refreshCookie,
      expiresIn: this.tokenService.accessTokenExpirySec
    };
  }

  /**
   * Logout user, revoking refresh token
   */
  async logout(rawRefreshToken = null, userId = null, { ipAddress = null, userAgent = null } = {}) {
    if (rawRefreshToken) {
      const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
      await this.storage.revokeRefreshToken(tokenHash);
    } else if (userId) {
      await this.storage.revokeAllUserRefreshTokens(userId);
    }

    if (userId) {
      await this.storage.recordAuthAudit({
        tenantId: 'tenant-default',
        userId,
        action: 'USER_LOGGED_OUT',
        ipAddress,
        userAgent
      });
    }

    return {
      success: true,
      clearCookie: this.tokenService.createClearRefreshCookie()
    };
  }

  /**
   * Request password reset email
   */
  async requestPasswordReset(email, { ipAddress = null, userAgent = null } = {}) {
    if (!email) return { success: true };
    const normalizedEmail = email.toLowerCase().trim();

    if (ipAddress) {
      const rl = this.rateLimiter.consume(`pwd_reset:${ipAddress}`, 5, 900);
      if (!rl.allowed) {
        throw new AuthError(`Too many password reset requests. Please wait ${rl.retryAfterSec} seconds.`, 429, 'RATE_LIMITED');
      }
    }

    const user = await this.storage.getUserByEmail(normalizedEmail);
    if (!user) {
      // Return 200 to prevent user enumeration attacks
      return { success: true, message: 'If the email exists, a password reset link has been dispatched.' };
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 3600 * 1000); // 1 hour

    await this.storage.createPasswordReset({
      userId: user.id,
      tokenHash,
      expiresAt
    });

    const resetUrl = `${this.baseUrl}/reset-password?token=${rawToken}`;
    await this.emailProvider.sendPasswordResetEmail(normalizedEmail, rawToken, resetUrl);

    await this.storage.recordAuthAudit({
      tenantId: user.tenant_id || user.tenantId,
      userId: user.id,
      action: 'PASSWORD_RESET_REQUESTED',
      ipAddress,
      userAgent
    });

    return { success: true, message: 'If the email exists, a password reset link has been dispatched.', rawToken };
  }

  /**
   * Confirm password reset with token
   */
  async resetPassword({ token, newPassword, ipAddress = null, userAgent = null }) {
    if (!token || !newPassword) {
      throw new AuthError('Token and new password are required', 400, 'MISSING_DATA');
    }

    const complexity = PasswordHasher.validateComplexity(newPassword);
    if (!complexity.valid) {
      throw new AuthError(complexity.reason, 400, 'WEAK_PASSWORD');
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const record = await this.storage.getPasswordResetByHash(tokenHash);

    if (!record) {
      throw new AuthError('Invalid or expired password reset token', 400, 'INVALID_RESET_TOKEN');
    }

    if (record.used_at || record.usedAt) {
      throw new AuthError('This password reset link has already been used', 400, 'TOKEN_ALREADY_USED');
    }

    if (new Date(record.expires_at || record.expiresAt) <= new Date()) {
      throw new AuthError('Password reset link has expired', 400, 'TOKEN_EXPIRED');
    }

    const userId = record.user_id || record.userId;
    const newHash = await PasswordHasher.hash(newPassword);

    await this.storage.updateUser(userId, {
      passwordHash: newHash,
      failedLoginAttempts: 0,
      lockedUntil: null
    });

    await this.storage.markPasswordResetUsed(tokenHash);
    await this.storage.revokeAllUserRefreshTokens(userId);

    await this.storage.recordAuthAudit({
      tenantId: 'tenant-default',
      userId,
      action: 'PASSWORD_RESET_COMPLETED',
      ipAddress,
      userAgent
    });

    return { success: true, message: 'Password reset successfully. Please log in with your new password.' };
  }

  /**
   * Request email verification
   */
  async requestEmailVerification(userId, { ipAddress = null, userAgent = null } = {}) {
    const user = await this.storage.getUserById(userId);
    if (!user) throw new AuthError('User not found', 404, 'USER_NOT_FOUND');

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000); // 24 hours

    await this.storage.createEmailVerification({
      userId: user.id,
      tokenHash,
      expiresAt
    });

    const verificationUrl = `${this.baseUrl}/verify-email?token=${rawToken}`;
    await this.emailProvider.sendVerificationEmail(user.email, rawToken, verificationUrl);

    return { success: true, message: 'Verification email sent', rawToken };
  }

  /**
   * Confirm email verification
   */
  async confirmEmailVerification(token) {
    if (!token) throw new AuthError('Verification token is required', 400, 'MISSING_TOKEN');

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const record = await this.storage.getEmailVerificationByHash(tokenHash);

    if (!record) {
      throw new AuthError('Invalid verification token', 400, 'INVALID_TOKEN');
    }

    if (record.verified_at || record.verifiedAt) {
      return { success: true, message: 'Email already verified' };
    }

    if (new Date(record.expires_at || record.expiresAt) <= new Date()) {
      throw new AuthError('Verification link has expired', 400, 'TOKEN_EXPIRED');
    }

    const userId = record.user_id || record.userId;
    await this.storage.updateUser(userId, { isEmailVerified: true });
    await this.storage.markEmailVerificationUsed(tokenHash);

    return { success: true, message: 'Email successfully verified' };
  }

  /**
   * Bootstrap Platform Admin (Initial System Setup)
   * Avoids hardcoded production credentials.
   */
  async bootstrapPlatformAdmin({ email, password = null, name = 'Platform Administrator' }) {
    if (!email) throw new AuthError('Admin email is required', 400, 'MISSING_EMAIL');
    const normalizedEmail = email.toLowerCase().trim();

    // Check if an admin already exists
    const existing = await this.storage.getUserByEmail(normalizedEmail);
    if (existing) {
      if (existing.role === SystemRoles.PLATFORM_ADMIN) {
        return {
          created: false,
          user: this._sanitizeUser(existing),
          temporaryPassword: null,
          message: 'Platform administrator already exists'
        };
      }
      throw new AuthError('User exists with different role', 409, 'USER_EXISTS');
    }

    // Generate random secure password if not provided
    const generatedPassword = password || crypto.randomBytes(18).toString('base64url');
    const complexity = PasswordHasher.validateComplexity(generatedPassword);
    if (!complexity.valid) {
      throw new AuthError(complexity.reason, 400, 'WEAK_PASSWORD');
    }

    // Ensure platform tenant exists
    const platformTenant = await this.storage.createTenant({
      id: 'tenant-platform',
      name: 'PULSE Platform Root',
      slug: 'platform-root',
      plan: 'ENTERPRISE'
    });

    const passwordHash = await PasswordHasher.hash(generatedPassword);
    const adminUser = await this.storage.createUser({
      tenantId: platformTenant.id,
      email: normalizedEmail,
      passwordHash,
      role: SystemRoles.PLATFORM_ADMIN,
      name,
      isEmailVerified: true,
      status: 'ACTIVE'
    });

    await this.storage.recordAuthAudit({
      tenantId: platformTenant.id,
      userId: adminUser.id,
      action: 'ADMIN_BOOTSTRAPPED',
      details: { email: normalizedEmail, generatedCredentials: !password }
    });

    return {
      created: true,
      user: this._sanitizeUser(adminUser),
      temporaryPassword: password ? null : generatedPassword,
      message: 'Platform administrator bootstrapped successfully'
    };
  }
}
