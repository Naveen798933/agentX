import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StorageEngine } from '../src/storage/db.js';
import { SandboxExecutor } from '../src/sandbox/sandboxExecutor.js';
import { BudgetManager } from '../src/budget/budgetManager.js';
import { ApprovalManager } from '../src/approval/approvalManager.js';
import { EventBus } from '../src/core/eventBus.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { VirtualHouseServer } from '../src/server/server.js';

describe('Autonomous Idea-to-Working-Software Engine Suite', () => {
  let tmpDir;
  let dbPath;
  let workspacesDir;
  let storage;
  let sandbox;
  let orchestrator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-auto-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    workspacesDir = path.join(tmpDir, 'workspaces');
    fs.mkdirSync(workspacesDir, { recursive: true });

    storage = new StorageEngine(dbPath);
    sandbox = new SandboxExecutor(workspacesDir, storage);
    const budgetManager = new BudgetManager(storage);
    const approvalManager = new ApprovalManager(storage);
    const eventBus = new EventBus(storage);

    orchestrator = new Orchestrator({
      storage,
      sandbox,
      budgetManager,
      approvalManager,
      eventBus
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  describe('1. Full Autonomous Workflow Execution', () => {
    test('autonomously synthesizes, verifies, and produces runnable software from project title', async () => {
      const proj = storage.createProject({
        id: 'proj-ecommerce-auto',
        name: 'Smart E-Commerce Platform',
        description: 'Build an e-commerce website with login, products, cart, payments, admin dashboard, and order tracking.',
        budgetTokens: 150000,
        budgetUsd: 20.0
      });

      const result = await orchestrator.buildProjectAutonomous(proj.id, {
        appType: 'E-Commerce Platform',
        fastMode: true
      });

      assert.strictEqual(result.status, 'READY_FOR_DEPLOYMENT');
      assert.strictEqual(result.testPassed, true);
      assert.ok(result.files.length >= 7);
      assert.ok(result.files.includes('public/index.html'));
      assert.ok(result.files.includes('src/api.js'));
      assert.ok(result.files.includes('tests/api.test.js'));
      assert.ok(result.files.includes('package.json'));
      assert.ok(result.files.includes('docs/PRD.md'));
      assert.ok(result.files.includes('docs/ADR-001.md'));

      // Verify the generated files exist in workspace
      const html = sandbox.readFileSafely(proj.id, 'public/index.html');
      assert.ok(html.includes('<!DOCTYPE html>'));
      assert.ok(html.includes('Smart E-Commerce Platform'));

      const api = sandbox.readFileSafely(proj.id, 'src/api.js');
      assert.ok(api.includes('export'));

      // Verify tasks were persisted in SQLite
      const tasks = storage.listTasks(proj.id);
      assert.ok(tasks.length >= 6);
      const pmTask = tasks.find(t => t.assigned_agent === 'PM');
      assert.ok(pmTask);
      assert.strictEqual(pmTask.project_id, proj.id);

      // Verify Git history was recorded
      const git = orchestrator.getGit(proj.id);
      const log = git.getLog(5);
      assert.ok(log.length >= 1);
      assert.strictEqual(log[0].author, 'Devon Kross');

      // Verify production deployment approval was requested
      const approvals = storage.listApprovals(proj.id, 'PENDING');
      assert.strictEqual(approvals.length, 1);
      assert.strictEqual(approvals[0].action_type, 'PRODUCTION_DEPLOYMENT');
      assert.strictEqual(approvals[0].risk_level, 'CRITICAL');
    });

    test('supports pause and resume during autonomous execution', () => {
      const proj = storage.createProject({
        id: 'proj-ctrl-test',
        name: 'Control Test App'
      });

      const pauseRes = orchestrator.pause(proj.id);
      assert.strictEqual(pauseRes.paused, true);
      assert.strictEqual(orchestrator.pipelineControls[proj.id].paused, true);

      const resumeRes = orchestrator.resume(proj.id);
      assert.strictEqual(resumeRes.resumed, true);
      assert.strictEqual(orchestrator.pipelineControls[proj.id].paused, false);
    });

    test('supports pipeline cancellation', () => {
      const proj = storage.createProject({
        id: 'proj-cancel-test',
        name: 'Cancel Test App'
      });

      const cancelRes = orchestrator.cancel(proj.id);
      assert.strictEqual(cancelRes.cancelled, true);
      assert.strictEqual(orchestrator.pipelineControls[proj.id].cancelled, true);

      const updated = storage.getProject(proj.id);
      assert.strictEqual(updated.status, 'CANCELLED');
    });
  });

  describe('2. HTTP Endpoints for Autonomous Building & Controls', () => {
    let server;
    let baseUrl;

    beforeEach(async () => {
      server = new VirtualHouseServer({
        port: 0,
        dbPath,
        workspacesDir
      });
      baseUrl = await server.start();
    });

    afterEach(async () => {
      await server.stop();
    });

    test('POST /api/projects/autonomous creates project and returns 201', async () => {
      const res = await fetch(`${baseUrl}/api/projects/autonomous`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Quantum Task Manager',
          description: 'Kanban board with priority queues and real-time updates',
          appType: 'Workflow Application',
          fastMode: true
        })
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.projectId.startsWith('proj-'));
      assert.strictEqual(data.project.name, 'Quantum Task Manager');
    });

    test('POST /api/projects/:id/pause and /resume work via REST', async () => {
      const projRes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Pause Test', autoRun: false })
      });
      const proj = await projRes.json();

      const pauseRes = await fetch(`${baseUrl}/api/projects/${proj.id}/pause`, { method: 'POST' });
      assert.strictEqual(pauseRes.status, 200);
      const pauseData = await pauseRes.json();
      assert.strictEqual(pauseData.paused, true);

      const resumeRes = await fetch(`${baseUrl}/api/projects/${proj.id}/resume`, { method: 'POST' });
      assert.strictEqual(resumeRes.status, 200);
      const resumeData = await resumeRes.json();
      assert.strictEqual(resumeData.resumed, true);
    });

    test('GET /api/projects/:id/preview serves actual generated application', async () => {
      // Build project first
      const projRes = await fetch(`${baseUrl}/api/projects/autonomous`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Preview App',
          description: 'A test preview application',
          fastMode: true
        })
      });
      const projData = await projRes.json();

      // Wait a moment for fastMode build to complete
      await new Promise(r => setTimeout(r, 200));

      const previewRes = await fetch(`${baseUrl}/api/projects/${projData.projectId}/preview`);
      assert.strictEqual(previewRes.status, 200);
      const html = await previewRes.text();
      assert.ok(html.includes('<!DOCTYPE html>'));
    });
  });
});
