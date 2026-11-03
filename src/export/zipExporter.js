import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { isExcludedPath, validateRelativePath } from '../artifacts/pathValidator.js';

export const ZIP_LIMITS = {
  MAX_SINGLE_FILE_BYTES: 50 * 1024 * 1024,   // 50 MB
  MAX_TOTAL_UNCOMPRESSED_BYTES: 250 * 1024 * 1024, // 250 MB
  MAX_FILE_COUNT: 10000
};

/**
 * Standard CRC32 Implementation
 */
export function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Generates an in-memory, standard PKZip archive Buffer from an array of files.
 * @param {Array<{ path: string, content: string|Buffer }>} files
 * @param {object} [options]
 * @returns {Buffer} Standard ZIP archive buffer
 */
export function buildZipBuffer(files, options = {}) {
  const maxTotalSize = options.maxTotalSize || ZIP_LIMITS.MAX_TOTAL_UNCOMPRESSED_BYTES;
  const maxFiles = options.maxFiles || ZIP_LIMITS.MAX_FILE_COUNT;

  if (files.length > maxFiles) {
    throw new Error(`File count (${files.length}) exceeds maximum archive limit of ${maxFiles}`);
  }

  const fileEntries = [];
  let offset = 0;
  let totalUncompressedSize = 0;

  for (const { path: rawPath, content } of files) {
    // Sanitize and validate path to prevent Zip-Slip
    const cleanPath = validateRelativePath(rawPath);
    const nameBuf = Buffer.from(cleanPath, 'utf8');
    const rawData = Buffer.isBuffer(content) ? content : Buffer.from(content || '', 'utf8');

    totalUncompressedSize += rawData.length;
    if (totalUncompressedSize > maxTotalSize) {
      throw new Error(`Archive uncompressed size (${totalUncompressedSize} bytes) exceeds limit of ${maxTotalSize} bytes`);
    }

    const compressed = zlib.deflateRawSync(rawData);
    const crc = crc32(rawData);

    // Local file header (30 bytes + name length + compressed size)
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);          // PK\x03\x04
    header.writeUInt16LE(20, 4);                  // Version needed: 2.0
    header.writeUInt16LE(0, 6);                   // Flags
    header.writeUInt16LE(8, 8);                   // Compression: Deflate
    header.writeUInt16LE(0, 10);                  // Mod time
    header.writeUInt16LE(0, 12);                  // Mod date
    header.writeUInt32LE(crc, 14);                // CRC32
    header.writeUInt32LE(compressed.length, 18);  // Compressed size
    header.writeUInt32LE(rawData.length, 22);     // Uncompressed size
    header.writeUInt16LE(nameBuf.length, 26);     // File name length
    header.writeUInt16LE(0, 28);                  // Extra field length

    const localChunk = Buffer.concat([header, nameBuf, compressed]);
    fileEntries.push({ nameBuf, compressed, rawData, crc, offset, localChunk });
    offset += localChunk.length;
  }

  const centralEntries = [];
  let centralDirSize = 0;

  for (const entry of fileEntries) {
    // Central directory header (46 bytes + name length)
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);                 // PK\x01\x02
    cd.writeUInt16LE(20, 4);                          // Version made by: 2.0
    cd.writeUInt16LE(20, 6);                          // Version needed: 2.0
    cd.writeUInt16LE(0, 8);                           // Flags
    cd.writeUInt16LE(8, 10);                          // Compression: Deflate
    cd.writeUInt16LE(0, 12);                          // Mod time
    cd.writeUInt16LE(0, 14);                          // Mod date
    cd.writeUInt32LE(entry.crc, 16);                  // CRC32
    cd.writeUInt32LE(entry.compressed.length, 20);    // Compressed size
    cd.writeUInt32LE(entry.rawData.length, 24);       // Uncompressed size
    cd.writeUInt16LE(entry.nameBuf.length, 28);       // File name length
    cd.writeUInt16LE(0, 30);                          // Extra field length
    cd.writeUInt16LE(0, 32);                          // Comment length
    cd.writeUInt16LE(0, 34);                          // Disk number start
    cd.writeUInt16LE(0, 36);                          // Internal file attributes
    cd.writeUInt32LE((0o100644 * 65536) >>> 0, 38);   // External file attributes (regular file rw-r--r--)
    cd.writeUInt32LE(entry.offset, 42);               // Relative offset of local header

    const cdChunk = Buffer.concat([cd, entry.nameBuf]);
    centralEntries.push(cdChunk);
    centralDirSize += cdChunk.length;
  }

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);                 // PK\x05\x06
  eocd.writeUInt16LE(0, 4);                           // Disk number
  eocd.writeUInt16LE(0, 6);                           // Central dir disk
  eocd.writeUInt16LE(fileEntries.length, 8);           // Entries on this disk
  eocd.writeUInt16LE(fileEntries.length, 10);          // Total entries
  eocd.writeUInt32LE(centralDirSize, 12);              // Size of central dir
  eocd.writeUInt32LE(offset, 16);                      // Offset of central dir
  eocd.writeUInt16LE(0, 20);                           // Comment length

  return Buffer.concat([
    ...fileEntries.map(e => e.localChunk),
    ...centralEntries,
    eocd
  ]);
}

/**
 * Reads a workspace directory recursively, strictly excluding secrets, caches,
 * dependencies, VCS directories, and temporary files.
 * @param {string} workspaceDir
 * @param {object} [options]
 * @returns {Array<{ path: string, content: Buffer }>}
 */
export function readWorkspaceFiles(workspaceDir, options = {}) {
  const files = [];
  const maxSingleFile = options.maxSingleFile || ZIP_LIMITS.MAX_SINGLE_FILE_BYTES;
  let excludedCount = 0;

  function walk(currentDir, relativePath = '') {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      // Strict security check: exclude secrets, caches, node_modules, .git, etc.
      if (isExcludedPath(relPath) || isExcludedPath(entry.name)) {
        excludedCount++;
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > maxSingleFile) {
            // Skip individual files exceeding limit
            continue;
          }
          const content = fs.readFileSync(fullPath);
          files.push({ path: relPath, content });
        } catch (_) {}
      }
    }
  }

  walk(workspaceDir);
  return files;
}

/**
 * Bundles a project workspace into a production-ready ZIP archive,
 * strictly excluding secrets and dependencies, and injecting deployment templates if missing.
 * @param {string} workspaceDir
 * @param {object} [projectMeta]
 * @param {object} [options]
 * @returns {Buffer} Standard ZIP buffer
 */
export function packageProjectAsZip(workspaceDir, projectMeta = {}, options = {}) {
  const files = readWorkspaceFiles(workspaceDir, options);
  const filePaths = new Set(files.map(f => f.path));

  const projName = (projectMeta.name || 'app').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');

  // Inject production Dockerfile if not present
  if (!filePaths.has('Dockerfile')) {
    files.push({
      path: 'Dockerfile',
      content: Buffer.from(`# Production Dockerfile for ${projectMeta.name || 'Synthesized Application'}
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install dependencies if package.json exists
COPY package*.json ./
RUN npm install --production --ignore-scripts || true

# Copy source and assets
COPY . .

# Run as non-root user for security
USER node

EXPOSE 3000
CMD ["npm", "start"]
`, 'utf8')
    });
  }

  // Inject .dockerignore if not present
  if (!filePaths.has('.dockerignore')) {
    files.push({
      path: '.dockerignore',
      content: Buffer.from(`node_modules\n.git\n.env\n*.log\ntmp\n`, 'utf8')
    });
  }

  // Inject deployment instructions if README is missing
  if (!filePaths.has('README.md')) {
    files.push({
      path: 'README.md',
      content: Buffer.from(`# ${projectMeta.name || 'Generated Project'}

${projectMeta.description || ''}

## Quick Start

### Running with Docker
\`\`\`bash
docker build -t ${projName} .
docker run -p 3000:3000 ${projName}
\`\`\`

### Running Locally
\`\`\`bash
npm install
npm test
npm start
\`\`\`
`, 'utf8')
    });
  }

  return buildZipBuffer(files, options);
}

/**
 * Packages workspace and returns archive buffer along with SHA-256 and metadata.
 * @param {string} workspaceDir
 * @param {object} [projectMeta]
 * @param {object} [options]
 * @returns {{ buffer: Buffer, sizeBytes: number, hashSha256: string, fileCount: number }}
 */
export function createProjectZipArchive(workspaceDir, projectMeta = {}, options = {}) {
  const buffer = packageProjectAsZip(workspaceDir, projectMeta, options);
  const hashSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return {
    buffer,
    sizeBytes: buffer.length,
    hashSha256,
    fileCount: readWorkspaceFiles(workspaceDir, options).length
  };
}
