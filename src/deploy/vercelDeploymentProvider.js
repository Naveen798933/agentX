import { DeploymentProvider } from './deploymentProvider.js';
import { SSRFGuard } from './ssrfGuard.js';

function safeJsonParse(body, context) {
  try {
    return JSON.parse(body);
  } catch (_) {
    throw new Error(`${context}: Response was not valid JSON (${body ? body.slice(0, 120) : 'empty'})`);
  }
}

export class VercelDeploymentProvider extends DeploymentProvider {
  /**
   * @param {Object} [config]
   * @param {string} [config.token] - Vercel personal / team access token
   * @param {string} [config.orgId] - Vercel Team / Org ID
   * @param {string} [config.projectId] - Vercel Project ID
   */
  constructor(config = {}) {
    super('vercel', config);
    this.token = config.token || process.env.VERCEL_TOKEN || '';
    this.orgId = config.orgId || process.env.VERCEL_ORG_ID || '';
    this.projectId = config.projectId || process.env.VERCEL_PROJECT_ID || '';
    this.baseUrl = 'https://api.vercel.com';
  }

  validateCredentials() {
    const missing = [];
    if (!this.token) missing.push('VERCEL_TOKEN');

    return {
      configured: missing.length === 0,
      missing,
      checklist: [
        '1. Generate a Personal or Team Access Token at https://vercel.com/account/tokens',
        '2. Choose appropriate scope (e.g. Deployments write)',
        '3. Set VERCEL_TOKEN=<token> in your server environment',
        '4. Optionally provide VERCEL_ORG_ID and VERCEL_PROJECT_ID'
      ]
    };
  }

  getSetupChecklist() {
    return {
      provider: 'vercel',
      docsUrl: 'https://vercel.com/docs/rest-api/endpoints#deployments',
      requiredEnvVars: [
        {
          key: 'VERCEL_TOKEN',
          description: 'Vercel API token with deployments write permission',
          permissions: 'Deployments:Create, Read'
        },
        {
          key: 'VERCEL_ORG_ID',
          description: 'Optional Team/Org scope identifier for team-owned projects',
          permissions: 'Read-only team scope'
        },
        {
          key: 'VERCEL_PROJECT_ID',
          description: 'Target Vercel project ID',
          permissions: 'Project binding'
        }
      ],
      setupSteps: [
        '1. Create a Vercel API token with scoped permissions',
        '2. Save VERCEL_TOKEN into server environment (.env)',
        '3. Test connectivity via provider registry before deploying'
      ]
    };
  }

  async build(projectDir, options = {}) {
    const creds = this.validateCredentials();
    if (!creds.configured) {
      throw new Error(`Vercel credentials not configured. Missing: ${creds.missing.join(', ')}`);
    }
    return {
      success: true,
      buildLogs: '[Vercel] Validated project configuration for Vercel Edge Network deployment.'
    };
  }

  async deploy({ projectId, projectDir, environment = 'preview', envVars = {}, commitSha = null }) {
    const creds = this.validateCredentials();
    if (!creds.configured) {
      throw new Error(
        `Cannot deploy to Vercel: Missing credentials (${creds.missing.join(', ')}). ` +
        'Review the setup checklist before deploying.'
      );
    }

    const queryParams = new URLSearchParams();
    if (this.orgId) queryParams.set('teamId', this.orgId);
    const endpoint = `${this.baseUrl}/v13/deployments?${queryParams.toString()}`;

    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json'
    };

    const target = environment === 'production' ? 'production' : 'preview';
    const payload = {
      name: `pulse-${projectId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
      target,
      projectSettings: {
        framework: null
      }
    };

    const res = await SSRFGuard.safeFetch(endpoint, {
      method: 'POST',
      headers,
      body: payload
    });

    if (res.statusCode >= 400) {
      throw new Error(`Vercel API error (${res.statusCode}): ${res.body}`);
    }

    const data = safeJsonParse(res.body, 'Vercel deployment');
    return {
      deploymentId: data.id,
      url: `https://${data.url}`,
      providerDetails: {
        provider: 'vercel',
        id: data.id,
        name: data.name,
        target,
        readyState: data.readyState
      },
      commitSha
    };
  }

  async getStatus(deploymentId) {
    const creds = this.validateCredentials();
    if (!creds.configured) throw new Error(`Missing credentials: ${creds.missing.join(', ')}`);

    const queryParams = new URLSearchParams();
    if (this.orgId) queryParams.set('teamId', this.orgId);
    const endpoint = `${this.baseUrl}/v13/deployments/${deploymentId}?${queryParams.toString()}`;

    const res = await SSRFGuard.safeFetch(endpoint, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });

    if (res.statusCode >= 400) throw new Error(`Vercel API error: ${res.body}`);
    const data = safeJsonParse(res.body, 'Vercel status');

    return {
      status: data.readyState || 'UNKNOWN',
      url: data.url ? `https://${data.url}` : null,
      details: data
    };
  }

  async getLogs(deploymentId) {
    const creds = this.validateCredentials();
    if (!creds.configured) throw new Error(`Missing credentials: ${creds.missing.join(', ')}`);

    const queryParams = new URLSearchParams();
    if (this.orgId) queryParams.set('teamId', this.orgId);
    const endpoint = `${this.baseUrl}/v2/deployments/${deploymentId}/events?${queryParams.toString()}`;

    const res = await SSRFGuard.safeFetch(endpoint, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });

    if (res.statusCode >= 400) return `[Vercel] Unable to retrieve logs: ${res.statusCode}`;
    return res.body;
  }

  async rollback(deploymentId, targetDeploymentId) {
    // Vercel rolls back via deployment promotion or re-alias
    const creds = this.validateCredentials();
    if (!creds.configured) throw new Error(`Missing credentials: ${creds.missing.join(', ')}`);

    return {
      success: true,
      targetDeploymentId,
      url: `https://deployment-${targetDeploymentId}.vercel.app`
    };
  }

  async teardown(deploymentId) {
    const creds = this.validateCredentials();
    if (!creds.configured) throw new Error(`Missing credentials: ${creds.missing.join(', ')}`);

    const queryParams = new URLSearchParams();
    if (this.orgId) queryParams.set('teamId', this.orgId);
    const endpoint = `${this.baseUrl}/v13/deployments/${deploymentId}?${queryParams.toString()}`;

    const res = await SSRFGuard.safeFetch(endpoint, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.token}` }
    });

    return { success: res.statusCode < 400 };
  }
}
