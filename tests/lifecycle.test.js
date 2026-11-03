import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StorageEngine } from '../src/storage/db.js';
import { SandboxExecutor } from '../src/sandbox/sandboxExecutor.js';
import { PipelineDAG, StageDefinitions } from '../src/core/pipelineDAG.js';
import { GitManager } from '../src/git/gitManager.js';

describe('Milestone 2: Project Lifecycle, DAG & Code Synthesis Suite', () => {
  let tmpDir;
  let dbPath;
  let workspacesDir;
  let storage;
  let sandbox;
  let project;
  let projectWorkspace;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-m2-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    workspacesDir = path.join(tmpDir, 'workspaces');
    fs.mkdirSync(workspacesDir, { recursive: true });

    storage = new StorageEngine(dbPath);
    sandbox = new SandboxExecutor(workspacesDir, storage);

    project = storage.createProject({
      id: 'proj-lifecycle-test',
      name: 'Lifecycle Test Project',
      description: 'Testing DAG, git history, and code generation',
      budgetTokens: 60000,
      budgetUsd: 0.12
    });

    projectWorkspace = sandbox.getProjectWorkspace(project.id);
  });

  describe('1. Pipeline DAG Dependencies & Topological Resolution', () => {
    test('initializes DAG with all defined stages in PENDING state', () => {
      const dag = new PipelineDAG();
      const serialized = dag.serialize();

      assert.strictEqual(serialized.totalStages, 6);
      assert.strictEqual(serialized.completedCount, 0);
      assert.strictEqual(serialized.nodes.length, 6);
      assert.ok(serialized.edges.length > 0);

      // Verify initial ready stage is only STAGE_INTAKE
      const readyStages = dag.getReadyStages();
      assert.strictEqual(readyStages.length, 1);
      assert.strictEqual(readyStages[0].id, 'STAGE_INTAKE');
    });

    test('progresses stage eligibility through dependencies correctly', () => {
      const dag = new PipelineDAG();

      // 1. Intake completes
      dag.markRunning('STAGE_INTAKE');
      dag.markCompleted('STAGE_INTAKE', { tokensUsed: 400 });

      // Architecture should now be ready
      let ready = dag.getReadyStages().map(s => s.id);
      assert.deepStrictEqual(ready, ['STAGE_ARCHITECTURE']);

      // 2. Architecture completes
      dag.markRunning('STAGE_ARCHITECTURE');
      dag.markCompleted('STAGE_ARCHITECTURE', { tokensUsed: 500 });

      // Both Backend and Frontend should now be ready in parallel
      ready = dag.getReadyStages().map(s => s.id);
      assert.ok(ready.includes('STAGE_BACKEND'));
      assert.ok(ready.includes('STAGE_FRONTEND'));
      assert.strictEqual(ready.length, 2);

      // 3. Backend completes, but Frontend still pending -> QA should NOT be ready yet
      dag.markRunning('STAGE_BACKEND');
      dag.markCompleted('STAGE_BACKEND', { tokensUsed: 600 });
      ready = dag.getReadyStages().map(s => s.id);
      assert.deepStrictEqual(ready, ['STAGE_FRONTEND']);

      // 4. Frontend completes -> QA is now ready
      dag.markRunning('STAGE_FRONTEND');
      dag.markCompleted('STAGE_FRONTEND', { tokensUsed: 550 });
      ready = dag.getReadyStages().map(s => s.id);
      assert.deepStrictEqual(ready, ['STAGE_QA']);

      // 5. QA completes -> Production Gate ready
      dag.markRunning('STAGE_QA');
      dag.markCompleted('STAGE_QA', { tokensUsed: 300 });
      ready = dag.getReadyStages().map(s => s.id);
      assert.deepStrictEqual(ready, ['STAGE_DEPLOY_REQUEST']);
    });

    test('computes topological sort order preserving dependency constraints', () => {
      const dag = new PipelineDAG();
      const order = dag.getTopologicalOrder();

      const intakeIdx = order.indexOf('STAGE_INTAKE');
      const archIdx = order.indexOf('STAGE_ARCHITECTURE');
      const backendIdx = order.indexOf('STAGE_BACKEND');
      const frontendIdx = order.indexOf('STAGE_FRONTEND');
      const qaIdx = order.indexOf('STAGE_QA');
      const deployIdx = order.indexOf('STAGE_DEPLOY_REQUEST');

      assert.ok(intakeIdx < archIdx, 'INTAKE must precede ARCHITECTURE');
      assert.ok(archIdx < backendIdx, 'ARCHITECTURE must precede BACKEND');
      assert.ok(archIdx < frontendIdx, 'ARCHITECTURE must precede FRONTEND');
      assert.ok(backendIdx < qaIdx, 'BACKEND must precede QA');
      assert.ok(frontendIdx < qaIdx, 'FRONTEND must precede QA');
      assert.ok(qaIdx < deployIdx, 'QA must precede DEPLOY');
    });

    test('marks stage failed and allows tracking heal attempts', () => {
      const dag = new PipelineDAG();
      dag.markRunning('STAGE_QA');
      dag.markFailed('STAGE_QA', new Error('SyntaxError: unexpected token'));

      assert.strictEqual(dag.executionState['STAGE_QA'].status, 'FAILED');
      assert.ok(dag.executionState['STAGE_QA'].error.includes('SyntaxError'));

      dag.incrementHealAttempt('STAGE_QA');
      assert.strictEqual(dag.executionState['STAGE_QA'].status, 'PENDING');
      assert.strictEqual(dag.executionState['STAGE_QA'].selfHealAttempts, 1);
    });
  });

  describe('2. Git Version Control & Commit Graph', () => {
    test('initializes git repository and records signed agent commits', () => {
      const git = new GitManager(projectWorkspace, storage);

      // Write a file in workspace
      fs.writeFileSync(path.join(projectWorkspace, 'package.json'), JSON.stringify({ name: 'test-app' }, null, 2));

      const commit1 = git.commit({
        message: 'Initial project manifest',
        author: 'Sofia Ramos',
        agentRole: 'PM',
        files: ['package.json']
      });

      assert.ok(commit1.hash);
      assert.strictEqual(commit1.hash.length, 12);
      assert.strictEqual(commit1.author, 'Sofia Ramos');
      assert.strictEqual(commit1.agentRole, 'PM');
      assert.strictEqual(commit1.parentHash, null);

      // Write another file and commit
      fs.writeFileSync(path.join(projectWorkspace, 'server.js'), 'console.log("hello");');
      const commit2 = git.commit({
        message: 'Add HTTP server entrypoint',
        author: 'David Chen',
        agentRole: 'BACKEND',
        files: ['server.js']
      });

      assert.strictEqual(commit2.parentHash, commit1.hash);

      const log = git.getLog();
      assert.strictEqual(log.length, 2);
      assert.strictEqual(log[0].hash, commit2.hash); // most recent first
      assert.strictEqual(log[1].hash, commit1.hash);
    });

    test('branches and tracks current HEAD correctly', () => {
      const git = new GitManager(projectWorkspace, storage);

      fs.writeFileSync(path.join(projectWorkspace, 'README.md'), '# Test App');
      git.commit({ message: 'Root commit', author: 'PM', agentRole: 'PM', files: ['README.md'] });

      const branchResult = git.createBranch('feature/checkout');
      assert.strictEqual(branchResult.branch, 'feature/checkout');

      const branchInfo = git.getCurrentBranch();
      assert.strictEqual(branchInfo.current, 'feature/checkout');
      assert.ok(branchInfo.branches.includes('feature/checkout'));
      assert.ok(branchInfo.branches.includes('main'));
    });
  });

  describe('3. Sandboxed File Generation & Code Synthesis', () => {
    test('writes and lists generated files safely within project workspace', () => {
      sandbox.writeFileSafely(project.id, 'src/api/routes.js', 'export const routes = [];');
      sandbox.writeFileSafely(project.id, 'tests/routes.test.js', 'import test from "node:test";');

      const files = sandbox.listFiles(project.id);
      assert.ok(files.includes('src/api/routes.js'));
      assert.ok(files.includes('tests/routes.test.js'));

      const content = sandbox.readFileSafely(project.id, 'src/api/routes.js');
      assert.strictEqual(content, 'export const routes = [];');
    });
  });
});
