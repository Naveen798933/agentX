import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { telemetry } from '../observability/telemetry.js';
import { rootLogger } from '../observability/logger.js';

export class QuotaExceededError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'QuotaExceededError';
    this.details = details;
    this.statusCode = 429;
  }
}

export const PlanTiers = {
  FREE: 'FREE',
  PRO: 'PRO',
  ENTERPRISE: 'ENTERPRISE'
};

export const DEFAULT_PLAN_LIMITS = {
  FREE: {
    maxDailyGenerations: 10,
    maxConcurrentJobs: 1,
    maxStorageBytes: 100 * 1024 * 1024, // 100 MB
    maxDailyDeployments: 5,
    maxTokensPerMonth: 100_000
  },
  PRO: {
    maxDailyGenerations: 100,
    maxConcurrentJobs: 5,
    maxStorageBytes: 5 * 1024 * 1024 * 1024, // 5 GB
    maxDailyDeployments: 50,
    maxTokensPerMonth: 2_000_000
  },
  ENTERPRISE: {
    maxDailyGenerations: 1000,
    maxConcurrentJobs: 20,
    maxStorageBytes: 50 * 1024 * 1024 * 1024, // 50 GB
    maxDailyDeployments: 500,
    maxTokensPerMonth: 50_000_000
  }
};

/**
 * UsageMeter
 * Enforces per-tenant and per-user limits across generation, concurrency, storage, and deployments.
 * Records usage events with idempotency keys and provides usage reconciliation.
 */
export class UsageMeter {
  /**
   * @param {Object} options
   * @param {import('../storage/db.js').StorageEngine} options.storage
   * @param {Object} [options.customLimits] - Overrides for plan limits
   * @param {string} [options.workspacesDir]
   */
  constructor(options = {}) {
    this.storage = options.storage;
    this.customLimits = options.customLimits || {};
    this.workspacesDir = options.workspacesDir || path.resolve('data/workspaces');
    this.logger = options.logger || rootLogger.child({ service: 'usage-meter' });
  }

  _getStartOfTodayIso() {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  }

  _getStartOfMonthIso() {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  }

  /**
   * Determine the effective plan tier for a tenant
   */
  async getTenantPlan(tenantId) {
    if (!tenantId) return PlanTiers.FREE;

    // Check active server-verified subscription first
    const sub = await this.storage.getTenantSubscription(tenantId);
    if (sub && (sub.status === 'active' || sub.status === 'trialing')) {
      const planKey = (sub.plan || 'FREE').toUpperCase();
      if (PlanTiers[planKey]) return planKey;
    }

    // Fall back to tenant record in database
    const tenant = this.storage.getTenantById ? await this.storage.getTenantById(tenantId) : null;
    if (tenant && tenant.plan) {
      const planKey = tenant.plan.toUpperCase();
      if (PlanTiers[planKey]) return planKey;
    }

    return PlanTiers.FREE;
  }

  /**
   * Get plan limits with any configured custom overrides
   */
  async getLimitsForTenant(tenantId) {
    const plan = await this.getTenantPlan(tenantId);
    const defaults = DEFAULT_PLAN_LIMITS[plan] || DEFAULT_PLAN_LIMITS.FREE;
    const overrides = this.customLimits[tenantId] || this.customLimits[plan] || {};
    return { plan, limits: { ...defaults, ...overrides } };
  }

  /**
   * Check if a requested action stays within quota.
   * Throws QuotaExceededError if limit is breached.
   *
   * @param {string} tenantId
   * @param {'generation'|'concurrency'|'storage'|'deployment'|'tokens'} limitType
   * @param {number} [requestedAmount=1]
   */
  async checkLimit(tenantId, limitType, requestedAmount = 1) {
    const { plan, limits } = await this.getLimitsForTenant(tenantId);
    const startOfToday = this._getStartOfTodayIso();
    const startOfMonth = this._getStartOfMonthIso();

    switch (limitType) {
      case 'generation': {
        const summary = await this.storage.getUsageSummary(tenantId, { since: startOfToday });
        const currentDailyGens = (summary.byType?.GENERATION_JOB?.eventCount || 0) +
                                 (summary.byType?.LLM_GENERATION?.eventCount || 0);
        if (currentDailyGens + requestedAmount > limits.maxDailyGenerations) {
          throw new QuotaExceededError(
            `Daily generation limit reached for plan ${plan}. (${currentDailyGens}/${limits.maxDailyGenerations})`,
            { tenantId, plan, limitType, currentUsage: currentDailyGens, requestedAmount, limit: limits.maxDailyGenerations }
          );
        }
        break;
      }

      case 'concurrency': {
        // Count active generation jobs in RUNNING state
        let activeJobs = 0;
        if (this.storage.isPostgres) {
          const res = await this.storage.query(
            `SELECT COUNT(*) as count FROM generation_jobs WHERE tenant_id = $1 AND status = 'RUNNING'`,
            [tenantId]
          );
          activeJobs = parseInt(res.rows[0]?.count || 0, 10);
        } else if (this.storage.db) {
          const row = this.storage.db.prepare(
            `SELECT COUNT(*) as count FROM generation_jobs WHERE tenant_id = ? AND status = 'RUNNING'`
          ).get(tenantId);
          activeJobs = row?.count || 0;
        }

        telemetry.setConcurrentJobs(tenantId, activeJobs);

        if (activeJobs + requestedAmount > limits.maxConcurrentJobs) {
          throw new QuotaExceededError(
            `Concurrent execution limit reached for plan ${plan}. Active: ${activeJobs}, Max: ${limits.maxConcurrentJobs}`,
            { tenantId, plan, limitType, currentUsage: activeJobs, requestedAmount, limit: limits.maxConcurrentJobs }
          );
        }
        break;
      }

      case 'storage': {
        // Sum total stored artifact bytes
        let currentStorageBytes = 0;
        if (this.storage.isPostgres) {
          const res = await this.storage.query(
            `SELECT COALESCE(SUM(file_size_bytes), 0) as total FROM generated_artifacts WHERE tenant_id = $1 AND deleted_at IS NULL`,
            [tenantId]
          );
          currentStorageBytes = parseInt(res.rows[0]?.total || 0, 10);
        } else if (this.storage.db) {
          const row = this.storage.db.prepare(
            `SELECT COALESCE(SUM(file_size_bytes), 0) as total FROM generated_artifacts WHERE tenant_id = ? AND deleted_at IS NULL`
          ).get(tenantId);
          currentStorageBytes = row?.total || 0;
        }

        if (currentStorageBytes + requestedAmount > limits.maxStorageBytes) {
          throw new QuotaExceededError(
            `Storage limit exceeded for plan ${plan}. Current: ${(currentStorageBytes / (1024*1024)).toFixed(2)} MB, Limit: ${(limits.maxStorageBytes / (1024*1024)).toFixed(2)} MB`,
            { tenantId, plan, limitType, currentUsage: currentStorageBytes, requestedAmount, limit: limits.maxStorageBytes }
          );
        }
        break;
      }

      case 'deployment': {
        // Daily deployments count
        let dailyDeployments = 0;
        if (this.storage.isPostgres) {
          const res = await this.storage.query(
            `SELECT COUNT(*) as count FROM project_deployments WHERE tenant_id = $1 AND created_at >= $2`,
            [tenantId, startOfToday]
          );
          dailyDeployments = parseInt(res.rows[0]?.count || 0, 10);
        } else if (this.storage.db) {
          const row = this.storage.db.prepare(
            `SELECT COUNT(*) as count FROM project_deployments WHERE tenant_id = ? AND created_at >= ?`
          ).get(tenantId, startOfToday);
          dailyDeployments = row?.count || 0;
        }

        if (dailyDeployments + requestedAmount > limits.maxDailyDeployments) {
          throw new QuotaExceededError(
            `Daily deployment limit reached for plan ${plan}. (${dailyDeployments}/${limits.maxDailyDeployments})`,
            { tenantId, plan, limitType, currentUsage: dailyDeployments, requestedAmount, limit: limits.maxDailyDeployments }
          );
        }
        break;
      }

      case 'tokens': {
        const summary = await this.storage.getUsageSummary(tenantId, { since: startOfMonth });
        const monthlyTokens = summary.byType?.LLM_TOKENS?.totalQuantity || 0;
        if (monthlyTokens + requestedAmount > limits.maxTokensPerMonth) {
          throw new QuotaExceededError(
            `Monthly LLM token quota reached for plan ${plan}. (${monthlyTokens.toLocaleString()}/${limits.maxTokensPerMonth.toLocaleString()})`,
            { tenantId, plan, limitType, currentUsage: monthlyTokens, requestedAmount, limit: limits.maxTokensPerMonth }
          );
        }
        break;
      }

      default:
        break;
    }

    return true;
  }

  /**
   * Record a usage event with idempotency protection.
   * If the idempotencyKey has already been processed, it returns the existing record
   * without duplicating usage totals or billing metrics.
   */
  async recordUsage({
    tenantId = 'tenant-default',
    userId = null,
    projectId = null,
    eventType,
    quantity = 1,
    unit = 'COUNT',
    idempotencyKey = null,
    metadata = null
  }) {
    if (!eventType) throw new Error('eventType is required');

    const result = await this.storage.recordUsageEvent({
      tenantId,
      userId,
      projectId,
      eventType,
      quantity,
      unit,
      idempotencyKey,
      metadata
    });

    if (result.isDuplicate) {
      this.logger.debug('Duplicate usage event skipped by idempotency key', {
        idempotencyKey,
        tenantId,
        eventType
      });
      return { recorded: false, duplicate: true, event: result.event };
    }

    // Telemetry metric count
    telemetry.recordUsageEventMetric({ tenantId, eventType });

    this.logger.info('Usage event recorded', {
      tenantId,
      eventType,
      quantity,
      unit,
      idempotencyKey
    });

    return { recorded: true, duplicate: false, event: result.event };
  }

  /**
   * Query complete usage metrics and limits for user/tenant dashboard
   */
  async getUsageAndLimits(tenantId = 'tenant-default') {
    const { plan, limits } = await this.getLimitsForTenant(tenantId);
    const startOfToday = this._getStartOfTodayIso();
    const startOfMonth = this._getStartOfMonthIso();

    const todaySummary = await this.storage.getUsageSummary(tenantId, { since: startOfToday });
    const monthSummary = await this.storage.getUsageSummary(tenantId, { since: startOfMonth });

    // Active concurrent jobs
    let concurrentJobs = 0;
    if (this.storage.isPostgres) {
      const res = await this.storage.query(
        `SELECT COUNT(*) as count FROM generation_jobs WHERE tenant_id = $1 AND status = 'RUNNING'`,
        [tenantId]
      );
      concurrentJobs = parseInt(res.rows[0]?.count || 0, 10);
    } else if (this.storage.db) {
      const row = this.storage.db.prepare(
        `SELECT COUNT(*) as count FROM generation_jobs WHERE tenant_id = ? AND status = 'RUNNING'`
      ).get(tenantId);
      concurrentJobs = row?.count || 0;
    }

    // Storage bytes
    let storageBytes = 0;
    if (this.storage.isPostgres) {
      const res = await this.storage.query(
        `SELECT COALESCE(SUM(file_size_bytes), 0) as total FROM generated_artifacts WHERE tenant_id = $1 AND deleted_at IS NULL`,
        [tenantId]
      );
      storageBytes = parseInt(res.rows[0]?.total || 0, 10);
    } else if (this.storage.db) {
      const row = this.storage.db.prepare(
        `SELECT COALESCE(SUM(file_size_bytes), 0) as total FROM generated_artifacts WHERE tenant_id = ? AND deleted_at IS NULL`
      ).get(tenantId);
      storageBytes = row?.total || 0;
    }

    // Daily Deployments
    let dailyDeployments = 0;
    if (this.storage.isPostgres) {
      const res = await this.storage.query(
        `SELECT COUNT(*) as count FROM project_deployments WHERE tenant_id = $1 AND created_at >= $2`,
        [tenantId, startOfToday]
      );
      dailyDeployments = parseInt(res.rows[0]?.count || 0, 10);
    } else if (this.storage.db) {
      const row = this.storage.db.prepare(
        `SELECT COUNT(*) as count FROM project_deployments WHERE tenant_id = ? AND created_at >= ?`
      ).get(tenantId, startOfToday);
      dailyDeployments = row?.count || 0;
    }

    const dailyGenerations = (todaySummary.byType?.GENERATION_JOB?.eventCount || 0) +
                             (todaySummary.byType?.LLM_GENERATION?.eventCount || 0);

    const monthlyTokens = monthSummary.byType?.LLM_TOKENS?.totalQuantity || 0;

    const sub = await this.storage.getTenantSubscription(tenantId);

    return {
      tenantId,
      plan,
      subscription: {
        status: sub?.status || 'none',
        provider: sub?.provider || 'none',
        currentPeriodEnd: sub?.current_period_end || null,
        cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end)
      },
      limits,
      currentUsage: {
        dailyGenerations,
        concurrentJobs,
        storageBytes,
        storageFormatted: `${(storageBytes / (1024 * 1024)).toFixed(2)} MB`,
        dailyDeployments,
        monthlyTokens
      },
      percentUsed: {
        dailyGenerations: Number(((dailyGenerations / limits.maxDailyGenerations) * 100).toFixed(1)),
        concurrentJobs: Number(((concurrentJobs / limits.maxConcurrentJobs) * 100).toFixed(1)),
        storageBytes: Number(((storageBytes / limits.maxStorageBytes) * 100).toFixed(1)),
        dailyDeployments: Number(((dailyDeployments / limits.maxDailyDeployments) * 100).toFixed(1)),
        monthlyTokens: Number(((monthlyTokens / limits.maxTokensPerMonth) * 100).toFixed(1))
      }
    };
  }

  /**
   * Reconcile recorded usage against actual database and filesystem artifacts
   */
  async reconcileUsage(tenantId = 'tenant-default') {
    const discrepancies = [];

    // Reconcile Storage
    let dbStorage = 0;
    if (this.storage.isPostgres) {
      const res = await this.storage.query(
        `SELECT COALESCE(SUM(file_size_bytes), 0) as total FROM generated_artifacts WHERE tenant_id = $1 AND deleted_at IS NULL`,
        [tenantId]
      );
      dbStorage = parseInt(res.rows[0]?.total || 0, 10);
    } else if (this.storage.db) {
      const row = this.storage.db.prepare(
        `SELECT COALESCE(SUM(file_size_bytes), 0) as total FROM generated_artifacts WHERE tenant_id = ? AND deleted_at IS NULL`
      ).get(tenantId);
      dbStorage = row?.total || 0;
    }

    // Storage summary events
    const storageSummary = await this.storage.getUsageSummary(tenantId);
    const recordedStorageEventBytes = storageSummary.byType?.STORAGE_BYTES?.totalQuantity || 0;

    // Check if recorded events deviate significantly from current active artifacts
    if (recordedStorageEventBytes > 0 && Math.abs(recordedStorageEventBytes - dbStorage) > 1024 * 1024) {
      discrepancies.push({
        metric: 'storage',
        dbValue: dbStorage,
        recordedUsageEvents: recordedStorageEventBytes,
        diffBytes: Math.abs(recordedStorageEventBytes - dbStorage)
      });
    }

    return {
      tenantId,
      timestamp: new Date().toISOString(),
      status: discrepancies.length === 0 ? 'IN_SYNC' : 'DISCREPANCY_DETECTED',
      discrepancies,
      reconciledTotals: {
        activeStorageBytes: dbStorage
      }
    };
  }
}
