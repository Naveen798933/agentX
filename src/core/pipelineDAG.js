import crypto from 'node:crypto';

/**
 * Pipeline DAG (Directed Acyclic Graph)
 * Models task dependencies and execution ordering for the virtual software house.
 */

export const StageDefinitions = {
  STAGE_INTAKE: {
    id: 'STAGE_INTAKE',
    label: 'Requirements & PRD',
    agent: 'PM',
    agentName: 'Sofia Ramos',
    icon: '📋',
    dependsOn: [],
    color: '#f472b6'
  },
  STAGE_ARCHITECTURE: {
    id: 'STAGE_ARCHITECTURE',
    label: 'System Architecture',
    agent: 'ARCHITECT',
    agentName: 'Marcus Vance',
    icon: '🏗️',
    dependsOn: ['STAGE_INTAKE'],
    color: '#a78bfa'
  },
  STAGE_BACKEND: {
    id: 'STAGE_BACKEND',
    label: 'Backend APIs',
    agent: 'BACKEND',
    agentName: 'David Chen',
    icon: '⚙️',
    dependsOn: ['STAGE_ARCHITECTURE'],
    color: '#60a5fa'
  },
  STAGE_FRONTEND: {
    id: 'STAGE_FRONTEND',
    label: 'Frontend UI',
    agent: 'FRONTEND',
    agentName: 'Aria Patel',
    icon: '🎨',
    dependsOn: ['STAGE_ARCHITECTURE'],
    color: '#2dd4bf'
  },
  STAGE_QA: {
    id: 'STAGE_QA',
    label: 'QA & Testing',
    agent: 'QA',
    agentName: 'Quinn Sterling',
    icon: '🧪',
    dependsOn: ['STAGE_BACKEND', 'STAGE_FRONTEND'],
    color: '#fbbf24'
  },
  STAGE_DEPLOY_REQUEST: {
    id: 'STAGE_DEPLOY_REQUEST',
    label: 'Production Gate',
    agent: 'DEVOPS',
    agentName: 'Devon Kross',
    icon: '🚀',
    dependsOn: ['STAGE_QA'],
    color: '#f87171'
  }
};

export class PipelineDAG {
  constructor() {
    this.nodes = { ...StageDefinitions };
    this.executionState = {};   // stageId -> { status, startTime, endTime, tokensUsed, output }

    Object.keys(this.nodes).forEach(id => {
      this.executionState[id] = {
        status: 'PENDING',    // PENDING | READY | RUNNING | COMPLETED | FAILED | SKIPPED
        startTime: null,
        endTime: null,
        tokensUsed: 0,
        selfHealAttempts: 0,
        output: null
      };
    });
  }

  /**
   * Compute which stages are currently eligible to run
   * (all their dependencies are COMPLETED)
   */
  getReadyStages() {
    return Object.values(this.nodes).filter(node => {
      const state = this.executionState[node.id];
      if (state.status !== 'PENDING') return false;
      return node.dependsOn.every(dep => this.executionState[dep]?.status === 'COMPLETED');
    });
  }

  /**
   * Get topologically sorted execution order
   */
  getTopologicalOrder() {
    const visited = new Set();
    const visiting = new Set();
    const order = [];

    const visit = (nodeId) => {
      if (visiting.has(nodeId)) {
        throw new Error(`Cycle detected in Pipeline DAG at node: ${nodeId}`);
      }
      if (visited.has(nodeId)) return;
      visiting.add(nodeId);
      const node = this.nodes[nodeId];
      if (node && node.dependsOn) {
        node.dependsOn.forEach(dep => visit(dep));
      }
      visiting.delete(nodeId);
      visited.add(nodeId);
      order.push(nodeId);
    };

    Object.keys(this.nodes).forEach(id => visit(id));
    return order;
  }

  markRunning(stageId) {
    this.executionState[stageId] = {
      ...this.executionState[stageId],
      status: 'RUNNING',
      startTime: Date.now()
    };
  }

  markCompleted(stageId, { tokensUsed = 0, output = null } = {}) {
    const state = this.executionState[stageId];
    this.executionState[stageId] = {
      ...state,
      status: 'COMPLETED',
      endTime: Date.now(),
      durationMs: state.startTime ? Date.now() - state.startTime : 0,
      tokensUsed,
      output
    };
  }

  markFailed(stageId, error) {
    const state = this.executionState[stageId];
    this.executionState[stageId] = {
      ...state,
      status: 'FAILED',
      endTime: Date.now(),
      error: error?.message || String(error)
    };
  }

  incrementHealAttempt(stageId) {
    this.executionState[stageId].selfHealAttempts++;
    this.executionState[stageId].status = 'PENDING'; // Reset to pending for retry
  }

  /**
   * Serialize the full DAG with execution state for dashboard rendering
   */
  serialize() {
    const nodes = Object.values(this.nodes).map(node => ({
      ...node,
      state: this.executionState[node.id]
    }));

    const edges = [];
    Object.values(this.nodes).forEach(node => {
      node.dependsOn.forEach(dep => {
        edges.push({ from: dep, to: node.id });
      });
    });

    const totalTokens = Object.values(this.executionState).reduce(
      (sum, s) => sum + (s.tokensUsed || 0), 0
    );
    const completedCount = Object.values(this.executionState).filter(s => s.status === 'COMPLETED').length;

    return { nodes, edges, totalTokens, completedCount, totalStages: nodes.length };
  }

  /**
   * Reset the DAG for a fresh pipeline run
   */
  reset() {
    Object.keys(this.nodes).forEach(id => {
      this.executionState[id] = {
        status: 'PENDING',
        startTime: null,
        endTime: null,
        tokensUsed: 0,
        selfHealAttempts: 0,
        output: null
      };
    });
  }
}
