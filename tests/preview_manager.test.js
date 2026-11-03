import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { StorageEngine } from '../src/storage/db.js';
import { SandboxExecutor } from '../src/sandbox/sandboxExecutor.js';
import { EventBus } from '../src/core/eventBus.js';
import { PreviewManager } from '../src/server/previewManager.js';
import { VirtualHouseServer } from '../src/server/server.js';

describe('Live Browser Preview Management & Isolated Runtime Suite', () => {
  const testDb = path.resolve('data/test_preview.db');
  const testWorkspaces = path.resolve('data/test_preview_workspaces');
  let storage;
  let sandbox;
  let eventBus;
  let previewManager;
  let server;
  let serverUrl;

  beforeEach(async () => {
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
    if (fs.existsSync(testWorkspaces)) fs.rmSync(testWorkspaces, { recursive: true, force: true });

    storage = new StorageEngine(testDb);
    sandbox = new SandboxExecutor(testWorkspaces, storage);
    eventBus = new EventBus(storage);
    previewManager = new PreviewManager({ storage, sandbox, eventBus }, { idleTimeoutMs: 5000 });

    server = new VirtualHouseServer({
      port: 0,
      dbPath: testDb,
      workspacesDir: testWorkspaces
    });
    serverUrl = await server.start();
  });

  afterEach(async () => {
    await previewManager.shutdownAll();
    await server.stop();
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
    if (fs.existsSync(testWorkspaces)) fs.rmSync(testWorkspaces, { recursive: true, force: true });
  });

  test('1. Detects project runtime correctly for static, node, and custom frameworks', () => {
    const projId = 'proj-detect-test';
    storage.createProject({ id: projId, name: 'Runtime Detect Project', budgetTokens: 100000 });

    // Initial state: fallback
    let runtime = previewManager.detectProjectRuntime(projId);
    assert.equal(runtime.runtimeType, 'static-spa');

    // Add public/index.html
    sandbox.writeFileSafely(projId, 'public/index.html', '<h1>Hello World</h1>');
    runtime = previewManager.detectProjectRuntime(projId);
    assert.equal(runtime.runtimeType, 'static-spa');
    assert.match(runtime.framework, /Single-Page Application/i);

    // Add package.json with express
    sandbox.writeFileSafely(projId, 'package.json', JSON.stringify({
      name: 'express-app',
      dependencies: { express: '^4.19.0' }
    }));
    runtime = previewManager.detectProjectRuntime(projId);
    assert.equal(runtime.runtimeType, 'node-server');
  });

  test('2. Starts and caches preview session with session telemetry', async () => {
    const projId = 'proj-session-test';
    storage.createProject({ id: projId, name: 'Session Test Project', budgetTokens: 100000 });
    sandbox.writeFileSafely(projId, 'public/index.html', '<html><body><div id="app">Live App</div></body></html>');

    const session = await previewManager.getOrCreateSession(projId);
    assert.ok(session.sessionId.startsWith('prev-'));
    assert.equal(session.projectId, projId);
    assert.equal(session.status, 'ready');
    assert.equal(session.buildState, 'success');
    assert.ok(session.logs.length > 0);

    const json = session.toJSON();
    assert.equal(json.projectId, projId);
    assert.equal(json.status, 'ready');
  });

  test('3. Delivers rendered application with injected live-reload bridge script', async () => {
    const projId = 'proj-render-test';
    storage.createProject({ id: projId, name: 'Render Test Project', budgetTokens: 100000 });
    sandbox.writeFileSafely(projId, 'public/index.html', '<!DOCTYPE html><html><body><h1 id="brand">Nexus Portal</h1></body></html>');

    const res = await fetch(`${serverUrl}/api/projects/${projId}/preview/`);
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /Nexus Portal/);
    assert.match(html, /__SYNAPSE_LIVE_PREVIEW_BRIDGE__/);
    assert.match(html, /SYNAPSE_ROUTE_CHANGED/);
    assert.match(html, /SYNAPSE_HOT_RELOAD/);
  });

  test('4. Supports client-side application routes (SPA fallback)', async () => {
    const projId = 'proj-spa-routes';
    storage.createProject({ id: projId, name: 'SPA Router Project', budgetTokens: 100000 });
    sandbox.writeFileSafely(projId, 'public/index.html', '<!DOCTYPE html><html><body><div id="router-view">Route View</div></body></html>');

    // Request non-root route like /dashboard or /products/item-1
    const res = await fetch(`${serverUrl}/api/projects/${projId}/preview/dashboard`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Route View/);
    assert.match(html, /__SYNAPSE_LIVE_PREVIEW_BRIDGE__/);
  });

  test('5. Serves static CSS, JS, and asset files with proper MIME types', async () => {
    const projId = 'proj-assets-test';
    storage.createProject({ id: projId, name: 'Assets Test Project', budgetTokens: 100000 });
    sandbox.writeFileSafely(projId, 'public/style.css', 'body { color: cyan; }');
    sandbox.writeFileSafely(projId, 'public/app.js', 'console.log("preview running");');

    const cssRes = await fetch(`${serverUrl}/api/projects/${projId}/preview/public/style.css`);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get('content-type'), /text\/css/);
    const cssText = await cssRes.text();
    assert.equal(cssText, 'body { color: cyan; }');

    const jsRes = await fetch(`${serverUrl}/api/projects/${projId}/preview/public/app.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get('content-type'), /javascript/);
  });

  test('6. Code Editor API writes file, commits to git, and notifies preview manager', async () => {
    const projId = 'proj-editor-save';
    storage.createProject({ id: projId, name: 'Editor Project', budgetTokens: 100000 });

    const newCode = '<!DOCTYPE html><html><body><h1>Updated by Human Developer</h1></body></html>';
    const saveRes = await fetch(`${serverUrl}/api/projects/${projId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'public/index.html', content: newCode })
    });

    assert.equal(saveRes.status, 200);
    const saveJson = await saveRes.json();
    assert.equal(saveJson.success, true);

    // Verify preview renders the updated content immediately
    const previewRes = await fetch(`${serverUrl}/api/projects/${projId}/preview/`);
    const previewHtml = await previewRes.text();
    assert.match(previewHtml, /Updated by Human Developer/);
  });

  test('7. Provides preview session status, logs, restart, and stop endpoints', async () => {
    const projId = 'proj-mgmt-endpoints';
    storage.createProject({ id: projId, name: 'Management Endpoints', budgetTokens: 100000 });
    sandbox.writeFileSafely(projId, 'public/index.html', '<h1>Management Test</h1>');

    // Get status
    const statusRes = await fetch(`${serverUrl}/api/projects/${projId}/preview/status`);
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.projectId, projId);
    assert.equal(statusData.status, 'ready');

    // Get logs
    const logsRes = await fetch(`${serverUrl}/api/projects/${projId}/preview/logs`);
    assert.equal(logsRes.status, 200);
    const logsData = await logsRes.json();
    assert.ok(Array.isArray(logsData));

    // Restart
    const restartRes = await fetch(`${serverUrl}/api/projects/${projId}/preview/restart`, { method: 'POST' });
    assert.equal(restartRes.status, 200);
    const restartData = await restartRes.json();
    assert.equal(restartData.status, 'ready');

    // Stop
    const stopRes = await fetch(`${serverUrl}/api/projects/${projId}/preview/stop`, { method: 'POST' });
    assert.equal(stopRes.status, 200);
    const stopData = await stopRes.json();
    assert.equal(stopData.status, 'stopped');
  });

  test('8. Isolates multiple concurrent project preview sessions without cross-access', async () => {
    const projA = 'proj-alpha';
    const projB = 'proj-beta';
    storage.createProject({ id: projA, name: 'Project Alpha', budgetTokens: 100000 });
    storage.createProject({ id: projB, name: 'Project Beta', budgetTokens: 100000 });

    sandbox.writeFileSafely(projA, 'public/index.html', '<h1>App Alpha</h1>');
    sandbox.writeFileSafely(projB, 'public/index.html', '<h1>App Beta</h1>');

    const resA = await fetch(`${serverUrl}/api/projects/${projA}/preview/`);
    const resB = await fetch(`${serverUrl}/api/projects/${projB}/preview/`);

    const htmlA = await resA.text();
    const htmlB = await resB.text();

    assert.match(htmlA, /App Alpha/);
    assert.doesNotMatch(htmlA, /App Beta/);

    assert.match(htmlB, /App Beta/);
    assert.doesNotMatch(htmlB, /App Alpha/);
  });
});
