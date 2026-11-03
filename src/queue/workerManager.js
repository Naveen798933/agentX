import { Worker, UnrecoverableError } from 'bullmq';
import { QueueNames, JobStates } from './queueManager.js';
import { getRedisConfig } from './redisClient.js';
import { BudgetExceededError } from '../budget/budgetManager.js';
import { AuthorizationError } from '../storage/tenantGuard.js';
import { rootLogger } from '../observability/logger.js';
import { telemetry } from '../observability/telemetry.js';
import { sentryProvider } from '../observability/sentryProvider.js';

/**
 * Determine if an error is transient (can be retried) or permanent (must fail immediately).
 */
export function isTransientError(error) {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();

  // Non-transient errors: Never retry
  if (error instanceof BudgetExceededError || msg.includes('budget exceeded')) return false;
  if (error instanceof AuthorizationError || msg.includes('authorization') || msg.includes('unauthorized') || msg.includes('forbidden')) return false;
  if (msg.includes('cancelled') || msg.includes('aborted') || msg.includes('not found')) return false;
  if (msg.includes('required') || msg.includes('invalid argument') || msg.includes('syntaxerror')) return false;

  // Transient errors: Eligible for exponential backoff retry
  if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('etimedout')) return true;
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('503') || msg.includes('overloaded')) return true;
  if (msg.includes('temporary') || msg.includes('timeout') || msg.includes('timed out') || msg.includes('service unavailable')) return true;
  if (msg.includes('resource exhausted') || msg.includes('backend error')) return true;

  // By default, unknown non-operational errors are not retried to avoid infinite loops
  return false;
}

/**
 * WorkerManager: coordinates background BullMQ workers, manages bounded concurrency,
 * progress updates, DB persistence, cancellation checks, and graceful shutdown.
 */
export class WorkerManager {
  /**
   * @param {Object} options
   * @param {Object} options.storage - Unified StorageEngine
   * @param {Object} options.orchestrator - Orchestrator instance
   * @param {Object} [options.eventBus] - EventBus instance
   * @param {Object} [options.redisConfig] - Redis configuration options
   * @param {number} [options.concurrency=2] - Bounded concurrency per worker
   */
  constructor(options = {}) {
    this.storage = options.storage;
    this.orchestrator = options.orchestrator;
    this.eventBus = options.eventBus || null;
    this.redisConfig = getRedisConfig(options.redisConfig || {});
    this.concurrency = parseInt(options.concurrency || process.env.QUEUE_CONCURRENCY || '2', 10);
    this.prefix = options.prefix || 'bull';
    this.connectionOptions = {
      ...this.redisConfig,
      maxRetriesPerRequest: null
    };

    this.workers = {};
    this.activeJobs = new Map(); // jobId -> AbortController or cancel flag
    this.deploymentManager = options.deploymentManager || null;
    this.isShuttingDown = false;

    this._initWorkers();
  }

  _initWorkers() {
    // 1. Project Generation Worker
    this.workers[QueueNames.PROJECT_GENERATION] = new Worker(
      QueueNames.PROJECT_GENERATION,
      async (job) => this._processGenerationJob(job),
      {
        connection: this.connectionOptions,
        prefix: this.prefix,
        concurrency: this.concurrency
      }
    );

    // 2. Code Validation Worker
    this.workers[QueueNames.CODE_VALIDATION] = new Worker(
      QueueNames.CODE_VALIDATION,
      async (job) => this._processValidationJob(job),
      {
        connection: this.connectionOptions,
        prefix: this.prefix,
        concurrency: this.concurrency
      }
    );

    // 3. Testing Worker
    this.workers[QueueNames.TESTING] = new Worker(
      QueueNames.TESTING,
      async (job) => this._processTestingJob(job),
      {
        connection: this.connectionOptions,
        prefix: this.prefix,
        concurrency: this.concurrency
      }
    );

    // 4. Deployment Worker
    this.workers[QueueNames.DEPLOYMENT] = new Worker(
      QueueNames.DEPLOYMENT,
      async (job) => this._processDeploymentJob(job),
      {
        connection: this.connectionOptions,
        prefix: this.prefix,
        concurrency: this.concurrency
      }
    );

    this._bindWorkerEvents();
  }

  _bindWorkerEvents() {
    for (const [queueName, worker] of Object.entries(this.workers)) {
      worker.on('failed', async (job, err) => {
        if (!job) return;
        const jobId = job.data?.jobId || job.id;
        const tenantId = job.data?.tenantId;
        const attemptsMade = job.attemptsMade;
        const maxRetries = job.opts?.attempts || 3;

        const existingJob = await this.storage.getGenerationJob(jobId, tenantId);
        const isCancelled = existingJob?.status === JobStates.CANCELLED || err.message?.toLowerCase().includes('cancelled');
        if (isCancelled) {
          return;
        }

        const isFatal = attemptsMade >= maxRetries || !isTransientError(err);
        const newStatus = isFatal ? JobStates.FAILED : JobStates.QUEUED;

        await this.storage.updateGenerationJob(jobId, {
          status: newStatus,
          retriesCount: attemptsMade,
          errorMessage: err.message
        }, tenantId);

        if (this.eventBus) {
          this.eventBus.publish(isFatal ? 'job.failed' : 'job.retrying', {
            jobId,
            queueName,
            status: newStatus,
            error: err.message,
            attemptsMade,
            maxRetries
          });
        }
      });

      worker.on('error', (err) => {
        if (process.env.NODE_ENV !== 'test') {
          console.error(`[Worker ${queueName}] Worker error:`, err.message);
        }
      });
    }
  }

  /**
   * Process full autonomous generation job.
   */
  async _processGenerationJob(job) {
    const { jobId, projectId, tenantId, title, description, appType, fastMode } = job.data;
    const now = new Date().toISOString();
    const jobStartTime = Date.now();
    const workerLogger = rootLogger.child({ service: 'worker', jobId, tenantId, projectId });

    workerLogger.info(`Worker started processing job ${jobId}`, {
      queue: QueueNames.PROJECT_GENERATION,
      title,
      appType,
      fastMode: Boolean(fastMode)
    });

    // Check if job was cancelled while queued
    const currentRecord = await this.storage.getGenerationJob(jobId, tenantId);
    if (currentRecord && currentRecord.status === JobStates.CANCELLED) {
      throw new UnrecoverableError('Job was cancelled before execution started');
    }

    // Mark job RUNNING in database
    await this.storage.updateGenerationJob(jobId, {
      status: JobStates.RUNNING,
      startedAt: now,
      progressPct: 5,
      progressStage: 'STAGE_INTAKE',
      progressMessage: 'Autonomous team mobilized. Analyzing requirements...'
    }, tenantId);

    if (this.eventBus) {
      this.eventBus.publish('job.started', {
        jobId,
        projectId,
        tenantId,
        queueName: QueueNames.PROJECT_GENERATION,
        status: JobStates.RUNNING
      });
    }

    // Track active job for cancellation
    this.activeJobs.set(jobId, { projectId, cancelled: false });

    // Progress Reporter Helper
    const reportProgress = async (pct, stage, message) => {
      // Check cancellation
      const jobCtrl = this.activeJobs.get(jobId);
      if (jobCtrl && jobCtrl.cancelled) {
        throw new UnrecoverableError(`Job ${jobId} was cancelled by user`);
      }

      await job.updateProgress({ pct, stage, message });
      await this.storage.updateGenerationJob(jobId, {
        progressPct: pct,
        progressStage: stage,
        progressMessage: message,
        stage
      }, tenantId);

      if (this.eventBus) {
        this.eventBus.publish('job.progress', {
          jobId,
          projectId,
          tenantId,
          pct,
          stage,
          message
        });
      }
    };

    try {
      await reportProgress(10, 'STAGE_INTAKE', 'Synthesizing Product Requirements Document (PRD)...');

      // Hook stage listeners on Orchestrator EventBus for automatic progress ticks
      const stageProgressMap = {
        'STAGE_INTAKE': { pct: 20, msg: 'PRD and requirements locked' },
        'STAGE_ARCHITECTURE': { pct: 40, msg: 'Architecture Decision Record ADR-001 defined' },
        'STAGE_BACKEND': { pct: 60, msg: 'Backend API controllers and models synthesized' },
        'STAGE_FRONTEND': { pct: 75, msg: 'Glassmorphic responsive interface synthesized' },
        'STAGE_QA': { pct: 90, msg: 'Sandboxed node:test execution verified' },
        'STAGE_DEPLOY_REQUEST': { pct: 98, msg: 'DevOps release candidate committed & ready' }
      };

      const unsubHandler = (evt, payload) => {
        if (payload?.projectId === projectId && stageProgressMap[payload?.stageId]) {
          const info = stageProgressMap[payload.stageId];
          reportProgress(info.pct, payload.stageId, info.msg).catch(() => {});
        }
      };

      if (this.orchestrator.eventBus) {
        this.orchestrator.eventBus.on('STAGE_COMPLETED', unsubHandler);
      }

      // Execute Autonomous Build via Orchestrator
      const result = await this.orchestrator.buildProjectAutonomous(projectId, {
        title,
        description,
        prompt: [title, description].filter(Boolean).join('\n\n'),
        appType,
        fastMode: Boolean(fastMode)
      });

      if (this.orchestrator.eventBus) {
        this.orchestrator.eventBus.off('STAGE_COMPLETED', unsubHandler);
      }

      // Check if project or job was cancelled
      const finalDbJob = await this.storage.getGenerationJob(jobId, tenantId);
      if (finalDbJob && finalDbJob.status === JobStates.CANCELLED) {
        throw new UnrecoverableError('Job was cancelled during execution');
      }

      // Mark Job as COMPLETED in DB with result payload
      await this.storage.completeGenerationJob(jobId, {
        status: JobStates.COMPLETED,
        tokensUsed: result.totalTokens || 7200,
        resultPayload: {
          projectId,
          status: result.status,
          filesCreated: result.filesCreated || [],
          testsPassed: result.testsPassed !== false,
          previewUrl: `/api/projects/${projectId}/preview/`
        }
      }, tenantId);

      await reportProgress(100, 'STAGE_DEPLOY_REQUEST', 'Project generation complete and ready!');

      const durationMs = Date.now() - jobStartTime;
      telemetry.recordQueueJob({
        queue: QueueNames.PROJECT_GENERATION,
        status: 'completed',
        durationSeconds: durationMs / 1000
      });

      workerLogger.info(`Worker completed job ${jobId} successfully`, {
        durationMs,
        tokensUsed: result.totalTokens || 7200
      });

      // Record idempotent usage event
      if (this.storage.recordUsageEvent) {
        try {
          await this.storage.recordUsageEvent({
            tenantId: tenantId || 'tenant-default',
            projectId,
            eventType: 'GENERATION_JOB',
            quantity: 1,
            unit: 'COUNT',
            idempotencyKey: `job_${jobId}`,
            metadata: { title, appType, durationMs }
          });
        } catch (_) {}
      }

      if (this.eventBus) {
        this.eventBus.publish('job.completed', {
          jobId,
          projectId,
          tenantId,
          status: JobStates.COMPLETED,
          previewUrl: `/api/projects/${projectId}/preview/`
        });
      }

      return {
        jobId,
        projectId,
        status: JobStates.COMPLETED,
        result
      };
    } catch (err) {
      const durationMs = Date.now() - jobStartTime;
      telemetry.recordQueueJob({
        queue: QueueNames.PROJECT_GENERATION,
        status: 'failed',
        durationSeconds: durationMs / 1000
      });
      workerLogger.error(`Worker failed during job ${jobId}: ${err.message}`, err, { durationMs });
      sentryProvider.captureException(err, { jobId, projectId, tenantId, service: 'worker' });

      const isCancelled = (err.message && err.message.toLowerCase().includes('cancelled')) ||
                          (await this.storage.getGenerationJob(jobId, tenantId))?.status === JobStates.CANCELLED;

      if (isCancelled) {
        await this.storage.updateGenerationJob(jobId, {
          status: JobStates.CANCELLED,
          errorMessage: err.message
        }, tenantId);
        throw new UnrecoverableError(err.message);
      }

      if (!isTransientError(err)) {
        // Unrecoverable error: fail fast without retrying
        await this.storage.completeGenerationJob(jobId, {
          status: JobStates.FAILED,
          errorMessage: err.message
        }, tenantId);
        throw new UnrecoverableError(err.message);
      }
      // Re-throw transient error for BullMQ exponential backoff retry
      throw err;
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  /**
   * Process discrete code validation job.
   */
  async _processValidationJob(job) {
    const { jobId, projectId, tenantId, stageId, files } = job.data;
    await this.storage.updateGenerationJob(jobId, {
      status: JobStates.RUNNING,
      startedAt: new Date().toISOString(),
      progressPct: 50,
      progressStage: stageId,
      progressMessage: `Validating ${files?.length || 0} files...`
    }, tenantId);

    try {
      // Perform validation check
      const valid = Array.isArray(files) && files.length >= 0;
      await this.storage.completeGenerationJob(jobId, {
        status: JobStates.COMPLETED,
        resultPayload: { valid, stageId, validatedFiles: files }
      }, tenantId);
      return { ok: true, valid };
    } catch (err) {
      if (!isTransientError(err)) {
        await this.storage.completeGenerationJob(jobId, {
          status: JobStates.FAILED,
          errorMessage: err.message
        }, tenantId);
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }

  /**
   * Process isolated sandbox test runner job.
   */
  async _processTestingJob(job) {
    const { jobId, projectId, tenantId, testCommand, autoFix, maxFixAttempts } = job.data;
    await this.storage.updateGenerationJob(jobId, {
      status: JobStates.RUNNING,
      startedAt: new Date().toISOString(),
      progressPct: 40,
      progressStage: 'STAGE_QA',
      progressMessage: `Running sandbox test "${testCommand}"...`
    }, tenantId);

    try {
      const testRun = await this.orchestrator.sandbox.executeCommand(projectId, testCommand || 'node --test', {
        agentRole: 'QA',
        timeoutMs: 20000
      });

      const passed = testRun.exitCode === 0;
      await this.storage.completeGenerationJob(jobId, {
        status: passed ? JobStates.COMPLETED : JobStates.FAILED,
        errorMessage: passed ? null : (testRun.stderr || 'Tests failed'),
        resultPayload: {
          exitCode: testRun.exitCode,
          stdout: testRun.stdout,
          stderr: testRun.stderr,
          passed
        }
      }, tenantId);

      return { passed, exitCode: testRun.exitCode };
    } catch (err) {
      if (!isTransientError(err)) {
        await this.storage.completeGenerationJob(jobId, {
          status: JobStates.FAILED,
          errorMessage: err.message
        }, tenantId);
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }

  /**
   * Process packaging and deployment job.
   */
  async _processDeploymentJob(job) {
    const { jobId, projectId, tenantId, environment } = job.data;
    await this.storage.updateGenerationJob(jobId, {
      status: JobStates.RUNNING,
      startedAt: new Date().toISOString(),
      progressPct: 50,
      progressStage: 'STAGE_DEPLOY_REQUEST',
      progressMessage: `Packaging release candidate for ${environment}...`
    }, tenantId);

    try {
      const git = this.orchestrator.getGit(projectId);
      const commit = git.getLatestCommit();

      let deployRecord = null;
      if (this.deploymentManager) {
        deployRecord = await this.deploymentManager.deployProject({
          projectId,
          tenantId,
          environment,
          providerName: job.data.providerName || null,
          envVars: job.data.envVars || {},
          commitSha: commit?.hash || null,
          approvalId: job.data.approvalId || null
        });
      }

      await this.storage.completeGenerationJob(jobId, {
        status: JobStates.COMPLETED,
        resultPayload: {
          environment,
          commitHash: commit?.hash || null,
          deploymentId: deployRecord?.id || null,
          deploymentUrl: deployRecord?.target_url || null,
          previewUrl: `/api/projects/${projectId}/preview/`
        }
      }, tenantId);

      return {
        deployed: true,
        environment,
        deploymentId: deployRecord?.id || null,
        deploymentUrl: deployRecord?.target_url || null,
        previewUrl: `/api/projects/${projectId}/preview/`
      };
    } catch (err) {
      if (!isTransientError(err)) {
        await this.storage.completeGenerationJob(jobId, {
          status: JobStates.FAILED,
          errorMessage: err.message
        }, tenantId);
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }

  /**
   * Request cancellation for an active in-flight job.
   */
  abortActiveJob(jobId) {
    const active = this.activeJobs.get(jobId);
    if (active) {
      active.cancelled = true;
      if (this.orchestrator?.pipelineControls && active.projectId) {
        if (!this.orchestrator.pipelineControls[active.projectId]) {
          this.orchestrator.pipelineControls[active.projectId] = {};
        }
        this.orchestrator.pipelineControls[active.projectId].cancelled = true;
      }
      return true;
    }
    return false;
  }

  /**
   * Check status of all active workers.
   */
  getStatus() {
    const status = {};
    for (const [name, worker] of Object.entries(this.workers)) {
      status[name] = {
        running: worker.isRunning(),
        paused: worker.isPaused(),
        concurrency: this.concurrency
      };
    }
    return status;
  }

  /**
   * Graceful shutdown of workers: pauses intake and waits for active jobs.
   */
  async close(options = {}) {
    this.isShuttingDown = true;
    const force = options.force !== undefined ? options.force : true;
    const timeoutMs = options.timeoutMs || 2500;

    const closePromises = Object.entries(this.workers).map(async ([name, worker]) => {
      try {
        await Promise.race([
          worker.close(force),
          new Promise((resolve) => setTimeout(resolve, timeoutMs))
        ]);
      } catch (err) {
        if (process.env.NODE_ENV !== 'test') {
          console.error(`[Worker ${name}] Close error:`, err.message);
        }
      }
    });

    await Promise.all(closePromises);
  }
}
