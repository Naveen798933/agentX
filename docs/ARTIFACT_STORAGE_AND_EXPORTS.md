# Phase 5 — Project Artifact Storage, S3/R2 Abstraction & Safe ZIP Export

This document details the storage architecture, credential isolation, metadata catalog, path sanitization, retention cleanup policies, and safe ZIP export mechanisms implemented for the AI Virtual Software House.

---

## 1. Architecture Overview

The artifact storage subsystem decouples physical object persistence from relational database metadata. File bytes are persisted exclusively in dedicated object storage providers (Local Filesystem for development; AWS S3, Cloudflare R2, or MinIO for production), while file metadata, cryptographic hashes, ownership, and lifecycle policies are indexed in PostgreSQL (with full SQLite compatibility for testing and embedded environments).

```
 ┌────────────────────────────────────────────────────────────────────────┐
 │                      Client / Web Dashboard / API                      │
 └──────────────┬──────────────────────────────────────────▲──────────────┘
                │ 1. Upload Artifact / Export ZIP          │ 4. Download
                ▼                                          │    (Signed URL)
 ┌─────────────────────────────────────────────────────────┴──────────────┐
 │                     VirtualHouseServer HTTP API                        │
 │  - RBAC & TenantGuard Isolation (project:read, project:update, export) │
 │  - File Size Limit Guard (Max 50MB single artifact, 250MB uncompressed)│
 │  - Filename & Path Traversal Validator (Null byte, .., Win reserved)   │
 └──────────────┬──────────────────────────────────────────▲──────────────┘
                │ Delegate                                 │
                ▼                                          │
 ┌─────────────────────────────────────────────────────────┴──────────────┐
 │                            ArtifactService                             │
 │  - Canonical Key: {tenantId}/{projectId}/{category}/{type}/{filename}  │
 │  - SHA-256 Checksum & ETag Calculation                                 │
 │  - Short-Lived HMAC / SigV4 Download Signer (900s TTL)                 │
 └──────────────┬──────────────────────────────────────────┬──────────────┘
                │ Metadata Record                          │ Object Stream
                ▼                                          ▼
 ┌───────────────────────────────┐        ┌───────────────────────────────┐
 │   PostgreSQL / SQLite Catalog │        │    StorageProvider Abstraction│
 │ - generated_artifacts table   │        ├───────────────────────────────┤
 │ - storage_key, storage_backend│        │ • LocalStorageProvider        │
 │ - retention_policy, expires_at│        │   (Atomic .tmp-* rename)      │
 │ - is_confidential = true      │        │ • S3StorageProvider           │
 │ - content = NULL (no DB rows) │        │   (AWS S3, Cloudflare R2)     │
 └───────────────────────────────┘        └───────────────────────────────┘
```

---

## 2. Storage Providers & Server-Side Credentials

### Provider Abstraction (`StorageProvider`)
Defined in [`src/artifacts/storageProvider.js`](file:///Users/kotanaveen/Documents/virtual%20company/src/artifacts/storageProvider.js):
- `putObject(key, data, options)`: Atomic object persistence with on-the-fly SHA-256 hash calculation and size limit enforcement.
- `getObject(key)`: Returns Buffer.
- `getObjectStream(key)`: Returns Node.js Readable stream.
- `headObject(key)`: Returns size, content-type, last modified, and ETag without downloading payload.
- `deleteObject(key)`: Safely deletes object and prunes empty parent directories.
- `deleteObjects(keys)`: Bulk deletion.
- `getSignedUrl(key, options)`: Issues time-limited signed URL for direct download.

### Local Filesystem Provider (`LocalStorageProvider`)
Located in [`src/artifacts/localStorageProvider.js`](file:///Users/kotanaveen/Documents/virtual%20company/src/artifacts/localStorageProvider.js):
- **Development & Single-Node Mode**: Stores objects under `data/artifacts/`.
- **Atomic Writes**: Writes to `.tmp-{uuid}` in target directory, hashes with SHA-256, verifies size bounds, and renames atomically to destination via `fs.renameSync`.
- **Integrity Guarantee**: Partial uploads or client disconnects abort immediately and unlink the temporary file.

### S3 & Cloudflare R2 Provider (`S3StorageProvider`)
Located in [`src/artifacts/s3StorageProvider.js`](file:///Users/kotanaveen/Documents/virtual%20company/src/artifacts/s3StorageProvider.js):
- **Zero-Dependency AWS SigV4 Client**: Built natively with `node:crypto` and global `fetch`. No heavy external AWS SDKs required.
- **Multi-Cloud Compatibility**: Seamlessly interoperates with Amazon Web Services S3, Cloudflare R2, MinIO, and Wasabi.
- **Server-Side Credentials Only**: Provider credentials (`accessKeyId`, `secretAccessKey`) remain strictly on the server and are never serialized in API responses, logs, or error payloads.
- **SigV4 Pre-signed Query URLs**: Generates query-authenticated pre-signed GET/PUT URLs with `X-Amz-Algorithm=AWS4-HMAC-SHA256`, `X-Amz-Credential`, `X-Amz-Expires`, and `X-Amz-Signature`.

---

## 3. Database Metadata & Ownership (Migration 006)

SQL migration file: [`src/storage/migrations/006_artifact_storage.sql`](file:///Users/kotanaveen/Documents/virtual%20company/src/storage/migrations/006_artifact_storage.sql).

### Schema Definition
```sql
ALTER TABLE generated_artifacts ALTER COLUMN content DROP NOT NULL;

ALTER TABLE generated_artifacts ADD COLUMN IF NOT EXISTS storage_backend VARCHAR(32) NOT NULL DEFAULT 'LOCAL';
ALTER TABLE generated_artifacts ADD COLUMN IF NOT EXISTS storage_key VARCHAR(512) NOT NULL DEFAULT '';
ALTER TABLE generated_artifacts ADD COLUMN IF NOT EXISTS content_type VARCHAR(128) NOT NULL DEFAULT 'application/octet-stream';
ALTER TABLE generated_artifacts ADD COLUMN IF NOT EXISTS is_confidential BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE generated_artifacts ADD COLUMN IF NOT EXISTS retention_policy VARCHAR(64) NOT NULL DEFAULT 'TEMPORARY_BUILD';
ALTER TABLE generated_artifacts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE generated_artifacts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE generated_artifacts ADD COLUMN IF NOT EXISTS metadata JSONB;

CREATE INDEX IF NOT EXISTS idx_artifacts_storage_key ON generated_artifacts(storage_key);
CREATE INDEX IF NOT EXISTS idx_artifacts_retention_expires ON generated_artifacts(retention_policy, expires_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_tenant_proj ON generated_artifacts(tenant_id, project_id);
```

### Database vs Storage Boundary
- **Never store file contents in database rows**: The `content` column is nullable and defaults to `NULL`. Only small JSON metadata manifests are stored in `metadata`.
- **Relational Integrity**: Foreign keys link `project_id` to `projects(id) ON DELETE CASCADE` and `job_id` to `generation_jobs(id)`.
- **Dual-Engine Compatibility**: Both [`src/storage/postgresAdapter.js`](file:///Users/kotanaveen/Documents/virtual%20company/src/storage/postgresAdapter.js) and [`src/storage/db.js`](file:///Users/kotanaveen/Documents/virtual%20company/src/storage/db.js) implement identical CRUD and query interfaces.

---

## 4. Canonical Key Partitioning Pattern

All artifacts are partitioned by tenant and project identifiers into a deterministic, secure namespace:

$$\text{Canonical Key} = \{\text{tenantId}\} / \{\text{projectId}\} / \{\text{category}\} / \{\text{artifactType}\} / \{\text{filename}\}$$

### Examples
- Build Artifact: `tenant-corp/proj-commerce/builds/BUILD_ARTIFACT/dist-bundle.tar.gz`
- Safe ZIP Export: `tenant-corp/proj-commerce/exports/ZIP_ARCHIVE/commerce-app-20261026.zip`
- Runtime Logs: `tenant-corp/proj-commerce/logs/LOGS_EXPORT/build-run-84.log`
- Test Report: `tenant-corp/proj-commerce/tests/TEST_REPORT/coverage.json`

Cross-tenant access attempts are strictly rejected at both the routing layer and the storage engine.

---

## 5. Path Traversal & Filename Security Validation

Implemented in [`src/artifacts/pathValidator.js`](file:///Users/kotanaveen/Documents/virtual%20company/src/artifacts/pathValidator.js):
- **Traversal Sequences**: Rejects `..`, `../`, `..\`, and URL-encoded variations (`%2e%2e%2f`, `..%2f`).
- **Null Byte Injection**: Rejects `\0` and `%00`.
- **Absolute Paths**: Prohibits POSIX roots (`/etc/...`), Windows drive letters (`C:\...`), and UNC network shares (`\\server\...`).
- **Forbidden Characters**: Rejects `< > : " | ? *` to guarantee cross-platform filesystem safety.
- **System Reserved Names**: Blocks Windows reserved words (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`).
- **Length Limits**: Maximum filename length is 255 characters; maximum path length is 1024 characters.
- **Zip-Slip Defense**: Ensures every unpacked or referenced relative path resolves strictly inside the project root via `resolveSafePath(baseDir, relativePath)`.

---

## 6. Safe ZIP Packaging & Exclusion Rules

Implemented in [`src/export/zipExporter.js`](file:///Users/kotanaveen/Documents/virtual%20company/src/export/zipExporter.js):
- **Exclusion Filters**:
  - **Secrets & Credentials**: `.env`, `.env.*`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `id_rsa`, `id_ed25519`, `credentials.json`, `serviceAccount*.json`.
  - **Dependencies**: `node_modules/`, `vendor/`, `.venv/`, `venv/`.
  - **Version Control**: `.git/`, `.svn/`, `.hg/`.
  - **Caches & Build Temps**: `.cache/`, `.next/`, `.nuxt/`, `.turbo/`, `__pycache__/`, `*.pyc`, `.pytest_cache/`, `*.tmp`, `*.swp`.
  - **OS System Files**: `.DS_Store`, `Thumbs.db`, `desktop.ini`.
- **Safety Thresholds**:
  - Maximum single file size: 50 MB
  - Maximum uncompressed archive size: 250 MB
  - Maximum file count: 10,000 files
- **Automatic Configuration Injection**: If missing, automatically generates production-ready `Dockerfile`, `.dockerignore`, and `README.md`.
- **Standard PKZIP Format**: Computes CRC32 polynomial checksums, raw deflate compression buffers, and SHA-256 archive digests without external npm packages.

---

## 7. Short-Lived Signed Download URLs

Implemented in [`src/artifacts/signedUrlService.js`](file:///Users/kotanaveen/Documents/virtual%20company/src/artifacts/signedUrlService.js):
- **Local Storage Downloads**:
  - Generates HMAC-SHA256 signed token: `base64url(payload) . signature`.
  - Payload contains: `{ sub: artifactId, key: storageKey, tid: tenantId, pid: projectId, act: 'download', exp: timestamp, nonce }`.
  - Verification validates signature in constant time (`crypto.timingSafeEqual`) and rejects expired or tampered tokens.
  - Endpoint: `GET /api/artifacts/download?token={token}`.
- **S3 / R2 Downloads**:
  - Issues standard AWS SigV4 pre-signed URL with query parameters (`X-Amz-Signature`).
  - Default TTL: 900 seconds (15 minutes). Maximum TTL: 3600 seconds.
- **Private By Default**: `is_confidential = true` on all records; private S3 ACLs enforced; raw bucket endpoints are never made public.

---

## 8. Retention Policies & Lifecycle Cleanup Manager

Implemented in [`src/artifacts/cleanupManager.js`](file:///Users/kotanaveen/Documents/virtual%20company/src/artifacts/cleanupManager.js):

| Policy | Target Artifacts | Default TTL | Description |
| :--- | :--- | :--- | :--- |
| `PERMANENT` | Golden builds, release tags, manual exports | Indefinite (`null`) | Retained permanently until explicit manual deletion. |
| `TEMPORARY_BUILD` | Intermediate builds, test run outputs | 7 days (604,800s) | Automatically expired and purged after 7 days. |
| `FAILED_BUILD` | Failed build outputs, crash logs, traces | 24 hours (86,400s) | Retained for developer inspection, then purged. |
| `EXPORT_ARCHIVE` | Generated project ZIP archives | 2 hours (7,200s) | Created for immediate user download, purged after 2 hours. |

### Cleanup Execution
- API Endpoint: `POST /api/artifacts/cleanup` (Requires admin role or `project:delete` permission).
- Purge Process:
  1. Finds expired artifacts where `expires_at <= NOW() AND deleted_at IS NULL`.
  2. Calls `storageProvider.deleteObject(storageKey)`.
  3. Updates DB record: `deleted_at = NOW()`.
  4. Scans and removes orphaned `.tmp-*` files older than 1 hour from local storage.

---

## 9. Environment Variables Configuration

Use placeholder credentials only:

```bash
# ── Object Storage Backend Selection ──
STORAGE_PROVIDER=local                   # 'local' | 's3' | 'r2'
STORAGE_LOCAL_DIR=data/artifacts        # Directory for local files
STORAGE_SIGNING_SECRET=replace-with-a-secure-random-32-byte-hex-secret
PUBLIC_API_URL=http://127.0.0.1:3000   # Base URL for local signed download links

# ── S3 / Cloudflare R2 Production Configuration ──
STORAGE_S3_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
STORAGE_S3_REGION=auto                   # 'auto' for R2, 'us-east-1' for AWS S3
STORAGE_S3_BUCKET=virtual-house-artifacts-production
STORAGE_S3_ACCESS_KEY_ID=YOUR_S3_ACCESS_KEY_ID_PLACEHOLDER
STORAGE_S3_SECRET_ACCESS_KEY=YOUR_S3_SECRET_ACCESS_KEY_PLACEHOLDER
STORAGE_S3_FORCE_PATH_STYLE=false       # true for MinIO/LocalStack

# ── Retention Policy Durations (Seconds) ──
RETENTION_TEMPORARY_BUILD_TTL=604800    # 7 days
RETENTION_FAILED_BUILD_TTL=86400        # 24 hours
RETENTION_EXPORT_ARCHIVE_TTL=7200       # 2 hours
MAX_ARTIFACT_SIZE_BYTES=52428800        # 50 MB
```

---

## 10. Migration Plan & Legacy Project Preservation

### Preserving Existing Local Workspaces
Existing workspace files under `data/workspaces/{projectId}/` remain untouched on disk.

### Running Migration
1. Run SQL migration 006 against PostgreSQL:
   ```bash
   psql "$DATABASE_URL" -f src/storage/migrations/006_artifact_storage.sql
   ```
2. Run workspace catalog indexer:
   ```bash
   node src/storage/migrateArtifacts.js
   ```
   **Output:**
   ```json
   {
     "workspacesScanned": 63,
     "filesIndexed": 217,
     "filesSkipped": 17,
     "errors": []
   }
   ```
   Existing workspaces are registered into `generated_artifacts` with `retention_policy = 'PERMANENT'` and `storage_backend = 'LOCAL'`.

---

## 11. Test Suite Verification

Comprehensive test suite in [`tests/artifact_storage_and_zip.test.js`](file:///Users/kotanaveen/Documents/virtual%20company/tests/artifact_storage_and_zip.test.js):

```bash
./bin/node --test tests/artifact_storage_and_zip.test.js
```

### Verified Test Results
```
▶ Phase 5 — Project Artifact Storage, S3 Abstraction & Safe ZIP Suite
  ✔ 1. Path Traversal & Filename Security Validation (1.20ms)
  ✔ 2. Safe Exclusion Patterns (Secrets, Caches, Dependencies, VCS) (0.86ms)
  ✔ 3. Local Storage Provider (Atomic Writes, SHA-256 & Size Enforce) (3.12ms)
  ✔ 4. S3 / Cloudflare R2 Provider & AWS SigV4 Pre-signed URLs (1.51ms)
  ✔ 5. Short-Lived Signed Download URLs & HMAC Integrity (0.56ms)
  ✔ 6. Safe ZIP Packaging (Preserves Structure, Excludes Secrets & node_modules) (4.68ms)
  ✔ 7. ArtifactService Catalog & Canonical Key Isolation (5.94ms)
  ✔ 8. Retention Policies & Lifecycle Cleanup Manager (4.61ms)
  ✔ 9. HTTP Server Artifact Endpoints, Signed Downloads & ZIP Export (398.65ms)
✔ Phase 5 — Project Artifact Storage, S3 Abstraction & Safe ZIP Suite (434.21ms)
ℹ tests 10, pass 10, fail 0
```
