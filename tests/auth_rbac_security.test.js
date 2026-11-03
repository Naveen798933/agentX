import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { StorageEngine } from '../src/storage/db.js';
import { PasswordHasher } from '../src/auth/passwordHasher.js';
import { TokenService } from '../src/auth/tokenService.js';
import { RateLimiter } from '../src/auth/rateLimiter.js';
import { MemoryEmailProvider } from '../src/auth/emailProvider.js';
import { AuthManager, AuthError } from '../src/auth/authManager.js';
import { AuthMiddleware } from '../src/auth/authMiddleware.js';
import { SystemRoles, ProjectRoles, Permissions, hasSystemPermission, hasProjectPermission } from '../src/auth/rbac.js';
import { VirtualHouseServer } from '../src/server/server.js';

describe('Phase 3 — Authentication, Authorization and RBAC Security Suite', () => {
  let tmpDir;
  let dbPath;
  let workspacesDir;
  let storage;
  let emailProvider;
  let tokenService;
  let rateLimiter;
  let authManager;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-auth-suite-'));
    dbPath = path.join(tmpDir, 'test_auth.db');
    workspacesDir = path.join(tmpDir, 'workspaces');
    fs.mkdirSync(workspacesDir, { recursive: true });

    storage = new StorageEngine(dbPath);
    emailProvider = new MemoryEmailProvider();
    tokenService = new TokenService({
      jwtSecret: 'test-crypto-jwt-secret-key-0123456789',
      accessTokenExpirySec: 900,
      refreshTokenExpirySec: 60,
      secureCookies: true
    });
    rateLimiter = new RateLimiter({
      maxLoginAttempts: 5,
      lockoutDurationSec: 2
    });
    authManager = new AuthManager({
      storage,
      tokenService,
      rateLimiter,
      emailProvider,
      baseUrl: 'http://127.0.0.1:3000'
    });
  });

  after(async () => {
    if (rateLimiter) rateLimiter.destroy();
    if (storage) storage.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  // ── 1. MODERN PASSWORD HASHING (SCRYPT) ───────────────────────────────────
  describe('1. Password Hashing & Complexity Validation', () => {
    test('enforces password complexity (minimum 8 chars, letters and numbers)', () => {
      assert.strictEqual(PasswordHasher.validateComplexity('short').valid, false);
      assert.strictEqual(PasswordHasher.validateComplexity('onlyletters').valid, false);
      assert.strictEqual(PasswordHasher.validateComplexity('12345678').valid, false);
      assert.strictEqual(PasswordHasher.validateComplexity('ValidPass123').valid, true);
    });

    test('hashes password using scrypt with unique salts and verified format', async () => {
      const password = 'SuperSecretPassword123';
      const hash1 = await PasswordHasher.hash(password);
      const hash2 = await PasswordHasher.hash(password);

      assert.ok(hash1.startsWith('scrypt:'), 'Hash must have scrypt algorithm prefix');
      assert.notStrictEqual(hash1, hash2, 'Salts must be randomly generated producing distinct hashes');

      const parts = hash1.split(':');
      assert.strictEqual(parts.length, 3, 'Format: scrypt:<saltHex>:<keyHex>');
      assert.strictEqual(parts[1].length, 32, 'Salt must be 16 bytes (32 hex characters)');
      assert.strictEqual(parts[2].length, 128, 'Derived key must be 64 bytes (128 hex characters)');
    });

    test('verifies correct passwords and rejects invalid passwords via timingSafeEqual', async () => {
      const password = 'CorrectPassword456';
      const hash = await PasswordHasher.hash(password);

      assert.strictEqual(await PasswordHasher.verify(password, hash), true);
      assert.strictEqual(await PasswordHasher.verify('WrongPassword123', hash), false);
      assert.strictEqual(await PasswordHasher.verify('', hash), false);
      assert.strictEqual(await PasswordHasher.verify(password, 'invalid:stored:hash'), false);
    });
  });

  // ── 2. REGISTRATION, LOGIN AND ACCOUNT LOCKOUT ────────────────────────────
  describe('2. User Registration, Authentication & Brute-Force Lockout', () => {
    test('registers a new user and denies duplicate email registration', async () => {
      const user = await authManager.register({
        email: 'alice@company.com',
        password: 'AlicePassword123',
        name: 'Alice Developer',
        role: SystemRoles.DEVELOPER
      });

      assert.ok(user.id);
      assert.strictEqual(user.email, 'alice@company.com');
      assert.strictEqual(user.role, SystemRoles.DEVELOPER);
      assert.strictEqual(user.isEmailVerified, false);

      // Attempt duplicate registration
      await assert.rejects(
        async () => {
          await authManager.register({
            email: 'alice@company.com',
            password: 'AnotherPassword789'
          });
        },
        /already exists/i
      );
    });

    test('authenticates valid credentials, returns tokens and secure cookie flags', async () => {
      const loginRes = await authManager.login({
        email: 'alice@company.com',
        password: 'AlicePassword123'
      });

      assert.ok(loginRes.accessToken, 'Must return JWT access token');
      assert.ok(loginRes.refreshToken, 'Must return raw refresh token');
      assert.ok(loginRes.refreshCookie.includes('HttpOnly'), 'Cookie must be HttpOnly');
      assert.ok(loginRes.refreshCookie.includes('SameSite=Strict'), 'Cookie must be SameSite=Strict');
      assert.ok(loginRes.refreshCookie.includes('Secure'), 'Cookie must include Secure flag');
      assert.ok(loginRes.refreshCookie.includes('Path=/api/auth'), 'Cookie must scope Path=/api/auth');
      assert.strictEqual(loginRes.user.email, 'alice@company.com');
    });

    test('triggers brute-force lockout after 5 consecutive failed login attempts', async () => {
      const targetEmail = 'brute-target@company.com';
      await authManager.register({
        email: targetEmail,
        password: 'ValidPassword123'
      });

      // Fail 4 times
      for (let i = 0; i < 4; i++) {
        await assert.rejects(
          async () => authManager.login({ email: targetEmail, password: 'BadPassword' }),
          /Invalid email or password/i
        );
      }

      // 5th failure triggers lockout
      await assert.rejects(
        async () => authManager.login({ email: targetEmail, password: 'BadPassword' }),
        /Account locked due to 5 consecutive failed attempts/i
      );

      // Even correct password is now blocked until lockout expires
      await assert.rejects(
        async () => authManager.login({ email: targetEmail, password: 'ValidPassword123' }),
        /Account temporarily locked/i
      );

      // Wait 2.1s for lockout to expire
      await new Promise(r => setTimeout(r, 2100));

      // Correct password now succeeds
      const success = await authManager.login({ email: targetEmail, password: 'ValidPassword123' });
      assert.ok(success.accessToken);
    });
  });

  // ── 3. TOKEN LIFECYCLE, ROTATION & REUSE DETECTION ────────────────────────
  describe('3. JWT Access Tokens, Rotation & Compromise Detection', () => {
    test('short-lived access token expires and is rejected by verifyAccessToken', async () => {
      const token = tokenService.generateAccessToken({ sub: 'usr-1', email: 'u1@test.com' }, 1);
      const immediate = tokenService.verifyAccessToken(token);
      assert.strictEqual(immediate.valid, true);

      // Wait 1.1s for expiration
      await new Promise(r => setTimeout(r, 1100));
      const expiredCheck = tokenService.verifyAccessToken(token);
      assert.strictEqual(expiredCheck.valid, false);
      assert.strictEqual(expiredCheck.expired, true);
    });

    test('tampered access token signature is detected and rejected', () => {
      const token = tokenService.generateAccessToken({ sub: 'usr-2', role: 'VIEWER' });
      const parts = token.split('.');
      // Tamper with payload (escalate role to PLATFORM_ADMIN)
      const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'usr-2', role: 'PLATFORM_ADMIN', exp: 9999999999 })).toString('base64url');
      const forgedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      const res = tokenService.verifyAccessToken(forgedToken);
      assert.strictEqual(res.valid, false);
      assert.strictEqual(res.error, 'Invalid token signature');
    });

    test('refresh session performs single-use rotation and revokes used token', async () => {
      const reg = await authManager.register({
        email: 'rotator@test.com',
        password: 'RotatorPass123'
      });
      const login = await authManager.login({ email: 'rotator@test.com', password: 'RotatorPass123' });

      // Rotate once
      const refreshed = await authManager.refreshSession(login.refreshToken);
      assert.ok(refreshed.accessToken);
      assert.ok(refreshed.refreshToken);
      assert.notStrictEqual(refreshed.refreshToken, login.refreshToken, 'New refresh token must be issued');

      // Old refresh token must now be marked revoked in database
      const oldHash = tokenService.hashRefreshToken(login.refreshToken);
      const oldRecord = await storage.getRefreshTokenByHash(oldHash);
      assert.ok(oldRecord.revoked_at || oldRecord.revokedAt, 'Previous refresh token must be revoked');
    });

    test('reuse detection: attempting to reuse a revoked token revokes all user sessions', async () => {
      const reg = await authManager.register({
        email: 'stolen@test.com',
        password: 'StolenPass123'
      });
      const login = await authManager.login({ email: 'stolen@test.com', password: 'StolenPass123' });

      // Legitimate user rotates token
      const refreshed = await authManager.refreshSession(login.refreshToken);

      // Attacker attempts to replay the stolen, already-used refresh token
      await assert.rejects(
        async () => authManager.refreshSession(login.refreshToken),
        /Suspicious session activity detected/i
      );

      // Verification: The legitimate user's active session is also revoked for protection
      await assert.rejects(
        async () => authManager.refreshSession(refreshed.refreshToken),
        /Suspicious session activity detected/i
      );
    });
  });

  // ── 4. EMAIL VERIFICATION & PASSWORD RESET ────────────────────────────────
  describe('4. Email Verification & Password Reset Workflows', () => {
    test('dispatches email verification token and confirms verification', async () => {
      const user = await authManager.register({
        email: 'verify-me@test.com',
        password: 'VerifyPassword123'
      });
      assert.strictEqual(user.isEmailVerified, false);

      const reqRes = await authManager.requestEmailVerification(user.id);
      assert.ok(reqRes.rawToken);

      const email = emailProvider.getLatestEmail('verify-me@test.com', 'VERIFICATION');
      assert.ok(email);
      assert.strictEqual(email.token, reqRes.rawToken);

      // Confirm verification
      const confirmRes = await authManager.confirmEmailVerification(reqRes.rawToken);
      assert.strictEqual(confirmRes.success, true);

      const updated = await storage.getUserById(user.id);
      assert.strictEqual(updated.isEmailVerified, true);
    });

    test('executes password reset flow, invalidating tokens upon use and updating credentials', async () => {
      const user = await authManager.register({
        email: 'reset-target@test.com',
        password: 'OldPassword123'
      });
      const loginBefore = await authManager.login({ email: 'reset-target@test.com', password: 'OldPassword123' });

      // Request reset
      const resetReq = await authManager.requestPasswordReset('reset-target@test.com');
      assert.ok(resetReq.rawToken);

      // Reset password
      const resetRes = await authManager.resetPassword({
        token: resetReq.rawToken,
        newPassword: 'NewPassword789'
      });
      assert.strictEqual(resetRes.success, true);

      // Old password fails
      await assert.rejects(
        async () => authManager.login({ email: 'reset-target@test.com', password: 'OldPassword123' }),
        /Invalid email or password/i
      );

      // New password succeeds
      const loginAfter = await authManager.login({ email: 'reset-target@test.com', password: 'NewPassword789' });
      assert.ok(loginAfter.accessToken);

      // Attempt to reuse the same reset token fails
      await assert.rejects(
        async () => authManager.resetPassword({ token: resetReq.rawToken, newPassword: 'AnotherPassword999' }),
        /already been used/i
      );
    });
  });

  // ── 5. RBAC PERMISSION MATRIX & PROJECT MEMBERSHIP ────────────────────────
  describe('5. RBAC Permission Matrix & Project Access Control', () => {
    test('verifies system role permissions hierarchy', () => {
      // Platform Admin
      assert.strictEqual(hasSystemPermission(SystemRoles.PLATFORM_ADMIN, Permissions.PLATFORM_ADMIN), true);
      assert.strictEqual(hasSystemPermission(SystemRoles.PLATFORM_ADMIN, Permissions.PROJECT_DELETE), true);

      // Org Admin
      assert.strictEqual(hasSystemPermission(SystemRoles.ORG_ADMIN, Permissions.ORG_BILLING_MANAGE), true);
      assert.strictEqual(hasSystemPermission(SystemRoles.ORG_ADMIN, Permissions.APPROVAL_DECIDE), true);
      assert.strictEqual(hasSystemPermission(SystemRoles.ORG_ADMIN, Permissions.PLATFORM_ADMIN), false);

      // Project Manager
      assert.strictEqual(hasSystemPermission(SystemRoles.PROJECT_MANAGER, Permissions.PROJECT_CREATE), true);
      assert.strictEqual(hasSystemPermission(SystemRoles.PROJECT_MANAGER, Permissions.APPROVAL_DECIDE), true);
      assert.strictEqual(hasSystemPermission(SystemRoles.PROJECT_MANAGER, Permissions.ORG_BILLING_MANAGE), false);

      // Developer
      assert.strictEqual(hasSystemPermission(SystemRoles.DEVELOPER, Permissions.FILE_WRITE), true);
      assert.strictEqual(hasSystemPermission(SystemRoles.DEVELOPER, Permissions.BUILD_TRIGGER), true);
      assert.strictEqual(hasSystemPermission(SystemRoles.DEVELOPER, Permissions.APPROVAL_DECIDE), false);

      // Viewer
      assert.strictEqual(hasSystemPermission(SystemRoles.VIEWER, Permissions.PROJECT_READ), true);
      assert.strictEqual(hasSystemPermission(SystemRoles.VIEWER, Permissions.FILE_READ), true);
      assert.strictEqual(hasSystemPermission(SystemRoles.VIEWER, Permissions.FILE_WRITE), false);
      assert.strictEqual(hasSystemPermission(SystemRoles.VIEWER, Permissions.BUILD_TRIGGER), false);
    });

    test('project owner and project-specific roles take precedence over base system roles', () => {
      // A user with system role VIEWER but project role DEVELOPER can write files in that project
      const canDevWrite = hasProjectPermission({
        userSystemRole: SystemRoles.VIEWER,
        projectMemberRole: ProjectRoles.DEVELOPER
      }, Permissions.FILE_WRITE);
      assert.strictEqual(canDevWrite, true);

      // A user with system role DEVELOPER but project role VIEWER is restricted to read-only
      const canViewerWrite = hasProjectPermission({
        userSystemRole: SystemRoles.DEVELOPER,
        projectMemberRole: ProjectRoles.VIEWER
      }, Permissions.FILE_WRITE);
      assert.strictEqual(canViewerWrite, false);

      // Project owner has full governance over project
      const canOwnerDecide = hasProjectPermission({
        userSystemRole: SystemRoles.DEVELOPER,
        isProjectOwner: true
      }, Permissions.APPROVAL_DECIDE);
      assert.strictEqual(canOwnerDecide, true);
    });
  });

  // ── 6. AUDIT LOGGING & INITIAL ADMIN BOOTSTRAP ────────────────────────────
  describe('6. Security Audit Records & Initial Admin Bootstrap', () => {
    test('records immutable audit logs for security-critical operations', async () => {
      await storage.recordAuthAudit({
        tenantId: 'tenant-audit-test',
        userId: 'usr-audit-1',
        action: 'ROLE_CHANGED',
        ipAddress: '192.168.1.100',
        userAgent: 'Mozilla/5.0 TestAgent',
        details: { oldRole: 'DEVELOPER', newRole: 'PROJECT_MANAGER' }
      });

      const logs = await storage.listAuthAuditLogs({ tenantId: 'tenant-audit-test', limit: 10 });
      assert.ok(logs.length >= 1);
      assert.strictEqual(logs[0].action, 'ROLE_CHANGED');
      assert.strictEqual(logs[0].ip_address || logs[0].ipAddress, '192.168.1.100');
    });

    test('bootstraps platform admin with random secure credentials and enforces idempotency', async () => {
      const boot1 = await authManager.bootstrapPlatformAdmin({
        email: 'root-admin@platform.gov',
        name: 'Chief Architect'
      });

      assert.strictEqual(boot1.created, true);
      assert.ok(boot1.temporaryPassword, 'Random password must be generated when not provided');
      assert.strictEqual(boot1.user.role, SystemRoles.PLATFORM_ADMIN);
      assert.strictEqual(boot1.user.tenantId, 'tenant-platform');

      // Second invocation is idempotent
      const boot2 = await authManager.bootstrapPlatformAdmin({
        email: 'root-admin@platform.gov'
      });
      assert.strictEqual(boot2.created, false);
      assert.strictEqual(boot2.temporaryPassword, null);
    });
  });

  // ── 7. INTEGRATED HTTP SERVER SECURITY & RBAC ENFORCEMENT ─────────────────
  describe('7. HTTP Server API Endpoint Authorization & Privilege Escalation Defense', () => {
    let server;
    let baseUrl;
    let devToken;
    let viewerToken;
    let adminToken;
    let orgATenantId = 'tenant-alpha';
    let orgBTenantId = 'tenant-beta';
    let projAId;

    before(async () => {
      server = new VirtualHouseServer({
        port: 0,
        host: '127.0.0.1',
        dbPath,
        workspacesDir,
        authEnabled: true,
        tokenService,
        authManager
      });
      baseUrl = await server.start();

      // Register test users
      const dev = await authManager.register({
        email: 'dev-caller@alpha.com',
        password: 'DevPassword123',
        role: SystemRoles.DEVELOPER,
        tenantId: orgATenantId
      });
      const devLogin = await authManager.login({ email: 'dev-caller@alpha.com', password: 'DevPassword123' });
      devToken = devLogin.accessToken;

      const viewer = await authManager.register({
        email: 'viewer-caller@alpha.com',
        password: 'ViewerPassword123',
        role: SystemRoles.VIEWER,
        tenantId: orgATenantId
      });
      const viewerLogin = await authManager.login({ email: 'viewer-caller@alpha.com', password: 'ViewerPassword123' });
      viewerToken = viewerLogin.accessToken;

      const admin = await authManager.register({
        email: 'admin-caller@alpha.com',
        password: 'AdminPassword123',
        role: SystemRoles.PLATFORM_ADMIN,
        tenantId: 'tenant-platform'
      });
      const adminLogin = await authManager.login({ email: 'admin-caller@alpha.com', password: 'AdminPassword123' });
      adminToken = adminLogin.accessToken;

      // Create a test project owned by org A
      projAId = 'proj-tenant-a-test';
      storage.createProject({
        id: projAId,
        tenantId: orgATenantId,
        name: 'Project Alpha Cloud',
        budgetTokens: 50000,
        budgetUsd: 10.0
      });
      server.sandbox.writeFileSafely(projAId, 'package.json', JSON.stringify({ name: projAId, version: '1.0.0' }));
      server.sandbox.writeFileSafely(projAId, 'src/index.js', 'console.log("hello");');
      storage.addProjectMember({
        tenantId: orgATenantId,
        projectId: projAId,
        userId: dev.id,
        role: ProjectRoles.DEVELOPER
      });
      storage.addProjectMember({
        tenantId: orgATenantId,
        projectId: projAId,
        userId: viewer.id,
        role: ProjectRoles.VIEWER
      });
    });

    after(async () => {
      if (server) await server.stop();
    });

    test('unauthenticated request is rejected with 401 Unauthorized', async () => {
      const res = await fetch(`${baseUrl}/api/status`);
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.strictEqual(data.code, 'UNAUTHORIZED');
    });

    test('authenticated request with valid bearer token succeeds (200 OK)', async () => {
      const res = await fetch(`${baseUrl}/api/status`, {
        headers: { Authorization: `Bearer ${devToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.status, 'ONLINE');
    });

    test('CSRF Defense: mutation without Authorization header or custom header is rejected (403)', async () => {
      // Send POST without Authorization header and without X-Requested-With
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Malicious CSRF Project' })
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.code, 'CSRF_FAILED');
    });

    test('privilege escalation defense: VIEWER cannot modify project files (403 Forbidden)', async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projAId}/files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${viewerToken}`
        },
        body: JSON.stringify({ file: 'src/hack.js', content: 'malicious payload' })
      });

      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.code, 'FORBIDDEN');
    });

    test('authorized DEVELOPER can modify project files (200 OK)', async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projAId}/files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${devToken}`
        },
        body: JSON.stringify({ file: 'src/feature.js', content: 'export const ok = true;' })
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
    });

    test('privilege escalation defense: DEVELOPER cannot approve gated production deployments (403 Forbidden)', async () => {
      // Seed approval
      const app = storage.createApproval({
        id: 'app-gated-test',
        tenantId: orgATenantId,
        projectId: projAId,
        actionType: 'PRODUCTION_DEPLOYMENT',
        payload: '{}',
        riskLevel: 'CRITICAL',
        reason: 'Release v1.0.0',
        requestedBy: 'emp-devops'
      });

      const res = await fetch(`${baseUrl}/api/approvals/${app.id}/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${devToken}`
        },
        body: JSON.stringify({ decision: 'APPROVED' })
      });

      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.code, 'FORBIDDEN');
    });

    test('PLATFORM_ADMIN can decide gated approvals (200 OK)', async () => {
      const res = await fetch(`${baseUrl}/api/approvals/app-gated-test/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`
        },
        body: JSON.stringify({ decision: 'APPROVED', reviewer: 'Platform Admin' })
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.status, 'APPROVED');
    });

    test('cross-tenant isolation: User from Tenant B cannot access Tenant A project (403 Forbidden)', async () => {
      const userB = await authManager.register({
        email: 'user@beta.com',
        password: 'BetaPassword123',
        tenantId: orgBTenantId,
        role: SystemRoles.DEVELOPER
      });
      const loginB = await authManager.login({ email: 'user@beta.com', password: 'BetaPassword123' });

      const res = await fetch(`${baseUrl}/api/projects/${projAId}`, {
        headers: { Authorization: `Bearer ${loginB.accessToken}` }
      });

      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.code, 'CROSS_TENANT_FORBIDDEN');
    });

    test('audit logs endpoint restricts access to privileged administrators', async () => {
      // Developer denied
      const devRes = await fetch(`${baseUrl}/api/admin/audit-logs`, {
        headers: { Authorization: `Bearer ${devToken}` }
      });
      assert.strictEqual(devRes.status, 403);

      // Platform Admin allowed
      const adminRes = await fetch(`${baseUrl}/api/admin/audit-logs`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.strictEqual(adminRes.status, 200);
      const logs = await adminRes.json();
      assert.ok(Array.isArray(logs));
    });
  });
});
