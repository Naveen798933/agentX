import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { fileURLToPath } from 'node:url';

import { StorageEngine } from '../src/storage/db.js';
import { SandboxExecutor } from '../src/sandbox/sandboxExecutor.js';
import { VirtualHouseServer } from '../src/server/server.js';
import {
  crc32,
  buildZipBuffer,
  readWorkspaceFiles,
  packageProjectAsZip
} from '../src/export/zipExporter.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Phase 1A: Containerization & Zero-Dependency ZIP Export Suite', () => {
  let tmpDir;
  let dbPath;
  let workspacesDir;
  let storage;
  let sandbox;
  let serverApp;
  let baseUrl;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-zip-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    workspacesDir = path.join(tmpDir, 'workspaces');
    fs.mkdirSync(workspacesDir, { recursive: true });

    storage = new StorageEngine(dbPath);
    sandbox = new SandboxExecutor(workspacesDir, storage);

    // Create a mock project workspace
    const projectDir = path.join(workspacesDir, 'proj-test-export');
    fs.mkdirSync(path.join(projectDir, 'public'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });

    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'proj-test-export',
      version: '1.0.0',
      type: 'module',
      scripts: { start: 'node src/server.js' }
    }, null, 2));

    fs.writeFileSync(path.join(projectDir, 'public', 'index.html'), '<!DOCTYPE html><html><body><h1>Export Test</h1></body></html>');
    fs.writeFileSync(path.join(projectDir, 'src', 'server.js'), 'import http from "node:http";\nhttp.createServer().listen(3000);');

    // Register project in DB
    storage.createProject({
      id: 'proj-test-export',
      name: 'Export Test Project',
      description: 'Project for testing containerization and one-click ZIP export',
      budgetTokens: 50000,
      budgetUsd: 5.0
    });
  });

  afterEach(async () => {
    if (serverApp) {
      await serverApp.stop();
      serverApp = null;
    }
    try {
      storage.close();
    } catch (_) {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  describe('1. Zero-Dependency ZIP Exporter Engine', () => {
    test('computes deterministic CRC32 matching standard polynomial', () => {
      const data1 = Buffer.from('123456789', 'ascii');
      // Standard CRC32 of '123456789' is 0xCBF43926 (3421760294 in decimal)
      const sum1 = crc32(data1);
      assert.equal(sum1, 0xCBF43926);

      const empty = Buffer.alloc(0);
      assert.equal(crc32(empty), 0);
    });

    test('buildZipBuffer constructs valid PKZIP buffer with magic headers', () => {
      const files = [
        { path: 'hello.txt', content: Buffer.from('Hello, World!\n', 'utf8') },
        { path: 'data/config.json', content: Buffer.from('{"key":"value"}', 'utf8') }
      ];

      const zipBuf = buildZipBuffer(files);
      assert.ok(Buffer.isBuffer(zipBuf));
      assert.ok(zipBuf.length > 0);

      // Verify local file header signature: PK\x03\x04
      assert.equal(zipBuf[0], 0x50); // 'P'
      assert.equal(zipBuf[1], 0x4B); // 'K'
      assert.equal(zipBuf[2], 0x03);
      assert.equal(zipBuf[3], 0x04);

      // Verify end of central directory signature: PK\x05\x06 at the end
      const eocdIndex = zipBuf.lastIndexOf(Buffer.from([0x50, 0x4B, 0x05, 0x06]));
      assert.ok(eocdIndex > 0, 'Must have End of Central Directory record');
    });

    test('readWorkspaceFiles filters out prohibited folders and returns clean tree', () => {
      const projectDir = path.join(workspacesDir, 'proj-test-export');
      fs.mkdirSync(path.join(projectDir, 'node_modules', 'dummy'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'node_modules', 'dummy', 'index.js'), 'module.exports = 1;');
      fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main');

      const files = readWorkspaceFiles(projectDir);
      const relativePaths = files.map(f => f.path);

      assert.ok(relativePaths.includes('package.json'));
      assert.ok(relativePaths.includes('public/index.html'));
      assert.ok(relativePaths.includes('src/server.js'));

      // Ensure blacklisted paths are not packed
      assert.ok(!relativePaths.some(p => p.startsWith('node_modules')));
      assert.ok(!relativePaths.some(p => p.startsWith('.git')));
    });

    test('packageProjectAsZip auto-injects Dockerfile and .dockerignore when missing', () => {
      const projectDir = path.join(workspacesDir, 'proj-test-export');
      const project = storage.getProject('proj-test-export');

      const zipBuffer = packageProjectAsZip(projectDir, project);
      assert.ok(zipBuffer.length > 500);

      // Verify byte content contains Dockerfile entry
      const zipString = zipBuffer.toString('binary');
      assert.ok(zipString.includes('Dockerfile'));
      assert.ok(zipString.includes('.dockerignore'));
      assert.ok(zipString.includes('README.md'));
      assert.ok(zipString.includes('package.json'));
      assert.ok(zipString.includes('public/index.html'));
    });
  });

  describe('2. Multi-Backend Sandbox Resilience', () => {
    test('getActiveBackend falls back safely to PROCESS_JAIL when Docker daemon is offline', () => {
      const executor = new SandboxExecutor(workspacesDir, storage, {
        backendMode: 'AUTO'
      });

      const active = executor.getActiveBackend();
      assert.equal(active, executor.dockerAvailable ? 'DOCKER' : 'PROCESS_JAIL');
    });

    test('getActiveBackend respects explicit PROCESS_JAIL backendMode override', () => {
      const executor = new SandboxExecutor(workspacesDir, storage, {
        backendMode: 'PROCESS_JAIL'
      });
      assert.equal(executor.getActiveBackend(), 'PROCESS_JAIL');
    });

    test('command execution returns backendUsed in execution result', async () => {
      const executor = new SandboxExecutor(workspacesDir, storage, {
        backendMode: 'PROCESS_JAIL'
      });

      const res = await executor.executeCommand('proj-test-export', 'node -v');
      assert.equal(res.backendUsed, 'PROCESS_JAIL');
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.startsWith('v'));
    });
  });

  describe('3. Server Dynamic Project Export REST API', () => {
    test('GET /api/projects/:id/export/zip serves binary ZIP with correct headers', async () => {
      serverApp = new VirtualHouseServer({
        port: 0,
        host: '127.0.0.1',
        dbPath,
        workspacesDir
      });

      baseUrl = await serverApp.start();

      const res = await fetch(`${baseUrl}/api/projects/proj-test-export/export/zip`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/zip');
      const disposition = res.headers.get('content-disposition') || '';
      assert.ok(disposition.includes('export-test-project.zip') || disposition.includes('proj-test-export.zip') || disposition.includes('.zip'));

      const arrayBuf = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      assert.ok(buf.length > 500);

      // Validate PK magic signature
      assert.equal(buf[0], 0x50);
      assert.equal(buf[1], 0x4B);
      assert.equal(buf[2], 0x03);
      assert.equal(buf[3], 0x04);
    });

    test('GET /api/projects/:id/export/zip returns 404 for unknown project', async () => {
      serverApp = new VirtualHouseServer({
        port: 0,
        host: '127.0.0.1',
        dbPath,
        workspacesDir
      });

      baseUrl = await serverApp.start();

      const res = await fetch(`${baseUrl}/api/projects/nonexistent-proj-id/export/zip`);
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.error, 'Project not found');
    });
  });

  describe('4. Production Container Assets Validation', () => {
    test('Root Dockerfile exists and meets production standards', () => {
      const dockerfilePath = path.join(repoRoot, 'Dockerfile');
      assert.ok(fs.existsSync(dockerfilePath), 'Root Dockerfile must exist');

      const content = fs.readFileSync(dockerfilePath, 'utf8');
      assert.ok(content.includes('FROM node:22-alpine'), 'Uses Node 22 Alpine base');
      assert.ok(content.includes('HEALTHCHECK'), 'Configures healthcheck');
      assert.ok(content.includes('EXPOSE 3000'), 'Exposes port 3000');
      assert.ok(content.includes('CMD ["node"'), 'Runs node start command');
    });

    test('Root docker-compose.yml exists and orchestrates platform service', () => {
      const composePath = path.join(repoRoot, 'docker-compose.yml');
      assert.ok(fs.existsSync(composePath), 'docker-compose.yml must exist');

      const content = fs.readFileSync(composePath, 'utf8');
      assert.ok(content.includes('virtual-software-house:'), 'Defines main service');
      assert.ok(content.includes('./data:/app/data'), 'Persists workspace and db data');
      assert.ok(content.includes('3000:3000'), 'Maps port 3000');
    });

    test('Root .dockerignore exists and excludes transient artifacts', () => {
      const ignorePath = path.join(repoRoot, '.dockerignore');
      assert.ok(fs.existsSync(ignorePath), '.dockerignore must exist');

      const content = fs.readFileSync(ignorePath, 'utf8');
      assert.ok(content.includes('node_modules'), 'Ignores node_modules');
      assert.ok(content.includes('.git'), 'Ignores .git');
      assert.ok(content.includes('.env'), 'Ignores .env secret');
    });
  });
});
