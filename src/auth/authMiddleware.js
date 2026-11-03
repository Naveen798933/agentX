import { TokenService } from './tokenService.js';
import { hasSystemPermission, hasProjectPermission, SystemRoles } from './rbac.js';

/**
 * Extract client IP address safely
 */
export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

/**
 * AuthMiddleware
 * Server HTTP request authorization, permission enforcement, and CSRF protection.
 */
export class AuthMiddleware {
  /**
   * @param {Object} options
   * @param {TokenService} options.tokenService
   * @param {Object} options.storage
   * @param {Object} [options.rateLimiter]
   */
  constructor(options = {}) {
    this.tokenService = options.tokenService;
    this.storage = options.storage;
    this.rateLimiter = options.rateLimiter;
  }

  /**
   * Extracts and validates user session from Authorization header or cookie
   * Attaches req.user = { id, tenantId, role, email, name } or null
   */
  authenticate(req) {
    req.user = null;
    let token = null;

    // 1. Check Authorization Bearer header
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
      req.authType = 'bearer';
    }

    // 2. Fall back to cookie
    if (!token && req.headers['cookie']) {
      token = TokenService.extractCookie(req.headers['cookie'], 'pulse_access_token');
      if (token) req.authType = 'cookie';
    }

    if (!token) return null;

    const verification = this.tokenService.verifyAccessToken(token);
    if (!verification.valid) {
      req.authError = verification.error;
      req.isTokenExpired = verification.expired || false;
      return null;
    }

    req.user = {
      id: verification.payload.sub || verification.payload.id,
      tenantId: verification.payload.tenantId,
      role: verification.payload.role,
      email: verification.payload.email,
      name: verification.payload.name || ''
    };

    return req.user;
  }

  /**
   * Enforces that request is authenticated
   * Returns true if allowed, false if rejected (sends 401 response)
   */
  requireAuth(req, res) {
    if (!req.user) {
      this.authenticate(req);
    }

    if (!req.user) {
      const isExpired = req.isTokenExpired;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: isExpired ? 'Access token has expired' : (req.authError || 'Authentication required'),
        code: isExpired ? 'TOKEN_EXPIRED' : 'UNAUTHORIZED'
      }));
      return false;
    }

    return true;
  }

  /**
   * Enforces a system-level RBAC permission
   * Returns true if allowed, false if rejected (sends 403 response)
   */
  requirePermission(req, res, permission) {
    if (!this.requireAuth(req, res)) return false;

    if (!hasSystemPermission(req.user.role, permission)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `Access denied. Role "${req.user.role}" lacks required permission "${permission}".`,
        code: 'FORBIDDEN'
      }));
      return false;
    }

    return true;
  }

  /**
   * Enforces project-level ownership, tenant boundary, and membership permissions
   * Returns true if allowed, false if rejected
   */
  async requireProjectAccess(req, res, projectId, permission) {
    if (!this.requireAuth(req, res)) return false;

    // Platform admin has global access across all tenants and projects
    if (req.user.role === SystemRoles.PLATFORM_ADMIN) {
      return true;
    }

    const project = this.storage.getProject(projectId);
    if (!project) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Project "${projectId}" not found`, code: 'NOT_FOUND' }));
      return false;
    }

    // Tenant boundary isolation
    const projectTenantId = project.tenant_id || project.tenantId;
    if (projectTenantId && projectTenantId !== req.user.tenantId) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Access denied: Project belongs to a different organization.',
        code: 'CROSS_TENANT_FORBIDDEN'
      }));
      return false;
    }

    // Org Admin has all project access within their tenant
    if (req.user.role === SystemRoles.ORG_ADMIN) {
      return true;
    }

    // Check project ownership
    const isOwner = (project.owner_id === req.user.id || project.ownerId === req.user.id);

    // Check project member role
    const member = await this.storage.getProjectMember(projectId, req.user.id);
    const projectMemberRole = member?.role || null;

    const permitted = hasProjectPermission({
      userSystemRole: req.user.role,
      projectMemberRole,
      isProjectOwner: isOwner
    }, permission);

    if (!permitted) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `Forbidden: You do not have permission "${permission}" on project "${projectId}".`,
        code: 'FORBIDDEN'
      }));
      return false;
    }

    return true;
  }

  /**
   * Enforces CSRF token for mutating requests when cookie authentication is used
   */
  verifyCsrf(req, res) {
    const method = req.method.toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return true;
    }

    // Bearer token authentication in Authorization header is immune to browser CSRF
    if (req.authType === 'bearer') {
      return true;
    }

    // If using cookie session or state-modifying requests without Bearer, verify custom header
    const customHeader = req.headers['x-requested-with'] || req.headers['x-csrf-token'];
    if (!customHeader) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'CSRF validation failed: Missing custom request header (X-Requested-With or X-CSRF-Token)',
        code: 'CSRF_FAILED'
      }));
      return false;
    }

    return true;
  }
}
