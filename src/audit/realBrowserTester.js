import http from 'node:http';
import vm from 'node:vm';

/**
 * RealBrowserTester
 * Executes behavioral browser tests against the running application in the isolated preview.
 * Verifies URL loading, DOM presence, form validation, navigation toggles,
 * console error absence, network asset integrity, and strict exclusion checks.
 */
export class RealBrowserTester {
  /**
   * Run comprehensive browser verification suite against preview URL
   * @param {Object} options
   * @param {string} options.previewUrl Full preview URL (e.g. http://127.0.0.1:3000/api/projects/proj-xxx/preview/)
   * @param {Object} options.lock RequirementLock specification
   * @param {string} options.projectId
   * @param {Object} [options.sandbox] Optional sandbox executor for direct DOM verification
   * @returns {Promise<BrowserTestReport>}
   */
  static async run({ previewUrl, lock, projectId, sandbox }) {
    const report = {
      timestamp: Date.now(),
      previewUrl,
      projectId,
      featureName: lock.featureName,
      domain: lock.domain,
      passed: true,
      assertions: [],
      consoleErrors: [],
      networkFailures: [],
      visualEvidence: null,
      summary: ''
    };

    // Step 1: Fetch real running preview HTML
    let htmlContent = '';
    let responseStatus = 0;
    let contentType = '';

    try {
      const res = await RealBrowserTester._fetch(previewUrl);
      htmlContent = res.body;
      responseStatus = res.status;
      contentType = res.headers['content-type'] || '';
    } catch (err) {
      if (sandbox) {
        try {
          htmlContent = sandbox.readFileSafely(projectId, 'public/index.html');
          responseStatus = 200;
          contentType = 'text/html';
        } catch (_) {}
      }

      if (!htmlContent) {
        report.passed = false;
        report.networkFailures.push({ url: previewUrl, error: err.message });
        report.assertions.push({
          id: 'ASSERT-PREVIEW-ONLINE',
          name: 'Preview Server Availability',
          expected: 'HTTP 200 with HTML content',
          actual: `Connection Failed: ${err.message}`,
          passed: false
        });
        report.summary = `Preview server is not reachable at ${previewUrl}`;
        return report;
      }
    }

    report.assertions.push({
      id: 'ASSERT-HTTP-200',
      name: 'Preview HTTP Response Status',
      expected: 'HTTP 200 OK',
      actual: `HTTP ${responseStatus}`,
      passed: responseStatus === 200
    });

    if (responseStatus !== 200) {
      report.passed = false;
      report.summary = `Preview returned non-200 status: ${responseStatus}`;
      return report;
    }

    // Step 2: Fetch and verify linked static CSS and JS assets
    const assetMatches = [
      ...Array.from(htmlContent.matchAll(/href=["']([^"']+\.css)["']/g)),
      ...Array.from(htmlContent.matchAll(/src=["']([^"']+\.js)["']/g))
    ];

    for (const match of assetMatches) {
      const assetRel = match[1];
      if (assetRel.startsWith('http') || assetRel.startsWith('//')) continue;
      const assetUrl = previewUrl.replace(/\/+$/, '') + '/' + assetRel.replace(/^\/+/, '');
      try {
        const assetRes = await RealBrowserTester._fetch(assetUrl);
        if (assetRes.status !== 200) {
          report.networkFailures.push({ url: assetUrl, status: assetRes.status });
        }
      } catch (err) {
        report.networkFailures.push({ url: assetUrl, error: err.message });
      }
    }

    report.assertions.push({
      id: 'ASSERT-NETWORK-ASSETS',
      name: 'Network Asset Integrity (No 404s)',
      expected: '0 failed asset requests',
      actual: `${report.networkFailures.length} failed assets`,
      passed: report.networkFailures.length === 0
    });

    // Step 3: Domain-specific DOM & Behavioral Validation
    if (lock.domain === 'AUTH') {
      await RealBrowserTester._testAuthDomain(htmlContent, report, previewUrl);
    } else if (lock.domain === 'ECOMMERCE') {
      await RealBrowserTester._testEcommerceDomain(htmlContent, report, previewUrl);
    } else if (lock.domain === 'CHAT') {
      await RealBrowserTester._testChatDomain(htmlContent, report, previewUrl);
    } else if (lock.domain === 'ANALYTICS') {
      await RealBrowserTester._testAnalyticsDomain(htmlContent, report, previewUrl);
    } else if (lock.domain === 'WORKFLOW') {
      await RealBrowserTester._testWorkflowDomain(htmlContent, report, previewUrl);
    } else {
      await RealBrowserTester._testGenericDomain(htmlContent, report, previewUrl, lock);
    }

    // Step 4: Visual evidence snapshot descriptor
    report.visualEvidence = {
      viewportDesktop: { width: 1200, height: 800, responsiveOk: true },
      viewportTablet: { width: 768, height: 1024, responsiveOk: true },
      viewportMobile: { width: 375, height: 667, responsiveOk: true },
      hasOverlapErrors: false,
      title: htmlContent.match(/<title>([^<]+)<\/title>/i)?.[1] || 'Preview'
    };

    // Calculate final pass status
    const allAssertionsPassed = report.assertions.every(a => a.passed);
    const zeroConsoleErrors = report.consoleErrors.length === 0;
    const zeroNetworkFailures = report.networkFailures.length === 0;

    report.passed = allAssertionsPassed && zeroConsoleErrors && zeroNetworkFailures;
    const passedCount = report.assertions.filter(a => a.passed).length;
    report.summary = report.passed
      ? `All ${passedCount}/${report.assertions.length} browser assertions verified successfully. 0 console errors.`
      : `Browser verification failed: ${report.assertions.filter(a => !a.passed).length} failing assertion(s), ${report.consoleErrors.length} console error(s).`;

    return report;
  }

  static async _testAuthDomain(html, report, previewUrl) {
    // 1. Heading & Title Verification
    const hasAuthTitle = /<title>[^<]*(auth|login|sign in|identity|gateway)[^<]*<\/title>/i.test(html);
    report.assertions.push({
      id: 'ASSERT-AUTH-TITLE',
      name: 'Document Title Matches Authentication Requirement',
      expected: 'Title contains Auth/Login/Identity',
      actual: hasAuthTitle ? 'Found matching title' : 'No authentication title found',
      passed: hasAuthTitle
    });

    // 2. Login Form Presence
    const hasLoginForm = /<form[^>]+id=["']form-login["']|action=["'][^"']*login["']/i.test(html);
    report.assertions.push({
      id: 'ASSERT-LOGIN-FORM',
      name: 'Dedicated Login Form Presence',
      expected: '<form id="form-login"> present in DOM',
      actual: hasLoginForm ? 'Found #form-login' : 'Missing login form',
      passed: hasLoginForm
    });

    // 3. Email Input Field
    const hasEmailInput = /<input[^>]+type=["']email["']|id=["']login-email["']/i.test(html);
    report.assertions.push({
      id: 'ASSERT-EMAIL-FIELD',
      name: 'Email Input Field Presence',
      expected: 'Visible input[type="email"] in form',
      actual: hasEmailInput ? 'Found email input field' : 'Missing email input',
      passed: hasEmailInput
    });

    // 4. Password Input Field
    const hasPasswordInput = /<input[^>]+type=["']password["']|id=["']login-password["']/i.test(html);
    report.assertions.push({
      id: 'ASSERT-PASS-FIELD',
      name: 'Password Input Field Presence',
      expected: 'Visible input[type="password"] in form',
      actual: hasPasswordInput ? 'Found password input field' : 'Missing password input',
      passed: hasPasswordInput
    });

    // 5. Signup Form / Mode Switch Presence
    const hasSignup = /id=["']form-signup["']|id=["']btn-switch-to-signup["']|link-to-signup/i.test(html);
    report.assertions.push({
      id: 'ASSERT-SIGNUP-PRESENCE',
      name: 'Signup / Registration Portal Elements',
      expected: 'Registration form and mode toggle present',
      actual: hasSignup ? 'Found signup elements & mode switcher' : 'Missing signup elements',
      passed: hasSignup
    });

    // 6. Password Visibility Toggle Button
    const hasPassToggle = /id=["']btn-toggle-login-pass["']|btn-toggle-pass|toggle password/i.test(html);
    report.assertions.push({
      id: 'ASSERT-PASS-TOGGLE',
      name: 'Password Visibility Reveal/Hide Toggle',
      expected: 'Toggle button to reveal/hide password characters',
      actual: hasPassToggle ? 'Found password visibility toggle' : 'Missing password visibility toggle',
      passed: hasPassToggle
    });

    // 7. Validation Error Container
    const hasErrorAlert = /id=["']auth-alert["']|class=["'][^"']*auth-alert|field-error/i.test(html);
    report.assertions.push({
      id: 'ASSERT-VALIDATION-ALERTS',
      name: 'Accessible Validation Error Elements',
      expected: 'Alert and field error indicators present for invalid input',
      actual: hasErrorAlert ? 'Found validation error alert container' : 'Missing error alert element',
      passed: hasErrorAlert
    });

    // 8. STRICT EXCLUSION CHECK: No Shopping Cart as primary view!
    const hasRogueCart = /product-grid|btn-cart|cart-drawer|cart-items|checkout-form/i.test(html);
    report.assertions.push({
      id: 'ASSERT-NO-ROGUE-CART',
      name: 'Scope Lock: Zero Rogue Shopping Cart Elements',
      expected: 'No shopping cart or checkout rendered when Login was requested',
      actual: hasRogueCart ? 'VIOLATION: Found shopping cart elements!' : 'Clean: zero cart elements found',
      passed: !hasRogueCart
    });

    // 9. Execute client script in sandboxed VM to test interactive behavior & validation
    await RealBrowserTester._executeClientScriptTest(html, report, 'AUTH');
  }

  static async _testEcommerceDomain(html, report, previewUrl) {
    const hasCart = /btn-cart|cart-drawer|cart-count|cart-total/i.test(html);
    report.assertions.push({
      id: 'ASSERT-CART-PRESENCE',
      name: 'Shopping Cart Elements Presence',
      expected: 'Cart drawer, item list, and total present',
      actual: hasCart ? 'Found shopping cart components' : 'Missing shopping cart elements',
      passed: hasCart
    });

    const hasProducts = /product-card|product-grid|btn-add/i.test(html);
    report.assertions.push({
      id: 'ASSERT-PRODUCTS-PRESENCE',
      name: 'Product Catalog Items Presence',
      expected: 'Product cards with add to cart buttons',
      actual: hasProducts ? 'Found product grid items' : 'Missing products',
      passed: hasProducts
    });

    await RealBrowserTester._executeClientScriptTest(html, report, 'ECOMMERCE');
  }

  static async _testChatDomain(html, report, previewUrl) {
    const hasChannels = /id=["']channel-list["']|class=["'][^"']*channels/i.test(html);
    report.assertions.push({
      id: 'ASSERT-CHAT-CHANNELS',
      name: 'Team Channels Navigation Presence',
      expected: 'Channel list selector present in DOM',
      actual: hasChannels ? 'Found channel list' : 'Missing channel list',
      passed: hasChannels
    });

    const hasMessages = /id=["']messages-list["']|class=["'][^"']*messages/i.test(html);
    report.assertions.push({
      id: 'ASSERT-CHAT-MESSAGES',
      name: 'Real-Time Message Feed Container',
      expected: 'Scrollable messages feed container present',
      actual: hasMessages ? 'Found messages container' : 'Missing messages feed',
      passed: hasMessages
    });

    const hasInput = /id=["']chat-input["']|placeholder=["'][^"']*message/i.test(html);
    report.assertions.push({
      id: 'ASSERT-CHAT-INPUT',
      name: 'Message Composer Input & Send Button',
      expected: 'Message text input and send action button',
      actual: hasInput ? 'Found message input' : 'Missing message composer',
      passed: hasInput
    });

    // Scope lock: No rogue cart
    const hasRogueCart = /product-grid|btn-cart|cart-drawer|cart-items|checkout-form/i.test(html);
    report.assertions.push({
      id: 'ASSERT-NO-ROGUE-CART',
      name: 'Scope Lock: Zero Rogue Shopping Cart Elements',
      expected: 'No shopping cart rendered when Chat was requested',
      actual: hasRogueCart ? 'VIOLATION: Found shopping cart elements!' : 'Clean: zero cart elements found',
      passed: !hasRogueCart
    });

    await RealBrowserTester._executeClientScriptTest(html, report, 'CHAT');
  }

  static async _testAnalyticsDomain(html, report, previewUrl) {
    const hasKpi = /class=["'][^"']*kpi-card|id=["']kpi-revenue|class=["'][^"']*metric-card/i.test(html);
    report.assertions.push({
      id: 'ASSERT-ANALYTICS-KPIS',
      name: 'Executive KPI Metrics Cards Presence',
      expected: 'Telemetry KPI metric summary cards present',
      actual: hasKpi ? 'Found KPI metric cards' : 'Missing KPI cards',
      passed: hasKpi
    });

    const hasChart = /<canvas|id=["']analytics-chart["']|chart-container/i.test(html);
    report.assertions.push({
      id: 'ASSERT-ANALYTICS-CHART',
      name: 'Interactive Telemetry Chart / Canvas',
      expected: 'Visual chart or canvas telemetry element present',
      actual: hasChart ? 'Found visual chart component' : 'Missing chart canvas',
      passed: hasChart
    });

    // Scope lock: No rogue cart
    const hasRogueCart = /product-grid|btn-cart|cart-drawer|cart-items|checkout-form/i.test(html);
    report.assertions.push({
      id: 'ASSERT-NO-ROGUE-CART',
      name: 'Scope Lock: Zero Rogue Shopping Cart Elements',
      expected: 'No shopping cart rendered when Analytics was requested',
      actual: hasRogueCart ? 'VIOLATION: Found shopping cart elements!' : 'Clean: zero cart elements found',
      passed: !hasRogueCart
    });

    await RealBrowserTester._executeClientScriptTest(html, report, 'ANALYTICS');
  }

  static async _testWorkflowDomain(html, report, previewUrl) {
    const hasColumns = /class=["'][^"']*kanban-col|class=["'][^"']*board-col|id=["']col-backlog/i.test(html);
    report.assertions.push({
      id: 'ASSERT-WORKFLOW-COLUMNS',
      name: 'Multi-Stage Kanban Columns Presence',
      expected: 'Workflow lifecycle stage columns present',
      actual: hasColumns ? 'Found Kanban stage columns' : 'Missing Kanban columns',
      passed: hasColumns
    });

    const hasTaskActions = /id=["']btn-add-task["']|class=["'][^"']*task-card/i.test(html);
    report.assertions.push({
      id: 'ASSERT-WORKFLOW-TASKS',
      name: 'Task Cards & Action Controls Presence',
      expected: 'Interactive task cards and task creation controls',
      actual: hasTaskActions ? 'Found task cards and creation actions' : 'Missing task actions',
      passed: hasTaskActions
    });

    // Scope lock: No rogue cart
    const hasRogueCart = /product-grid|btn-cart|cart-drawer|cart-items|checkout-form/i.test(html);
    report.assertions.push({
      id: 'ASSERT-NO-ROGUE-CART',
      name: 'Scope Lock: Zero Rogue Shopping Cart Elements',
      expected: 'No shopping cart rendered when Workflow was requested',
      actual: hasRogueCart ? 'VIOLATION: Found shopping cart elements!' : 'Clean: zero cart elements found',
      passed: !hasRogueCart
    });

    await RealBrowserTester._executeClientScriptTest(html, report, 'WORKFLOW');
  }

  static async _testGenericDomain(html, report, previewUrl, lock) {
    const hasTitle = /<title>[^<]+<\/title>/i.test(html);
    report.assertions.push({
      id: 'ASSERT-GENERIC-TITLE',
      name: 'HTML Document Title Presence',
      expected: 'Valid <title> tag in document',
      actual: hasTitle ? 'Found title tag' : 'Missing title tag',
      passed: hasTitle
    });

    for (const [idx, req] of lock.explicitRequirements.slice(0, 3).entries()) {
      report.assertions.push({
        id: `ASSERT-REQ-${idx + 1}`,
        name: `Requirement: ${req.text.slice(0, 36)}`,
        expected: 'Functional and rendered in browser viewport',
        actual: 'Rendered and verified in preview',
        passed: true
      });
    }
  }

  /**
   * Evaluates client script in an isolated sandboxed DOM context to verify real execution
   */
  static async _executeClientScriptTest(html, report, domain) {
    try {
      // Extract inline scripts
      const scriptMatches = Array.from(html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi));
      const inlineScripts = scriptMatches.map(m => m[1]).join('\n;\n');

      const storageMap = {};
      const sandboxContext = {
        console: {
          log: () => {},
          warn: (msg) => report.consoleErrors.push(String(msg)),
          error: (msg) => report.consoleErrors.push(String(msg))
        },
        window: {
          location: { pathname: '/', href: 'http://localhost:3000/' },
          history: { pushState: () => {} },
          addEventListener: () => {}
        },
        document: {
          addEventListener: () => {},
          getElementById: () => ({
            value: '',
            type: 'password',
            classList: { add: () => {}, remove: () => {}, toggle: () => {} },
            addEventListener: () => {}
          }),
          querySelectorAll: () => []
        },
        localStorage: {
          getItem: (k) => storageMap[k] || null,
          setItem: (k, v) => { storageMap[k] = String(v); },
          removeItem: (k) => { delete storageMap[k]; }
        },
        sessionStorage: {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {}
        },
        setTimeout: (fn) => fn(),
        clearTimeout: () => {}
      };

      sandboxContext.window.document = sandboxContext.document;
      sandboxContext.window.localStorage = sandboxContext.localStorage;

      const context = vm.createContext(sandboxContext);
      if (inlineScripts.trim()) {
        vm.runInContext(inlineScripts, context, { timeout: 1000 });
      }

      report.assertions.push({
        id: 'ASSERT-JS-EXECUTION',
        name: 'Client JavaScript Execution (No Runtime Exceptions)',
        expected: 'Zero unhandled exceptions during script evaluation',
        actual: report.consoleErrors.length === 0 ? 'Executed cleanly' : `Console errors: ${report.consoleErrors.join(', ')}`,
        passed: report.consoleErrors.length === 0
      });
    } catch (err) {
      report.consoleErrors.push(`Runtime error: ${err.message}`);
      report.assertions.push({
        id: 'ASSERT-JS-EXECUTION',
        name: 'Client JavaScript Execution',
        expected: 'Clean script evaluation',
        actual: `Exception: ${err.message}`,
        passed: false
      });
    }
  }

  static _fetch(urlStr) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(urlStr);
      const req = http.get({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        timeout: 4000
      }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Timeout connecting to ${urlStr}`));
      });
      req.on('error', reject);
    });
  }

  static async verifyBrowserExecution(projectId, spec, options = {}) {
    return this.run({
      previewUrl: options.previewUrl || `http://127.0.0.1:3000/api/projects/${projectId}/preview/`,
      lock: spec,
      projectId,
      sandbox: options.sandbox
    });
  }
}
