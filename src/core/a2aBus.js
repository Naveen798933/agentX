import crypto from 'node:crypto';

export const A2AIntents = Object.freeze({
  PROPOSE: 'PROPOSE',
  CRITIQUE: 'CRITIQUE',
  REVISE: 'REVISE',
  APPROVE: 'APPROVE',
  ESCALATE: 'ESCALATE',
  INFO: 'INFO'
});

export const CritiqueSeverity = Object.freeze({
  BLOCKING: 'BLOCKING',
  WARNING: 'WARNING',
  INFO: 'INFO'
});

export class A2ABus {
  /**
   * @param {Object} options
   * @param {import('../storage/db.js').StorageEngine} [options.storage]
   */
  constructor(options = {}) {
    this.storage = options.storage || null;

    // In-memory registry for fast local dispatch
    this.threads = new Map();     // threadId -> ThreadObject
    this.messages = new Map();    // threadId -> Array<MessageObject>
    this.critiques = new Map();   // critiqueId -> CritiqueObject
    this.listeners = new Map();   // threadId -> Set<Function>
    this.globalListeners = new Set();
  }

  /**
   * Initialize a new peer-to-peer or squad discussion thread
   */
  createThread({
    projectId,
    tenantId = 'tenant-default',
    topic,
    initiatorRole,
    targetRole,
    stage = 'STAGE_ARCHITECTURE'
  }) {
    if (!projectId || !topic || !initiatorRole) {
      throw new Error('projectId, topic, and initiatorRole are required to create an A2A thread');
    }

    const threadId = `thrd_${crypto.randomUUID().slice(0, 12)}`;
    const thread = {
      id: threadId,
      projectId,
      tenantId,
      topic,
      initiatorRole,
      targetRole: targetRole || 'ALL',
      stage,
      status: 'OPEN',
      reviewRounds: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.threads.set(threadId, thread);
    this.messages.set(threadId, []);

    if (this.storage && typeof this.storage.createAgentConversation === 'function') {
      try {
        this.storage.createAgentConversation(thread);
      } catch (err) {
        console.warn(`[A2ABus] Could not persist thread: ${err.message}`);
      }
    }

    return thread;
  }

  /**
   * Dispatches a structured typed message into a thread
   */
  sendMessage({
    threadId,
    fromRole,
    toRole,
    intent = A2AIntents.INFO,
    content = '',
    artifacts = [],
    critiques = []
  }) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`A2A Thread ${threadId} not found`);
    }

    const messageId = `msg_${crypto.randomUUID().slice(0, 12)}`;
    const threadMsgs = this.messages.get(threadId);
    const sequenceNumber = (threadMsgs ? threadMsgs.length : 0) + 1;

    // Process and register attached critiques
    const processedCritiques = (critiques || []).map((crit, idx) => {
      const critiqueId = crit.id || `crit_${crypto.randomUUID().slice(0, 10)}`;
      const critiqueObj = {
        id: critiqueId,
        messageId,
        threadId,
        reviewerRole: fromRole,
        filePath: crit.filePath || 'src/index.js',
        lineNumber: crit.lineNumber || null,
        severity: crit.severity || CritiqueSeverity.WARNING,
        issueDescription: crit.issueDescription || '',
        suggestedFix: crit.suggestedFix || null,
        isResolved: false,
        resolvedAt: null,
        resolutionNote: null,
        createdAt: new Date().toISOString()
      };
      this.critiques.set(critiqueId, critiqueObj);
      return critiqueObj;
    });

    const msg = {
      id: messageId,
      threadId,
      projectId: thread.projectId,
      tenantId: thread.tenantId,
      fromRole,
      toRole: toRole || thread.targetRole,
      intent,
      content,
      artifactsAttached: artifacts || [],
      critiques: processedCritiques,
      sequenceNumber,
      createdAt: new Date().toISOString()
    };

    threadMsgs.push(msg);
    thread.updatedAt = msg.createdAt;

    if (intent === A2AIntents.CRITIQUE) {
      thread.reviewRounds++;
    } else if (intent === A2AIntents.APPROVE) {
      thread.status = 'RESOLVED';
    } else if (intent === A2AIntents.ESCALATE) {
      thread.status = 'ESCALATED';
    }

    if (this.storage && typeof this.storage.createAgentMessage === 'function') {
      try {
        this.storage.createAgentMessage(msg);
      } catch (err) {
        console.warn(`[A2ABus] Could not persist message: ${err.message}`);
      }
    }

    // Notify listeners
    this._notifyListeners(threadId, msg);

    return msg;
  }

  /**
   * Resolves a specific critique item
   */
  resolveCritique(critiqueId, { resolutionNote = '', resolvedBy = 'AUTHOR', commitSha = null }) {
    const critique = this.critiques.get(critiqueId);
    if (!critique) {
      throw new Error(`Critique ${critiqueId} not found`);
    }

    critique.isResolved = true;
    critique.resolvedAt = new Date().toISOString();
    critique.resolutionNote = resolutionNote;
    critique.resolvedBy = resolvedBy;
    critique.commitSha = commitSha;

    if (this.storage && typeof this.storage.resolveAgentCritique === 'function') {
      try {
        this.storage.resolveAgentCritique(critiqueId, critique);
      } catch (err) {
        console.warn(`[A2ABus] Could not persist critique resolution: ${err.message}`);
      }
    }

    return critique;
  }

  getThread(threadId) {
    return this.threads.get(threadId) || null;
  }

  getMessages(threadId) {
    return this.messages.get(threadId) || [];
  }

  listProjectThreads(projectId) {
    return Array.from(this.threads.values()).filter(t => t.projectId === projectId);
  }

  hasBlockingCritiques(threadId) {
    const threadMsgs = this.messages.get(threadId) || [];
    for (const msg of threadMsgs) {
      for (const crit of msg.critiques || []) {
        if (crit.severity === CritiqueSeverity.BLOCKING && !crit.isResolved) {
          return true;
        }
      }
    }
    return false;
  }

  subscribe(threadId, handler) {
    if (!this.listeners.has(threadId)) {
      this.listeners.set(threadId, new Set());
    }
    this.listeners.get(threadId).add(handler);
    return () => this.listeners.get(threadId).delete(handler);
  }

  subscribeGlobal(handler) {
    this.globalListeners.add(handler);
    return () => this.globalListeners.delete(handler);
  }

  _notifyListeners(threadId, message) {
    const threadHandlers = this.listeners.get(threadId);
    if (threadHandlers) {
      for (const handler of threadHandlers) {
        try { handler(message); } catch (_) {}
      }
    }
    for (const handler of this.globalListeners) {
      try { handler(message); } catch (_) {}
    }
  }
}

