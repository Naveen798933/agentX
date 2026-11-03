import crypto from 'node:crypto';
import path from 'node:path';
import { LocalStorageProvider, StorageError } from './localStorageProvider.js';
import { S3StorageProvider } from './s3StorageProvider.js';
import { SignedUrlService } from './signedUrlService.js';
import { CleanupManager, RetentionPolicies, calculateExpirationDate } from './cleanupManager.js';
import { validateFilename, validateRelativePath } from './pathValidator.js';
import { createProjectZipArchive } from '../export/zipExporter.js';

export const ArtifactTypes = {
  CODE: 'CODE',
  BUILD_ARTIFACT: 'BUILD_ARTIFACT',
  LOGS_EXPORT: 'LOGS_EXPORT',
  ZIP_ARCHIVE: 'ZIP_ARCHIVE',
  TEST_REPORT: 'TEST_REPORT'
};

export const ArtifactCategories = {
  BUILDS: 'builds',
  EXPORTS: 'exports',
  LOGS: 'logs',
  TESTS: 'tests',
  GENERAL: 'artifacts'
};

/**
 * High-level Artifact Storage Service.
 * Unifies object storage backends, PostgreSQL/SQLite metadata catalogs,
 * path validation, retention policies, and signed downloads.
 */
export class ArtifactService {
  /**
   * @param {object} [options]
   * @param {import('./storageProvider.js').StorageProvider} [options.storageProvider]
   * @param {object} [options.storageEngine]
   * @param {SignedUrlService} [options.signedUrlService]
   * @param {CleanupManager} [options.cleanupManager]
   */
  constructor(options = {}) {
    this.storageEngine = options.storageEngine || null;
    this.signedUrlService = options.signedUrlService || new SignedUrlService({
      secret: process.env.STORAGE_SIGNING_SECRET,
      baseUrl: process.env.PUBLIC_API_URL
    });

    if (options.storageProvider) {
      this.storageProvider = options.storageProvider;
    } else {
      const providerType = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();
      if (providerType === 's3' || providerType === 'r2') {
        this.storageProvider = new S3StorageProvider({
          bucket: process.env.STORAGE_S3_BUCKET || 'virtual-house-artifacts',
          endpoint: process.env.STORAGE_S3_ENDPOINT,
          region: process.env.STORAGE_S3_REGION || 'us-east-1',
          accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY,
          forcePathStyle: process.env.STORAGE_S3_FORCE_PATH_STYLE === 'true'
        });
      } else {
        this.storageProvider = new LocalStorageProvider({
          baseDir: process.env.STORAGE_LOCAL_DIR || path.join(process.cwd(), 'data', 'artifacts'),
          signedUrlService: this.signedUrlService
        });
      }
    }

    this.cleanupManager = options.cleanupManager || new CleanupManager({
      storageProvider: this.storageProvider,
      storageEngine: this.storageEngine
    });
  }

  /**
   * Binds or updates the database storage engine.
   * @param {object} storageEngine
   */
  setStorageEngine(storageEngine) {
    this.storageEngine = storageEngine;
    this.cleanupManager.storageEngine = storageEngine;
  }

  /**
   * Sets the base URL for generating absolute download URLs.
   * @param {string} baseUrl
   */
  setBaseUrl(baseUrl) {
    if (this.signedUrlService) {
      this.signedUrlService.baseUrl = baseUrl;
    }
    if (this.storageProvider && this.storageProvider.signedUrlService) {
      this.storageProvider.signedUrlService.baseUrl = baseUrl;
    }
  }

  /**
   * Constructs the secure, tenant-isolated canonical storage key.
   * Pattern: {tenantId}/{projectId}/{category}/{artifactType}/{filename}
   */
  buildCanonicalKey(tenantId, projectId, category, artifactType, filename) {
    const safeTenant = validateFilename(tenantId || 'tenant-default');
    const safeProject = validateFilename(projectId || 'proj-default');
    const safeCat = validateFilename(category || ArtifactCategories.GENERAL);
    const safeType = validateFilename(artifactType || ArtifactTypes.BUILD_ARTIFACT);
    const safeName = validateFilename(filename);

    return `${safeTenant}/${safeProject}/${safeCat}/${safeType}/${safeName}`;
  }

  /**
   * Stores an artifact: writes content to object storage and saves metadata record in database.
   * Never stores raw file content in database rows.
   */
  async storeArtifact({
    id,
    tenantId = 'tenant-default',
    projectId,
    jobId = null,
    filePath,
    filename,
    fileType = ArtifactTypes.BUILD_ARTIFACT,
    category = ArtifactCategories.BUILDS,
    content,
    retentionPolicy = RetentionPolicies.TEMPORARY_BUILD,
    customTtlSeconds = null,
    isConfidential = true,
    contentType = 'application/octet-stream',
    metadata = {},
    expectedHash = null
  }) {
    if (!projectId) {
      throw new StorageError('projectId is required to store artifact', 'MISSING_PROJECT_ID', 400);
    }

    const artifactName = filename || (filePath ? path.basename(filePath) : `artifact-${Date.now()}.bin`);
    validateFilename(artifactName);

    const safeFilePath = filePath ? validateRelativePath(filePath) : artifactName;
    const storageKey = this.buildCanonicalKey(tenantId, projectId, category, fileType, artifactName);

    // 1. Write object bytes to StorageProvider (verifies hash & bounds atomically)
    const uploadResult = await this.storageProvider.putObject(storageKey, content, {
      contentType,
      expectedHash,
      isConfidential,
      metadata
    });

    // 2. Compute expiration timestamp based on retention policy
    const expiresAt = calculateExpirationDate(retentionPolicy, new Date(), customTtlSeconds);
    const artifactId = id || `art-${crypto.randomUUID().slice(0, 12)}`;

    // 3. Persist metadata record in DB (NOT raw file content)
    let dbRecord = null;
    if (this.storageEngine && typeof this.storageEngine.saveArtifactRecord === 'function') {
      dbRecord = await this.storageEngine.saveArtifactRecord({
        id: artifactId,
        tenantId,
        projectId,
        jobId,
        filePath: safeFilePath,
        fileType,
        fileHash: uploadResult.hashSha256,
        fileSizeBytes: uploadResult.sizeBytes,
        storageBackend: uploadResult.storageBackend,
        storageKey,
        contentType,
        isConfidential,
        retentionPolicy,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        metadata
      });
    }

    // 4. Generate signed download URL
    const signedDownloadUrl = await this.storageProvider.getSignedUrl(storageKey, {
      artifactId,
      tenantId,
      projectId,
      expiresInSeconds: 900
    });

    return {
      artifact: dbRecord || {
        id: artifactId,
        tenantId,
        projectId,
        jobId,
        filePath: safeFilePath,
        fileType,
        fileHash: uploadResult.hashSha256,
        fileSizeBytes: uploadResult.sizeBytes,
        storageBackend: uploadResult.storageBackend,
        storageKey,
        contentType,
        isConfidential,
        retentionPolicy,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        metadata
      },
      signedDownloadUrl
    };
  }

  /**
   * Retrieves artifact metadata with tenant ownership check and generates a fresh signed download URL.
   */
  async getArtifact(artifactId, tenantId = null) {
    if (!this.storageEngine || typeof this.storageEngine.getArtifactRecord !== 'function') {
      throw new StorageError('Database storage engine not configured for artifact queries', 'DB_NOT_CONFIGURED');
    }

    const artifact = await this.storageEngine.getArtifactRecord(artifactId);
    if (!artifact || artifact.deleted_at) {
      throw new StorageError(`Artifact "${artifactId}" not found`, 'NOT_FOUND', 404);
    }

    // Enforce tenant authorization guard
    if (tenantId && artifact.tenant_id !== tenantId) {
      throw new StorageError(`Access denied: artifact does not belong to tenant "${tenantId}"`, 'FORBIDDEN', 403);
    }

    const signedDownloadUrl = await this.storageProvider.getSignedUrl(artifact.storage_key, {
      artifactId: artifact.id,
      tenantId: artifact.tenant_id,
      projectId: artifact.project_id,
      expiresInSeconds: 900
    });

    return { artifact, signedDownloadUrl };
  }

  /**
   * Downloads raw artifact bytes after verifying tenant ownership.
   */
  async downloadArtifact(artifactId, tenantId = null) {
    const { artifact } = await this.getArtifact(artifactId, tenantId);
    const buffer = await this.storageProvider.getObject(artifact.storage_key);
    return { artifact, buffer };
  }

  /**
   * Lists artifacts for a project with signed download URLs.
   */
  async listProjectArtifacts(projectId, tenantId = null, filters = {}) {
    if (!this.storageEngine || typeof this.storageEngine.listArtifactRecords !== 'function') {
      return [];
    }

    const records = await this.storageEngine.listArtifactRecords(projectId, tenantId, filters);
    const enriched = await Promise.all(
      records.map(async (record) => {
        let signedDownloadUrl = null;
        try {
          signedDownloadUrl = await this.storageProvider.getSignedUrl(record.storage_key, {
            artifactId: record.id,
            tenantId: record.tenant_id,
            projectId: record.project_id,
            expiresInSeconds: 900
          });
        } catch (_) {}
        return { ...record, signedDownloadUrl };
      })
    );

    return enriched;
  }

  /**
   * Generates a safe ZIP archive for a project workspace, stores it with EXPORT_ARCHIVE retention (2 hours),
   * and returns signed download URL.
   */
  async packageAndStoreProjectZip(projectId, tenantId = 'tenant-default', workspaceDir, projectMeta = {}) {
    const projName = (projectMeta.name || projectId).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${projName}-${timestamp}.zip`;

    // 1. Build Safe ZIP buffer (excluding secrets, node_modules, .git, caches)
    const { buffer, sizeBytes, hashSha256 } = createProjectZipArchive(workspaceDir, projectMeta);

    // 2. Store in object storage as an EXPORT_ARCHIVE artifact
    const { artifact, signedDownloadUrl } = await this.storeArtifact({
      tenantId,
      projectId,
      filePath: `exports/${filename}`,
      filename,
      fileType: ArtifactTypes.ZIP_ARCHIVE,
      category: ArtifactCategories.EXPORTS,
      content: buffer,
      retentionPolicy: RetentionPolicies.EXPORT_ARCHIVE,
      customTtlSeconds: 2 * 3600, // 2 hours
      isConfidential: true,
      contentType: 'application/zip',
      expectedHash: hashSha256,
      metadata: {
        exportedAt: new Date().toISOString(),
        archiveFormat: 'zip',
        uncompressedEstimated: sizeBytes
      }
    });

    return { artifact, signedDownloadUrl, buffer };
  }

  /**
   * Deletes an artifact from both storage and database.
   */
  async deleteArtifact(artifactId, tenantId = null) {
    const { artifact } = await this.getArtifact(artifactId, tenantId);

    // Delete from storage provider
    await this.storageProvider.deleteObject(artifact.storage_key);

    // Delete or mark deleted in database
    if (this.storageEngine && typeof this.storageEngine.deleteArtifactRecord === 'function') {
      await this.storageEngine.deleteArtifactRecord(artifactId);
    }

    return true;
  }

  /**
   * Runs retention policy cleanup.
   */
  async cleanupExpiredArtifacts(options = {}) {
    return this.cleanupManager.runCleanup(options);
  }
}
