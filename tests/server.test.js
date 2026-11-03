import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

import { VirtualHouseServer } from '../src/server/server.js';

describe('Milestone 3: Web Dashboard, REST API & Telemetry Suite', () => {
  let tmpDir;
  let dbPath;
  let workspacesDir;
  let serverInstance;
  let baseUrl;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-m3-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    workspacesDir = path.join(tmpDir, 'workspaces');
    fs.mkdirSync(workspacesDir, { recursive: true });

    serverInstance = new VirtualHouseServer({
      port: 0, // Ephemeral port
      host: '127.0.0.1',
      dbPath,
      workspacesDir
    });

    baseUrl = await serverInstance.start();
  });

  after(async () => {
    if (serverInstance) {
      await serverInstance.stop();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('1. Static Asset Delivery', () => {
    test('serves index.html with HTML5 content-type', async () => {
      const res = await fetch(`${baseUrl}/`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('text/html'));
      const text = await res.text();
      assert.ok(text.includes('SYNAPSE'));
      assert.ok(text.includes('AI Virtual Software House'));
    });

    test('serves style.css with CSS content-type', async () => {
      const res = await fetch(`${baseUrl}/style.css`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('text/css'));
      const text = await res.text();
      assert.ok(text.includes('--bg-primary') || text.includes('font-family'));
    });

    test('serves app.js with JavaScript content-type', async () => {
      const res = await fetch(`${baseUrl}/app.js`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('application/javascript'));
    });
  });

  describe('2. System Status & Project Endpoints', () => {
    test('GET /api/status returns comprehensive system telemetry', async () => {
      const res = await fetch(`${baseUrl}/api/status`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();

      assert.ok(data.activeProject);
      assert.strictEqual(data.activeProject.id, 'proj-ecommerce-core');
      assert.ok(data.budgetSummary);
      assert.ok(data.llmMode);
      assert.ok(Array.isArray(data.pendingApprovals));
      assert.ok(data.dag);
      assert.ok(Array.isArray(data.gitLog));
    });

    test('GET /api/projects returns seeded and created projects', async () => {
      const res = await fetch(`${baseUrl}/api/projects`);
      assert.strictEqual(res.status, 200);
      const list = await res.json();
      assert.ok(Array.isArray(list));
      assert.ok(list.length >= 1);
    });

    test('POST /api/projects creates a new project record', async () => {
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Realtime Chat Service',
          description: 'WebSocket distributed chat application',
          budgetUsd: 15.0,
          budgetTokens: 75000
        })
      });

      assert.strictEqual(res.status, 201);
      const newProj = await res.json();
      assert.ok(newProj.id);
      assert.strictEqual(newProj.name, 'Realtime Chat Service');
      assert.strictEqual(newProj.budget_tokens, 75000);
    });
  });

  describe('3. DAG, Git & Workspace Explorer Endpoints', () => {
    test('GET /api/projects/:id/dag returns nodes and execution state', async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-ecommerce-core/dag`);
      assert.strictEqual(res.status, 200);
      const dag = await res.json();

      assert.ok(Array.isArray(dag.nodes));
      assert.ok(Array.isArray(dag.edges));
      assert.strictEqual(dag.totalStages, 6);
    });

    test('GET /api/projects/:id/git/log returns commit history', async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-ecommerce-core/git/log`);
      assert.strictEqual(res.status, 200);
      const commits = await res.json();

      assert.ok(Array.isArray(commits));
      assert.ok(commits.length >= 1);
      assert.ok(commits[0].hash);
      assert.ok(commits[0].author);
    });

    test('GET /api/projects/:id/files lists workspace files and reads file content', async () => {
      const listRes = await fetch(`${baseUrl}/api/projects/proj-ecommerce-core/files`);
      assert.strictEqual(listRes.status, 200);
      const files = await listRes.json();
      assert.ok(Array.isArray(files));
      assert.ok(files.length > 0);

      // Read package.json
      const fileRes = await fetch(`${baseUrl}/api/projects/proj-ecommerce-core/files/content?file=package.json`);
      assert.strictEqual(fileRes.status, 200);
      const fileData = await fileRes.json();
      assert.strictEqual(fileData.file, 'package.json');
      assert.ok(fileData.content.includes('nexus-store-engine'));
    });
  });

  describe('4. Human Approval Workflow & Budget Adjustment', () => {
    test('POST /api/approvals/:id/decide grants approval and updates record', async () => {
      // Find pending approval for proj-ecommerce-core
      const appRes = await fetch(`${baseUrl}/api/approvals?projectId=proj-ecommerce-core`);
      const approvals = await appRes.json();
      const pending = approvals.find(a => a.status === 'PENDING');

      assert.ok(pending, 'There should be a pending approval');

      const decideRes = await fetch(`${baseUrl}/api/approvals/${pending.id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'APPROVE', reviewer: 'Lead Engineer' })
      });

      assert.strictEqual(decideRes.status, 200);
      const updated = await decideRes.json();
      assert.strictEqual(updated.status, 'APPROVED');
      assert.strictEqual(updated.resolved_by, 'Lead Engineer');
    });

    test('POST /api/budget/increase adds tokens to active project', async () => {
      const incRes = await fetch(`${baseUrl}/api/budget/increase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'proj-ecommerce-core',
          additionalTokens: 25000,
          authorizedBy: 'Engineering Director'
        })
      });

      assert.strictEqual(incRes.status, 200);
      const result = await incRes.json();
      assert.ok(result.budgetTokens >= 150000);
    });
  });

  describe('5. Real-Time Telemetry Stream (SSE)', () => {
    test('establishes Server-Sent Events handshake and sends heartbeat', (t, done) => {
      const parsed = new URL(`${baseUrl}/api/stream`);
      const req = http.request(parsed, (res) => {
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res.headers['content-type']?.includes('text/event-stream'));

        res.on('data', (chunk) => {
          const str = chunk.toString();
          if (str.includes(': heartbeat') || str.includes('event:')) {
            req.destroy();
            done();
          }
        });
      });

      req.on('error', (err) => {
        if (err.code !== 'ECONNRESET') done(err);
      });

      req.end();
    });
  });
});
