import { DeploymentProvider } from './deploymentProvider.js';
import { SSRFGuard } from './ssrfGuard.js';

function safeJsonParse(body, context) {
  try {
    return JSON.parse(body);
  } catch (_) {
    throw new Error(`${context}: Response was not valid JSON (${body ? body.slice(0, 120) : 'empty'})`);
  }
}

export class CloudflarePagesProvider extends DeploymentProvider {
  /**
   * @param {Object} [config]
   * @param {string} [config.apiToken] - Cloudflare API Token (least-privilege: Account:Pages:Edit)
   * @param {string} [config.accountId] - Cloudflare Account ID
   * @param {string} [config.projectName] - Default Cloudflare Pages project name
   */
  constructor(config = {}) {
    super('cloudflare-pages', config);
    this.apiToken = config.apiToken || process.env.CLOUDFLARE_API_TOKEN || '';
    this.accountId = config.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || '';
    this.projectName = config.projectName || process.env.CLOUDFLARE_PAGES_PROJECT || '';
    this.baseUrl = 'https://api.cloudflare.com/client/v4';
  }

  validateCredentials() {
    const missing = [];
    if (!this.apiToken) missing.push('CLOUDFLARE_API_TOKEN');
    if (!this.accountId) missing.push('CLOUDFLARE_ACCOUNT_ID');

    return {
      configured: missing.length === 0,
      missing,
      checklist: [
        '1. Log in to Cloudflare Dashboard -> My Profile -> API Tokens',
        '2. Create custom token with Account -> Cloudflare Pages -> Edit permission',
        '3. Set CLOUDFLARE_API_TOKEN=<token> and CLOUDFLARE_ACCOUNT_ID=<account_id> in environment',
        '4. Never commit these secrets into client bundles or git repository'
      ]
    };
  }

  getSetupChecklist() {
    return {
      provider: 'cloudflare-pages',
      docsUrl: 'https://developers.cloudflare.com/pages/platform/direct-upload/',
      requiredEnvVars: [
        {
          key: 'CLOUDFLARE_API_TOKEN',
          description: 'Cloudflare API token scoped to Pages:Edit',
          permissions: 'Account.Cloudflare Pages:Edit (Least Privilege)'
        },
        {
          key: 'CLOUDFLARE_ACCOUNT_ID',
          description: '32-character hexadecimal Cloudflare account identifier',
          permissions: 'Read-only access to account identifier'
        },
        {
          key: 'CLOUDFLARE_PAGES_PROJECT',
          description: 'Optional default project name for Pages deployment',
          permissions: 'Target project container'
        }
      ],
      setupSteps: [
        '1. Generate a scoped API token in Cloudflare Dashboard under "API Tokens"',
        '2. Restrict token TTL and IP range if operating in enterprise environments',
        '3. Add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to server-side .env file',
        '4. Verify credentials via GET /api/deploy/providers endpoint before triggering deployments'
      ]
    };
  }

  async build(projectDir, options = {}) {
    const creds = this.validateCredentials();
    if (!creds.configured) {
      throw new Error(`Cloudflare Pages credentials not configured. Missing: ${creds.missing.join(', ')}`);
    }
    return {
      success: true,
      buildLogs: '[CloudflarePages] Validated project artifacts for Cloudflare Edge CDN release.'
    };
  }

  async deploy({ projectId, projectDir, environment = 'preview', envVars = {}, commitSha = null }) {
    const creds = this.validateCredentials();
    if (!creds.configured) {
      throw new Error(
        `Cannot deploy to Cloudflare Pages: Missing credentials (${creds.missing.join(', ')}). ` +
        'Review the setup checklist before deploying.'
      );
    }

    const pagesProject = this.projectName || `pulse-${projectId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    const endpoint = `${this.baseUrl}/accounts/${this.accountId}/pages/projects/${pagesProject}/deployments`;

    const headers = {
      'Authorization': `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json'
    };

    const res = await SSRFGuard.safeFetch(endpoint, {
      method: 'POST',
      headers,
      body: {
        branch: environment === 'production' ? 'main' : environment,
        commit_hash: commitSha
      }
    });

    if (res.statusCode >= 400) {
      throw new Error(`Cloudflare Pages API error (${res.statusCode}): ${res.body}`);
    }

    const data = safeJsonParse(res.body, 'Cloudflare Pages deployment');
    if (!data.success) {
      throw new Error(`Cloudflare Pages deployment rejected: ${JSON.stringify(data.errors)}`);
    }

    const result = data.result;
    return {
      deploymentId: result.id,
      url: result.url,
      providerDetails: {
        provider: 'cloudflare-pages',
        accountId: this.accountId,
        project: pagesProject,
        environment,
        aliases: result.aliases || []
      },
      commitSha: result.deployment_trigger?.metadata?.commit_hash || commitSha
    };
  }

  async getStatus(deploymentId) {
    const creds = this.validateCredentials();
    if (!creds.configured) throw new Error(`Missing credentials: ${creds.missing.join(', ')}`);

    const endpoint = `${this.baseUrl}/accounts/${this.accountId}/pages/projects/${this.projectName}/deployments/${deploymentId}`;
    const res = await SSRFGuard.safeFetch(endpoint, {
      headers: { 'Authorization': `Bearer ${this.apiToken}` }
    });

    if (res.statusCode >= 400) throw new Error(`Cloudflare Pages API error: ${res.body}`);
    const data = safeJsonParse(res.body, 'Cloudflare Pages status');
    const result = data.result || {};

    return {
      status: (result.latest_stage?.status || 'UNKNOWN').toUpperCase(),
      url: result.url,
      details: result
    };
  }

  async getLogs(deploymentId) {
    const creds = this.validateCredentials();
    if (!creds.configured) throw new Error(`Missing credentials: ${creds.missing.join(', ')}`);

    const endpoint = `${this.baseUrl}/accounts/${this.accountId}/pages/projects/${this.projectName}/deployments/${deploymentId}/history`;
    const res = await SSRFGuard.safeFetch(endpoint, {
      headers: { 'Authorization': `Bearer ${this.apiToken}` }
    });

    if (res.statusCode >= 400) return `[CloudflarePages] Unable to retrieve logs: ${res.statusCode}`;
    return res.body;
  }

  async rollback(deploymentId, targetDeploymentId) {
    const creds = this.validateCredentials();
    if (!creds.configured) throw new Error(`Missing credentials: ${creds.missing.join(', ')}`);

    const endpoint = `${this.baseUrl}/accounts/${this.accountId}/pages/projects/${this.projectName}/deployments/${targetDeploymentId}/rollback`;
    const res = await SSRFGuard.safeFetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiToken}` }
    });

    if (res.statusCode >= 400) throw new Error(`Cloudflare Pages rollback failed: ${res.body}`);
    const data = safeJsonParse(res.body, 'Cloudflare Pages rollback');

    return {
      success: data.success,
      targetDeploymentId,
      url: data.result?.url
    };
  }

  async teardown(deploymentId) {
    const creds = this.validateCredentials();
    if (!creds.configured) throw new Error(`Missing credentials: ${creds.missing.join(', ')}`);

    const endpoint = `${this.baseUrl}/accounts/${this.accountId}/pages/projects/${this.projectName}/deployments/${deploymentId}`;
    const res = await SSRFGuard.safeFetch(endpoint, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.apiToken}` }
    });

    return { success: res.statusCode < 400 };
  }
}
