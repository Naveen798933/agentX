import path from 'node:path';

/**
 * Patterns of sensitive files and directories that must be excluded from archives and public artifact exports.
 */
export const EXCLUDED_PATTERNS = [
  // Secrets and Credentials
  /^\.env(\..+)?$/i,
  /\.(pem|key|pfx|p12|pkcs12|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /credentials\.json$/i,
  /serviceAccount.*\.json$/i,
  /\.htpasswd$/i,

  // Version Control & VCS metadata
  /^\.git(\/|\\|$)/i,
  /^\.svn(\/|\\|$)/i,
  /^\.hg(\/|\\|$)/i,

  // Dependencies & Heavy Packages
  /^node_modules(\/|\\|$)/i,
  /^vendor(\/|\\|$)/i,
  /^\.venv(\/|\\|$)/i,
  /^venv(\/|\\|$)/i,
  /^env(\/|\\|$)/i,

  // Build Caches & Temporary Artifacts
  /^\.cache(\/|\\|$)/i,
  /^\.next(\/|\\|$)/i,
  /^\.nuxt(\/|\\|$)/i,
  /^\.turbo(\/|\\|$)/i,
  /^\.parcel-cache(\/|\\|$)/i,
  /__pycache__(\/|\\|$)/i,
  /\.(pyc|pyo|pyd)$/i,
  /^\.pytest_cache(\/|\\|$)/i,
  /^\.eslintcache$/i,
  /\.tsbuildinfo$/i,

  // System & OS Files
  /\.DS_Store$/i,
  /Thumbs\.db$/i,
  /desktop\.ini$/i,

  // Temporary & Editor Backups
  /\.tmp$/i,
  /\.temp$/i,
  /~$/i,
  /\.swp$/i,
  /\.swo$/i
];

/**
 * Windows reserved names (case-insensitive)
 */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

export class PathValidationError extends Error {
  constructor(message, code = 'INVALID_PATH') {
    super(message);
    this.name = 'PathValidationError';
    this.code = code;
  }
}

/**
 * Validates a single filename (no directory separators allowed).
 * @param {string} filename
 * @returns {string} Sanitized/validated filename
 */
export function validateFilename(filename) {
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new PathValidationError('Filename must be a non-empty string', 'EMPTY_FILENAME');
  }

  const trimmed = filename.trim();

  // Length check
  if (trimmed.length > 255) {
    throw new PathValidationError('Filename exceeds maximum allowed length of 255 characters', 'FILENAME_TOO_LONG');
  }

  // Check for null bytes and encoded null bytes
  if (trimmed.includes('\0') || trimmed.includes('%00')) {
    throw new PathValidationError('Filename contains illegal null byte character', 'NULL_BYTE_DETECTED');
  }

  // Prevent path traversal sequences
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new PathValidationError('Filename must not contain path separators or traversal elements', 'PATH_TRAVERSAL_DETECTED');
  }

  // Reject invalid / dangerous filesystem characters: < > : " | ? *
  if (/[<>:"|?*]/.test(trimmed)) {
    throw new PathValidationError('Filename contains illegal characters (< > : " | ? *)', 'ILLEGAL_CHARACTERS');
  }

  // Check Windows reserved names
  const baseName = trimmed.split('.')[0].toUpperCase();
  if (WINDOWS_RESERVED_NAMES.has(baseName)) {
    throw new PathValidationError(`Filename "${trimmed}" uses a reserved system name`, 'RESERVED_NAME');
  }

  return trimmed;
}

/**
 * Validates a relative workspace or storage path, preventing path traversal attacks.
 * @param {string} relativePath
 * @returns {string} Normalized forward-slash relative path
 */
export function validateRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new PathValidationError('Path must be a non-empty string', 'EMPTY_PATH');
  }

  const raw = relativePath.trim();

  // Length check
  if (raw.length > 1024) {
    throw new PathValidationError('Path exceeds maximum allowed length of 1024 characters', 'PATH_TOO_LONG');
  }

  // Check for null bytes
  if (raw.includes('\0') || raw.includes('%00')) {
    throw new PathValidationError('Path contains illegal null byte character', 'NULL_BYTE_DETECTED');
  }

  // Reject URL-encoded traversal patterns
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch (_) {
    // If malformed URI, fallback to raw
  }
  if (decoded.includes('\0')) {
    throw new PathValidationError('Path contains illegal null byte character', 'NULL_BYTE_DETECTED');
  }

  // Prevent absolute paths (POSIX / Windows / UNC)
  if (path.isAbsolute(raw) || path.isAbsolute(decoded) || /^[a-zA-Z]:[/\\]/.test(raw) || /^\\\\/.test(raw)) {
    throw new PathValidationError('Absolute paths are strictly prohibited', 'ABSOLUTE_PATH_PROHIBITED');
  }

  // Normalize path separators to POSIX forward slashes
  const normalized = path.posix.normalize(decoded.replace(/\\/g, '/')).replace(/^\/+/, '');

  // Check if normalized path attempts to escape parent directory
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new PathValidationError('Path traversal attempt detected (..)', 'PATH_TRAVERSAL_DETECTED');
  }

  // Validate each segment of the path
  const segments = normalized.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new PathValidationError('Path traversal attempt detected', 'PATH_TRAVERSAL_DETECTED');
    }
    // Validate individual segment characters
    if (/[<>:"|?*]/.test(segment)) {
      throw new PathValidationError(`Path segment "${segment}" contains illegal characters`, 'ILLEGAL_CHARACTERS');
    }
    const base = segment.split('.')[0].toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(base)) {
      throw new PathValidationError(`Path segment "${segment}" uses a reserved system name`, 'RESERVED_NAME');
    }
  }

  return normalized;
}

/**
 * Safely resolves a relative path within a base directory, verifying no jailbreak.
 * @param {string} baseDir Base directory (must be absolute)
 * @param {string} relativePath Relative path to resolve
 * @returns {string} Absolute resolved path
 */
export function resolveSafePath(baseDir, relativePath) {
  const safeRelPath = validateRelativePath(relativePath);
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, safeRelPath);

  // Verification guard: ensure target is strictly inside base directory
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new PathValidationError('Resolved path escapes target base directory', 'JAILBREAK_DETECTED');
  }

  return resolvedTarget;
}

/**
 * Checks whether a given relative path matches any exclusion patterns
 * (e.g. .env, node_modules, .git, secret keys, temporary files).
 * @param {string} relativePath
 * @returns {boolean} True if the path should be excluded
 */
export function isExcludedPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/');
  const filename = segments[segments.length - 1];

  for (const pattern of EXCLUDED_PATTERNS) {
    // Check against full relative path
    if (pattern.test(normalized)) return true;
    // Check against just the filename
    if (pattern.test(filename)) return true;
    // Check against any intermediate folder segment
    for (const seg of segments) {
      if (pattern.test(seg)) return true;
    }
  }

  return false;
}
