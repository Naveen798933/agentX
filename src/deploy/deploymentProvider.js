/**
 * DeploymentProvider Base Interface
 * Pluggable abstraction for multi-cloud deployment providers.
 */
export class DeploymentProvider {
  /**
   * @param {string} name - Unique provider identifier (e.g. 'mock', 'cloudflare-pages', 'vercel')
   * @param {Object} [config] - Provider-specific configuration and credentials
   */
  constructor(name, config = {}) {
    if (!name) throw new Error('Provider name is required');
    this.name = name;
    this.config = config;
  }

  getName() {
    return this.name;
  }

  /**
   * Validate provider credentials and return configuration status
   * @returns {{ configured: boolean, missing: string[], checklist: string[] }}
   */
  validateCredentials() {
    throw new Error(`validateCredentials() not implemented in ${this.constructor.name}`);
  }

  /**
   * Return clear, actionable setup instructions and least-privilege token requirements
   * @returns {{ provider: string, docsUrl: string, requiredEnvVars: Array<{ key: string, description: string, permissions: string }>, setupSteps: string[] }}
   */
  getSetupChecklist() {
    throw new Error(`getSetupChecklist() not implemented in ${this.constructor.name}`);
  }

  /**
   * Validate and build project code in the sandbox prior to deployment
   * @param {string} projectDir - Absolute directory to project workspace
   * @param {Object} [options]
   * @returns {Promise<{ success: boolean, buildLogs: string, artifacts?: string[] }>}
   */
  async build(projectDir, options = {}) {
    throw new Error(`build() not implemented in ${this.constructor.name}`);
  }

  /**
   * Deploy project release bundle to target cloud host
   * @param {Object} params
   * @param {string} params.projectId
   * @param {string} params.projectDir
   * @param {string} params.environment - 'preview' | 'staging' | 'production'
   * @param {Object} [params.envVars]
   * @param {string} [params.commitSha]
   * @param {Object} [params.metadata]
   * @returns {Promise<{ deploymentId: string, url: string, providerDetails: Object, commitSha?: string }>}
   */
  async deploy(params) {
    throw new Error(`deploy() not implemented in ${this.constructor.name}`);
  }

  /**
   * Query deployment status from provider API
   * @param {string} deploymentId
   * @returns {Promise<{ status: string, url?: string, details?: Object }>}
   */
  async getStatus(deploymentId) {
    throw new Error(`getStatus() not implemented in ${this.constructor.name}`);
  }

  /**
   * Fetch build/deployment logs from provider API
   * @param {string} deploymentId
   * @returns {Promise<Array<string>|string>}
   */
  async getLogs(deploymentId) {
    throw new Error(`getLogs() not implemented in ${this.constructor.name}`);
  }

  /**
   * Rollback active deployment to a previous target deployment
   * @param {string} deploymentId
   * @param {string} targetDeploymentId
   * @returns {Promise<{ success: boolean, targetDeploymentId: string, url: string }>}
   */
  async rollback(deploymentId, targetDeploymentId) {
    throw new Error(`rollback() not implemented in ${this.constructor.name}`);
  }

  /**
   * Teardown and delete deployment from provider
   * @param {string} deploymentId
   * @returns {Promise<{ success: boolean }>}
   */
  async teardown(deploymentId) {
    throw new Error(`teardown() not implemented in ${this.constructor.name}`);
  }
}
