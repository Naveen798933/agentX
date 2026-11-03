import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StorageEngine } from './db.js';
import { ArtifactService, ArtifactTypes, ArtifactCategories } from '../artifacts/index.js';
import { isExcludedPath, validateRelativePath } from '../artifacts/pathValidator.js';

/**
 * Migration utility for Phase 5:
 * Scans existing local project workspaces and registers metadata in PostgreSQL/SQLite catalog.
 * Preserves all existing local files on disk without destructive changes.
 */
export async function migrateLocalWorkspacesToArtifactCatalog(options = {}) {
  const workspacesDir = path.resolve(options.workspacesDir || 'data/workspaces');
  const storage = options.storage || new StorageEngine(options.dbPath || 'data/virtual_company.db');
  const artifactService = options.artifactService || new ArtifactService({ storageEngine: storage });

  const summary = {
    workspacesScanned: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    errors: []
  };

  if (!fs.existsSync(workspacesDir)) {
    return summary;
  }

  const projectDirs = fs.readdirSync(workspacesDir, { withFileTypes: true });

  for (const dir of projectDirs) {
    if (!dir.isDirectory() || dir.name.startsWith('.')) continue;

    const projectId = dir.name;
    const projectDir = path.join(workspacesDir, projectId);
    summary.workspacesScanned++;

    // Retrieve project from database. Skip orphaned workspace directories without DB project.
    let project = null;
    try {
      project = storage.getProject(projectId);
    } catch (_) {}

    if (!project) {
      continue;
    }

    const tenantId = project.tenant_id || project.tenantId || 'tenant-default';

    // Scan files in workspace
    const walk = async (currentDir, relPath = '') => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const itemRel = relPath ? `${relPath}/${entry.name}` : entry.name;

        // Skip secrets, VCS, node_modules, and cache files
        if (isExcludedPath(itemRel) || isExcludedPath(entry.name)) {
          summary.filesSkipped++;
          continue;
        }

        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath, itemRel);
        } else if (entry.isFile()) {
          try {
            const stat = fs.statSync(fullPath);
            const content = fs.readFileSync(fullPath);
            const fileHash = crypto.createHash('sha256').update(content).digest('hex');

            // Store metadata record (content kept in local workspace, not database rows)
            const canonicalKey = artifactService.buildCanonicalKey(
              tenantId,
              projectId,
              ArtifactCategories.GENERAL,
              ArtifactTypes.CODE,
              entry.name
            );

            await storage.saveArtifactRecord({
              id: `art-migrated-${crypto.randomUUID().slice(0, 16)}`,
              tenantId,
              projectId,
              filePath: itemRel,
              fileType: ArtifactTypes.CODE,
              fileHash,
              fileSizeBytes: stat.size,
              storageBackend: 'LOCAL',
              storageKey: canonicalKey,
              contentType: getMimeType(entry.name),
              isConfidential: true,
              retentionPolicy: 'PERMANENT',
              metadata: {
                migratedFromWorkspace: true,
                originalWorkspacePath: itemRel,
                migratedAt: new Date().toISOString()
              }
            });

            summary.filesIndexed++;
          } catch (err) {
            summary.errors.push({ file: itemRel, error: err.message });
          }
        }
      }
    };

    try {
      await walk(projectDir);
    } catch (err) {
      summary.errors.push({ project: projectId, error: err.message });
    }
  }

  return summary;
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.json': 'application/json',
    '.html': 'text/html',
    '.css': 'text/css',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.wasm': 'application/wasm'
  };
  return map[ext] || 'application/octet-stream';
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('src/storage/migrateArtifacts.js')) {
  console.log('[Migration 006] Indexing existing local workspaces into artifact catalog...');
  migrateLocalWorkspacesToArtifactCatalog()
    .then((res) => {
      console.log('[Migration 006] Complete! Summary:', JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Migration 006] Failed:', err);
      process.exit(1);
    });
}
