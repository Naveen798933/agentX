import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import {
  ArtifactService,
  StorageProvider,
  LocalStorageProvider,
  S3StorageProvider,
  SignedUrlService,
  SignedUrlError,
  CleanupManager,
  RetentionPolicies,
  ArtifactTypes,
  ArtifactCategories,
  validateFilename,
  validateRelativePath,
  resolveSafePath,
  isExcludedPath,
  PathValidationError,
  StorageError
} from '../src/artifacts/index.js';

import {
  buildZipBuffer,
  readWorkspaceFiles,
  packageProjectAsZip,
  createProjectZipArchive
} from '../src/export/zipExporter.js';

import { StorageEngine } from '../src/storage/db.js';
import { VirtualHouseServer } from '../src/server/server.js';
import { SystemRoles, Permissions } from '../src/auth/rbac.js';

process.env.NODE_ENV = 'test';

test('Phase 5 — Project Artifact Storage, S3 Abstraction & Safe ZIP Suite', async (t) => {
  const TEST_DIR = path.resolve('data/test-phase5');
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });

  t.after(() => {
    if (fs.existsSync(TEST_DIR)) {
      try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Path Traversal & Filename Security Validation
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('1. Path Traversal & Filename Security Validation', async () => {
    // Valid filenames
    assert.strictEqual(validateFilename('bundle.min.js'), 'bundle.min.js');
    assert.strictEqual(validateFilename('report-2026_final.json'), 'report-2026_final.json');

    // Filenames with path separators
    assert.throws(() => validateFilename('../secret.txt'), PathValidationError);
    assert.throws(() => validateFilename('sub/file.txt'), PathValidationError);
    assert.throws(() => validateFilename('sub\\file.txt'), PathValidationError);

    // Null bytes
    assert.throws(() => validateFilename('file.txt\0.exe'), PathValidationError);
    assert.throws(() => validateFilename('file%00.txt'), PathValidationError);

    // Reserved Windows names
    assert.throws(() => validateFilename('CON.txt'), PathValidationError);
    assert.throws(() => validateFilename('NUL'), PathValidationError);
    assert.throws(() => validateFilename('com1.log'), PathValidationError);

    // Illegal characters (< > : " | ? *)
    assert.throws(() => validateFilename('bad<name>.js'), PathValidationError);
    assert.throws(() => validateFilename('bad:name.js'), PathValidationError);
    assert.throws(() => validateFilename('bad|name.js'), PathValidationError);

    // Path Traversal in Relative Paths
    assert.throws(() => validateRelativePath('../../etc/passwd'), PathValidationError);
    assert.throws(() => validateRelativePath('folder/../../secret'), PathValidationError);
    assert.throws(() => validateRelativePath('..\\..\\Windows\\System32'), PathValidationError);
    assert.throws(() => validateRelativePath('%2e%2e%2fsecret'), PathValidationError);

    // Absolute paths
    assert.throws(() => validateRelativePath('/etc/shadow'), PathValidationError);
    assert.throws(() => validateRelativePath('C:\\Windows\\System32'), PathValidationError);
    assert.throws(() => validateRelativePath('\\\\server\\share'), PathValidationError);

    // Safe base directory resolution
    const baseDir = path.join(TEST_DIR, 'sandbox');
    fs.mkdirSync(baseDir, { recursive: true });

    const safeResolved = resolveSafePath(baseDir, 'dist/app.js');
    assert.strictEqual(safeResolved, path.join(baseDir, 'dist', 'app.js'));

    assert.throws(() => resolveSafePath(baseDir, '../outside.txt'), PathValidationError);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Safe Exclusion Patterns Filter
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('2. Safe Exclusion Patterns (Secrets, Caches, Dependencies, VCS)', async () => {
    // Sensitive secrets must be excluded
    assert.strictEqual(isExcludedPath('.env'), true);
    assert.strictEqual(isExcludedPath('.env.production'), true);
    assert.strictEqual(isExcludedPath('.env.local'), true);
    assert.strictEqual(isExcludedPath('certs/server.key'), true);
    assert.strictEqual(isExcludedPath('keys/cert.pem'), true);
    assert.strictEqual(isExcludedPath('id_rsa'), true);
    assert.strictEqual(isExcludedPath('id_ed25519.pub'), true);
    assert.strictEqual(isExcludedPath('credentials.json'), true);
    assert.strictEqual(isExcludedPath('serviceAccountKey.json'), true);

    // Heavy dependencies & VCS must be excluded
    assert.strictEqual(isExcludedPath('node_modules/react/index.js'), true);
    assert.strictEqual(isExcludedPath('.git/HEAD'), true);
    assert.strictEqual(isExcludedPath('.svn/entries'), true);
    assert.strictEqual(isExcludedPath('.venv/bin/python'), true);
    assert.strictEqual(isExcludedPath('vendor/autoload.php'), true);

    // Caches & temps must be excluded
    assert.strictEqual(isExcludedPath('.cache/build.json'), true);
    assert.strictEqual(isExcludedPath('.next/server/pages.js'), true);
    assert.strictEqual(isExcludedPath('__pycache__/app.cpython-311.pyc'), true);
    assert.strictEqual(isExcludedPath('.DS_Store'), true);
    assert.strictEqual(isExcludedPath('dist/temp.tmp'), true);
    assert.strictEqual(isExcludedPath('file.swp'), true);

    // Safe project source files must NOT be excluded
    assert.strictEqual(isExcludedPath('index.js'), false);
    assert.strictEqual(isExcludedPath('src/api.js'), false);
    assert.strictEqual(isExcludedPath('package.json'), false);
    assert.strictEqual(isExcludedPath('README.md'), false);
    assert.strictEqual(isExcludedPath('public/styles.css'), false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Local Storage Provider: Atomic Writes, Hashing & Size Enforce
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('3. Local Storage Provider (Atomic Writes, SHA-256 & Size Enforce)', async () => {
    const localDir = path.join(TEST_DIR, 'local-storage');
    const provider = new LocalStorageProvider({
      baseDir: localDir,
      maxSizeBytes: 1024 * 1024 // 1MB limit for test
    });

    const key = 'tenant-1/proj-1/builds/BUILD_ARTIFACT/output.txt';
    const content = Buffer.from('Hello Virtual Software House Artifact Storage!', 'utf8');
    const expectedSha256 = crypto.createHash('sha256').update(content).digest('hex');

    // 1. Put object atomically with hash verification
    const putRes = await provider.putObject(key, content, {
      expectedHash: expectedSha256,
      contentType: 'text/plain'
    });

    assert.strictEqual(putRes.key, key);
    assert.strictEqual(putRes.sizeBytes, content.length);
    assert.strictEqual(putRes.hashSha256, expectedSha256);
    assert.strictEqual(putRes.storageBackend, 'LOCAL');

    // Verify no temporary files remain
    const targetDir = path.dirname(resolveSafePath(localDir, key));
    const dirFiles = fs.readdirSync(targetDir);
    assert.ok(dirFiles.every(f => !f.startsWith('.tmp-')), 'No temporary files should linger after write');

    // 2. Read object back
    const readBuf = await provider.getObject(key);
    assert.strictEqual(readBuf.toString('utf8'), content.toString('utf8'));

    // 3. Head object
    const head = await provider.headObject(key);
    assert.ok(head !== null);
    assert.strictEqual(head.sizeBytes, content.length);

    // 4. Integrity Check Failure (mismatched hash must reject and unlink temp file)
    await assert.rejects(
      async () => {
        await provider.putObject('bad-hash.txt', content, {
          expectedHash: '0000000000000000000000000000000000000000000000000000000000000000'
        });
      },
      (err) => err.code === 'INTEGRITY_CHECK_FAILED'
    );
    assert.strictEqual(fs.existsSync(path.join(localDir, 'bad-hash.txt')), false);

    // 5. Size Limit Enforcement
    const oversized = Buffer.alloc(1024 * 1024 + 100);
    await assert.rejects(
      async () => {
        await provider.putObject('too-big.bin', oversized);
      },
      (err) => err.code === 'PAYLOAD_TOO_LARGE'
    );

    // 6. Delete object
    const deleted = await provider.deleteObject(key);
    assert.strictEqual(deleted, true);
    assert.strictEqual(await provider.headObject(key), null);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. S3 & Cloudflare R2 Provider Pre-signed SigV4 Generation
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('4. S3 / Cloudflare R2 Provider & AWS SigV4 Pre-signed URLs', async () => {
    const s3Provider = new S3StorageProvider({
      bucket: 'test-artifacts-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.amazonaws.com',
      accessKeyId: 'AKIA_EXAMPLE_KEY_123',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      forcePathStyle: false
    });

    const key = 'tenant-abc/proj-xyz/builds/app.tar.gz';
    const signedGetUrl = await s3Provider.getSignedUrl(key, {
      operation: 'getObject',
      expiresInSeconds: 600
    });

    const parsedUrl = new URL(signedGetUrl);
    assert.strictEqual(parsedUrl.hostname, 'test-artifacts-bucket.s3.amazonaws.com');
    assert.strictEqual(parsedUrl.pathname, `/${encodeURIComponent('tenant-abc/proj-xyz/builds/app.tar.gz').replace(/%2F/g, '/')}`);

    // Verify SigV4 Query Parameters
    assert.strictEqual(parsedUrl.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.ok(parsedUrl.searchParams.get('X-Amz-Credential').includes('AKIA_EXAMPLE_KEY_123/'));
    assert.strictEqual(parsedUrl.searchParams.get('X-Amz-Expires'), '600');
    assert.strictEqual(parsedUrl.searchParams.get('X-Amz-SignedHeaders'), 'host');
    assert.ok(parsedUrl.searchParams.has('X-Amz-Signature'));

    // Server-side credentials must never be in query parameters
    assert.ok(!signedGetUrl.includes('wJalrXUtnFEMI'), 'Secret key must never appear in URL or query params');

    // Cloudflare R2 Virtual Host Style Verification
    const r2Provider = new S3StorageProvider({
      bucket: 'my-r2-bucket',
      region: 'auto',
      endpoint: 'https://0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'R2_ACCESS_KEY',
      secretAccessKey: 'R2_SECRET_KEY'
    });
    assert.strictEqual(r2Provider.providerName, 'R2');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Short-Lived Signed Download URLs (HMAC Service)
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('5. Short-Lived Signed Download URLs & HMAC Integrity', async () => {
    const signingSecret = 'super-secret-signing-key-minimum-32-chars-long';
    const service = new SignedUrlService({
      secret: signingSecret,
      defaultExpiresInSeconds: 300,
      baseUrl: 'http://127.0.0.1:3000'
    });

    const tokenParams = {
      artifactId: 'art-12345',
      storageKey: 'tenant-1/proj-1/exports/app.zip',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      expiresInSeconds: 10
    };

    const token = service.createToken(tokenParams);
    assert.ok(typeof token === 'string' && token.includes('.'));

    // 1. Valid token verifies
    const payload = service.verifyToken(token, { tenantId: 'tenant-1', projectId: 'proj-1' });
    assert.strictEqual(payload.sub, 'art-12345');
    assert.strictEqual(payload.key, 'tenant-1/proj-1/exports/app.zip');
    assert.strictEqual(payload.tid, 'tenant-1');
    assert.strictEqual(payload.pid, 'proj-1');

    // 2. Tampered signature is rejected
    const tampered = token.slice(0, -4) + 'abcd';
    assert.throws(
      () => service.verifyToken(tampered),
      (err) => err.code === 'SIGNATURE_MISMATCH'
    );

    // 3. Expired token is rejected
    const expiredToken = service.createToken({
      ...tokenParams,
      expiresInSeconds: -10 // expired in the past
    });
    assert.throws(
      () => service.verifyToken(expiredToken),
      (err) => err.code === 'TOKEN_EXPIRED'
    );

    // 4. Tenant mismatch is rejected
    assert.throws(
      () => service.verifyToken(token, { tenantId: 'tenant-attacker' }),
      (err) => err.code === 'TENANT_MISMATCH'
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Safe ZIP Packaging & Directory Structure Preservation
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('6. Safe ZIP Packaging (Preserves Structure, Excludes Secrets & node_modules)', async () => {
    const workspaceDir = path.join(TEST_DIR, 'workspace-zip');
    fs.mkdirSync(workspaceDir, { recursive: true });

    // Legitimate project files
    fs.writeFileSync(path.join(workspaceDir, 'package.json'), JSON.stringify({ name: 'safe-app', version: '1.0.0' }));
    fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'src/api.js'), 'export function hello() { return "world"; }');

    // Forbidden files that MUST be excluded
    fs.writeFileSync(path.join(workspaceDir, '.env'), 'SECRET_API_KEY=topsecret123');
    fs.writeFileSync(path.join(workspaceDir, '.env.local'), 'DB_PASSWORD=rootpass');
    fs.writeFileSync(path.join(workspaceDir, 'private.key'), '-----BEGIN PRIVATE KEY-----');
    fs.writeFileSync(path.join(workspaceDir, 'id_rsa'), 'ssh-rsa AAAAB3NzaC1yc2E...');
    fs.writeFileSync(path.join(workspaceDir, 'serviceAccount.json'), '{"private_key": "abc"}');

    // Forbidden directories that MUST be excluded
    fs.mkdirSync(path.join(workspaceDir, 'node_modules/lodash'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'node_modules/lodash/index.js'), 'module.exports = {};');

    fs.mkdirSync(path.join(workspaceDir, '.git/refs'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.git/HEAD'), 'ref: refs/heads/main');

    fs.mkdirSync(path.join(workspaceDir, '.cache/turbo'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.cache/turbo/cache.dat'), 'cachedata');

    fs.mkdirSync(path.join(workspaceDir, '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '__pycache__/app.pyc'), 'binarypyc');

    // Package project as ZIP
    const zipArchive = createProjectZipArchive(workspaceDir, { name: 'SafeApp', description: 'Test app' });

    assert.ok(zipArchive.buffer.length > 0);
    assert.strictEqual(typeof zipArchive.hashSha256, 'string');
    assert.strictEqual(zipArchive.hashSha256.length, 64);

    // Inspect the ZIP entries using zip directory headers
    const zipStr = zipArchive.buffer.toString('utf8');

    // Safe files MUST be included
    assert.ok(zipStr.includes('package.json'), 'package.json must be in ZIP');
    assert.ok(zipStr.includes('src/api.js'), 'src/api.js must be in ZIP');
    assert.ok(zipStr.includes('Dockerfile'), 'Dockerfile must be automatically injected');
    assert.ok(zipStr.includes('.dockerignore'), '.dockerignore must be automatically injected');
    assert.ok(zipStr.includes('README.md'), 'README.md must be automatically injected');

    // Sensitive & unnecessary files MUST be excluded
    assert.ok(!zipStr.includes('.env'), '.env files must be strictly excluded from ZIP');
    assert.ok(!zipStr.includes('private.key'), 'Private keys must be strictly excluded from ZIP');
    assert.ok(!zipStr.includes('id_rsa'), 'SSH keys must be strictly excluded from ZIP');
    assert.ok(!zipStr.includes('serviceAccount.json'), 'Service account JSON must be excluded from ZIP');
    assert.ok(!zipStr.includes('node_modules'), 'node_modules must be strictly excluded from ZIP');
    assert.ok(!zipStr.includes('.git/HEAD'), '.git repository must be strictly excluded from ZIP');
    assert.ok(!zipStr.includes('.cache'), '.cache directory must be strictly excluded from ZIP');
    assert.ok(!zipStr.includes('__pycache__'), '__pycache__ must be strictly excluded from ZIP');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. ArtifactService Database Catalog & Canonical Key Partitioning
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('7. ArtifactService Catalog & Canonical Key Isolation', async () => {
    const storage = new StorageEngine(':memory:');
    storage.createProject({ id: 'proj-omega', name: 'Omega Project', tenant_id: 'tenant-alpha' });

    const localDir = path.join(TEST_DIR, 'service-storage');
    const artifactService = new ArtifactService({
      storageEngine: storage,
      storageProvider: new LocalStorageProvider({ baseDir: localDir })
    });

    // Verify canonical key pattern: {tenantId}/{projectId}/{category}/{artifactType}/{filename}
    const key = artifactService.buildCanonicalKey(
      'tenant-alpha',
      'proj-omega',
      ArtifactCategories.BUILDS,
      ArtifactTypes.BUILD_ARTIFACT,
      'dist-bundle.tar.gz'
    );
    assert.strictEqual(key, 'tenant-alpha/proj-omega/builds/BUILD_ARTIFACT/dist-bundle.tar.gz');

    // Store artifact
    const content = Buffer.from('console.log("Omega Production Build");', 'utf8');
    const { artifact, signedDownloadUrl } = await artifactService.storeArtifact({
      tenantId: 'tenant-alpha',
      projectId: 'proj-omega',
      filename: 'dist-bundle.tar.gz',
      fileType: ArtifactTypes.BUILD_ARTIFACT,
      category: ArtifactCategories.BUILDS,
      content,
      retentionPolicy: RetentionPolicies.TEMPORARY_BUILD,
      isConfidential: true
    });

    assert.ok(artifact.id.startsWith('art-'));
    assert.strictEqual(artifact.storage_key, key);
    assert.strictEqual(artifact.storage_backend, 'LOCAL');
    assert.strictEqual(artifact.file_size_bytes, content.length);
    assert.strictEqual(artifact.is_confidential, true);
    assert.ok(signedDownloadUrl.includes('/api/artifacts/download?token='));

    // DB record must NOT store raw file bytes in database rows
    const rawDbRecord = storage.getArtifactRecord(artifact.id);
    assert.strictEqual(rawDbRecord.content, null, 'Raw content bytes must NOT be stored in DB rows');
    assert.strictEqual(rawDbRecord.storage_key, key);

    // Retrieve through ArtifactService
    const retrieved = await artifactService.getArtifact(artifact.id, 'tenant-alpha');
    assert.strictEqual(retrieved.artifact.id, artifact.id);

    // Cross-tenant protection: tenant-beta cannot access tenant-alpha artifact
    await assert.rejects(
      async () => {
        await artifactService.getArtifact(artifact.id, 'tenant-beta');
      },
      (err) => err.statusCode === 403
    );

    // Download bytes through service
    const { buffer: downloadedBuf } = await artifactService.downloadArtifact(artifact.id, 'tenant-alpha');
    assert.strictEqual(downloadedBuf.toString('utf8'), content.toString('utf8'));

    // Listing artifacts
    const list = await artifactService.listProjectArtifacts('proj-omega', 'tenant-alpha');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, artifact.id);
    assert.ok(list[0].signedDownloadUrl);

    storage.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Retention Policies & Lifecycle Cleanup Manager
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('8. Retention Policies & Lifecycle Cleanup Manager', async () => {
    const storage = new StorageEngine(':memory:');
    storage.createProject({ id: 'proj-ret', name: 'Retention Proj', tenant_id: 'tenant-1' });

    const localDir = path.join(TEST_DIR, 'cleanup-storage');
    const artifactService = new ArtifactService({
      storageEngine: storage,
      storageProvider: new LocalStorageProvider({ baseDir: localDir })
    });

    const now = new Date();
    const pastTime = new Date(now.getTime() - 3600 * 1000).toISOString(); // 1 hour ago
    const futureTime = new Date(now.getTime() + 86400 * 1000).toISOString(); // 1 day in future

    // 1. Expired FAILED_BUILD artifact
    const { artifact: artFailed } = await artifactService.storeArtifact({
      tenantId: 'tenant-1',
      projectId: 'proj-ret',
      filename: 'build-error.log',
      fileType: ArtifactTypes.LOGS_EXPORT,
      retentionPolicy: RetentionPolicies.FAILED_BUILD,
      content: Buffer.from('Error: Stack trace of failed build', 'utf8')
    });
    // Manually set expiration to past to simulate timeout
    storage.db.prepare('UPDATE generated_artifacts SET expires_at = ? WHERE id = ?').run(pastTime, artFailed.id);

    // 2. Expired EXPORT_ARCHIVE artifact
    const { artifact: artExport } = await artifactService.storeArtifact({
      tenantId: 'tenant-1',
      projectId: 'proj-ret',
      filename: 'export.zip',
      fileType: ArtifactTypes.ZIP_ARCHIVE,
      retentionPolicy: RetentionPolicies.EXPORT_ARCHIVE,
      content: Buffer.from('ZIP content bytes', 'utf8')
    });
    storage.db.prepare('UPDATE generated_artifacts SET expires_at = ? WHERE id = ?').run(pastTime, artExport.id);

    // 3. Active TEMPORARY_BUILD artifact (not expired)
    const { artifact: artActive } = await artifactService.storeArtifact({
      tenantId: 'tenant-1',
      projectId: 'proj-ret',
      filename: 'active-build.bin',
      fileType: ArtifactTypes.BUILD_ARTIFACT,
      retentionPolicy: RetentionPolicies.TEMPORARY_BUILD,
      content: Buffer.from('Active build data', 'utf8')
    });
    storage.db.prepare('UPDATE generated_artifacts SET expires_at = ? WHERE id = ?').run(futureTime, artActive.id);

    // 4. PERMANENT artifact (no expiration)
    const { artifact: artPermanent } = await artifactService.storeArtifact({
      tenantId: 'tenant-1',
      projectId: 'proj-ret',
      filename: 'golden-release.zip',
      fileType: ArtifactTypes.ZIP_ARCHIVE,
      retentionPolicy: RetentionPolicies.PERMANENT,
      content: Buffer.from('Release v1.0.0', 'utf8')
    });

    // Run cleanup routine
    const cleanupStats = await artifactService.cleanupExpiredArtifacts();

    assert.strictEqual(cleanupStats.scannedCount, 2);
    assert.strictEqual(cleanupStats.deletedCount, 2);
    assert.ok(cleanupStats.reclaimedBytes > 0);

    // Expired artifacts must be marked deleted in DB
    const failedCheck = storage.getArtifactRecord(artFailed.id);
    assert.ok(failedCheck.deleted_at !== null, 'Expired failed build must have deleted_at set');

    const exportCheck = storage.getArtifactRecord(artExport.id);
    assert.ok(exportCheck.deleted_at !== null, 'Expired export archive must have deleted_at set');

    // Files must be removed from physical storage
    const headFailed = await artifactService.storageProvider.headObject(artFailed.storage_key);
    assert.strictEqual(headFailed, null);

    // Active & Permanent artifacts must remain intact
    const activeCheck = storage.getArtifactRecord(artActive.id);
    assert.strictEqual(activeCheck.deleted_at, null);
    const headActive = await artifactService.storageProvider.headObject(artActive.storage_key);
    assert.ok(headActive !== null);

    const permCheck = storage.getArtifactRecord(artPermanent.id);
    assert.strictEqual(permCheck.deleted_at, null);
    const headPerm = await artifactService.storageProvider.headObject(artPermanent.storage_key);
    assert.ok(headPerm !== null);

    storage.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 9. HTTP API Endpoints Integration: Upload, Download, List & Safe Export
  // ───────────────────────────────────────────────────────────────────────────
  await t.test('9. HTTP Server Artifact Endpoints, Signed Downloads & ZIP Export', async () => {
    const storage = new StorageEngine(':memory:');
    const server = new VirtualHouseServer({
      port: 0,
      storage,
      authEnabled: true,
      asyncEnabled: false
    });

    const baseUrl = await server.start();

    // 1. Setup Tenant and Users (PM and Developer)
    const tenantId = 'tenant-test-artifacts';
    storage.createTenant({
      id: tenantId,
      name: 'Artifact Tenant',
      slug: 'art-corp',
      plan: 'PRO'
    });

    const pmUser = await server.authManager.register({
      email: 'pm@artifacts.io',
      password: 'ArtifactPass123!',
      name: 'Artifact PM',
      tenantId
    });
    // Promote to ORG_ADMIN (has both project management and delete/cleanup permissions)
    storage.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(SystemRoles.ORG_ADMIN, pmUser.id);
    const pmLogin = await server.authManager.login({
      email: 'pm@artifacts.io',
      password: 'ArtifactPass123!'
    });
    const pmToken = pmLogin.accessToken;

    // Attacker from different tenant
    storage.createTenant({
      id: 'tenant-other',
      name: 'Other Tenant',
      slug: 'other-corp',
      plan: 'FREE'
    });
    const attackerUser = await server.authManager.register({
      email: 'attacker@other.io',
      password: 'AttackerPass123!',
      name: 'Attacker',
      tenantId: 'tenant-other'
    });
    const attackerLogin = await server.authManager.login({
      email: 'attacker@other.io',
      password: 'AttackerPass123!'
    });
    const attackerToken = attackerLogin.accessToken;

    // Create Project
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pmToken}`,
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({
        name: 'Artifact Demo App',
        description: 'Testing artifact endpoints',
        autoRun: false
      })
    });
    const projData = await projRes.json();
    const projectId = projData.id || projData.project?.id;

    // A. Upload Artifact via HTTP
    const artifactBody = Buffer.from('Compiled WebAssembly binary simulation bytes', 'utf8');
    const artifactSha256 = crypto.createHash('sha256').update(artifactBody).digest('hex');

    const uploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/artifacts/upload?filename=engine.wasm`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${pmToken}`,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/wasm',
        'x-artifact-filename': 'engine.wasm',
        'x-artifact-type': ArtifactTypes.BUILD_ARTIFACT,
        'x-content-sha256': artifactSha256
      },
      body: artifactBody
    });

    assert.strictEqual(uploadRes.status, 201, 'Upload artifact should return 201 Created');
    const uploadJson = await uploadRes.json();
    assert.strictEqual(uploadJson.ok, true);
    assert.strictEqual(uploadJson.artifact.file_hash, artifactSha256);
    const artifactId = uploadJson.artifact.id;
    const signedDownloadUrl = uploadJson.signedDownloadUrl;
    assert.ok(signedDownloadUrl.includes('/api/artifacts/download?token='));

    // B. List Project Artifacts
    const listRes = await fetch(`${baseUrl}/api/projects/${projectId}/artifacts`, {
      headers: { 'Authorization': `Bearer ${pmToken}` }
    });
    assert.strictEqual(listRes.status, 200);
    const listJson = await listRes.json();
    assert.strictEqual(listJson.artifacts.length, 1);
    assert.strictEqual(listJson.artifacts[0].id, artifactId);

    const toAbsUrl = (u) => u.startsWith('http') ? u : `${baseUrl}${u}`;

    // C. Download via Short-Lived Signed URL (no Bearer token needed!)
    const directDownloadRes = await fetch(toAbsUrl(signedDownloadUrl));
    assert.strictEqual(directDownloadRes.status, 200);
    assert.strictEqual(directDownloadRes.headers.get('content-type'), 'application/octet-stream');
    const downloadedData = await directDownloadRes.text();
    assert.strictEqual(downloadedData, 'Compiled WebAssembly binary simulation bytes');

    // D. Cross-tenant access guard: Attacker cannot access Tenant's artifact
    const attackerAccess = await fetch(`${baseUrl}/api/projects/${projectId}/artifacts/${artifactId}/download`, {
      headers: { 'Authorization': `Bearer ${attackerToken}` }
    });
    assert.strictEqual(attackerAccess.status, 403, 'Cross-tenant artifact access must be 403 Forbidden');

    // E. Export Project as Safe ZIP via HTTP
    const zipExportRes = await fetch(`${baseUrl}/api/projects/${projectId}/export/zip`, {
      headers: {
        'Authorization': `Bearer ${pmToken}`,
        'Accept': 'application/json'
      }
    });
    assert.strictEqual(zipExportRes.status, 200);
    const zipJson = await zipExportRes.json();
    assert.strictEqual(zipJson.ok, true);
    assert.strictEqual(zipJson.artifact.file_type, ArtifactTypes.ZIP_ARCHIVE);
    assert.ok(zipJson.signedDownloadUrl);

    // Download the generated ZIP through signed token
    const zipDownloadRes = await fetch(toAbsUrl(zipJson.signedDownloadUrl));
    assert.strictEqual(zipDownloadRes.status, 200);
    const zipBuffer = Buffer.from(await zipDownloadRes.arrayBuffer());
    assert.ok(zipBuffer.length > 50);

    // Verify ZIP magic number PK\x03\x04
    assert.strictEqual(zipBuffer.readUInt32LE(0), 0x04034b50);

    // F. Admin Retention Cleanup Endpoint
    const cleanupRes = await fetch(`${baseUrl}/api/artifacts/cleanup`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${pmToken}`,
        'X-Requested-With': 'XMLHttpRequest'
      }
    });
    assert.strictEqual(cleanupRes.status, 200);
    const cleanupJson = await cleanupRes.json();
    assert.strictEqual(cleanupJson.ok, true);
    assert.strictEqual(typeof cleanupJson.stats.scannedCount, 'number');

    // G. Invalid & Expired Token Rejection
      const tamperedRes = await fetch(`${baseUrl}/api/artifacts/download?token=invalid.tamperedtoken`);
      assert.strictEqual(tamperedRes.status, 403, 'Tampered token must be rejected with 403');

      const expiredToken = server.artifactService.signedUrlService.createToken({
        artifactId: 'art-exp',
        storageKey: 'tenant-test-artifacts/proj/builds/app.bin',
        tenantId: 'tenant-test-artifacts',
        projectId: 'proj-dummy',
        expiresInSeconds: -10
      });
      const expiredRes = await fetch(`${baseUrl}/api/artifacts/download?token=${encodeURIComponent(expiredToken)}`);
      assert.strictEqual(expiredRes.status, 401, 'Expired token must be rejected with 401');

      // H. Oversized Upload Rejection (HTTP 413 Payload Too Large)
      const oversizedStatus = await new Promise((resolve) => {
        const u = new URL(`${baseUrl}/api/projects/${projectId}/artifacts/upload`);
        const req = http.request(u, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${pmToken}`,
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Length': (60 * 1024 * 1024).toString() // Declares 60MB (> 50MB limit)
          }
        }, (res) => {
          resolve(res.statusCode);
        });
        req.on('error', () => resolve(413));
        req.write('chunk');
        req.end();
      });
      assert.strictEqual(oversizedStatus, 413, 'Upload exceeding 50MB must be rejected with 413');

      await server.stop();
  });
});
