import { A2AIntents, CritiqueSeverity } from './a2aBus.js';

export class SquadCoordinator {
  /**
   * @param {Object} options
   * @param {Object} options.team - Instantiated 13-agent roster
   * @param {import('./a2aBus.js').A2ABus} options.a2aBus
   * @param {import('../storage/db.js').StorageEngine} [options.storage]
   * @param {import('./orchestrator.js').Orchestrator} [options.orchestrator]
   */
  constructor(options = {}) {
    this.team = options.team || {};
    this.a2aBus = options.a2aBus;
    this.storage = options.storage || null;
    this.orchestrator = options.orchestrator || null;

    // Define squad boundaries
    this.squads = {
      product: {
        name: 'Product & UX Squad',
        lead: this.team.pm,
        members: [this.team.pm, this.team.ba, this.team.designer]
      },
      engineering: {
        name: 'Core Engineering Squad',
        lead: this.team.techlead || this.team.architect,
        members: [
          this.team.architect,
          this.team.techlead,
          this.team.database,
          this.team.backend,
          this.team.frontend,
          this.team.ai
        ]
      },
      assurance: {
        name: 'Quality, Security & Operations Squad',
        lead: this.team.reviewer || this.team.qa,
        members: [this.team.reviewer, this.team.qa, this.team.security, this.team.devops]
      }
    };
  }

  getSquads() {
    return {
      product: {
        name: this.squads.product.name,
        memberRoles: this.squads.product.members.filter(Boolean).map(m => m.role)
      },
      engineering: {
        name: this.squads.engineering.name,
        memberRoles: this.squads.engineering.members.filter(Boolean).map(m => m.role)
      },
      assurance: {
        name: this.squads.assurance.name,
        memberRoles: this.squads.assurance.members.filter(Boolean).map(m => m.role)
      }
    };
  }

  /**
   * Coordinates a formal peer review round between author (Developer) and reviewer (Code Reviewer / Security)
   */
  async coordinateReview({
    projectId,
    tenantId = 'tenant-default',
    topic,
    authorRole,
    reviewerRole,
    files = [],
    critiqueRules = []
  }) {
    if (!this.a2aBus) {
      throw new Error('A2ABus instance is required for squad coordination');
    }

    // 1. Author opens review thread with a proposal
    const thread = this.a2aBus.createThread({
      projectId,
      tenantId,
      topic: topic || `Code Review: ${authorRole} changes`,
      initiatorRole: authorRole,
      targetRole: reviewerRole,
      stage: 'STAGE_REVIEW'
    });

    this.a2aBus.sendMessage({
      threadId: thread.id,
      fromRole: authorRole,
      toRole: reviewerRole,
      intent: A2AIntents.PROPOSE,
      content: `Submitted ${files.length} file(s) for formal peer review.`,
      artifacts: files
    });

    // 2. Reviewer inspects files and applies static/heuristic critique rules
    const discoveredCritiques = [];
    for (const file of files) {
      const code = file.content || '';
      for (const rule of critiqueRules) {
        if (rule.pattern && rule.pattern.test(code)) {
          discoveredCritiques.push({
            filePath: file.path,
            lineNumber: rule.lineNumber || 1,
            severity: rule.severity || CritiqueSeverity.BLOCKING,
            issueDescription: rule.message,
            suggestedFix: rule.suggestedFix || null
          });
        }
      }
    }

    // 3. Reviewer emits critique or approval
    if (discoveredCritiques.length > 0) {
      const critiqueMsg = this.a2aBus.sendMessage({
        threadId: thread.id,
        fromRole: reviewerRole,
        toRole: authorRole,
        intent: A2AIntents.CRITIQUE,
        content: `Found ${discoveredCritiques.length} issue(s) during review. Revision required.`,
        critiques: discoveredCritiques
      });
      return {
        threadId: thread.id,
        status: 'CHANGES_REQUESTED',
        approved: false,
        critiqueCount: critiqueMsg.critiques.length,
        critiques: critiqueMsg.critiques
      };
    }

    // Zero issues -> Approve immediately
    this.a2aBus.sendMessage({
      threadId: thread.id,
      fromRole: reviewerRole,
      toRole: authorRole,
      intent: A2AIntents.APPROVE,
      content: `Peer review passed with zero defects. Approved for merge.`
    });

    return {
      threadId: thread.id,
      status: 'APPROVED',
      approved: true,
      critiqueCount: 0,
      critiques: []
    };
  }

  /**
   * Author revises code to address critiques and requests re-evaluation
   */
  async submitRevision({
    threadId,
    authorRole,
    reviewerRole,
    revisedFiles = [],
    resolvedCritiqueIds = []
  }) {
    const thread = this.a2aBus.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }

    if (thread.reviewRounds >= 3) {
      // Exceeded max review iterations -> Escalate to Tech Lead
      this.a2aBus.sendMessage({
        threadId,
        fromRole: authorRole,
        toRole: 'TECH_LEAD',
        intent: A2AIntents.ESCALATE,
        content: `Max review rounds (3) exceeded. Escalating to Tech Lead for binding arbitration.`
      });
      return {
        threadId,
        status: 'ESCALATED_TO_TECH_LEAD',
        approved: false,
        escalated: true
      };
    }

    // Mark specific critiques resolved
    for (const critId of resolvedCritiqueIds) {
      this.a2aBus.resolveCritique(critId, {
        resolutionNote: 'Fixed in revision',
        resolvedBy: authorRole
      });
    }

    // Dispatch revision message
    this.a2aBus.sendMessage({
      threadId,
      fromRole: authorRole,
      toRole: reviewerRole,
      intent: A2AIntents.REVISE,
      content: `Submitted revised code addressing ${resolvedCritiqueIds.length} critique(s).`,
      artifacts: revisedFiles
    });

    const stillBlocking = this.a2aBus.hasBlockingCritiques(threadId);
    if (!stillBlocking) {
      // Reviewer signs off
      this.a2aBus.sendMessage({
        threadId,
        fromRole: reviewerRole,
        toRole: authorRole,
        intent: A2AIntents.APPROVE,
        content: `All blocking critiques verified and cleared. Approved.`
      });
      return {
        threadId,
        status: 'APPROVED',
        approved: true,
        escalated: false
      };
    }

    return {
      threadId,
      status: 'UNDER_REVIEW',
      approved: false,
      escalated: false
    };
  }

  /**
   * Tech Lead arbitration decision on an escalated thread
   */
  async arbitrateDispute({
    threadId,
    decision = 'APPROVE_OVERRIDE', // 'APPROVE_OVERRIDE' | 'REJECT_TO_REDRAFT'
    instructions = '',
    techLeadRole = 'TECH_LEAD'
  }) {
    const thread = this.a2aBus.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }

    if (decision === 'APPROVE_OVERRIDE') {
      this.a2aBus.sendMessage({
        threadId,
        fromRole: techLeadRole,
        toRole: 'ALL',
        intent: A2AIntents.APPROVE,
        content: `Tech Lead Arbitration: Approved with override. Notes: ${instructions}`
      });
      return { threadId, status: 'RESOLVED_BY_TECH_LEAD', approved: true };
    }

    this.a2aBus.sendMessage({
      threadId,
      fromRole: techLeadRole,
      toRole: thread.initiatorRole,
      intent: A2AIntents.CRITIQUE,
      content: `Tech Lead Arbitration: Redraft required. Guidance: ${instructions}`
    });
    return { threadId, status: 'REDRAFT_ORDERED_BY_TECH_LEAD', approved: false };
  }
}
