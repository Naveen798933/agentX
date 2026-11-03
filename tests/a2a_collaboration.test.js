import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AgentFactory, AgentRoles } from '../src/agents/agentFactory.js';
import { StorageEngine } from '../src/storage/db.js';
import { BudgetManager } from '../src/budget/budgetManager.js';
import { SandboxExecutor } from '../src/sandbox/sandboxExecutor.js';
import { ApprovalManager } from '../src/approval/approvalManager.js';
import { A2ABus, A2AIntents, CritiqueSeverity } from '../src/core/a2aBus.js';
import { SquadCoordinator } from '../src/core/squadCoordinator.js';
import { Orchestrator } from '../src/core/orchestrator.js';

describe('V2.0 — Agent Squads & A2A Collaboration Protocol Suite', () => {
  let tmpDir;
  let dbPath;
  let storage;
  let budgetManager;
  let sandbox;
  let approvalManager;
  let agentFactory;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-a2a-test-'));
    dbPath = path.join(tmpDir, 'test_a2a.db');
    const workspacesDir = path.join(tmpDir, 'workspaces');
    fs.mkdirSync(workspacesDir, { recursive: true });

    storage = new StorageEngine(dbPath);
    budgetManager = new BudgetManager(storage);
    sandbox = new SandboxExecutor(workspacesDir, storage);
    approvalManager = new ApprovalManager(storage);

    agentFactory = new AgentFactory({
      storage,
      budgetManager,
      sandbox,
      approvalManager
    });
  });

  after(() => {
    try {
      storage.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  describe('1. 13-Agent Persona Roster & Tech Lead Instantiation', () => {
    test('instantiates all 13 specialized engineering roles including Tech Lead', () => {
      const team = agentFactory.createFullTeam();
      const roleKeys = Object.keys(team);

      assert.strictEqual(roleKeys.length, 13, 'Must instantiate exactly 13 specialized agent personas');
      assert.ok(team.pm, 'PM exists');
      assert.ok(team.ba, 'BA exists');
      assert.ok(team.designer, 'Designer exists');
      assert.ok(team.architect, 'Architect exists');
      assert.ok(team.techlead, 'Tech Lead exists');
      assert.ok(team.backend, 'Backend Dev exists');
      assert.ok(team.frontend, 'Frontend Dev exists');
      assert.ok(team.database, 'Database Eng exists');
      assert.ok(team.ai, 'AI Eng exists');
      assert.ok(team.reviewer, 'Code Reviewer exists');
      assert.ok(team.qa, 'QA Eng exists');
      assert.ok(team.security, 'Security Reviewer exists');
      assert.ok(team.devops, 'DevOps Eng exists');

      // Verify Tech Lead specifics
      assert.strictEqual(team.techlead.role, AgentRoles.TECH_LEAD);
      assert.ok(team.techlead.name.includes('Alex Rivera'));
      assert.ok(team.techlead.systemPrompt.includes('Software Architect and Engineering Coordinator'));
    });
  });

  describe('2. Cross-Functional Squad Assembly', () => {
    test('organizes agents into 3 functional squads (Product, Engineering, Assurance)', () => {
      const team = agentFactory.createFullTeam();
      const a2aBus = new A2ABus({ storage });
      const coordinator = new SquadCoordinator({ team, a2aBus, storage });

      const squads = coordinator.getSquads();
      assert.ok(squads.product, 'Product squad exists');
      assert.ok(squads.engineering, 'Engineering squad exists');
      assert.ok(squads.assurance, 'Assurance squad exists');

      // Verify members
      assert.deepStrictEqual(squads.product.memberRoles, ['PM', 'BA', 'DESIGNER']);
      assert.deepStrictEqual(squads.engineering.memberRoles, [
        'ARCHITECT', 'TECH_LEAD', 'DATABASE', 'BACKEND', 'FRONTEND', 'AI_ENGINEER'
      ]);
      assert.deepStrictEqual(squads.assurance.memberRoles, [
        'CODE_REVIEWER', 'QA', 'SECURITY', 'DEVOPS'
      ]);
    });
  });

  describe('3. A2ABus Thread Lifecycle & Critique Engine', () => {
    test('creates thread, sends typed messages, indexes critiques, and tracks blocking issues', () => {
      const a2aBus = new A2ABus({ storage });
      const thread = a2aBus.createThread({
        projectId: 'proj-collab-1',
        topic: 'User Registration REST Controller Review',
        initiatorRole: 'BACKEND',
        targetRole: 'CODE_REVIEWER',
        stage: 'STAGE_BACKEND'
      });

      assert.ok(thread.id.startsWith('thrd_'));
      assert.strictEqual(thread.status, 'OPEN');

      // Step 1: Backend Proposes Code
      const msg1 = a2aBus.sendMessage({
        threadId: thread.id,
        fromRole: 'BACKEND',
        toRole: 'CODE_REVIEWER',
        intent: A2AIntents.PROPOSE,
        content: 'Draft controller implementation in src/controllers/user.js',
        artifacts: [{ path: 'src/controllers/user.js', content: 'app.post("/register", handler);' }]
      });
      assert.strictEqual(msg1.sequenceNumber, 1);
      assert.strictEqual(msg1.intent, A2AIntents.PROPOSE);

      // Step 2: Code Reviewer critiques code with a blocking issue
      const msg2 = a2aBus.sendMessage({
        threadId: thread.id,
        fromRole: 'CODE_REVIEWER',
        toRole: 'BACKEND',
        intent: A2AIntents.CRITIQUE,
        content: 'Found vulnerability in registration input handling',
        critiques: [
          {
            filePath: 'src/controllers/user.js',
            lineNumber: 14,
            severity: CritiqueSeverity.BLOCKING,
            issueDescription: 'Missing password complexity check',
            suggestedFix: 'Enforce minimum 8 chars with scrypt hash'
          }
        ]
      });

      assert.strictEqual(msg2.sequenceNumber, 2);
      assert.strictEqual(msg2.critiques.length, 1);
      const crit = msg2.critiques[0];
      assert.strictEqual(crit.severity, CritiqueSeverity.BLOCKING);
      assert.strictEqual(crit.isResolved, false);

      // Verify thread detects blocking critique
      assert.strictEqual(a2aBus.hasBlockingCritiques(thread.id), true);

      // Step 3: Backend resolves critique
      const resolved = a2aBus.resolveCritique(crit.id, {
        resolutionNote: 'Implemented password complexity and scrypt hashing',
        resolvedBy: 'BACKEND'
      });
      assert.strictEqual(resolved.isResolved, true);
      assert.strictEqual(a2aBus.hasBlockingCritiques(thread.id), false);

      // Step 4: Reviewer approves
      const msg3 = a2aBus.sendMessage({
        threadId: thread.id,
        fromRole: 'CODE_REVIEWER',
        toRole: 'BACKEND',
        intent: A2AIntents.APPROVE,
        content: 'Critique resolved cleanly. Approved for merge.'
      });
      assert.strictEqual(msg3.sequenceNumber, 3);
      assert.strictEqual(a2aBus.getThread(thread.id).status, 'RESOLVED');
    });
  });

  describe('4. Squad Coordinator Peer Review Workflow & Escalation', () => {
    test('coordinateReview approves clean code with zero defects', async () => {
      const team = agentFactory.createFullTeam();
      const a2aBus = new A2ABus({ storage });
      const coordinator = new SquadCoordinator({ team, a2aBus, storage });

      const reviewOutcome = await coordinator.coordinateReview({
        projectId: 'proj-clean-review',
        authorRole: 'BACKEND',
        reviewerRole: 'CODE_REVIEWER',
        files: [{ path: 'src/utils.js', content: 'export function add(a, b) { return a + b; }' }],
        critiqueRules: []
      });

      assert.strictEqual(reviewOutcome.approved, true);
      assert.strictEqual(reviewOutcome.status, 'APPROVED');
      assert.strictEqual(reviewOutcome.critiqueCount, 0);
    });

    test('coordinateReview requests changes when critique rule is triggered and resolves on revision', async () => {
      const team = agentFactory.createFullTeam();
      const a2aBus = new A2ABus({ storage });
      const coordinator = new SquadCoordinator({ team, a2aBus, storage });

      const critiqueRules = [
        {
          pattern: /eval\(/,
          severity: CritiqueSeverity.BLOCKING,
          message: 'eval() is strictly forbidden for security reasons'
        }
      ];

      // Round 1: Author submits dangerous code
      const reviewOutcome = await coordinator.coordinateReview({
        projectId: 'proj-eval-review',
        authorRole: 'BACKEND',
        reviewerRole: 'SECURITY',
        files: [{ path: 'src/calc.js', content: 'export function calc(expr) { return eval(expr); }' }],
        critiqueRules
      });

      assert.strictEqual(reviewOutcome.approved, false);
      assert.strictEqual(reviewOutcome.status, 'CHANGES_REQUESTED');
      assert.strictEqual(reviewOutcome.critiqueCount, 1);
      const critId = reviewOutcome.critiques[0].id;

      // Round 2: Author revises and resolves critique
      const revisionOutcome = await coordinator.submitRevision({
        threadId: reviewOutcome.threadId,
        authorRole: 'BACKEND',
        reviewerRole: 'SECURITY',
        revisedFiles: [{ path: 'src/calc.js', content: 'export function calc(a, b) { return a + b; }' }],
        resolvedCritiqueIds: [critId]
      });

      assert.strictEqual(revisionOutcome.approved, true);
      assert.strictEqual(revisionOutcome.status, 'APPROVED');
    });

    test('escalates to Tech Lead after exceeding review rounds and allows arbitration', async () => {
      const team = agentFactory.createFullTeam();
      const a2aBus = new A2ABus({ storage });
      const coordinator = new SquadCoordinator({ team, a2aBus, storage });

      const thread = a2aBus.createThread({
        projectId: 'proj-dispute',
        topic: 'Architecture Dispute',
        initiatorRole: 'BACKEND',
        targetRole: 'ARCHITECT'
      });

      // Simulate 3 review rounds
      thread.reviewRounds = 3;

      const revisionOutcome = await coordinator.submitRevision({
        threadId: thread.id,
        authorRole: 'BACKEND',
        reviewerRole: 'ARCHITECT',
        revisedFiles: []
      });

      assert.strictEqual(revisionOutcome.escalated, true);
      assert.strictEqual(revisionOutcome.status, 'ESCALATED_TO_TECH_LEAD');

      // Tech lead arbitrates
      const arbitrateOutcome = await coordinator.arbitrateDispute({
        threadId: thread.id,
        decision: 'APPROVE_OVERRIDE',
        instructions: 'Proceed with asynchronous event stream pattern as approved by Tech Lead'
      });

      assert.strictEqual(arbitrateOutcome.approved, true);
      assert.strictEqual(arbitrateOutcome.status, 'RESOLVED_BY_TECH_LEAD');
      assert.strictEqual(a2aBus.getThread(thread.id).status, 'RESOLVED');
    });
  });

  describe('5. Database Persistence for Agent Threads & Messages', () => {
    test('persists conversation threads and messages to SQLite database', () => {
      const threadData = {
        id: 'thrd_db_test_01',
        projectId: 'proj-db-persist',
        tenantId: 'tenant-default',
        topic: 'Database Schema Review',
        initiatorRole: 'DATABASE',
        targetRole: 'TECH_LEAD',
        stage: 'STAGE_ARCHITECTURE',
        status: 'OPEN',
        reviewRounds: 1
      };

      storage.createAgentConversation(threadData);
      const retrievedThread = storage.getAgentConversation('thrd_db_test_01');
      assert.ok(retrievedThread);
      assert.strictEqual(retrievedThread.topic, 'Database Schema Review');
      assert.strictEqual(retrievedThread.initiator_role, 'DATABASE');

      const msgData = {
        id: 'msg_db_test_01',
        threadId: 'thrd_db_test_01',
        projectId: 'proj-db-persist',
        tenantId: 'tenant-default',
        fromRole: 'DATABASE',
        toRole: 'TECH_LEAD',
        intent: 'PROPOSE',
        content: 'PostgreSQL Migration 009 schema proposal',
        artifactsAttached: [{ file: '009.sql' }],
        critiques: [],
        sequenceNumber: 1
      };

      storage.createAgentMessage(msgData);
      const messages = storage.listAgentMessages('thrd_db_test_01');
      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0].from_role, 'DATABASE');
      assert.strictEqual(messages[0].intent, 'PROPOSE');
    });
  });

  describe('6. Orchestrator Squad & Bus Integration', () => {
    test('Orchestrator exposes getSquadCoordinator() and getA2ABus() with 13 agents', () => {
      const project = storage.createProject({ id: 'proj-orch-a2a', name: 'Orchestrator A2A Project' });
      const orchestrator = new Orchestrator({ storage, budgetManager, sandbox, approvalManager });

      const coordinator = orchestrator.getSquadCoordinator();
      const bus = orchestrator.getA2ABus();

      assert.ok(coordinator, 'SquadCoordinator is accessible');
      assert.ok(bus, 'A2ABus is accessible');

      const squads = coordinator.getSquads();
      assert.strictEqual(squads.engineering.memberRoles.includes('TECH_LEAD'), true);
      assert.strictEqual(squads.engineering.memberRoles.includes('AI_ENGINEER'), true);
      assert.strictEqual(squads.assurance.memberRoles.includes('SECURITY'), true);
    });
  });
});

