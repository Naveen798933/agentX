import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { GatedActions, ApprovalRequiredError, ApprovalRejectedError } from '../approval/approvalManager.js';
import { SSRFGuard, DependencyGuard } from './ssrfGuard.js';
import { SecretManager } from './secretManager.js';
import { MockDeploymentProvider } from './mockDeploymentProvider.js';
import { CloudflarePagesProvider } from './cloudflarePagesProvider.js';
import { VercelDeploymentProvider } from './vercelDeploymentProvider.js';

export class QuotaExceededError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'QuotaExceededError';
    this.details = details;
  }
}

export const PLAN_DEPLOYMENT_QUOTAS = {
  free: 5,        // 5 deployments per day
  starter: 15,
  pro: 50,
  enterprise: 500
};

export class DeploymentManager {
  /**
   * @param {Object} deps
   * @param {import('../storage/db.js').StorageEngine} deps.storage
   * @param {import('../sandbox/sandboxExecutor.js').SandboxExecutor} deps.sandbox
   * @param {import('../approval/approvalManager.js').ApprovalManager} deps.approvalManager
   * @param {import('../core/eventBus.js').EventBus} deps.eventBus
   * @param {Object} [options]
   */
  constructor({ storage, sandbox, approvalManager, eventBus }, options = {}) {
    this.storage = storage;
    this.sandbox = sandbox;
    this.approvalManager = approvalManager;
    this.eventBus = eventBus;
    this.defaultProviderName = options.defaultProvider || 'mock';

    // Provider registry
    this.providers = new Map();
    this.registerProvider(new MockDeploymentProvider(options.mockConfig || {}));
    this.registerProvider(new CloudflarePagesProvider(options.cloudflareConfig || {}));
    this.registerProvider(new VercelDeploymentProvider(options.vercelConfig || {}));
  }

  /**
   * Register a new deployment provider
   */
  registerProvider(provider) {
    this.providers.set(provider.getName(), provider);
  }

  /**
   * Get provider by name or fallback to default
   */
  getProvider(name = null) {
    const targetName = name || this.defaultProviderName;
    const provider = this.providers.get(targetName);
    if (!provider) {
      throw new Error(`Deployment provider "${targetName}" is not registered. Available: ${Array.from(this.providers.keys()).join(', ')}`);
    }
    return provider;
  }

  /**
   * List all registered providers and their configuration readiness
   */
  listProviders() {
    return Array.from(this.providers.values()).map(provider => {
      const creds = provider.validateCredentials();
      const checklist = provider.getSetupChecklist();
      return {
        name: provider.getName(),
        configured: creds.configured,
        missing: creds.missing,
        docsUrl: checklist.docsUrl,
        requiredEnvVars: checklist.requiredEnvVars
      };
    });
  }

  /**
   * Get setup checklist for a specific provider
   */
  getSetupChecklist(providerName) {
    const provider = this.getProvider(providerName);
    return provider.getSetupChecklist();
  }

  /**
   * Enforce tenant daily deployment quota
   */
  async checkTenantQuota(tenantId) {
    const tenant = this.storage.getTenantById ? this.storage.getTenantById(tenantId) : (this.storage.getTenant ? this.storage.getTenant(tenantId) : null);
    const plan = (tenant?.plan || 'pro').toLowerCase();
    const quota = PLAN_DEPLOYMENT_QUOTAS[plan] || PLAN_DEPLOYMENT_QUOTAS.pro;

    // Count deployments created by tenant in the last 24 hours
    const deployments = this.storage.listDeployments ? this.storage.listDeployments(null, tenantId) : [];
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentCount = deployments.filter(d => new Date(d.created_at).getTime() > oneDayAgo).length;

    if (recentCount >= quota) {
      throw new QuotaExceededError(
        `Deployment quota exceeded for tenant plan "${plan}". Limit is ${quota} deployments/24h (Used: ${recentCount}). Upgrade plan to deploy more.`,
        { plan, quota, recentCount }
      );
    }
    return { plan, quota, remaining: quota - recentCount };
  }

  /**
   * Initiate and execute the complete deployment workflow
   */
  async deployProject({
    projectId,
    tenantId = 'tenant-default',
    providerName = null,
    environment = 'preview',
    envVars = {},
    commitSha = null,
    approvalId = null,
    operatorId = null,
    metadata = {}
  }) {
    // 1. Verify project existence and tenant ownership
    const project = this.storage.getProject(projectId);
    if (!project) {
      throw new Error(`Project "${projectId}" not found`);
    }
    if (tenantId && project.tenant_id && project.tenant_id !== tenantId) {
      throw new Error(`Forbidden: Tenant "${tenantId}" is not authorized to deploy project "${projectId}"`);
    }

    // 2. Enforce tenant quota & resource budget
    await this.checkTenantQuota(tenantId);

    const provider = this.getProvider(providerName);

    // 3. Verify provider credentials
    const credStatus = provider.validateCredentials();
    if (!credStatus.configured) {
      const checklist = provider.getSetupChecklist();
      throw new Error(
        `Provider "${provider.getName()}" is not configured: missing [${credStatus.missing.join(', ')}]. ` +
        `Setup checklist available at: ${checklist.docsUrl}`
      );
    }

    // 4. Production Gated Approval: Require explicit user confirmation before deploying to production
    const isProduction = environment === 'production';
    if (isProduction) {
      if (!approvalId) {
        // Create pending approval request in ApprovalManager
        const approval = this.approvalManager.requestApproval({
          projectId,
          actionType: GatedActions.PRODUCTION_DEPLOYMENT,
          riskLevel: 'HIGH',
          reason: `Production cloud deployment for "${project.name}" on ${provider.getName()} requires explicit operator authorization.`,
          payload: JSON.stringify({
            projectId,
            provider: provider.getName(),
            environment,
            commitSha
          }),
          requestedBy: operatorId || 'DEPLOYMENT_ENGINE'
        });

        // Record initial pending deployment in database
        const depRecord = this.storage.createDeployment({
          tenant_id: tenantId,
          project_id: projectId,
          provider: provider.getName(),
          environment,
          status: 'PENDING_APPROVAL',
          approval_id: approval.id,
          commit_sha: commitSha,
          env_vars: envVars,
          metadata
        });

        throw new ApprovalRequiredError(
          `Production deployment requires explicit confirmation. Approval request created with ID: ${approval.id}`,
          { approvalId: approval.id, deploymentId: depRecord.id, status: 'PENDING_APPROVAL' }
        );
      }

      // Verify provided approval is approved
      const approval = this.approvalManager.getApproval(approvalId);
      if (approval.status !== 'APPROVED') {
        throw new ApprovalRejectedError(
          `Cannot proceed with production deployment: approval "${approvalId}" is in status "${approval.status}".`,
          { approvalId, status: approval.status }
        );
      }
    }

    // 5. Create active deployment record in DB
    const deploymentRecord = this.storage.createDeployment({
      tenant_id: tenantId,
      project_id: projectId,
      provider: provider.getName(),
      environment,
      status: 'BUILDING',
      approval_id: approvalId,
      approved_by: operatorId || (approvalId ? 'OPERATOR' : null),
      commit_sha: commitSha,
      env_vars: envVars,
      metadata
    });

    const projectDir = this.sandbox.getProjectWorkspace(projectId);

    try {
      // 6. Security Checks & Sandbox Pre-flight
      // 6a. Check project dependencies
      const pkgPath = path.join(projectDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkgContent = fs.readFileSync(pkgPath, 'utf8');
        const depCheck = DependencyGuard.scanPackageJson(pkgContent);
        if (!depCheck.safe) {
          throw new Error(`Deployment pre-flight rejected: ${depCheck.errors.join('; ')}`);
        }
      }

      // 6b. Partition environment variables & ensure server secrets NEVER leak into frontend bundles
      const { clientSafe, serverSecrets } = SecretManager.partitionEnvVars(envVars);
      SecretManager.assertFrontendSafety(projectDir, serverSecrets);

      // 7. Sandbox Build & Compilation via Provider
      this.storage.updateDeploymentStatus(deploymentRecord.id, {
        status: 'BUILDING',
        build_logs: `[Build] Building project "${projectId}" inside secure sandbox...\n`
      }, tenantId);

      const buildResult = await provider.build(projectDir, { environment, envVars: clientSafe });
      if (!buildResult.success) {
        throw new Error(buildResult.error || 'Project build failed during sandbox compilation');
      }

      // 8. Dispatch Deployment to Provider
      this.storage.updateDeploymentStatus(deploymentRecord.id, {
        status: 'DEPLOYING',
        build_logs: (buildResult.buildLogs || '') + `\n[Deploy] Uploading artifacts to ${provider.getName()}...`
      }, tenantId);

      const deployResult = await provider.deploy({
        projectId,
        projectDir,
        environment,
        envVars: clientSafe,
        commitSha,
        metadata,
        deploymentId: deploymentRecord.id
      });

      // 9. Post-Deployment Health Check Verification
      const isHealthy = await this._verifyHealthCheck(deployResult.url);
      if (!isHealthy) {
        throw new Error(`Deployment health verification failed: endpoint "${deployResult.url}" did not respond with HTTP 200/300`);
      }

      // 10. Update deployment record as successfully DEPLOYED
      const updated = this.storage.updateDeploymentStatus(deploymentRecord.id, {
        status: 'DEPLOYED',
        target_url: deployResult.url,
        commit_sha: deployResult.commitSha || commitSha,
        build_logs: (buildResult.buildLogs || '') + `\n[Success] Verified healthy release at ${deployResult.url}`
      }, tenantId);

      this.eventBus.publish('deployment.completed', {
        projectId,
        deploymentId: updated.id,
        environment,
        url: updated.target_url
      });

      return updated;
    } catch (err) {
      // Record failure in DB
      this.storage.updateDeploymentStatus(deploymentRecord.id, {
        status: 'FAILED',
        error_message: err.message,
        build_logs: `[Error] Deployment failed: ${err.message}`
      }, tenantId);

      this.eventBus.publish('deployment.failed', {
        projectId,
        deploymentId: deploymentRecord.id,
        error: err.message
      });

      throw err;
    }
  }

  /**
   * Verify deployment health via HTTP GET
   */
  async _verifyHealthCheck(url, timeoutMs = 5000) {
    if (!url) return false;
    // For mock URLs or simulated domains
    if (url.includes('pulse-deploy.net') || url.includes('.mock')) {
      return true;
    }
    try {
      const res = await SSRFGuard.safeFetch(url, { timeout: timeoutMs });
      return res.statusCode >= 200 && res.statusCode < 400;
    } catch (_) {
      return false;
    }
  }

  /**
   * Rollback an active deployment to a previous target deployment
   */
  async rollbackDeployment(deploymentId, targetDeploymentId, tenantId = 'tenant-default') {
    const current = this.storage.getDeployment(deploymentId, tenantId);
    if (!current) {
      throw new Error(`Current deployment "${deploymentId}" not found`);
    }

    const target = this.storage.getDeployment(targetDeploymentId, tenantId);
    if (!target) {
      throw new Error(`Target rollback deployment "${targetDeploymentId}" not found`);
    }

    if (current.project_id !== target.project_id) {
      throw new Error('Rollback target must belong to the same project');
    }

    const provider = this.getProvider(current.provider);
    const rollbackResult = await provider.rollback(deploymentId, targetDeploymentId);

    // Create a new rollback deployment record
    const rollbackRecord = this.storage.createDeployment({
      tenant_id: tenantId,
      project_id: current.project_id,
      provider: current.provider,
      environment: current.environment,
      status: 'DEPLOYED',
      target_url: rollbackResult.url || target.target_url,
      commit_sha: target.commit_sha,
      rollback_target_id: targetDeploymentId,
      build_logs: `[Rollback] Restored previous release candidate "${targetDeploymentId}" (${target.commit_sha})`
    });

    // Mark current as ROLLED_BACK
    this.storage.updateDeploymentStatus(deploymentId, {
      status: 'ROLLED_BACK'
    }, tenantId);

    this.eventBus.publish('deployment.rolled_back', {
      projectId: current.project_id,
      fromDeploymentId: deploymentId,
      toDeploymentId: targetDeploymentId,
      newDeploymentId: rollbackRecord.id
    });

    return rollbackRecord;
  }

  /**
   * Teardown and delete deployment from provider
   */
  async teardownDeployment(deploymentId, tenantId = 'tenant-default') {
    const deployment = this.storage.getDeployment(deploymentId, tenantId);
    if (!deployment) {
      throw new Error(`Deployment "${deploymentId}" not found`);
    }

    const provider = this.getProvider(deployment.provider);
    await provider.teardown(deploymentId);

    const updated = this.storage.updateDeploymentStatus(deploymentId, {
      status: 'TERMINATED',
      build_logs: (deployment.build_logs || '') + '\n[Teardown] Deployment resources terminated.'
    }, tenantId);

    this.eventBus.publish('deployment.terminated', {
      projectId: deployment.project_id,
      deploymentId
    });

    return updated;
  }
}
