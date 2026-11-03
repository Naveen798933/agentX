import { telemetry } from '../observability/telemetry.js';

export class BudgetExceededError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BudgetExceededError';
    this.details = details;
  }
}

export class BudgetManager {
  /**
   * @param {import('../storage/db.js').StorageEngine} storage
   * @param {Object} options
   */
  constructor(storage, options = {}) {
    this.storage = storage;
    this.costPer1kTokens = options.costPer1kTokens || 0.002; // Standard LLM blended rate ($0.002 per 1k)
    this.usageMeter = options.usageMeter || null;
  }

  /**
   * Compute USD cost from token quantity
   */
  tokensToUsd(tokens) {
    return Number(((tokens / 1000) * this.costPer1kTokens).toFixed(4));
  }

  /**
   * Compute token equivalent from USD
   */
  usdToTokens(usd) {
    return Math.floor((usd / this.costPer1kTokens) * 1000);
  }

  /**
   * Checks if the project has enough remaining tokens for an estimated cost
   */
  canAfford(projectId, estimatedTokens) {
    const project = this.storage.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }
    const remaining = project.budget_tokens - project.spent_tokens;
    return remaining >= estimatedTokens;
  }

  /**
   * Record token consumption for a project and task.
   * Throws BudgetExceededError if the request breaches the allocated budget.
   */
  recordUsage(projectId, { taskId = null, agentRole = 'SYSTEM', tokens = 0, purpose = 'Agent inference' }) {
    if (tokens < 0) {
      throw new Error('Tokens used must be a positive integer');
    }

    const project = this.storage.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const remaining = project.budget_tokens - project.spent_tokens;

    // Perform atomic deduction in SQLite to prevent concurrency races
    const deducted = this.storage.deductTokensAtomically(projectId, tokens);

    if (!deducted) {
      // Mark project as BUDGET_EXCEEDED
      this.storage.updateProject(projectId, { status: 'BUDGET_EXCEEDED' });
      this.storage.logAuditEvent(
        projectId,
        agentRole,
        'BUDGET_HALT',
        `Attempted to use ${tokens} tokens with only ${remaining} remaining. Total budget: ${project.budget_tokens}. Hard-stop triggered.`
      );

      throw new BudgetExceededError(
        `Budget exceeded for project ${projectId}. Remaining: ${remaining} tokens, requested: ${tokens} tokens.`,
        {
          projectId,
          taskId,
          budgetTokens: project.budget_tokens,
          spentTokens: project.spent_tokens,
          requestedTokens: tokens,
          shortfall: (project.spent_tokens + tokens) - project.budget_tokens
        }
      );
    }

    const updatedProject = this.storage.getProject(projectId);
    const projectedSpent = updatedProject.spent_tokens;

    // Update task tokens if provided
    if (taskId) {
      const task = this.storage.getTask(taskId);
      if (task) {
        this.storage.updateTask(taskId, {
          tokens_used: task.tokens_used + tokens
        });
      }
    }

    // Log audit event
    this.storage.logAuditEvent(
      projectId,
      agentRole,
      'TOKEN_USAGE',
      `Consumed ${tokens} tokens for "${purpose}". Progress: ${projectedSpent}/${project.budget_tokens} (${Math.round((projectedSpent / project.budget_tokens) * 100)}%)`
    );

    // Record OpenTelemetry metrics
    telemetry.recordLlmGeneration({
      tenantId: project.tenant_id || 'tenant-default',
      model: agentRole,
      totalTokens: tokens
    });

    // Record usage event with idempotency protection
    if (this.usageMeter) {
      this.usageMeter.recordUsage({
        tenantId: project.tenant_id || 'tenant-default',
        projectId,
        eventType: 'LLM_TOKENS',
        quantity: tokens,
        unit: 'TOKENS',
        metadata: { agentRole, taskId, purpose }
      }).catch(() => {});
    } else if (this.storage.recordUsageEvent) {
      try {
        this.storage.recordUsageEvent({
          tenantId: project.tenant_id || 'tenant-default',
          projectId,
          eventType: 'LLM_TOKENS',
          quantity: tokens,
          unit: 'TOKENS',
          metadata: { agentRole, taskId, purpose }
        });
      } catch (_) {}
    }

    return {
      projectId,
      tokensUsed: tokens,
      totalSpent: projectedSpent,
      remainingTokens: project.budget_tokens - projectedSpent,
      usdSpent: this.tokensToUsd(projectedSpent)
    };
  }

  /**
   * Retrieve budget summary for reporting and dashboard
   */
  getBudgetSummary(projectId) {
    const project = this.storage.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const spent = project.spent_tokens;
    const total = project.budget_tokens;
    const remaining = Math.max(0, total - spent);
    const percentUsed = total > 0 ? Math.min(100, Math.round((spent / total) * 100)) : 100;

    return {
      projectId,
      name: project.name,
      status: project.status,
      budgetTokens: total,
      spentTokens: spent,
      remainingTokens: remaining,
      percentUsed,
      budgetUsd: project.budget_usd,
      spentUsd: this.tokensToUsd(spent),
      isExceeded: spent >= total || project.status === 'BUDGET_EXCEEDED'
    };
  }

  /**
   * Safe budget increase (Must be authorized or called via ApprovalManager)
   */
  applyApprovedBudgetIncrease(projectId, additionalTokens, authorizedBy = 'OPERATOR') {
    const project = this.storage.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const newBudgetTokens = project.budget_tokens + additionalTokens;
    const newBudgetUsd = project.budget_usd + this.tokensToUsd(additionalTokens);

    const newStatus = project.status === 'BUDGET_EXCEEDED' ? 'IN_PROGRESS' : project.status;

    this.storage.updateProject(projectId, {
      budget_tokens: newBudgetTokens,
      budget_usd: newBudgetUsd,
      status: newStatus
    });

    this.storage.logAuditEvent(
      projectId,
      'FINANCE',
      'BUDGET_INCREASED',
      `Budget increased by ${additionalTokens} tokens ($${this.tokensToUsd(additionalTokens)}) by ${authorizedBy}. New total: ${newBudgetTokens} tokens.`
    );

    return this.getBudgetSummary(projectId);
  }
}
