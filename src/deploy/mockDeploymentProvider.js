import crypto from 'node:crypto';
import { DeploymentProvider } from './deploymentProvider.js';

export class MockDeploymentProvider extends DeploymentProvider {
  constructor(config = {}) {
    super('mock', config);
    this.deployments = new Map();
    this.simulateBuildFailure = config.simulateBuildFailure || false;
    this.simulateDeployError = config.simulateDeployError || false;
    this.simulateUnavailable = config.simulateUnavailable || false;
    this.mockDomain = config.mockDomain || 'pulse-deploy.net';
  }

  validateCredentials() {
    if (this.simulateUnavailable) {
      return {
        configured: false,
        missing: ['MOCK_API_KEY'],
        checklist: ['Set MOCK_API_KEY=mock-key-12345 in your environment']
      };
    }
    return {
      configured: true,
      missing: [],
      checklist: ['Mock provider is fully configured for testing']
    };
  }

  getSetupChecklist() {
    return {
      provider: 'mock',
      docsUrl: 'https://docs.pulse-workspace.dev/providers/mock',
      requiredEnvVars: [
        {
          key: 'MOCK_API_KEY',
          description: 'Deterministic test token for isolated deployment testing',
          permissions: 'Full test access'
        }
      ],
      setupSteps: [
        '1. Ensure MOCK_API_KEY is present in environment or config',
        '2. No external network credentials required'
      ]
    };
  }

  async build(projectDir, options = {}) {
    if (this.simulateUnavailable) {
      throw new Error('Mock provider unavailable: upstream service outage');
    }
    if (this.simulateBuildFailure) {
      const logs = [
        '[MockBuild] Starting project artifact compilation...',
        '[MockBuild] Resolving dependencies...',
        '[MockBuild] ERROR: Syntax error in project source: Unexpected token',
        '[MockBuild] Build exited with status code 1'
      ].join('\n');
      return { success: false, buildLogs: logs, error: 'Simulated build failure' };
    }

    const logs = [
      '[MockBuild] Validating workspace structure...',
      '[MockBuild] Checking dependency graph & client bundles...',
      '[MockBuild] Compilation successful. Zero security violations.',
      '[MockBuild] Bundle output ready for release distribution.'
    ].join('\n');

    return { success: true, buildLogs: logs, artifacts: ['dist/bundle.js', 'dist/index.html'] };
  }

  async deploy({ projectId, projectDir, environment = 'preview', envVars = {}, commitSha = null, metadata = {}, deploymentId = null }) {
    if (this.simulateUnavailable) {
      throw new Error('Mock provider API unreachable: 503 Service Unavailable');
    }
    if (this.simulateDeployError) {
      throw new Error('Mock provider deployment rejected: Insufficient provider quota or network failure');
    }

    const effectiveId = deploymentId || `dep_mock_${crypto.randomUUID().slice(0, 8)}`;
    const slug = projectId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const url = environment === 'production'
      ? `https://${slug}.${this.mockDomain}`
      : `https://${slug}-${environment}-${effectiveId.slice(-4)}.${this.mockDomain}`;

    const record = {
      deploymentId: effectiveId,
      projectId,
      environment,
      status: 'DEPLOYED',
      url,
      commitSha: commitSha || crypto.randomBytes(8).toString('hex'),
      envVars,
      metadata,
      logs: [
        `[MockDeploy] Initiating deployment for project "${projectId}" to ${environment}...`,
        `[MockDeploy] Uploading build artifacts to ${this.mockDomain}...`,
        `[MockDeploy] Release published successfully at ${url}`,
        `[MockDeploy] Health probe verified: HTTP 200 OK`
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.deployments.set(effectiveId, record);

    return {
      deploymentId: effectiveId,
      url,
      providerDetails: {
        provider: 'mock',
        domain: this.mockDomain,
        environment,
        deployedAt: record.createdAt
      },
      commitSha: record.commitSha
    };
  }

  async getStatus(deploymentId) {
    if (this.simulateUnavailable) {
      throw new Error('Mock provider API unreachable');
    }
    const record = this.deployments.get(deploymentId);
    if (!record) {
      throw new Error(`Deployment "${deploymentId}" not found in mock provider ledger`);
    }
    return {
      status: record.status,
      url: record.url,
      details: {
        environment: record.environment,
        commitSha: record.commitSha,
        updatedAt: record.updatedAt
      }
    };
  }

  async getLogs(deploymentId) {
    const record = this.deployments.get(deploymentId);
    if (!record) {
      throw new Error(`Deployment "${deploymentId}" not found in mock provider ledger`);
    }
    return record.logs;
  }

  async rollback(deploymentId, targetDeploymentId) {
    const current = this.deployments.get(deploymentId);
    const target = this.deployments.get(targetDeploymentId);

    if (!target) {
      throw new Error(`Rollback target deployment "${targetDeploymentId}" not found`);
    }

    const newDepId = `dep_mock_rb_${crypto.randomUUID().slice(0, 8)}`;
    const rollbackRecord = {
      deploymentId: newDepId,
      projectId: target.projectId,
      environment: target.environment,
      status: 'DEPLOYED',
      url: target.url,
      commitSha: target.commitSha,
      rollbackFrom: deploymentId,
      logs: [
        `[MockDeploy] Rolling back deployment "${deploymentId}" to commit ${target.commitSha}...`,
        `[MockDeploy] Target release restored at ${target.url}`
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (current) {
      current.status = 'ROLLED_BACK';
      current.updatedAt = new Date().toISOString();
    }

    this.deployments.set(newDepId, rollbackRecord);

    return {
      success: true,
      deploymentId: newDepId,
      targetDeploymentId,
      url: target.url,
      commitSha: target.commitSha
    };
  }

  async teardown(deploymentId) {
    const record = this.deployments.get(deploymentId);
    if (!record) {
      return { success: true, alreadyRemoved: true };
    }
    record.status = 'TERMINATED';
    record.updatedAt = new Date().toISOString();
    this.deployments.delete(deploymentId);
    return { success: true, deploymentId };
  }
}
