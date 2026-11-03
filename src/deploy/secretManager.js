import path from 'node:path';
import fs from 'node:fs';

export class SecretScanError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SecretScanError';
    this.details = details;
  }
}

/**
 * Common high-entropy secret patterns
 */
export const SENSITIVE_PATTERNS = [
  { name: 'AWS Access Key ID', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Generic Private Key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Slack Bot Token', regex: /\bxoxb-[0-9]{11}-[0-9]{11}-[a-zA-Z0-9]{24}\b/ },
  { name: 'GitHub Personal Access Token', regex: /\bgh[pous]_[A-Za-z0-9_]{36,255}\b/ },
  { name: 'Stripe Secret Key', regex: /\bsk_live_[0-9a-zA-Z]{24}\b/ },
  { name: 'Google API Key', regex: /\bAIza[0-9A-Za-z\\-_]{35}\b/ },
  { name: 'Generic Password/Secret Assignment', regex: /(?:api[_-]?secret|password|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"][a-zA-Z0-9!@#$%^&*()_+=\-`~]{8,}['"]/i }
];

export class SecretManager {
  /**
   * Split environment variables into safe client-side vars and secure server-side secrets
   */
  static partitionEnvVars(envVars = {}) {
    const clientSafe = {};
    const serverSecrets = {};

    for (const [key, value] of Object.entries(envVars)) {
      if (this.isClientSafeKey(key)) {
        clientSafe[key] = value;
      } else {
        serverSecrets[key] = value;
      }
    }

    return { clientSafe, serverSecrets };
  }

  /**
   * Check if an environment variable key is explicitly designated for public frontend consumption
   */
  static isClientSafeKey(key) {
    if (!key || typeof key !== 'string') return false;
    const upper = key.toUpperCase();
    return upper.startsWith('VITE_PUBLIC_') ||
           upper.startsWith('NEXT_PUBLIC_') ||
           upper.startsWith('REACT_APP_PUBLIC_') ||
           upper.startsWith('PUBLIC_');
  }

  /**
   * Scan project files or generated frontend bundles for leaked server secrets
   */
  static scanDirectoryForSecrets(projectDir, serverSecrets = {}) {
    if (!fs.existsSync(projectDir)) return { safe: true, findings: [] };

    const findings = [];
    const secretValues = Object.entries(serverSecrets)
      .map(([k, v]) => ({ key: k, value: String(v || '').trim() }))
      .filter(s => s.value.length >= 8); // Only match non-trivial secret values

    function walk(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip node_modules and .git
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          // Scan frontend assets: html, js, mjs, css, json, map
          if (['.html', '.js', '.mjs', '.css', '.json', '.map'].includes(ext)) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              const relPath = path.relative(projectDir, fullPath);

              // 1. Check known server secret values
              for (const { key, value } of secretValues) {
                if (content.includes(value)) {
                  findings.push({
                    file: relPath,
                    type: 'SERVER_SECRET_LEAK',
                    secretKey: key,
                    message: `Server secret "${key}" was found embedded in frontend asset "${relPath}"`
                  });
                }
              }

              // 2. Check high-entropy pattern matches (only in public/ or dist/ directories)
              if (relPath.startsWith('public') || relPath.startsWith('dist') || relPath.startsWith('build')) {
                for (const pattern of SENSITIVE_PATTERNS) {
                  if (pattern.regex.test(content)) {
                    findings.push({
                      file: relPath,
                      type: 'PATTERN_MATCH',
                      patternName: pattern.name,
                      message: `High-risk credential pattern "${pattern.name}" matched in client bundle "${relPath}"`
                    });
                  }
                }
              }
            } catch (_) {}
          }
        }
      }
    }

    walk(projectDir);

    return {
      safe: findings.length === 0,
      findings
    };
  }

  /**
   * Enforce secret safety check; throws SecretScanError if any sensitive leaks are found
   */
  static assertFrontendSafety(projectDir, serverSecrets = {}) {
    const result = this.scanDirectoryForSecrets(projectDir, serverSecrets);
    if (!result.safe) {
      throw new SecretScanError(
        `Frontend secret scan failed: ${result.findings.length} secret(s) detected in client bundle`,
        { findings: result.findings }
      );
    }
    return true;
  }
}
