import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StorageEngine } from '../src/storage/db.js';
import { BudgetManager, BudgetExceededError } from '../src/budget/budgetManager.js';
import { AgentFactory, AgentRoles } from '../src/agents/agentFactory.js';
import { BaseAgent } from '../src/agents/baseAgent.js';
import { EventBus, BusEvents } from '../src/core/eventBus.js';

describe('Milestone 1: Multi-Agent Orchestration & Roles Suite', () => {
  let tmpDir;
  let dbPath;
  let storage;
  let budgetManager;
  let eventBus;
  let factory;
  let team;
  let testProject;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-m1-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    storage = new StorageEngine(dbPath);
    budgetManager = new BudgetManager(storage, { costPer1kTokens: 0.002 });
    eventBus = new EventBus(storage);
    factory = new AgentFactory({ storage, budgetManager, eventBus });
    team = factory.createFullTeam();

    testProject = storage.createProject({
      id: 'proj-m1-test',
      name: 'Agent Coordination Test Project',
      description: 'Testing multi-agent collaboration and event propagation',
      budgetTokens: 50000,
      budgetUsd: 0.10
    });
  });

  describe('1. Agent Persona & Factory Instantiation', () => {
    test('instantiates complete engineering team with distinct roles and prompts', () => {
      assert.ok(team.pm instanceof BaseAgent);
      assert.strictEqual(team.pm.role, AgentRoles.PM);
      assert.ok(team.pm.systemPrompt.includes('Product Manager'));

      assert.ok(team.architect instanceof BaseAgent);
      assert.strictEqual(team.architect.role, AgentRoles.ARCHITECT);
      assert.ok(team.architect.systemPrompt.includes('Architect'));

      assert.ok(team.backend instanceof BaseAgent);
      assert.strictEqual(team.backend.role, AgentRoles.BACKEND);
      assert.ok(team.backend.systemPrompt.includes('Backend'));

      assert.ok(team.frontend instanceof BaseAgent);
      assert.strictEqual(team.frontend.role, AgentRoles.FRONTEND);
      assert.ok(team.frontend.systemPrompt.includes('Frontend'));

      assert.ok(team.qa instanceof BaseAgent);
      assert.strictEqual(team.qa.role, AgentRoles.QA);
      assert.ok(team.qa.systemPrompt.includes('QA'));

      assert.ok(team.devops instanceof BaseAgent);
      assert.strictEqual(team.devops.role, AgentRoles.DEVOPS);
      assert.ok(team.devops.systemPrompt.includes('DevOps'));
    });

    test('accurately estimates token count from text heuristic', () => {
      const pm = team.pm;
      assert.strictEqual(pm.estimateTokens(''), 0);
      assert.strictEqual(pm.estimateTokens('hello'), 2); // 5 chars / 4 = 1.25 -> 2
      assert.strictEqual(pm.estimateTokens('a'.repeat(400)), 100);
    });
  });

  describe('2. Agent Task Processing & Budget Integration', () => {
    test('processes task, meters token expenditure, and writes audit log', async () => {
      const task = storage.createTask({
        projectId: testProject.id,
        title: 'Draft PRD',
        assignedAgent: AgentRoles.PM
      });

      const initialBudget = budgetManager.getBudgetSummary(testProject.id);
      const result = await team.pm.processTask(testProject.id, task, { requirement: 'Build shopping cart' });

      assert.strictEqual(result.status, 'COMPLETED');
      assert.strictEqual(result.role, AgentRoles.PM);

      // Verify tokens metered
      const updatedBudget = budgetManager.getBudgetSummary(testProject.id);
      assert.ok(updatedBudget.remainingTokens < initialBudget.remainingTokens);

      // Verify audit logs
      const logs = storage.getAuditLogs(testProject.id, 10);
      const taskStartedLog = logs.find(l => l.event_type === 'TASK_STARTED');
      const taskCompletedLog = logs.find(l => l.event_type === 'TASK_COMPLETED');
      assert.ok(taskStartedLog, 'Should log TASK_STARTED');
      assert.ok(taskCompletedLog, 'Should log TASK_COMPLETED');
    });

    test('fails task execution if project cannot afford estimated inference tokens', async () => {
      const lowBudgetProject = storage.createProject({
        id: 'proj-low-budget',
        name: 'Depleted Project',
        budgetTokens: 100, // less than base estimate (500)
        budgetUsd: 0.0002
      });

      const task = storage.createTask({
        projectId: lowBudgetProject.id,
        title: 'Architecture Review',
        assignedAgent: AgentRoles.ARCHITECT
      });

      await assert.rejects(
        async () => {
          await team.architect.processTask(lowBudgetProject.id, task);
        },
        /Insufficient budget/
      );
    });
  });

  describe('3. Event-Driven Message Bus', () => {
    test('publishes typed event and notifies subscribed listeners', (t, done) => {
      eventBus.subscribe(BusEvents.STAGE_STARTED, (event) => {
        assert.strictEqual(event.type, BusEvents.STAGE_STARTED);
        assert.strictEqual(event.payload.projectId, testProject.id);
        assert.strictEqual(event.payload.stageId, 'STAGE_INTAKE');
        done();
      });

      eventBus.publish(BusEvents.STAGE_STARTED, {
        projectId: testProject.id,
        stageId: 'STAGE_INTAKE'
      });
    });

    test('wildcard subscriber receives all dispatched events', () => {
      const received = [];
      const unsubscribe = eventBus.subscribeAll((event) => {
        received.push(event.type);
      });

      eventBus.publish(BusEvents.AGENT_STARTED, { projectId: testProject.id });
      eventBus.publish(BusEvents.CODE_PRODUCED, { projectId: testProject.id });
      eventBus.publish(BusEvents.TEST_PASSED, { projectId: testProject.id });

      assert.deepStrictEqual(received, [
        BusEvents.AGENT_STARTED,
        BusEvents.CODE_PRODUCED,
        BusEvents.TEST_PASSED
      ]);

      unsubscribe();
      eventBus.publish(BusEvents.STAGE_COMPLETED, { projectId: testProject.id });
      assert.strictEqual(received.length, 3, 'Unsubscribed listener should not receive further events');
    });

    test('retains in-memory history of recent events for stream replay', () => {
      for (let i = 0; i < 5; i++) {
        eventBus.publish(BusEvents.CODE_PRODUCED, { index: i });
      }

      const history = eventBus.getHistory(3);
      assert.strictEqual(history.length, 3);
      assert.strictEqual(history[2].payload.index, 4);
    });

    test('streams agent reasoning thoughts via think() helper', (t, done) => {
      eventBus.subscribe(BusEvents.AGENT_THOUGHT, (event) => {
        assert.strictEqual(event.payload.agentRole, AgentRoles.ARCHITECT);
        assert.strictEqual(event.payload.agentName, 'Marcus (System Architect)');
        assert.ok(event.payload.message.includes('Evaluating database schema'));
        done();
      });

      eventBus.think(
        testProject.id,
        AgentRoles.ARCHITECT,
        'Marcus (System Architect)',
        'Evaluating database schema tradeoffs between SQLite and PostgreSQL...'
      );
    });
  });

  describe('4. Inter-Agent Pipeline Coordination Handoff', () => {
    test('simulates pipeline handoff from PM to Architect to Developer to QA', async () => {
      const pipelineTrace = [];
      eventBus.subscribeAll((event) => {
        if ([BusEvents.AGENT_STARTED, BusEvents.AGENT_COMPLETED].includes(event.type)) {
          pipelineTrace.push(`${event.payload.agentRole}:${event.type}`);
        }
      });

      // 1. PM creates PRD
      eventBus.publish(BusEvents.AGENT_STARTED, { agentRole: AgentRoles.PM });
      const prd = { spec: 'REST API with authentication' };
      eventBus.publish(BusEvents.AGENT_COMPLETED, { agentRole: AgentRoles.PM, output: prd });

      // 2. Architect receives PRD and designs API
      eventBus.publish(BusEvents.AGENT_STARTED, { agentRole: AgentRoles.ARCHITECT, input: prd });
      const architecture = { endpoints: ['/api/login', '/api/users'] };
      eventBus.publish(BusEvents.AGENT_COMPLETED, { agentRole: AgentRoles.ARCHITECT, output: architecture });

      // 3. Backend implements code
      eventBus.publish(BusEvents.AGENT_STARTED, { agentRole: AgentRoles.BACKEND, input: architecture });
      const code = { files: ['server.js', 'auth.js'] };
      eventBus.publish(BusEvents.AGENT_COMPLETED, { agentRole: AgentRoles.BACKEND, output: code });

      // 4. QA verifies code
      eventBus.publish(BusEvents.AGENT_STARTED, { agentRole: AgentRoles.QA, input: code });
      const testResults = { passed: true, suitesRun: 4 };
      eventBus.publish(BusEvents.AGENT_COMPLETED, { agentRole: AgentRoles.QA, output: testResults });

      assert.deepStrictEqual(pipelineTrace, [
        'PM:AGENT_STARTED',
        'PM:AGENT_COMPLETED',
        'ARCHITECT:AGENT_STARTED',
        'ARCHITECT:AGENT_COMPLETED',
        'BACKEND:AGENT_STARTED',
        'BACKEND:AGENT_COMPLETED',
        'QA:AGENT_STARTED',
        'QA:AGENT_COMPLETED'
      ]);
    });
  });
});
