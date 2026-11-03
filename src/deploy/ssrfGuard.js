import net from 'node:net';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export class SSRFSecurityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SSRFSecurityError';
    this.details = details;
  }
}

/**
 * Cloud metadata endpoints and known internal service addresses
 */
export const BLOCKED_METADATA_IPS = new Set([
  '169.254.169.254', // AWS EC2 / Azure IMDS / GCP / DigitalOcean metadata
  '169.254.170.2',   // AWS ECS task metadata
  '100.100.100.200', // Alibaba Cloud metadata
  'fd00:ec2::254'    // AWS IPv6 metadata
]);

export const BLOCKED_HOSTNAMES = [
  /^localhost$/i,
  /\.localhost$/i,
  /^metadata\.google\.internal$/i,
  /^instance-data$/i,
  /\.internal$/i,
  /\.local$/i,
  /\.lan$/i,
  /\.arpa$/i
];

export const BLOCKED_PORTS = new Set([
  22,    // SSH
  23,    // Telnet
  25,    // SMTP
  111,   // Portmapper
  2375,  // Docker daemon
  2376,  // Docker daemon SSL
  3306,  // MySQL
  5432,  // PostgreSQL
  6379,  // Redis
  8086,  // InfluxDB
  9200,  // Elasticsearch
  9300,  // Elasticsearch cluster
  10250, // Kubelet
  10255, // Kubelet read-only
  11211, // Memcached
  27017  // MongoDB
]);

/**
 * Convert IPv4 address to 32-bit unsigned integer for CIDR matching
 */
function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

/**
 * Check if IPv4 is within a given CIDR subnet
 */
function isIpInCidr(ip, cidr) {
  const [range, bits = 32] = cidr.split('/');
  const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
}

/**
 * Private and restricted IPv4 CIDR ranges
 */
const RESTRICTED_IPV4_CIDRS = [
  '0.0.0.0/8',       // Current network (RFC 1122)
  '10.0.0.0/8',      // Private class A (RFC 1918)
  '127.0.0.0/8',     // Loopback (RFC 1122)
  '169.254.0.0/16',  // Link-local / Cloud Metadata (RFC 3927)
  '172.16.0.0/12',   // Private class B (RFC 1918)
  '192.168.0.0/16',  // Private class C (RFC 1918)
  '100.64.0.0/10',   // Carrier-grade NAT (RFC 6598)
  '198.18.0.0/15',   // Benchmark testing
  '224.0.0.0/4',     // Multicast
  '240.0.0.0/4',     // Reserved
  '255.255.255.255/32' // Broadcast
];

export class SSRFGuard {
  /**
   * Determine if an IP address belongs to private, loopback, or metadata networks
   */
  static isRestrictedIp(ip) {
    if (!ip) return true;
    const cleanIp = ip.replace(/^::ffff:/i, ''); // Strip IPv4-mapped IPv6

    if (BLOCKED_METADATA_IPS.has(cleanIp.toLowerCase())) {
      return true;
    }

    const family = net.isIP(cleanIp);
    if (family === 4) {
      for (const cidr of RESTRICTED_IPV4_CIDRS) {
        if (isIpInCidr(cleanIp, cidr)) {
          return true;
        }
      }
      return false;
    }

    if (family === 6) {
      const lower = cleanIp.toLowerCase();
      // Loopback ::1
      if (lower === '::1' || lower === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
      // Unspecified ::
      if (lower === '::' || lower === '0000:0000:0000:0000:0000:0000:0000:0000') return true;
      // Link-local fe80::/10
      if (lower.startsWith('fe80:') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
      // Unique local fc00::/7
      if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
      return false;
    }

    return true; // Unknown address family treated as restricted
  }

  /**
   * Check if a destination port targets protected internal services
   */
  static isRestrictedPort(port) {
    const num = Number(port);
    return BLOCKED_PORTS.has(num);
  }

  /**
   * Comprehensive validation of a destination URL before dispatching HTTP/HTTPS requests
   * Resolves DNS to thwart DNS rebinding attacks and validates every resolved IP
   */
  static async validateUrl(urlStr, options = {}) {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      throw new SSRFSecurityError(`Invalid URL string: "${urlStr}"`);
    }

    // Protocol check: only http and https allowed
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SSRFSecurityError(`Unsupported protocol "${parsed.protocol}". Only HTTP and HTTPS are permitted.`, {
        url: urlStr,
        protocol: parsed.protocol
      });
    }

    const hostname = parsed.hostname;
    const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);

    // Port check
    if (this.isRestrictedPort(port)) {
      throw new SSRFSecurityError(`Access to restricted internal port ${port} is forbidden`, {
        url: urlStr,
        port
      });
    }

    // Hostname regex check
    for (const pattern of BLOCKED_HOSTNAMES) {
      if (pattern.test(hostname)) {
        throw new SSRFSecurityError(`Access to internal/metadata host "${hostname}" is forbidden`, {
          url: urlStr,
          hostname
        });
      }
    }

    // Check if hostname is a raw IP literal
    if (net.isIP(hostname)) {
      if (this.isRestrictedIp(hostname)) {
        throw new SSRFSecurityError(`Access to restricted IP address "${hostname}" is forbidden (SSRF protection)`, {
          url: urlStr,
          ip: hostname
        });
      }
      return { safe: true, hostname, port, resolvedIps: [hostname] };
    }

    // Resolve DNS records to verify all target IPs
    if (!options.skipDns) {
      try {
        const addresses = await dns.lookup(hostname, { all: true });
        if (!addresses || addresses.length === 0) {
          throw new SSRFSecurityError(`DNS lookup returned no addresses for host "${hostname}"`);
        }

        const resolvedIps = addresses.map(a => a.address);
        for (const resolvedIp of resolvedIps) {
          if (this.isRestrictedIp(resolvedIp)) {
            throw new SSRFSecurityError(
              `SSRF Blocked: Hostname "${hostname}" resolves to restricted IP "${resolvedIp}"`,
              { url: urlStr, hostname, resolvedIp }
            );
          }
        }
        return { safe: true, hostname, port, resolvedIps };
      } catch (err) {
        if (err instanceof SSRFSecurityError) throw err;
        throw new SSRFSecurityError(`DNS resolution failed for "${hostname}": ${err.message}`, {
          url: urlStr,
          hostname
        });
      }
    }

    return { safe: true, hostname, port, resolvedIps: [] };
  }

  /**
   * Safe HTTP GET/POST fetcher with redirect interception and strict SSRF verification
   */
  static async safeFetch(urlStr, options = {}) {
    const maxRedirects = options.maxRedirects !== undefined ? options.maxRedirects : 3;
    let currentUrl = urlStr;
    let redirectCount = 0;

    while (redirectCount <= maxRedirects) {
      // Validate current URL against SSRF policy
      await this.validateUrl(currentUrl);

      const parsed = new URL(currentUrl);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;

      const requestOptions = {
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 8000
      };

      const result = await new Promise((resolve, reject) => {
        const req = lib.request(currentUrl, requestOptions, (res) => {
          // Handle redirects manually to inspect target Location
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            const nextLocation = new URL(res.headers.location, currentUrl).href;
            res.resume(); // Discard response body
            resolve({ redirect: true, nextLocation, statusCode: res.statusCode });
            return;
          }

          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            resolve({
              redirect: false,
              statusCode: res.statusCode,
              headers: res.headers,
              body: data
            });
          });
        });

        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error(`Request timed out after ${requestOptions.timeout}ms`));
        });

        if (options.body) {
          req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        }
        req.end();
      });

      if (result.redirect) {
        redirectCount++;
        currentUrl = result.nextLocation;
        continue;
      }

      return result;
    }

    throw new SSRFSecurityError(`Exceeded maximum allowed redirects (${maxRedirects})`, {
      originalUrl: urlStr
    });
  }
}

/**
 * DependencyGuard
 * Scans project package.json and manifests for banned or dangerous packages,
 * unsafe life-cycle install scripts, and remote execution vectors.
 */
export class DependencyGuard {
  static BANNED_PACKAGES = new Set([
    'flatmap-stream',
    'event-stream@3.3.6',
    'colors@1.4.1',
    'faker@6.6.6',
    'pepe-coin',
    'node-ipc@10.1.1',
    'node-ipc@10.1.2'
  ]);

  static DANGEROUS_SCRIPT_PATTERNS = [
    /\bcurl\b.*\|\s*(?:ba)?sh\b/i,
    /\bwget\b.*\|\s*(?:ba)?sh\b/i,
    /\brm\s+-(?:rf|fr)\s+(?:\/|~|\.\.)/i,
    /\bnc(?:at)?\s+-[el]/i,
    /\/dev\/tcp\//i,
    /\bsudo\b/i
  ];

  /**
   * Scan package.json contents for vulnerabilities, malicious packages, or dangerous install hooks
   */
  static scanPackageJson(pkgContent) {
    let pkg;
    try {
      pkg = typeof pkgContent === 'string' ? JSON.parse(pkgContent) : pkgContent;
    } catch (err) {
      return { safe: false, errors: [`Invalid package.json format: ${err.message}`] };
    }

    const errors = [];
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

    // Check banned dependencies
    for (const [depName, version] of Object.entries(deps)) {
      if (this.BANNED_PACKAGES.has(depName) || this.BANNED_PACKAGES.has(`${depName}@${version}`)) {
        errors.push(`Banned vulnerable/malicious dependency detected: "${depName}@${version}"`);
      }
    }

    // Check lifecycle scripts
    const scripts = pkg.scripts || {};
    const dangerousHooks = ['preinstall', 'install', 'postinstall', 'prepublish', 'prepare'];
    for (const hook of dangerousHooks) {
      if (scripts[hook]) {
        for (const pattern of this.DANGEROUS_SCRIPT_PATTERNS) {
          if (pattern.test(scripts[hook])) {
            errors.push(`Dangerous lifecycle script detected in "${hook}": "${scripts[hook]}" matches pattern ${pattern}`);
          }
        }
      }
    }

    return {
      safe: errors.length === 0,
      errors
    };
  }
}
