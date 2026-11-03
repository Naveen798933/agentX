# PHASE 3 — AUTHENTICATION, AUTHORIZATION AND RBAC ARCHITECTURE

## 1. Overview & System Architecture

PULSE Collaborative Workspace implements enterprise-grade identity, access control, and defense-in-depth security. The authentication and authorization engine is built with zero-trust principles:

- **Zero Plaintext Storage**: Passwords are never stored in plaintext, never logged, and never exposed in client bundles.
- **Modern Password Hashing**: Utilizes native Node.js `scrypt` with a 16-byte cryptographically secure random salt, 64-byte key length (512-bit), and timing-safe comparison (`crypto.timingSafeEqual`) to mitigate side-channel timing attacks.
- **Short-Lived Access Tokens**: HMAC-SHA256 signed JSON Web Tokens (15-minute default TTL) containing tenant context, system role, user ID, and expiration claims.
- **Rotatable, Revokable Refresh Tokens**: Refresh tokens are 32-byte cryptographically random hex strings. The database stores strictly their SHA-256 hash. Refresh tokens are single-use: upon refresh, the token is revoked and rotated.
- **Refresh Token Reuse Detection**: Attempting to reuse an already-revoked refresh token triggers automated reuse detection, revoking all active sessions in the compromised token family and emitting an immutable audit event (`REFRESH_TOKEN_REUSE_DETECTED`).
- **Secure Cookie Flag Standards**: Refresh tokens are transmitted with `HttpOnly; SameSite=Strict; Path=/api/auth` (and `; Secure` in production environments) to protect against XSS token harvesting and CSRF.
- **Brute-Force & Account Lockout Defense**: In-memory sliding window bucket tracker monitors authentication attempts. 5 consecutive failed login attempts on an account trigger an automatic 15-minute lockout (`locked_until`), returning HTTP 429 Too Many Requests.
- **CSRF Protection**: For cookie-authenticated sessions, state-modifying HTTP methods (`POST`, `PUT`, `DELETE`, `PATCH`) must supply either an `Authorization: Bearer <token>` header or custom anti-CSRF request headers (`X-Requested-With` or `X-CSRF-Token`).
- **Security Audit Telemetry**: All security-critical events (`USER_REGISTERED`, `LOGIN_SUCCESS`, `LOGIN_FAILED`, `ACCOUNT_LOCKED`, `PASSWORD_RESET_COMPLETED`, `PROJECT_MEMBER_ADDED`, `PROJECT_MEMBER_REMOVED`, `ADMIN_BOOTSTRAPPED`) are persisted with IP address, user agent, tenant ID, and actor metadata in `auth_audit_logs`.

---

## 2. Role-Permission Matrix

The platform implements a two-tier access model:
1. **System Roles**: Global authorization tier across organizations.
2. **Project Roles**: Scoped collaboration tier per repository/project.

### 2.1 System Roles Hierarchy

| System Role | Scope | Description |
|:---|:---|:---|
| `PLATFORM_ADMIN` | Global (Cross-Tenant) | Superadministrator with complete root access to all organizations, system telemetry, database diagnostics, and administrative bootstrapping. |
| `ORG_ADMIN` | Organization / Tenant | Administrator with full control over the tenant, user invites, billing quotas, and all projects within their organization. |
| `PROJECT_MANAGER` | Tenant Projects | Manages project lifecycles, assigns tasks, requests budget increases, and decides project-level governance gates. |
| `DEVELOPER` | Assigned Projects | Executes code edits, triggers feature builds, runs isolated sandbox tasks, and commits to git. |
| `VIEWER` | Assigned Projects | Read-only access to files, logs, builds, and preview statuses. Prohibited from mutating code, triggering builds, or approving gates. |

### 2.2 Permissions Matrix

| Permission | Description | `PLATFORM_ADMIN` | `ORG_ADMIN` | `PROJECT_MANAGER` | `DEVELOPER` | `VIEWER` |
|:---|:---|:---:|:---:|:---:|:---:|:---:|
| `platform:admin` | Root platform administration & diagnostics | ✔ | ✖ | ✖ | ✖ | ✖ |
| `org:manage` | Manage organization settings & metadata | ✔ | ✔ | ✖ | ✖ | ✖ |
| `org:members:manage` | Invite, remove, and manage organization members | ✔ | ✔ | ✖ | ✖ | ✖ |
| `org:billing:manage` | Increase token budgets & update subscription tiers | ✔ | ✔ | ✖ | ✖ | ✖ |
| `project:create` | Create new software projects & repositories | ✔ | ✔ | ✔ | ✖ | ✖ |
| `project:read` | Inspect project telemetry, details, and status | ✔ | ✔ | ✔ | ✔ | ✔ |
| `project:update` | Modify project settings and configurations | ✔ | ✔ | ✔ | ✖ | ✖ |
| `project:delete` | Delete project workspace and associated databases | ✔ | ✔ | ✖ | ✖ | ✖ |
| `project:export` | Download release ZIP archives & Docker bundles | ✔ | ✔ | ✔ | ✔ | ✖ |
| `project:members:read` | View project collaborators & roles | ✔ | ✔ | ✔ | ✔ | ✔ |
| `project:members:manage`| Add, remove, or modify project collaborators | ✔ | ✔ | ✔ | ✖ | ✖ |
| `build:trigger` | Trigger autonomous feature synthesis and builds | ✔ | ✔ | ✔ | ✔ | ✖ |
| `build:read` | Inspect build runs, coverage trees, and test logs | ✔ | ✔ | ✔ | ✔ | ✔ |
| `sandbox:run` | Execute terminal commands in container sandbox | ✔ | ✔ | ✔ | ✔ | ✖ |
| `test:run` | Execute automated Node test runners | ✔ | ✔ | ✔ | ✔ | ✖ |
| `file:read` | Read source code files and reports | ✔ | ✔ | ✔ | ✔ | ✔ |
| `file:write` | Write and modify workspace source code files | ✔ | ✔ | ✔ | ✔ | ✖ |
| `git:read` | View commit history and changelog | ✔ | ✔ | ✔ | ✔ | ✔ |
| `git:commit` | Author git commits to project repository | ✔ | ✔ | ✔ | ✔ | ✖ |
| `approval:request` | Request operator sign-off for high-risk actions | ✔ | ✔ | ✔ | ✔ | ✖ |
| `approval:decide` | Approve or reject production release gates | ✔ | ✔ | ✔ | ✖ | ✖ |

### 2.3 Project-Scoped Roles (`project_members`)

When a user is assigned an explicit role on a specific project, their project role dictates their capabilities inside that project workspace:
- `OWNER`: Full project permissions, including project deletion, collaborator management, and budget management.
- `MANAGER`: Full feature build, task control, approval decision, and file modification rights.
- `DEVELOPER`: Full code editing, test execution, and build triggering rights.
- `VIEWER`: Read-only access to files and build telemetry. Even if the user's corporate title is `DEVELOPER`, assigning them `VIEWER` on a sensitive project strictly enforces read-only access.

---

## 3. Database Schema & Migration 004

Database migration `004_auth_and_rbac.sql` introduces normalized tables with foreign keys, composite indexes, and PostgreSQL Row-Level Security:

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│     tenants     │◄──────┤      users      │◄──────┤  refresh_tokens │
│ (id, name, slug)│       │(id, email, hash)│       │ (id, token_hash)│
└────────┬────────┘       └────────┬────────┘       └─────────────────┘
         │                         │
         │                         ├───────────────►┌─────────────────┐
         │                         │                │ password_resets │
         │                         │                └─────────────────┘
         ▼                         ▼
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│    projects     │◄──────┤ project_members │       │ auth_audit_logs │
│ (id, tenant_id) │       │(project_id, user│       │(tenant_id, ... )│
└─────────────────┘       └─────────────────┘       └─────────────────┘
```

### Table Definitions:
1. **`users`** (Extended):
   - `name VARCHAR(255)`
   - `is_email_verified BOOLEAN NOT NULL DEFAULT FALSE`
   - `status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE'`
   - `failed_login_attempts INTEGER NOT NULL DEFAULT 0`
   - `locked_until TIMESTAMPTZ`
2. **`project_members`**:
   - `id VARCHAR(64) PRIMARY KEY`
   - `tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`
   - `project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE`
   - `user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE`
   - `role VARCHAR(50) NOT NULL DEFAULT 'DEVELOPER'`
   - `UNIQUE(project_id, user_id)`
3. **`refresh_tokens`**:
   - `id VARCHAR(64) PRIMARY KEY`
   - `user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE`
   - `tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`
   - `token_hash VARCHAR(64) UNIQUE NOT NULL` (SHA-256 digest)
   - `expires_at TIMESTAMPTZ NOT NULL`
   - `revoked_at TIMESTAMPTZ`
4. **`password_resets`**:
   - `id VARCHAR(64) PRIMARY KEY`
   - `user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE`
   - `token_hash VARCHAR(64) UNIQUE NOT NULL`
   - `expires_at TIMESTAMPTZ NOT NULL`
   - `used_at TIMESTAMPTZ`
5. **`email_verifications`**:
   - `id VARCHAR(64) PRIMARY KEY`
   - `user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE`
   - `token_hash VARCHAR(64) UNIQUE NOT NULL`
   - `expires_at TIMESTAMPTZ NOT NULL`
   - `verified_at TIMESTAMPTZ`
6. **`auth_audit_logs`**:
   - `id BIGSERIAL PRIMARY KEY`
   - `tenant_id VARCHAR(64) REFERENCES tenants(id) ON DELETE CASCADE`
   - `user_id VARCHAR(64)`
   - `action VARCHAR(100) NOT NULL`
   - `ip_address VARCHAR(45)`
   - `user_agent VARCHAR(255)`
   - `details TEXT`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

---

## 4. Environment Setup & Configuration

Add the following environment variables to your `.env` or deployment configuration:

```bash
# Authentication & Tokens
AUTH_ENABLED=true
JWT_SECRET=super-secure-production-jwt-hmac-sha256-secret-key-32chars
SECURE_COOKIES=true

# Initial Admin Bootstrap (Optional; if omitted, CLI generates random password)
BOOTSTRAP_ADMIN_EMAIL=admin@pulse.local
BOOTSTRAP_ADMIN_PASSWORD=OptionalStrongPassword123
BOOTSTRAP_ADMIN_NAME="Platform Administrator"
```

---

## 5. Platform Admin Bootstrap Process

To safely initialize the initial root administrator without hardcoded credentials:

```bash
# Automatic generation of secure random 24-character credential
./bin/node bin/bootstrap-admin.js --email admin@myorganization.com

# Or specify credential via environment variable:
BOOTSTRAP_ADMIN_PASSWORD="MyCustomSecurePassword123" ./bin/node bin/bootstrap-admin.js --email admin@myorganization.com
```

The script verifies if an administrator already exists, outputs the user ID and generated credentials once, and exits idempotently.

---

## 6. API Reference

### Authentication Endpoints
- `POST /api/auth/register` — Create account (`email`, `password`, `name`, `tenantId`, `role`).
- `POST /api/auth/login` — Authenticate and receive `accessToken` + HttpOnly `Set-Cookie` for refresh token.
- `POST /api/auth/refresh` — Rotate refresh token and obtain new short-lived access token.
- `POST /api/auth/logout` — Revoke refresh token and clear session cookie.
- `GET /api/auth/me` — Inspect caller's verified identity and role.
- `POST /api/auth/password-reset/request` — Request reset link via email provider.
- `POST /api/auth/password-reset/confirm` — Reset password with token.
- `POST /api/auth/verify-email/request` — Request email verification token.
- `POST /api/auth/verify-email/confirm` — Confirm email verification.
- `POST /api/admin/bootstrap` — Initial root admin initialization.
- `GET /api/admin/audit-logs` — Query security audit logs (restricted to admins).

### Project Collaboration Endpoints
- `GET /api/projects/:id/members` — List collaborators and their project-specific roles.
- `POST /api/projects/:id/members` — Add collaborator or update role (`userId`, `role`).
- `DELETE /api/projects/:id/members/:userId` — Remove collaborator from project.

---

## 7. Security Test Verification

The automated security test suite `tests/auth_rbac_security.test.js` exercises 25 security assertions across 7 domains:

1. **Password Hashing & Complexity Validation** (3 tests)
   - Minimum 8 characters, letter and number complexity validation.
   - `scrypt` hashing with unique 16-byte random salts and 64-byte key length.
   - Timing-safe verification preventing side-channel attacks.
2. **Registration, Authentication & Lockout** (3 tests)
   - Account registration with sanitized return objects and duplicate email rejection.
   - Valid credential login with `HttpOnly`, `SameSite=Strict`, `Secure`, and `Path` cookies.
   - Sliding-window brute force defense locking accounts after 5 failed attempts.
3. **Token Lifecycle & Rotation** (4 tests)
   - Access token expiration validation.
   - Signature tampering detection.
   - Single-use refresh token rotation.
   - Revoked token reuse detection causing immediate revocation of compromised token families.
4. **Email Verification & Password Reset** (2 tests)
   - Verification token dispatch, email delivery, and confirmation.
   - Single-use password reset workflow, credential update, and active session invalidation.
5. **RBAC Permission Matrix & Project Access** (2 tests)
   - System roles hierarchy verification (`PLATFORM_ADMIN` through `VIEWER`).
   - Project-scoped role precedence over base system roles.
6. **Audit Records & Admin Bootstrap** (2 tests)
   - Immutable security audit logging with IP and actor telemetry.
   - Cryptographically random admin password generation and idempotent bootstrap.
7. **HTTP Server API Endpoint Authorization & Privilege Escalation Defense** (9 tests)
   - Unauthenticated requests rejected with 401 Unauthorized.
   - Valid Bearer token authentication verified.
   - CSRF defense blocking cookie mutations without custom headers.
   - Privilege escalation defense blocking `VIEWER` from writing files (403 Forbidden).
   - Authorized `DEVELOPER` permitted to write files (200 OK).
   - Privilege escalation defense blocking `DEVELOPER` from approving production gates (403 Forbidden).
   - `PLATFORM_ADMIN` authorized to resolve gated approvals (200 OK).
   - Cross-tenant isolation blocking users from accessing projects in other organizations (403 Forbidden).
   - Privileged audit logs endpoint restricted to platform administrators.
