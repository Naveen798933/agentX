import { EventEmitter } from 'node:events';

/**
 * Event-Driven Message Bus
 * Typed pub/sub backbone for inter-agent communication.
 * All events are persisted to the audit log for full observability.
 */
export const BusEvents = {
  // Agent lifecycle
  AGENT_STARTED: 'AGENT_STARTED',
  AGENT_COMPLETED: 'AGENT_COMPLETED',
  AGENT_ERROR: 'AGENT_ERROR',
  AGENT_THOUGHT: 'AGENT_THOUGHT',       // Step-by-step reasoning stream

  // Pipeline stages
  STAGE_STARTED: 'STAGE_STARTED',
  STAGE_COMPLETED: 'STAGE_COMPLETED',
  STAGE_FAILED: 'STAGE_FAILED',

  // Code artifacts
  CODE_PRODUCED: 'CODE_PRODUCED',
  FILE_WRITTEN: 'FILE_WRITTEN',

  // Testing
  TEST_STARTED: 'TEST_STARTED',
  TEST_PASSED: 'TEST_PASSED',
  TEST_FAILED: 'TEST_FAILED',
  SELF_HEAL_TRIGGERED: 'SELF_HEAL_TRIGGERED',
  SELF_HEAL_RESOLVED: 'SELF_HEAL_RESOLVED',

  // Approvals & governance
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_GRANTED: 'APPROVAL_GRANTED',
  APPROVAL_REJECTED: 'APPROVAL_REJECTED',

  // Budget
  BUDGET_WARNING: 'BUDGET_WARNING',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',

  // DAG
  DAG_UPDATED: 'DAG_UPDATED',
  TASK_DEPENDENCY_READY: 'TASK_DEPENDENCY_READY',

  // Git
  GIT_COMMIT: 'GIT_COMMIT',
  GIT_BRANCH_CREATED: 'GIT_BRANCH_CREATED'
};

export class EventBus extends EventEmitter {
  /**
   * @param {import('../storage/db.js').StorageEngine} storage
   */
  constructor(storage = null) {
    super();
    this.setMaxListeners(50);
    this.storage = storage;
    this._history = [];    // In-memory event history for replay
  }

  /**
   * Publish a typed event with structured payload.
   * Automatically persists to audit log and history buffer.
   */
  publish(eventType, payload = {}) {
    const event = {
      type: eventType,
      payload,
      timestamp: new Date().toISOString(),
      id: Math.random().toString(36).slice(2, 10)
    };

    // Keep last 500 events in memory
    this._history.push(event);
    if (this._history.length > 500) this._history.shift();

    // Persist to audit log if storage available
    if (this.storage && payload.projectId) {
      try {
        this.storage.logAuditEvent(
          payload.projectId,
          payload.agentRole || 'BUS',
          eventType,
          typeof payload.message === 'string'
            ? payload.message
            : JSON.stringify(payload).slice(0, 512)
        );
      } catch (_) {}
    }

    // Emit to all subscribers
    this.emit(eventType, event);
    this.emit('*', event); // wildcard subscriber support
    return event;
  }

  /**
   * Subscribe to one or more event types
   */
  subscribe(eventTypes, handler) {
    const types = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
    types.forEach(type => this.on(type, handler));
    return () => types.forEach(type => this.off(type, handler));
  }

  /**
   * Subscribe to all events via wildcard
   */
  subscribeAll(handler) {
    this.on('*', handler);
    return () => this.off('*', handler);
  }

  /**
   * Publish a thought step (streamed agent reasoning)
   */
  think(projectId, agentRole, agentName, thought) {
    return this.publish(BusEvents.AGENT_THOUGHT, {
      projectId,
      agentRole,
      agentName,
      message: thought,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Get recent event history (for SSE replay on new connections)
   */
  getHistory(limit = 50) {
    return this._history.slice(-limit);
  }

  /**
   * Clear history
   */
  clearHistory() {
    this._history = [];
  }
}
