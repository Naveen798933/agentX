import crypto from 'node:crypto';

export class ApprovalRequiredError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApprovalRequiredError';
    this.details = details;
  }
}

export class ApprovalRejectedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApprovalRejectedError';
    this.details = details;
  }
}

export const GatedActions = {
  PRODUCTION_DEPLOYMENT: 'PRODUCTION_DEPLOYMENT',
  BUDGET_INCREASE: 'BUDGET_INCREASE',
  DESTRUCTIVE_ACTION: 'DESTRUCTIVE_ACTION',
  EXTERNAL_NETWORK_CALL: 'EXTERNAL_NETWORK_CALL',
  ENVIRONMENT_SECRET_OVERRIDE: 'ENVIRONMENT_SECRET_OVERRIDE'
};

export class ApprovalManager {
  /**
   * @param {import('../storage/db.js').StorageEngine} storage
   */
  constructor(storage) {
    this.storage = storage;
  }

  /**
   * Register a new pending approval request
   */
  requestApproval({
    projectId,
    taskId = null,
    actionType,
    payload = '',
    riskLevel = 'HIGH',
    reason = '',
    requestedBy = 'AGENT'
  }) {
    if (!projectId) {
      throw new Error('Project ID is required to request approval');
    }
    if (!actionType) {
      throw new Error('Action type is required to request approval');
    }

    const id = `appr_${crypto.randomUUID().slice(0, 8)}`;

    return this.storage.createApproval({
      id,
      projectId,
      taskId,
      actionType,
      payload,
      riskLevel,
      reason,
      requestedBy
    });
  }

  /**
   * Check status of an approval request
   */
  getApproval(approvalId) {
    const approval = this.storage.getApproval(approvalId);
    if (!approval) {
      throw new Error(`Approval request "${approvalId}" not found`);
    }
    return approval;
  }

  /**
   * List pending approvals for a project
   */
  listPending(projectId) {
    return this.storage.listApprovals(projectId, 'PENDING');
  }

  /**
   * Human operator resolves an approval request
   */
  resolveApproval(approvalId, { decision, operatorId = 'HUMAN_OPERATOR', notes = '' }) {
    if (!['APPROVE', 'REJECT'].includes(decision)) {
      throw new Error(`Invalid decision "${decision}". Must be "APPROVE" or "REJECT".`);
    }

    const approval = this.getApproval(approvalId);
    if (approval.status !== 'PENDING') {
      throw new Error(`Approval "${approvalId}" is already resolved as "${approval.status}".`);
    }

    const newStatus = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';

    return this.storage.updateApproval(approvalId, {
      status: newStatus,
      resolvedBy: operatorId,
      notes
    });
  }

  /**
   * Assert that an approval exists, is APPROVED, and matches expected action
   */
  assertApproved(approvalId, expectedActionType = null, options = {}) {
    const approval = this.getApproval(approvalId);

    if (expectedActionType && approval.action_type !== expectedActionType) {
      throw new ApprovalRequiredError(
        `Approval "${approvalId}" is for action "${approval.action_type}", expected "${expectedActionType}"`,
        { approvalId, actionType: approval.action_type, expectedActionType }
      );
    }

    if (approval.status === 'PENDING') {
      throw new ApprovalRequiredError(
        `Action "${approval.action_type}" requires explicit human operator approval. Current status is PENDING.`,
        { approvalId, status: 'PENDING', actionType: approval.action_type }
      );
    }

    if (approval.status === 'REJECTED') {
      throw new ApprovalRejectedError(
        `Action "${approval.action_type}" was explicitly REJECTED by operator (${approval.resolved_by}). Notes: ${approval.notes || 'None'}`,
        { approvalId, status: 'REJECTED', resolvedBy: approval.resolved_by, notes: approval.notes }
      );
    }

    if (approval.status !== 'APPROVED') {
      throw new ApprovalRequiredError(`Approval "${approvalId}" is not in APPROVED state (current: ${approval.status})`);
    }

    // Check approval expiration TTL (default 24 hours)
    const createdAt = new Date(approval.created_at).getTime();
    const ttlMs = options.ttlMs || 86400000;
    if (Date.now() - createdAt > ttlMs) {
      throw new ApprovalRequiredError(
        `Approval "${approvalId}" has expired (exceeded ${Math.round(ttlMs / 3600000)}h TTL). Re-authorization required.`,
        { approvalId, status: 'EXPIRED' }
      );
    }

    return approval;
  }

  /**
   * Execute protected action function ONLY IF approved
   */
  async executeIfApproved(approvalId, expectedActionType, actionFn) {
    this.assertApproved(approvalId, expectedActionType);
    return await actionFn();
  }
}
