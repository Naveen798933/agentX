/**
 * Roles & Permissions Definition (RBAC)
 * Defines system roles, project roles, and granular permission checks.
 */

export const SystemRoles = Object.freeze({
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  SUPERADMIN: 'PLATFORM_ADMIN', // Alias
  ORG_ADMIN: 'ORG_ADMIN',
  PROJECT_MANAGER: 'PROJECT_MANAGER',
  DEVELOPER: 'DEVELOPER',
  VIEWER: 'VIEWER'
});

export const ProjectRoles = Object.freeze({
  OWNER: 'OWNER',
  MANAGER: 'MANAGER',
  DEVELOPER: 'DEVELOPER',
  VIEWER: 'VIEWER'
});

export const Permissions = Object.freeze({
  // Platform & Superadmin
  PLATFORM_ADMIN: 'platform:admin',
  PLATFORM_DIAGNOSTICS: 'platform:diagnostics',

  // Tenant / Organization
  ORG_MANAGE: 'org:manage',
  ORG_MEMBERS_MANAGE: 'org:members:manage',
  ORG_BILLING_MANAGE: 'org:billing:manage',

  // Projects
  PROJECT_CREATE: 'project:create',
  PROJECT_READ: 'project:read',
  PROJECT_UPDATE: 'project:update',
  PROJECT_EDIT: 'project:update', // Alias
  PROJECT_DELETE: 'project:delete',
  PROJECT_EXPORT: 'project:export',

  // Project Members
  PROJECT_MEMBERS_READ: 'project:members:read',
  PROJECT_MEMBERS_MANAGE: 'project:members:manage',

  // Builds, Sandboxes & Pipelines
  BUILD_TRIGGER: 'build:trigger',
  BUILD_READ: 'build:read',
  BUILD_CONTROL: 'build:control', // Pause, Resume, Cancel, Retry
  SANDBOX_RUN: 'sandbox:run',
  TEST_RUN: 'test:run',

  // File Operations & Git
  FILE_READ: 'file:read',
  FILE_WRITE: 'file:write',
  GIT_READ: 'git:read',
  GIT_COMMIT: 'git:commit',

  // Approvals & Governance
  APPROVAL_REQUEST: 'approval:request',
  APPROVAL_DECIDE: 'approval:decide'
});

/**
 * System-Level Role Permission Matrix
 */
const SYSTEM_ROLE_PERMISSIONS = {
  [SystemRoles.PLATFORM_ADMIN]: new Set(Object.values(Permissions)),

  [SystemRoles.ORG_ADMIN]: new Set([
    Permissions.ORG_MANAGE,
    Permissions.ORG_MEMBERS_MANAGE,
    Permissions.ORG_BILLING_MANAGE,
    Permissions.PROJECT_CREATE,
    Permissions.PROJECT_READ,
    Permissions.PROJECT_UPDATE,
    Permissions.PROJECT_DELETE,
    Permissions.PROJECT_EXPORT,
    Permissions.PROJECT_MEMBERS_READ,
    Permissions.PROJECT_MEMBERS_MANAGE,
    Permissions.BUILD_TRIGGER,
    Permissions.BUILD_READ,
    Permissions.BUILD_CONTROL,
    Permissions.SANDBOX_RUN,
    Permissions.TEST_RUN,
    Permissions.FILE_READ,
    Permissions.FILE_WRITE,
    Permissions.GIT_READ,
    Permissions.GIT_COMMIT,
    Permissions.APPROVAL_REQUEST,
    Permissions.APPROVAL_DECIDE
  ]),

  [SystemRoles.PROJECT_MANAGER]: new Set([
    Permissions.PROJECT_CREATE,
    Permissions.PROJECT_READ,
    Permissions.PROJECT_UPDATE,
    Permissions.PROJECT_EXPORT,
    Permissions.PROJECT_MEMBERS_READ,
    Permissions.PROJECT_MEMBERS_MANAGE,
    Permissions.BUILD_TRIGGER,
    Permissions.BUILD_READ,
    Permissions.BUILD_CONTROL,
    Permissions.SANDBOX_RUN,
    Permissions.TEST_RUN,
    Permissions.FILE_READ,
    Permissions.FILE_WRITE,
    Permissions.GIT_READ,
    Permissions.GIT_COMMIT,
    Permissions.APPROVAL_REQUEST,
    Permissions.APPROVAL_DECIDE
  ]),

  [SystemRoles.DEVELOPER]: new Set([
    Permissions.PROJECT_READ,
    Permissions.PROJECT_EXPORT,
    Permissions.PROJECT_MEMBERS_READ,
    Permissions.BUILD_TRIGGER,
    Permissions.BUILD_READ,
    Permissions.SANDBOX_RUN,
    Permissions.TEST_RUN,
    Permissions.FILE_READ,
    Permissions.FILE_WRITE,
    Permissions.GIT_READ,
    Permissions.GIT_COMMIT,
    Permissions.APPROVAL_REQUEST
  ]),

  [SystemRoles.VIEWER]: new Set([
    Permissions.PROJECT_READ,
    Permissions.PROJECT_MEMBERS_READ,
    Permissions.BUILD_READ,
    Permissions.FILE_READ,
    Permissions.GIT_READ
  ])
};

/**
 * Project-Level Role Permission Matrix
 */
const PROJECT_ROLE_PERMISSIONS = {
  [ProjectRoles.OWNER]: new Set([
    Permissions.PROJECT_READ,
    Permissions.PROJECT_UPDATE,
    Permissions.PROJECT_DELETE,
    Permissions.PROJECT_EXPORT,
    Permissions.PROJECT_MEMBERS_READ,
    Permissions.PROJECT_MEMBERS_MANAGE,
    Permissions.BUILD_TRIGGER,
    Permissions.BUILD_READ,
    Permissions.BUILD_CONTROL,
    Permissions.SANDBOX_RUN,
    Permissions.TEST_RUN,
    Permissions.FILE_READ,
    Permissions.FILE_WRITE,
    Permissions.GIT_READ,
    Permissions.GIT_COMMIT,
    Permissions.APPROVAL_REQUEST,
    Permissions.APPROVAL_DECIDE,
    Permissions.ORG_BILLING_MANAGE // Can manage budget for owned project
  ]),

  [ProjectRoles.MANAGER]: new Set([
    Permissions.PROJECT_READ,
    Permissions.PROJECT_UPDATE,
    Permissions.PROJECT_EXPORT,
    Permissions.PROJECT_MEMBERS_READ,
    Permissions.PROJECT_MEMBERS_MANAGE,
    Permissions.BUILD_TRIGGER,
    Permissions.BUILD_READ,
    Permissions.BUILD_CONTROL,
    Permissions.SANDBOX_RUN,
    Permissions.TEST_RUN,
    Permissions.FILE_READ,
    Permissions.FILE_WRITE,
    Permissions.GIT_READ,
    Permissions.GIT_COMMIT,
    Permissions.APPROVAL_REQUEST,
    Permissions.APPROVAL_DECIDE
  ]),

  [ProjectRoles.DEVELOPER]: new Set([
    Permissions.PROJECT_READ,
    Permissions.PROJECT_EXPORT,
    Permissions.PROJECT_MEMBERS_READ,
    Permissions.BUILD_TRIGGER,
    Permissions.BUILD_READ,
    Permissions.SANDBOX_RUN,
    Permissions.TEST_RUN,
    Permissions.FILE_READ,
    Permissions.FILE_WRITE,
    Permissions.GIT_READ,
    Permissions.GIT_COMMIT,
    Permissions.APPROVAL_REQUEST
  ]),

  [ProjectRoles.VIEWER]: new Set([
    Permissions.PROJECT_READ,
    Permissions.PROJECT_MEMBERS_READ,
    Permissions.BUILD_READ,
    Permissions.FILE_READ,
    Permissions.GIT_READ
  ])
};

/**
 * Normalize role string to uppercase standard
 */
export function normalizeRole(role) {
  if (!role || typeof role !== 'string') return SystemRoles.VIEWER;
  const upper = role.trim().toUpperCase();
  if (upper === 'SUPERADMIN' || upper === 'PLATFORM_ADMIN') return SystemRoles.PLATFORM_ADMIN;
  if (upper === 'ADMIN' || upper === 'ORG_ADMIN') return SystemRoles.ORG_ADMIN;
  if (upper === 'PM' || upper === 'PROJECT_MANAGER') return SystemRoles.PROJECT_MANAGER;
  if (upper === 'DEV' || upper === 'DEVELOPER') return SystemRoles.DEVELOPER;
  if (upper === 'VIEWER') return SystemRoles.VIEWER;
  return upper;
}

/**
 * Check if a system-level role has a given permission
 * @param {string} role - System role
 * @param {string} permission - Permission constant
 * @returns {boolean}
 */
export function hasSystemPermission(role, permission) {
  const normRole = normalizeRole(role);
  const perms = SYSTEM_ROLE_PERMISSIONS[normRole];
  if (!perms) return false;
  return perms.has(permission);
}

/**
 * Check if a user has permission within a project context
 * Considers system role, project ownership, and explicit project membership
 *
 * @param {Object} context
 * @param {string} context.userSystemRole
 * @param {string} [context.projectMemberRole] - Role in project_members table
 * @param {boolean} [context.isProjectOwner=false]
 * @param {string} permission
 * @returns {boolean}
 */
export function hasProjectPermission({ userSystemRole, projectMemberRole, isProjectOwner = false }, permission) {
  const normSystemRole = normalizeRole(userSystemRole);

  // 1. Platform Admin always has full access
  if (normSystemRole === SystemRoles.PLATFORM_ADMIN) {
    return true;
  }

  // 2. Org Admin has full access within their tenant
  if (normSystemRole === SystemRoles.ORG_ADMIN) {
    return true;
  }

  // 3. Project Owner has full project permissions
  if (isProjectOwner) {
    return true;
  }

  // 4. Check project member role if assigned
  if (projectMemberRole) {
    const normProjRole = projectMemberRole.trim().toUpperCase();
    const projPerms = PROJECT_ROLE_PERMISSIONS[normProjRole];
    return !!(projPerms && projPerms.has(permission));
  }

  // 5. Fall back to system role permissions if user is member or default
  const sysPerms = SYSTEM_ROLE_PERMISSIONS[normSystemRole];
  return !!(sysPerms && sysPerms.has(permission));
}
