import { Queue } from 'bullmq';
import crypto from 'node:crypto';
import { createRedisClient, getRedisConfig, checkRedisHealth, sanitizeRedisConfig } from './redisClient.js';

export const QueueNames = {
  PROJECT_GENERATION: 'project-generation',
  CODE_VALIDATION: 'code-validation',
  TESTING: 'testing',
  DEPLOYMENT: 'deployment'
};

export const JobStates = {
  QUEUED: 'QUEUED',
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
};

/**
 * QueueManager: centralized coordinator for BullMQ queues, job dispatching,
 * idempotency enforcement, state queries, cancellation, and metrics.
 */
export class QueueManager {
  /**
   * @param {Object} options
   * @param {Object} options.storage - Unified StorageEngine (PostgreSQL/SQLite)
   * @param {Object} [options.eventBus] - EventBus instance
   * @param {Object} [options.redisConfig] - Custom Redis configuration or connection
   * @param {number} [options.defaultTimeoutMs=120000]
   */
  constructor(options = {}) {
    this.storage = options.storage;
    this.eventBus = options.eventBus || null;
    this.redisConfig = getRedisConfig(options.redisConfig || {});
    this.defaultTimeoutMs = options.defaultTimeoutMs || 120000;
    this.prefix = options.prefix || 'bull';
    this.redisClient = options.redisClient || createRedisClient(this.redisConfig);

    // BullMQ shared connection options
    this.connectionOptions = {
      ...this.redisConfig,
      maxRetriesPerRequest: null
    };

    this.queues = {};
    this._initQueues();
  }

  _initQueues() {
    for (const [key, queueName] of Object.entries(QueueNames)) {
      this.queues[queueName] = new Queue(queueName, {
        connection: this.connectionOptions,
        prefix: this.prefix,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000
          },
          removeOnComplete: { age: 3600, count: 500 },
          removeOnFail: { age: 86400, count: 1000 }
        }
      });
    }
  }

  /**
   * Drain and remove all jobs across all managed queues.
   */
  async obliterate() {
    for (const queue of Object.values(this.queues)) {
      try {
        await queue.obliterate({ force: true });
      } catch (err) {
        // Ignore if already empty or closed
      }
    }
  }

  getQueue(queueName) {
    const queue = this.queues[queueName];
    if (!queue) throw new Error(`Unknown queue: ${queueName}`);
    return queue;
  }

  /**
   * Enqueue a full autonomous project generation job with idempotency guard.
   */
  async enqueueGeneration({
    projectId,
    tenantId = 'tenant-default',
    createdBy = null,
    title,
    description = '',
    appType = 'Auto-Detect',
    fastMode = false,
    maxRetries = 3,
    budgetTokens = 120000,
    budgetUsd = 15.0,
    idempotencyKey = null
  }) {
    // 1. Idempotency Check
    if (idempotencyKey) {
      const existing = await this.storage.getGenerationJobByIdempotencyKey(idempotencyKey, tenantId);
      if (existing) {
        // Return existing job if active, queued, or successfully completed
        if ([JobStates.QUEUED, JobStates.RUNNING, JobStates.COMPLETED].includes(existing.status)) {
          return {
            job: existing,
            deduplicated: true,
            status: existing.status
          };
        }
      }
    }

    const jobId = `job-${crypto.randomUUID().slice(0, 10)}`;
    const fullPrompt = [title, description].filter(Boolean).join('\n\n');

    // 2. Persist Initial State in PostgreSQL/SQLite Database
    const dbJob = await this.storage.createGenerationJob({
      id: jobId,
      tenantId,
      projectId,
      queueName: QueueNames.PROJECT_GENERATION,
      stage: 'STAGE_INTAKE',
      status: JobStates.QUEUED,
      instruction: fullPrompt,
      idempotencyKey,
      createdBy,
      maxRetries,
      progressPct: 0,
      progressStage: 'STAGE_INTAKE',
      progressMessage: 'Job queued for background autonomous processing'
    });

    // 3. Add to BullMQ Queue
    const queue = this.getQueue(QueueNames.PROJECT_GENERATION);
    const bullJob = await queue.add(
      'buildProjectAutonomous',
      {
        jobId,
        projectId,
        tenantId,
        createdBy,
        title,
        description,
        appType,
        fastMode: Boolean(fastMode),
        budgetTokens,
        budgetUsd,
        idempotencyKey
      },
      {
        jobId,
        attempts: maxRetries,
        backoff: { type: 'exponential', delay: 1000 }
      }
    );

    await this.storage.updateGenerationJob(jobId, { bullmqJobId: bullJob.id }, tenantId);

    if (this.eventBus) {
      this.eventBus.publish('job.queued', {
        jobId,
        projectId,
        tenantId,
        queueName: QueueNames.PROJECT_GENERATION,
        status: JobStates.QUEUED
      });
    }

    return {
      job: { ...dbJob, bullmq_job_id: bullJob.id },
      deduplicated: false,
      status: JobStates.QUEUED
    };
  }

  /**
   * Enqueue a discrete code validation job.
   */
  async enqueueValidation({
    projectId,
    tenantId = 'tenant-default',
    createdBy = null,
    stageId = 'STAGE_ARCHITECTURE',
    files = [],
    idempotencyKey = null
  }) {
    const jobId = `val-${crypto.randomUUID().slice(0, 10)}`;
    const dbJob = await this.storage.createGenerationJob({
      id: jobId,
      tenantId,
      projectId,
      queueName: QueueNames.CODE_VALIDATION,
      stage: stageId,
      status: JobStates.QUEUED,
      instruction: `Validate code artifacts for ${stageId}`,
      idempotencyKey,
      createdBy
    });

    const queue = this.getQueue(QueueNames.CODE_VALIDATION);
    const bullJob = await queue.add('validateCode', {
      jobId, projectId, tenantId, createdBy, stageId, files
    }, { jobId });

    await this.storage.updateGenerationJob(jobId, { bullmqJobId: bullJob.id }, tenantId);
    return { job: dbJob, bullmqJobId: bullJob.id, status: JobStates.QUEUED };
  }

  /**
   * Enqueue a sandboxed test suite run.
   */
  async enqueueTesting({
    projectId,
    tenantId = 'tenant-default',
    createdBy = null,
    testCommand = 'node --test',
    autoFix = true,
    maxFixAttempts = 2,
    idempotencyKey = null
  }) {
    const jobId = `test-${crypto.randomUUID().slice(0, 10)}`;
    const dbJob = await this.storage.createGenerationJob({
      id: jobId,
      tenantId,
      projectId,
      queueName: QueueNames.TESTING,
      stage: 'STAGE_QA',
      status: JobStates.QUEUED,
      instruction: `Execute sandboxed test suite "${testCommand}"`,
      idempotencyKey,
      createdBy
    });

    const queue = this.getQueue(QueueNames.TESTING);
    const bullJob = await queue.add('runTests', {
      jobId, projectId, tenantId, createdBy, testCommand, autoFix, maxFixAttempts
    }, { jobId });

    await this.storage.updateGenerationJob(jobId, { bullmqJobId: bullJob.id }, tenantId);
    return { job: dbJob, bullmqJobId: bullJob.id, status: JobStates.QUEUED };
  }

  /**
   * Enqueue a deployment / packaging job.
   */
  async enqueueDeployment({
    projectId,
    tenantId = 'tenant-default',
    createdBy = null,
    environment = 'PREVIEW',
    idempotencyKey = null
  }) {
    const jobId = `dep-${crypto.randomUUID().slice(0, 10)}`;
    const dbJob = await this.storage.createGenerationJob({
      id: jobId,
      tenantId,
      projectId,
      queueName: QueueNames.DEPLOYMENT,
      stage: 'STAGE_DEPLOY_REQUEST',
      status: JobStates.QUEUED,
      instruction: `Deploy project to ${environment}`,
      idempotencyKey,
      createdBy
    });

    const queue = this.getQueue(QueueNames.DEPLOYMENT);
    const bullJob = await queue.add('deployProject', {
      jobId, projectId, tenantId, createdBy, environment
    }, { jobId });

    await this.storage.updateGenerationJob(jobId, { bullmqJobId: bullJob.id }, tenantId);
    return { job: dbJob, bullmqJobId: bullJob.id, status: JobStates.QUEUED };
  }

  /**
   * Query unified job status (combining durable DB record and live BullMQ state).
   */
  async getJobStatus(jobId, tenantId = null) {
    const dbJob = await this.storage.getGenerationJob(jobId, tenantId);
    if (!dbJob) return null;

    let liveState = null;
    let liveProgress = null;

    try {
      const queue = this.queues[dbJob.queue_name || QueueNames.PROJECT_GENERATION];
      if (queue) {
        const bullJob = await queue.getJob(dbJob.bullmq_job_id || jobId);
        if (bullJob) {
          liveState = await bullJob.getState();
          liveProgress = bullJob.progress;
        }
      }
    } catch (_) {}

    return {
      id: dbJob.id,
      projectId: dbJob.project_id,
      tenantId: dbJob.tenant_id,
      queueName: dbJob.queue_name,
      bullmqJobId: dbJob.bullmq_job_id,
      status: dbJob.status,
      liveState,
      stage: dbJob.stage,
      progressPct: dbJob.progress_pct ?? 0,
      progressStage: dbJob.progress_stage,
      progressMessage: dbJob.progress_message,
      tokensUsed: dbJob.tokens_used ?? 0,
      modelUsed: dbJob.model_used,
      retriesCount: dbJob.retries_count ?? 0,
      maxRetries: dbJob.max_retries ?? 3,
      errorMessage: dbJob.error_message,
      cancelledAt: dbJob.cancelled_at,
      startedAt: dbJob.started_at,
      completedAt: dbJob.completed_at,
      resultPayload: dbJob.resultPayload || null,
      createdAt: dbJob.created_at,
      updatedAt: dbJob.updated_at
    };
  }

  /**
   * Abort and cancel a pending or running job.
   */
  async cancelJob(jobId, reason = 'Aborted by user', tenantId = null) {
    const dbJob = await this.storage.getGenerationJob(jobId, tenantId);
    if (!dbJob) return null;

    const now = new Date().toISOString();
    const updated = await this.storage.updateGenerationJob(jobId, {
      status: JobStates.CANCELLED,
      cancelledAt: now,
      errorMessage: reason
    }, tenantId);

    // Try to remove or discard from BullMQ queue
    try {
      const queue = this.queues[dbJob.queue_name || QueueNames.PROJECT_GENERATION];
      if (queue) {
        const bullJob = await queue.getJob(dbJob.bullmq_job_id || jobId);
        if (bullJob) {
          const state = await bullJob.getState();
          if (state === 'waiting' || state === 'delayed') {
            await bullJob.remove();
          } else if (state === 'active') {
            await bullJob.discard();
          }
        }
      }
    } catch (_) {}

    if (this.eventBus) {
      this.eventBus.publish('job.cancelled', {
        jobId,
        projectId: dbJob.project_id,
        tenantId: dbJob.tenant_id,
        reason
      });
    }

    return updated;
  }

  /**
   * Health check for Redis and queues.
   */
  async getHealth() {
    const redisHealth = await checkRedisHealth(this.redisClient);
    const queueMetrics = await this.getQueueMetrics();

    const isHealthy = redisHealth.ok;
    return {
      status: isHealthy ? 'HEALTHY' : 'UNHEALTHY',
      redis: {
        ...redisHealth,
        config: sanitizeRedisConfig(this.redisConfig)
      },
      queues: queueMetrics
    };
  }

  /**
   * Retrieve job counts for all registered queues.
   */
  async getQueueMetrics() {
    const metrics = {};
    for (const [name, queue] of Object.entries(this.queues)) {
      try {
        const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
        metrics[name] = counts;
      } catch (err) {
        metrics[name] = { error: err.message };
      }
    }
    return metrics;
  }

  /**
   * Check for interrupted jobs left in RUNNING/ACTIVE state after crash/restart
   * and apply recovery policy.
   */
  async recoverInterruptedJobs() {
    const interrupted = await this.storage.getInterruptedGenerationJobs();
    const recovered = [];

    for (const job of interrupted) {
      const currentRetries = (job.retries_count || 0) + 1;
      const maxRetries = job.max_retries || 3;

      if (currentRetries <= maxRetries) {
        // Re-enqueue job
        await this.storage.updateGenerationJob(job.id, {
          status: JobStates.QUEUED,
          retriesCount: currentRetries,
          progressMessage: `Recovered from server restart (attempt ${currentRetries}/${maxRetries})`
        });

        try {
          const queue = this.getQueue(job.queue_name || QueueNames.PROJECT_GENERATION);
          await queue.add('recoverInterrupted', {
            jobId: job.id,
            projectId: job.project_id,
            tenantId: job.tenant_id,
            prompt: job.instruction
          }, {
            jobId: `${job.id}-retry-${currentRetries}`
          });
          recovered.push({ id: job.id, action: 'RE_ENQUEUED', attempt: currentRetries });
        } catch (err) {
          recovered.push({ id: job.id, action: 'ERROR', error: err.message });
        }
      } else {
        // Exceeded max retries, mark as failed
        await this.storage.updateGenerationJob(job.id, {
          status: JobStates.FAILED,
          errorMessage: 'Job interrupted by unexpected server restart and exceeded max recovery attempts'
        });
        recovered.push({ id: job.id, action: 'FAILED_EXCEEDED_RETRIES' });
      }
    }

    return recovered;
  }

  /**
   * Gracefully close all BullMQ queues and Redis connections.
   */
  async close() {
    for (const queue of Object.values(this.queues)) {
      try { await queue.close(); } catch (_) {}
    }
    try { this.redisClient.disconnect(); } catch (_) {}
  }
}
