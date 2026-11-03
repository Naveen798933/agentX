/**
 * Tenant Authorization & Ownership Boundary Enforcement
 * Protects against cross-tenant data access and unauthorized client-supplied tenant IDs.
 */

export class AuthorizationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AuthorizationError';
    this.status = details.status || 403;
    this.details = details;
  }
}

export class TenantGuard {
  /**
   * Validate user authorization context
   * @param {Object} userContext
   * @returns {string} tenantId
   */
  static extractTenant(userContext) {
    if (!userContext || typeof userContext !== 'object') {
      throw new AuthorizationError('Authentication required: Missing user context', { status: 401 });
    }
    const tenantId = userContext.tenantId || userContext.tenant_id;
    if (!tenantId || typeof tenantId !== 'string') {
      throw new AuthorizationError('Authentication required: User context missing authorized tenant identifier', { status: 401 });
    }
    return tenantId;
  }

  /**
   * Assert caller has permission to access the target tenant domain
   * Requirement 8: Never trust a client-supplied tenant ID without authorization.
   *
   * @param {Object} userContext - Authenticated user context
   * @param {string} requestedTenantId - Client-supplied or target resource tenant ID
   * @param {string} [resourceName] - Description of target resource
   */
  static assertTenantAccess(userContext, requestedTenantId, resourceName = 'resource') {
    const callerTenantId = TenantGuard.extractTenant(userContext);

    // If caller is superadmin role with system bypass
    if (userContext.role === 'SUPERADMIN') {
      return callerTenantId;
    }

    if (!requestedTenantId || callerTenantId !== requestedTenantId) {
      throw new AuthorizationError(
        `Cross-tenant access violation: caller from tenant "${callerTenantId}" is not authorized to access ${resourceName} in tenant "${requestedTenantId}"`,
        {
          callerTenantId,
          requestedTenantId,
          resourceName,
          status: 403
        }
      );
    }

    return callerTenantId;
  }

  /**
   * Assert caller has permission to access a specific project
   */
  static assertProjectAccess(userContext, project) {
    if (!project) throw new AuthorizationError('Target project not found', { status: 404 });
    return TenantGuard.assertTenantAccess(userContext, project.tenant_id, `project "${project.id}"`);
  }

  /**
   * Bind tenant parameter safely to the authenticated user context,
   * ignoring any unverified client-supplied tenant IDs.
   */
  static resolveAuthorizedTenant(userContext, clientSuppliedTenantId = null) {
    const callerTenantId = TenantGuard.extractTenant(userContext);

    // If client supplied a different tenant ID without SUPERADMIN privilege, reject immediately
    if (clientSuppliedTenantId && clientSuppliedTenantId !== callerTenantId && userContext.role !== 'SUPERADMIN') {
      throw new AuthorizationError(
        `Security violation: Attempted to spoof tenant ID "${clientSuppliedTenantId}". Operating tenant is locked to "${callerTenantId}".`,
        {
          callerTenantId,
          attemptedTenantId: clientSuppliedTenantId,
          status: 403
        }
      );
    }

    return callerTenantId;
  }
}
