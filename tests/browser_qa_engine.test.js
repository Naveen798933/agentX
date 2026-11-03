import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  BrowserTestRunner,
  VisualRegression,
  AccessibilityAuditor,
  StepActions,
  StepStatuses,
  SessionStatuses
} from '../src/qa/index.js';
import { StorageEngine } from '../src/storage/db.js';
import { Orchestrator } from '../src/core/orchestrator.js';

describe('V2.0 — Autonomous Browser QA & Interaction Testing Engine Suite', () => {
  let tmpDir;
  let dbPath;
  let storage;
  let qaRunner;
  let mockServer;
  let serverPort;
  let serverBaseUrl;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-browser-qa-test-'));
    dbPath = path.join(tmpDir, 'test_qa.db');
    storage = new StorageEngine(dbPath);

    // Initialize required test projects in storage to satisfy foreign keys
    storage.createProject({ id: 'proj-qa-001', name: 'QA Project 1' });
    storage.createProject({ id: 'proj-qa-002', name: 'QA Project 2' });
    storage.createProject({ id: 'proj-qa-persisted', name: 'QA Persisted Project' });

    // Custom fetcher for in-memory dispatch (ensures zero socket failures in sandboxed test runners)
    const customFetcher = (rawUrl) => {
      const url = new URL(rawUrl);
      if (url.pathname === '/app') {
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Pulse Test Application</title></head><body><header><h1 id="welcome-heading">Welcome to Pulse App</h1></header><main><form id="login-form"><label for="username">Username</label><input id="username" name="username" type="text" value="" /><button id="submit-btn" type="submit">Log In</button></form><img id="logo-img" src="/logo.png" alt="Company Logo" /></main></body></html>`
        };
      }
      if (url.pathname === '/disabled-btn') {
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: `<!DOCTYPE html><html lang="en"><head><title>Disabled Action</title></head><body><button id="action-btn" disabled>Disabled Action</button></body></html>`
        };
      }
      return { status: 404, headers: {}, body: 'Not Found' };
    };

    qaRunner = new BrowserTestRunner({ storage, customFetcher });

    // Setup local mock preview HTTP server
    mockServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === '/app') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="utf-8">
            <title>Pulse Test Application</title>
          </head>
          <body>
            <header>
              <h1 id="welcome-heading">Welcome to Pulse App</h1>
            </header>
            <main>
              <form id="login-form">
                <label for="username">Username</label>
                <input id="username" name="username" type="text" value="" />
                <button id="submit-btn" type="submit">Log In</button>
              </form>
              <img id="logo-img" src="/logo.png" alt="Company Logo" />
            </main>
          </body>
          </html>
        `);
      } else if (url.pathname === '/inaccessible-app') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <!-- Missing title -->
          </head>
          <body>
            <h1>Heading 1</h1>
            <h3>Skipped to Heading 3</h3>
            <img src="/broken.png" />
            <input type="text" id="unlabeled" />
            <button id="empty-button"></button>
            <div id="duplicate">First</div>
            <div id="duplicate">Second</div>
          </body>
          </html>
        `);
      } else if (url.pathname === '/disabled-btn') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html lang="en">
          <head><title>Disabled Action</title></head>
          <body>
            <button id="action-btn" disabled>Disabled Action</button>
          </body>
          </html>
        `);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    await new Promise((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        serverPort = mockServer.address().port;
        serverBaseUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => mockServer.close(resolve));
    try {
      storage.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  describe('1. Visual Regression & Pixel Diff Engine', () => {
    test('compares identical pixel buffers and reports 0% difference', () => {
      const width = 100;
      const height = 100;
      const baseline = VisualRegression.createSyntheticCanvas(width, height, [255, 255, 255, 255]);
      const candidate = VisualRegression.createSyntheticCanvas(width, height, [255, 255, 255, 255]);

      const report = VisualRegression.compareBuffers(baseline, candidate);
      assert.strictEqual(report.passed, true);
      assert.strictEqual(report.totalPixels, 10000);
      assert.strictEqual(report.mismatchedPixels, 0);
      assert.strictEqual(report.diffPercentage, 0);
      assert.strictEqual(report.error, null);
    });

    test('accepts minor variations within tolerance threshold (< 1% diff)', () => {
      const width = 100;
      const height = 100;
      const baseline = VisualRegression.createSyntheticCanvas(width, height, [255, 255, 255, 255]);
      const candidate = VisualRegression.createSyntheticCanvas(width, height, [255, 255, 255, 255]);

      // Draw a tiny 5x5 rectangle: 25 pixels out of 10,000 = 0.25% diff
      VisualRegression.drawRect(candidate, width, { x: 10, y: 10, w: 5, h: 5, color: [200, 0, 0, 255] });

      const report = VisualRegression.compareBuffers(baseline, candidate, { maxDiffPercent: 0.01 });
      assert.strictEqual(report.passed, true, 'Diff of 0.25% must pass maxDiffPercent of 1%');
      assert.strictEqual(report.mismatchedPixels, 25);
      assert.strictEqual(report.diffPercentage, 0.0025);
    });

    test('detects UI breakage exceeding 1% pixel diff and produces highlight diff mask', () => {
      const width = 100;
      const height = 100;
      const baseline = VisualRegression.createSyntheticCanvas(width, height, [255, 255, 255, 255]);
      const candidate = VisualRegression.createSyntheticCanvas(width, height, [255, 255, 255, 255]);

      // Draw a 30x20 element: 600 pixels out of 10,000 = 6% diff
      VisualRegression.drawRect(candidate, width, { x: 10, y: 10, w: 30, h: 20, color: [0, 100, 255, 255] });

      const report = VisualRegression.compareBuffers(baseline, candidate, { maxDiffPercent: 0.01 });
      assert.strictEqual(report.passed, false, 'Diff of 6% must fail maxDiffPercent of 1%');
      assert.strictEqual(report.mismatchedPixels, 600);
      assert.strictEqual(report.diffPercentage, 0.06);
      assert.ok(report.error.includes('Visual regression diff 6.00% exceeds threshold 1.00%'));
      assert.ok(Buffer.isBuffer(report.diffBuffer));

      // Verify diff mask has bright magenta highlights on mismatched pixels
      const diffPixelOffset = (10 * width + 10) * 4;
      assert.strictEqual(report.diffBuffer[diffPixelOffset], 255);     // R
      assert.strictEqual(report.diffBuffer[diffPixelOffset + 1], 0);   // G
      assert.strictEqual(report.diffBuffer[diffPixelOffset + 2], 128); // B
    });

    test('computes deterministic SHA-256 buffer checksum', () => {
      const buf = VisualRegression.createSyntheticCanvas(20, 20, [100, 150, 200, 255]);
      const hash1 = VisualRegression.computeChecksum(buf);
      const hash2 = VisualRegression.computeChecksum(buf);
      assert.strictEqual(hash1.length, 64);
      assert.strictEqual(hash1, hash2);
    });
  });

  describe('2. Automated WCAG 2.1 AA Accessibility Auditor', () => {
    test('passes accessible HTML markup with 100 score and verified checks', () => {
      const validHtml = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <title>Accessible Enterprise Portal</title>
        </head>
        <body>
          <main>
            <h1>Dashboard</h1>
            <h2>Activity</h2>
            <img src="/chart.png" alt="Quarterly Revenue Trend Chart" />
            <form>
              <label for="email-field">Email Address</label>
              <input id="email-field" type="email" />
              <button type="submit">Submit Request</button>
            </form>
          </main>
        </body>
        </html>
      `;

      const report = AccessibilityAuditor.audit(validHtml);
      assert.strictEqual(report.passed, true);
      assert.strictEqual(report.score, 100);
      assert.strictEqual(report.violations.length, 0);
      assert.ok(report.passes.length >= 4);
    });

    test('identifies critical and serious accessibility defects with remediation guidance', () => {
      const badHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <!-- Missing title -->
        </head>
        <body>
          <h1>Heading 1</h1>
          <h3>Skipped Heading 3</h3>
          <img src="/photo.jpg" />
          <input type="text" id="bad-input" />
          <button id="icon-btn"></button>
          <div id="dup-id">A</div>
          <div id="dup-id">B</div>
        </body>
        </html>
      `;

      const report = AccessibilityAuditor.audit(badHtml);
      assert.strictEqual(report.passed, false);
      assert.ok(report.score < 50, `Score must reflect multiple penalties: ${report.score}`);

      const ruleIds = report.violations.map(v => v.rule);
      assert.ok(ruleIds.includes('HTML_LANG'), 'Must detect missing html lang');
      assert.ok(ruleIds.includes('PAGE_TITLE'), 'Must detect missing title');
      assert.ok(ruleIds.includes('IMAGE_ALT'), 'Must detect missing img alt');
      assert.ok(ruleIds.includes('FORM_LABEL'), 'Must detect unlabeled input');
      assert.ok(ruleIds.includes('EMPTY_BUTTON'), 'Must detect empty button');
      assert.ok(ruleIds.includes('DUPLICATE_ID'), 'Must detect duplicate ID');
      assert.ok(ruleIds.includes('HEADING_HIERARCHY'), 'Must detect skipped heading');

      const markdown = AccessibilityAuditor.formatReportMarkdown(report);
      assert.ok(markdown.includes('WCAG 2.1 Accessibility Audit Report'));
      assert.ok(markdown.includes('Violations:'));
    });
  });

  describe('3. Autonomous Browser Interaction & Test Scenario Runner', () => {
    test('enforces loopback security sandbox and rejects external targets', () => {
      assert.throws(() => {
        qaRunner.validateTargetUrl('https://malicious-external-site.com/exploit');
      }, /Security sandbox violation/);

      assert.throws(() => {
        qaRunner.validateTargetUrl('file:///etc/passwd');
      }, /Forbidden protocol/);

      const validUrl = qaRunner.validateTargetUrl(`${serverBaseUrl}/app`);
      assert.ok(validUrl.startsWith('http://127.0.0.1:'));
    });

    test('executes end-to-end user journey: navigate, fill form, click button, verify elements and a11y', async () => {
      const spec = {
        tenantId: 'tenant-qa-test',
        projectId: 'proj-qa-001',
        sessionName: 'Login Form Verification',
        targetUrl: `${serverBaseUrl}/app`,
        steps: [
          { action: StepActions.NAVIGATE, url: `${serverBaseUrl}/app` },
          { action: StepActions.ASSERT_ELEMENT, targetSelector: '#login-form', shouldExist: true },
          { action: StepActions.TYPE, targetSelector: '#username', payload: 'lead_developer' },
          { action: StepActions.CLICK, targetSelector: '#submit-btn' },
          { action: StepActions.ASSERT_TEXT, targetSelector: '#welcome-heading', payload: 'Welcome to Pulse App' },
          { action: StepActions.SCREENSHOT },
          { action: StepActions.A11Y_AUDIT }
        ]
      };

      const result = await qaRunner.executeSession(spec);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.status, SessionStatuses.PASSED);
      assert.strictEqual(result.totalSteps, 7);
      assert.strictEqual(result.passedSteps, 7);
      assert.strictEqual(result.failedSteps, 0);
      assert.ok(result.artifacts.length >= 2, 'Must capture screenshot and a11y artifacts');
    });

    test('handles interaction failure cleanly on disabled buttons and generates self-healing context', async () => {
      const spec = {
        tenantId: 'tenant-qa-test',
        projectId: 'proj-qa-002',
        sessionName: 'Disabled Button Failure Scenario',
        targetUrl: `${serverBaseUrl}/disabled-btn`,
        steps: [
          { action: StepActions.NAVIGATE, url: `${serverBaseUrl}/disabled-btn` },
          { action: StepActions.CLICK, targetSelector: '#action-btn' },
          { action: StepActions.ASSERT_TEXT, targetSelector: '#result', payload: 'Done' }
        ]
      };

      const result = await qaRunner.executeSession(spec);
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.status, SessionStatuses.FAILED);
      assert.strictEqual(result.failedSteps, 1);
      assert.strictEqual(result.steps[1].status, StepStatuses.FAILED);
      assert.ok(result.steps[1].errorMessage.includes('Cannot click disabled element'));
      assert.strictEqual(result.steps[2].status, StepStatuses.SKIPPED);

      const healingContext = qaRunner.generateHealingContext(result);
      assert.ok(healingContext.includes('Autonomous Browser QA Failure Report'));
      assert.ok(healingContext.includes('Cannot click disabled element'));
      assert.ok(healingContext.includes('Remediation Hint'));
    });
  });

  describe('4. Database Persistence & Orchestrator Integration', () => {
    test('persists QA sessions, steps, and artifacts in SQLite storage', async () => {
      const spec = {
        tenantId: 'tenant-db-test',
        projectId: 'proj-qa-persisted',
        sessionName: 'Persisted Suite Run',
        targetUrl: `${serverBaseUrl}/app`,
        steps: [
          { action: StepActions.NAVIGATE, url: `${serverBaseUrl}/app` },
          { action: StepActions.ASSERT_ELEMENT, targetSelector: '#welcome-heading' }
        ]
      };

      const result = await qaRunner.executeSession(spec);
      assert.strictEqual(result.passed, true);

      // Verify retrieval from storage
      const sessionRow = storage.getBrowserQASession(result.sessionId);
      assert.ok(sessionRow);
      assert.strictEqual(sessionRow.status, 'PASSED');
      assert.strictEqual(sessionRow.total_steps, 2);

      const stepRows = storage.listBrowserQASteps(result.sessionId);
      assert.strictEqual(stepRows.length, 2);
      assert.strictEqual(stepRows[0].action, StepActions.NAVIGATE);
      assert.strictEqual(stepRows[1].action, StepActions.ASSERT_ELEMENT);
    });

    test('Orchestrator exposes getBrowserQARunner() instance', () => {
      const orchestrator = new Orchestrator({ storage });
      const runner = orchestrator.getBrowserQARunner();
      assert.ok(runner instanceof BrowserTestRunner);
    });
  });
});
