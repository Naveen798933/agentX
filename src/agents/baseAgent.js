import crypto from 'node:crypto';

export class BaseAgent {
  /**
   * @param {Object} config
   * @param {string} config.role - Agent role name
   * @param {string} config.name - Display name
   * @param {string} config.systemPrompt - Role definition
   * @param {import('../storage/db.js').StorageEngine} config.storage
   * @param {import('../budget/budgetManager.js').BudgetManager} config.budgetManager
   * @param {import('../sandbox/sandboxExecutor.js').SandboxExecutor} [config.sandbox]
   * @param {import('../approval/approvalManager.js').ApprovalManager} [config.approvalManager]
   */
  constructor({ role, name, systemPrompt, storage, budgetManager, sandbox = null, approvalManager = null }) {
    this.role = role;
    this.name = name;
    this.systemPrompt = systemPrompt;
    this.storage = storage;
    this.budgetManager = budgetManager;
    this.sandbox = sandbox;
    this.approvalManager = approvalManager;
  }

  /**
   * Approximate token count from text (heuristic: ~4 chars per token)
   */
  estimateTokens(text = '') {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
  }

  /**
   * Meter tokens and log agent activity
   */
  meterTokens(projectId, taskId, tokens, purpose) {
    if (this.budgetManager) {
      return this.budgetManager.recordUsage(projectId, {
        taskId,
        agentRole: this.role,
        tokens,
        purpose
      });
    }
    return null;
  }

  /**
   * Emit audit log
   */
  log(projectId, eventType, details) {
    if (this.storage) {
      this.storage.logAuditEvent(projectId, this.role, eventType, details);
    }
  }

  /**
   * Base task runner
   */
  async processTask(projectId, task, input = {}) {
    this.log(projectId, 'TASK_STARTED', `Agent ${this.name} (${this.role}) started processing task: ${task.title}`);

    // Pre-flight budget check for estimated base inference
    const estimatedTokens = 500;
    if (this.budgetManager && !this.budgetManager.canAfford(projectId, estimatedTokens)) {
      throw new Error(`Insufficient budget for agent ${this.role} to proceed with task ${task.id}`);
    }

    // Agent execution hook
    const result = await this.execute(projectId, task, input);

    // Record token usage
    const tokensConsumed = result.tokensUsed || estimatedTokens;
    this.meterTokens(projectId, task.id, tokensConsumed, `Task execution: ${task.title}`);

    this.log(projectId, 'TASK_COMPLETED', `Agent ${this.name} (${this.role}) finished task: ${task.title}`);
    return result;
  }

  /**
   * To be implemented by role instances or overridden
   */
  async execute(projectId, task, input) {
    return {
      status: 'COMPLETED',
      role: this.role,
      summary: `Base execution completed by ${this.name}`,
      tokensUsed: 350,
      output: input
    };
  }
}
