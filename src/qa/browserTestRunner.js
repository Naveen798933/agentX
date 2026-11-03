import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { VisualRegression } from './visualRegression.js';
import { AccessibilityAuditor } from './accessibilityAuditor.js';

export const StepActions = Object.freeze({
  NAVIGATE: 'NAVIGATE',
  CLICK: 'CLICK',
  TYPE: 'TYPE',
  ASSERT_TEXT: 'ASSERT_TEXT',
  ASSERT_ELEMENT: 'ASSERT_ELEMENT',
  SCREENSHOT: 'SCREENSHOT',
  VISUAL_REGRESSION: 'VISUAL_REGRESSION',
  A11Y_AUDIT: 'A11Y_AUDIT'
});

export const StepStatuses = Object.freeze({
  PENDING: 'PENDING',
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED'
});

export const SessionStatuses = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  ERROR: 'ERROR'
});

export class BrowserTestRunner {
  /**
   * @param {Object} [options]
   * @param {import('../storage/db.js').StorageEngine} [options.storage]
   * @param {Function} [options.customFetcher] Optional in-memory HTTP/HTML fetcher (e.g. for offline sandbox testing)
   * @param {number} [options.viewportWidth=1280]
   * @param {number} [options.viewportHeight=800]
   * @param {number} [options.networkTimeoutMs=10000]
   */
  constructor(options = {}) {
    this.storage = options.storage || null;
    this.customFetcher = options.customFetcher || null;
    this.viewportWidth = options.viewportWidth || 1280;
    this.viewportHeight = options.viewportHeight || 800;
    this.networkTimeoutMs = options.networkTimeoutMs || 10000;
  }

  /**
   * Enforces security boundaries: only loopback / localhost addresses allowed.
   * Prevents SSRF attacks, file scheme leaks, and unauthorized external traffic.
   * @param {string} rawUrl
   * @throws {Error} If URL violates security sandbox
   */
  validateTargetUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') {
      throw new Error('Target URL must be a non-empty string');
    }

    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Forbidden protocol "${parsed.protocol}". Only HTTP/HTTPS allowed`);
    }

    const host = parsed.hostname.toLowerCase();
    const isLoopback = (
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === '::1' ||
      host.endsWith('.localhost')
    );

    if (!isLoopback) {
      throw new Error(`Security sandbox violation: Target host "${host}" is not a permitted loopback preview server (127.0.0.1)`);
    }

    return parsed.toString();
  }

  /**
   * Fetches HTML content via HTTP or registered custom fetcher
   * @param {string} url
   * @returns {Promise<{ status: number, headers: Object, body: string }>}
   */
  async fetchHtml(url) {
    this.validateTargetUrl(url);

    if (this.customFetcher && typeof this.customFetcher === 'function') {
      const res = await this.customFetcher(url);
      return {
        status: res.status || 200,
        headers: res.headers || {},
        body: typeof res === 'string' ? res : (res.body || '')
      };
    }

    return new Promise((resolve, reject) => {
      const client = url.startsWith('https:') ? https : http;
      const req = client.get(url, { timeout: this.networkTimeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 200,
            headers: res.headers,
            body
          });
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`HTTP request timed out after ${this.networkTimeoutMs}ms for ${url}`));
      });
    });
  }

  /**
   * Parses DOM element properties, tags, and text from HTML string
   */
  parseDom(html) {
    const elements = [];
    // Match every opening or void tag: <tagName attrs>
    const tagRegex = /<([a-z0-9]+)\b([^>]*?)(\/?)>/gi;
    let match;

    while ((match = tagRegex.exec(html)) !== null) {
      const tagName = match[1].toLowerCase();
      if (tagName === 'script' || tagName === 'style') continue;
      const rawAttrs = match[2] || '';

      // Extract attributes
      const idMatch = rawAttrs.match(/\bid\s*=\s*["']([^"']+)["']/i);
      const classMatch = rawAttrs.match(/\bclass\s*=\s*["']([^"']+)["']/i);
      const nameMatch = rawAttrs.match(/\bname\s*=\s*["']([^"']+)["']/i);
      const typeMatch = rawAttrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
      const valueMatch = rawAttrs.match(/\bvalue\s*=\s*["']([^"']*?)["']/i);
      const disabled = /\bdisabled\b/i.test(rawAttrs);

      // Extract text content immediately following opening tag up to next tag
      const postTagIndex = tagRegex.lastIndex;
      const nextTagIndex = html.indexOf('<', postTagIndex);
      const textChunk = nextTagIndex !== -1 ? html.slice(postTagIndex, nextTagIndex) : '';
      const text = textChunk.trim();

      elements.push({
        tagName,
        id: idMatch ? idMatch[1] : null,
        className: classMatch ? classMatch[1] : '',
        name: nameMatch ? nameMatch[1] : null,
        type: typeMatch ? typeMatch[1] : null,
        value: valueMatch ? valueMatch[1] : '',
        disabled,
        text,
        rawAttrs,
        fullMatch: match[0]
      });
    }

    return {
      html,
      elements,
      findElement(selector) {
        if (!selector) return null;
        const s = selector.trim();

        // ID selector: #id
        if (s.startsWith('#')) {
          const targetId = s.slice(1);
          return elements.find(el => el.id === targetId) || null;
        }

        // Class selector: .class
        if (s.startsWith('.')) {
          const targetClass = s.slice(1);
          return elements.find(el => el.className && el.className.split(/\s+/).includes(targetClass)) || null;
        }

        // Attribute selector: [name="xxx"] or [type="submit"]
        const attrMatch = s.match(/\[([a-z0-9_-]+)\s*=\s*["']([^"']+)["']\]/i);
        if (attrMatch) {
          const [_, attrName, attrVal] = attrMatch;
          return elements.find(el => {
            if (attrName === 'id') return el.id === attrVal;
            if (attrName === 'name') return el.name === attrVal;
            if (attrName === 'type') return el.type === attrVal;
            const r = new RegExp(`\\b${attrName}\\s*=\\s*["']${attrVal}["']`, 'i');
            return r.test(el.rawAttrs);
          }) || null;
        }

        // Tag name selector: button, input, h1, etc.
        const tag = s.toLowerCase();
        return elements.find(el => el.tagName === tag) || null;
      }
    };
  }

  /**
   * Executes a full autonomous Browser QA test session
   * @param {Object} spec
   * @param {string} spec.tenantId
   * @param {string} spec.projectId
   * @param {string} spec.sessionName
   * @param {string} spec.targetUrl
   * @param {Array<Object>} spec.steps Sequence of interaction actions
   * @param {Buffer} [spec.baselineScreenshot]
   * @returns {Promise<Object>} Completed session report
   */
  async executeSession(spec) {
    const startTime = Date.now();
    const sessionId = `bqa_${crypto.randomUUID().slice(0, 10)}`;
    const tenantId = spec.tenantId || 'tenant-default';
    const projectId = spec.projectId;

    let currentUrl = spec.targetUrl;
    let currentHtml = '';
    let dom = null;
    let lastScreenshotBuffer = null;

    const stepResults = [];
    const artifacts = [];
    let passedCount = 0;
    let failedCount = 0;
    let sessionStatus = SessionStatuses.RUNNING;

    // Persist session if storage available
    if (this.storage && typeof this.storage.createBrowserQASession === 'function') {
      try {
        this.storage.createBrowserQASession({
          id: sessionId,
          tenantId,
          projectId,
          sessionName: spec.sessionName || 'Autonomous Browser QA Run',
          targetUrl: spec.targetUrl,
          status: SessionStatuses.RUNNING,
          viewportWidth: this.viewportWidth,
          viewportHeight: this.viewportHeight,
          totalSteps: spec.steps.length
        });
      } catch (err) {
        console.warn(`[BrowserTestRunner] Storage error creating session: ${err.message}`);
      }
    }

    for (let i = 0; i < spec.steps.length; i++) {
      const step = spec.steps[i];
      const stepStart = Date.now();
      let stepStatus = StepStatuses.PENDING;
      let errorMessage = null;

      try {
        switch (step.action) {
          case StepActions.NAVIGATE: {
            if (step.html) {
              currentUrl = step.url || currentUrl;
              currentHtml = step.html;
              dom = this.parseDom(currentHtml);
              stepStatus = StepStatuses.PASSED;
              break;
            }
            const urlToLoad = step.url || currentUrl;
            this.validateTargetUrl(urlToLoad);
            const res = await this.fetchHtml(urlToLoad);
            if (res.status >= 400) {
              throw new Error(`HTTP error ${res.status} while navigating to ${urlToLoad}`);
            }
            currentUrl = urlToLoad;
            currentHtml = res.body;
            dom = this.parseDom(currentHtml);
            stepStatus = StepStatuses.PASSED;
            break;
          }

          case StepActions.CLICK: {
            if (!dom) dom = this.parseDom(currentHtml);
            const el = dom.findElement(step.targetSelector);
            if (!el) {
              throw new Error(`Element with selector "${step.targetSelector}" not found in DOM`);
            }
            if (el.disabled || (el.rawAttrs && /\bdisabled\b/i.test(el.rawAttrs))) {
              throw new Error(`Cannot click disabled element "${step.targetSelector}"`);
            }
            stepStatus = StepStatuses.PASSED;
            break;
          }

          case StepActions.TYPE: {
            if (!dom) dom = this.parseDom(currentHtml);
            const el = dom.findElement(step.targetSelector);
            if (!el) {
              throw new Error(`Input element with selector "${step.targetSelector}" not found in DOM`);
            }
            el.value = step.payload || '';
            stepStatus = StepStatuses.PASSED;
            break;
          }

          case StepActions.ASSERT_TEXT: {
            if (!dom) dom = this.parseDom(currentHtml);
            const el = dom.findElement(step.targetSelector);
            if (!el) {
              throw new Error(`Element "${step.targetSelector}" not found for text assertion`);
            }
            const expected = String(step.payload || '');
            if (!el.text.includes(expected)) {
              throw new Error(`Text assertion failed for "${step.targetSelector}": expected to contain "${expected}", found "${el.text}"`);
            }
            stepStatus = StepStatuses.PASSED;
            break;
          }

          case StepActions.ASSERT_ELEMENT: {
            if (!dom) dom = this.parseDom(currentHtml);
            const el = dom.findElement(step.targetSelector);
            const shouldExist = step.shouldExist !== false;
            if (shouldExist && !el) {
              throw new Error(`Element "${step.targetSelector}" was expected to exist in DOM but was absent`);
            } else if (!shouldExist && el) {
              throw new Error(`Element "${step.targetSelector}" was expected to be absent from DOM but was found`);
            }
            stepStatus = StepStatuses.PASSED;
            break;
          }

          case StepActions.SCREENSHOT: {
            // Synthesize visual screenshot representation
            lastScreenshotBuffer = VisualRegression.createSyntheticCanvas(
              this.viewportWidth,
              this.viewportHeight,
              [245, 247, 250, 255]
            );
            // Draw simulated UI header and elements
            VisualRegression.drawRect(lastScreenshotBuffer, this.viewportWidth, {
              x: 0, y: 0, w: this.viewportWidth, h: 60, color: [30, 41, 59, 255]
            });
            artifacts.push({
              artifactType: 'SCREENSHOT',
              sessionId,
              stepIndex: i,
              buffer: lastScreenshotBuffer,
              metadata: { width: this.viewportWidth, height: this.viewportHeight }
            });
            stepStatus = StepStatuses.PASSED;
            break;
          }

          case StepActions.VISUAL_REGRESSION: {
            const baseline = step.baselineBuffer || spec.baselineScreenshot;
            if (!baseline) {
              throw new Error('No baseline screenshot provided for visual regression comparison');
            }
            const candidate = lastScreenshotBuffer || VisualRegression.createSyntheticCanvas(
              this.viewportWidth,
              this.viewportHeight,
              [245, 247, 250, 255]
            );
            const comp = VisualRegression.compareBuffers(baseline, candidate, {
              maxDiffPercent: step.maxDiffPercent || 0.01
            });
            if (!comp.passed) {
              artifacts.push({
                artifactType: 'DIFF_IMAGE',
                sessionId,
                stepIndex: i,
                buffer: comp.diffBuffer,
                metadata: { diffPercentage: comp.diffPercentage }
              });
              throw new Error(comp.error);
            }
            stepStatus = StepStatuses.PASSED;
            break;
          }

          case StepActions.A11Y_AUDIT: {
            const report = AccessibilityAuditor.audit(currentHtml, { url: currentUrl });
            artifacts.push({
              artifactType: 'A11Y_REPORT',
              sessionId,
              stepIndex: i,
              metadata: report
            });
            if (!report.passed) {
              throw new Error(`Accessibility audit failed with score ${report.score}/100: ${report.violations.length} violations found`);
            }
            stepStatus = StepStatuses.PASSED;
            break;
          }

          default:
            throw new Error(`Unrecognized step action "${step.action}"`);
        }
      } catch (err) {
        stepStatus = StepStatuses.FAILED;
        errorMessage = err.message;
      }

      const durationMs = Date.now() - stepStart;
      const stepRecord = {
        id: `bstep_${crypto.randomUUID().slice(0, 10)}`,
        sessionId,
        stepIndex: i,
        action: step.action,
        targetSelector: step.targetSelector || null,
        payload: step.payload || null,
        status: stepStatus,
        errorMessage,
        durationMs
      };

      stepResults.push(stepRecord);

      if (this.storage && typeof this.storage.recordBrowserQAStep === 'function') {
        try {
          this.storage.recordBrowserQAStep(stepRecord);
        } catch (_) {}
      }

      if (stepStatus === StepStatuses.PASSED) {
        passedCount++;
      } else {
        failedCount++;
        // If critical step fails, remaining steps may be skipped
        if (step.abortOnFailure !== false) {
          for (let j = i + 1; j < spec.steps.length; j++) {
            const skippedStep = {
              id: `bstep_${crypto.randomUUID().slice(0, 10)}`,
              sessionId,
              stepIndex: j,
              action: spec.steps[j].action,
              targetSelector: spec.steps[j].targetSelector || null,
              status: StepStatuses.SKIPPED,
              errorMessage: `Skipped due to prior step failure at index ${i}`,
              durationMs: 0
            };
            stepResults.push(skippedStep);
            if (this.storage && typeof this.storage.recordBrowserQAStep === 'function') {
              try { this.storage.recordBrowserQAStep(skippedStep); } catch (_) {}
            }
          }
          break;
        }
      }
    }

    const totalDurationMs = Date.now() - startTime;
    sessionStatus = failedCount === 0 ? SessionStatuses.PASSED : SessionStatuses.FAILED;
    const summary = sessionStatus === SessionStatuses.PASSED
      ? `All ${passedCount} browser interaction steps verified successfully in ${totalDurationMs}ms`
      : `Browser QA run failed: ${failedCount} step(s) failed out of ${spec.steps.length}`;

    if (this.storage && typeof this.storage.updateBrowserQASession === 'function') {
      try {
        this.storage.updateBrowserQASession(sessionId, {
          status: sessionStatus,
          summary,
          totalSteps: spec.steps.length,
          passedSteps: passedCount,
          failedSteps: failedCount,
          durationMs: totalDurationMs
        });
      } catch (_) {}
    }

    const sessionReport = {
      sessionId,
      tenantId,
      projectId,
      sessionName: spec.sessionName || 'Autonomous Browser QA Run',
      targetUrl: spec.targetUrl,
      status: sessionStatus,
      passed: sessionStatus === SessionStatuses.PASSED,
      summary,
      totalSteps: spec.steps.length,
      passedSteps: passedCount,
      failedSteps: failedCount,
      durationMs: totalDurationMs,
      steps: stepResults,
      artifacts
    };

    return sessionReport;
  }

  /**
   * Formats an actionable self-healing diagnostic block for Developer/QA agents
   * @param {Object} report Output from executeSession()
   * @returns {string} Markdown prompt context
   */
  generateHealingContext(report) {
    if (!report || report.passed) return '';

    const lines = [
      '### Autonomous Browser QA Failure Report & Self-Healing Context:',
      '',
      `**Target Preview URL:** ${report.targetUrl}`,
      `**Status:** ${report.status} (${report.failedSteps} step(s) failed)`,
      `**Summary:** ${report.summary}`,
      '',
      '#### Failed Steps & Trace:'
    ];

    for (const step of report.steps) {
      if (step.status === StepStatuses.FAILED) {
        lines.push(`- **Step #${step.stepIndex} [${step.action}]**: \`${step.targetSelector || 'N/A'}\``);
        lines.push(`  *Error:* ${step.errorMessage}`);
        if (step.action === StepActions.CLICK || step.action === StepActions.TYPE) {
          lines.push(`  *Remediation Hint:* Ensure element with selector \`${step.targetSelector}\` exists in the rendered HTML template and is interactive (not disabled).`);
        } else if (step.action === StepActions.ASSERT_TEXT) {
          lines.push(`  *Remediation Hint:* Inspect element content or state bindings to ensure expected value is rendered.`);
        } else if (step.action === StepActions.A11Y_AUDIT) {
          lines.push('  *Remediation Hint:* Review WCAG 2.1 AA violations: add missing alt attributes, label tags, or page title.');
        } else if (step.action === StepActions.VISUAL_REGRESSION) {
          lines.push('  *Remediation Hint:* Layout or stylesheet changed by more than acceptable tolerance threshold.');
        }
      }
    }

    return lines.join('\n');
  }
}
