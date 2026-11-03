import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { SSRFGuard, DependencyGuard } from '../deploy/ssrfGuard.js';

export const PREVIEW_SECURITY_HEADERS = {
  'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-same-origin; default-src 'self' data: blob: https:; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; frame-ancestors 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer'
};

/**
 * PreviewSession Model
 * Represents a live preview instance for a synthesized or generated project.
 */
export class PreviewSession {
  constructor(projectId, options = {}) {
    this.sessionId = 'prev-' + crypto.randomUUID().slice(0, 8);
    this.projectId = projectId;
    this.runtimeType = options.runtimeType || 'static-spa'; // 'static-spa' | 'node-server' | 'custom'
    this.framework = options.framework || 'Vanilla Web Application';
    this.status = 'starting'; // 'starting' | 'ready' | 'updating' | 'error' | 'stopped'
    this.buildState = 'success'; // 'success' | 'outdated' | 'failed'
    this.port = options.port || null;
    this.process = null;
    this.url = `/api/projects/${projectId}/preview`;
    this.targetUrl = options.port ? `http://127.0.0.1:${options.port}` : null;
    this.startTime = Date.now();
    this.lastHealthCheck = Date.now();
    this.lastAccessed = Date.now();
    this.lastModified = Date.now();
    this.lastError = null;
    this.activeRoute = '/';
    this.logs = [];
    this.maxLogs = 100;
  }

  addLog(message, stream = 'system') {
    const entry = {
      timestamp: Date.now(),
      stream,
      message: String(message).trim()
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
  }

  touch() {
    this.lastAccessed = Date.now();
  }

  toJSON() {
    return {
      sessionId: this.sessionId,
      projectId: this.projectId,
      runtimeType: this.runtimeType,
      framework: this.framework,
      status: this.status,
      buildState: this.buildState,
      port: this.port,
      url: this.url,
      activeRoute: this.activeRoute,
      startTime: this.startTime,
      lastHealthCheck: this.lastHealthCheck,
      lastModified: this.lastModified,
      lastError: this.lastError,
      logsCount: this.logs.length
    };
  }
}

/**
 * PreviewManager
 * Manages runtime detection, isolated process execution, dynamic reverse-proxying,
 * live hot-reloading, and sandboxed iframe asset delivery for generated projects.
 */
export class PreviewManager {
  /**
   * @param {Object} deps
   * @param {import('../storage/db.js').StorageEngine} deps.storage
   * @param {import('../sandbox/sandboxExecutor.js').SandboxExecutor} deps.sandbox
   * @param {import('../core/eventBus.js').EventBus} deps.eventBus
   * @param {Object} [options]
   */
  constructor({ storage, sandbox, eventBus }, options = {}) {
    this.storage = storage;
    this.sandbox = sandbox;
    this.eventBus = eventBus;
    this.sessions = new Map(); // projectId -> PreviewSession
    this.portRangeStart = options.portRangeStart || 3200;
    this.portRangeEnd = options.portRangeEnd || 3800;
    this.idleTimeoutMs = options.idleTimeoutMs || 20 * 60 * 1000; // 20 min idle expiry

    // Periodic idle cleanup
    this.cleanupTimer = setInterval(() => this.cleanupIdleSessions(), 60000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /**
   * Find an available local TCP port
   */
  async allocateFreePort() {
    for (let port = this.portRangeStart; port <= this.portRangeEnd; port++) {
      // Check if already in use by active sessions
      const inUse = Array.from(this.sessions.values()).some(s => s.port === port);
      if (inUse) continue;

      const isFree = await new Promise((resolve) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', () => resolve(false));
        srv.listen(port, '127.0.0.1', () => {
          srv.close(() => resolve(true));
        });
      });

      if (isFree) return port;
    }
    throw new Error('No available ports in preview pool range');
  }

  /**
   * Detect project runtime and framework
   */
  detectProjectRuntime(projectId) {
    const files = this.sandbox.listFiles(projectId);
    let runtimeType = 'static-spa';
    let framework = 'Vanilla HTML/CSS/JavaScript';

    // Check for package.json
    if (files.includes('package.json')) {
      try {
        const pkgContent = this.sandbox.readFileSafely(projectId, 'package.json');
        const pkg = JSON.parse(pkgContent);
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

        let hasRunnableServer = false;
        const serverFile = files.find(f => f === 'src/server.js' || f === 'server.js');
        if (serverFile) {
          try {
            const serverCode = this.sandbox.readFileSafely(projectId, serverFile);
            if (serverCode.includes('.listen(') || serverCode.includes('createServer(') || serverCode.includes('express()')) {
              hasRunnableServer = true;
            }
          } catch (_) {}
        }

        if (deps.vite || (pkg.scripts && Object.values(pkg.scripts).some(s => s.includes('vite')))) {
          runtimeType = 'vite';
          framework = deps.react ? 'Vite + React' : deps.vue ? 'Vite + Vue' : 'Vite Web App';
        } else if (deps.next || (pkg.scripts && Object.values(pkg.scripts).some(s => s.includes('next')))) {
          runtimeType = 'nextjs';
          framework = 'Next.js App';
        } else if (deps.express || hasRunnableServer) {
          runtimeType = 'node-server';
          framework = 'Node.js Express Server';
        } else if (deps['@angular/core']) {
          framework = 'Angular App';
        } else if (deps.react) {
          framework = 'React Single-Page App';
        }
      } catch (_) {}
    }

    if (runtimeType === 'static-spa') {
      if (files.some(f => f === 'public/index.html' || f === 'index.html')) {
        framework = 'Interactive Single-Page Application';
      } else {
        framework = 'Autonomous Software API & Client';
      }
    }

    return { runtimeType, framework };
  }

  /**
   * Get or start a preview session for a project
   */
  async getOrCreateSession(projectId) {
    let session = this.sessions.get(projectId);
    if (!session || session.status === 'stopped') {
      session = await this.startSession(projectId);
    } else {
      session.touch();
    }
    return session;
  }

  /**
   * Start a new preview session
   */
  async startSession(projectId) {
    // Stop existing session if running
    if (this.sessions.has(projectId)) {
      await this.stopSession(projectId);
    }

    const { runtimeType, framework } = this.detectProjectRuntime(projectId);
    const session = new PreviewSession(projectId, { runtimeType, framework });
    this.sessions.set(projectId, session);

    session.addLog(`Initializing preview session (${framework})...`, 'system');

    try {
      // 1. Dependency validation in package.json
      const files = this.sandbox.listFiles(projectId);
      if (files.includes('package.json')) {
        try {
          const pkgRaw = this.sandbox.readFileSafely(projectId, 'package.json');
          const depCheck = DependencyGuard.scanPackageJson(pkgRaw);
          if (!depCheck.safe) {
            throw new Error(`Sandbox dependency validation failed: ${depCheck.errors.join('; ')}`);
          }
        } catch (err) {
          if (err.message.startsWith('Sandbox dependency validation failed:')) throw err;
        }
      }

      // Check if project has a standalone server that can be spawned
      let hasRunnableServer = false;
      const serverFile = files.find(f => f === 'src/server.js' || f === 'server.js');
      if (serverFile) {
        try {
          const serverCode = this.sandbox.readFileSafely(projectId, serverFile);
          if (serverCode.includes('.listen(') || serverCode.includes('createServer(') || serverCode.includes('express()')) {
            hasRunnableServer = true;
          }
        } catch (_) {}
      }

      if (hasRunnableServer && (runtimeType === 'node-server' || runtimeType === 'express')) {
        await this._startNodeServerProcess(session, projectId);
      } else {
        // Direct sandboxed Static SPA mode (zero overhead, instant response)
        session.status = 'ready';
        session.buildState = 'success';
        session.addLog(`Preview ready: static SPA / API preview mounted on ${session.url}`, 'system');
      }

      this.eventBus.publish('preview.session_started', {
        projectId,
        session: session.toJSON()
      });
    } catch (err) {
      session.status = 'error';
      session.buildState = 'failed';
      session.lastError = err.message;
      session.addLog(`Failed to start preview: ${err.message}`, 'stderr');
      throw err;
    }

    return session;
  }

  /**
   * Start child Node server process inside project sandbox
   */
  async _startNodeServerProcess(session, projectId) {
    const port = await this.allocateFreePort();
    session.port = port;
    session.targetUrl = `http://127.0.0.1:${port}`;
    session.addLog(`Allocated ephemeral preview port: ${port}`, 'system');

    const projectDir = this.sandbox.getProjectWorkspace(projectId);
    const serverScript = fs.existsSync(path.join(projectDir, 'src/server.js')) ? 'src/server.js' : 'server.js';

    // Sandbox execution environment
    const binDir = path.resolve('bin');
    const childEnv = {
      PATH: `${binDir}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'preview',
      PROJECT_DIR: projectDir
    };

    const nodeBin = fs.existsSync(path.join(binDir, 'node')) ? path.join(binDir, 'node') : 'node';

    // Validate server script syntax before spawning inside sandbox
    const syntaxCheck = spawnSync(nodeBin, ['--check', serverScript], {
      cwd: projectDir,
      timeout: 4000
    });
    if (syntaxCheck.status !== 0) {
      const syntaxErr = syntaxCheck.stderr ? syntaxCheck.stderr.toString('utf8').trim() : 'Syntax check failed';
      throw new Error(`Sandbox build validation failed: Node.js syntax error in ${serverScript}: ${syntaxErr}`);
    }

    const proc = spawn(nodeBin, [serverScript], {
      cwd: projectDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });

    session.process = proc;

    proc.stdout.on('data', (d) => {
      const text = d.toString('utf8');
      session.addLog(text, 'stdout');
    });

    proc.stderr.on('data', (d) => {
      const text = d.toString('utf8');
      session.addLog(text, 'stderr');
      if (session.status === 'ready') {
        session.buildState = 'outdated';
      }
    });

    proc.on('close', (code) => {
      session.addLog(`Process exited with code ${code}`, 'system');
      if (session.status !== 'stopped') {
        session.status = 'error';
        session.buildState = 'failed';
        session.lastError = `Server process exited unexpectedly (code ${code})`;
      }
    });

    // Wait for server health
    await this._waitForHealth(session, port, 8000);
    session.status = 'ready';
    session.buildState = 'success';
    session.addLog(`Server health verified at http://127.0.0.1:${port}`, 'system');
  }

  /**
   * Poll health check on allocated port
   */
  async _waitForHealth(session, port, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!session.process || session.process.killed) {
        throw new Error('Server process terminated before becoming healthy');
      }

      const isLive = await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 800 }, (res) => {
          resolve(true);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });

      if (isLive) {
        session.lastHealthCheck = Date.now();
        return true;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Server health check timed out after ${timeoutMs}ms`);
  }

  /**
   * Stop an active session and kill spawned process
   */
  async stopSession(projectId) {
    const session = this.sessions.get(projectId);
    if (!session) return;

    session.status = 'stopped';
    if (session.process) {
      try {
        if (session.process.pid) {
          process.kill(-session.process.pid, 'SIGTERM');
        } else {
          session.process.kill('SIGTERM');
        }
      } catch (_) {
        try { session.process.kill('SIGKILL'); } catch (__) {}
      }
      session.process = null;
    }
    session.addLog('Preview session stopped', 'system');
  }

  /**
   * Complete teardown and removal of preview session
   */
  async cleanupSession(projectId) {
    await this.stopSession(projectId);
    this.sessions.delete(projectId);
    this.eventBus.publish('preview.session_cleaned', { projectId });
    return { success: true, projectId, status: 'cleaned' };
  }

  /**
   * Restart an existing preview session
   */
  async restartSession(projectId) {
    await this.stopSession(projectId);
    return this.startSession(projectId);
  }

  /**
   * Handle file update and trigger hot reload
   */
  async handleFileChange(projectId, relPath, content) {
    const session = this.sessions.get(projectId);
    if (!session) return;

    session.lastModified = Date.now();
    session.addLog(`File updated: ${relPath} (${new Date().toLocaleTimeString()})`, 'system');

    // If server script updated and server running, restart process
    const isServerFile = relPath === 'src/server.js' || relPath === 'server.js' || relPath === 'package.json';
    if (isServerFile && session.process) {
      session.status = 'updating';
      try {
        await this.restartSession(projectId);
      } catch (err) {
        session.status = 'error';
        session.buildState = 'failed';
        session.lastError = err.message;
      }
    } else {
      session.buildState = 'success';
      session.status = 'ready';
    }

    // Broadcast reload notification
    this.eventBus.publish('preview.updated', {
      projectId,
      file: relPath,
      timestamp: Date.now(),
      status: session.status,
      buildState: session.buildState
    });
  }

  /**
   * Handle incoming preview HTTP request (reverse proxy or static asset delivery)
   */
  async handlePreviewRequest(req, res, projectId, subpath = '', tenantId = null) {
    const project = this.storage.getProject(projectId);
    if (!project) {
      res.writeHead(404, { 'Content-Type': 'application/json', ...PREVIEW_SECURITY_HEADERS });
      res.end(JSON.stringify({ error: 'Project not found' }));
      return;
    }

    const effectiveTenantId = tenantId || req.tenantId || req.headers?.['x-tenant-id'];
    if (effectiveTenantId && project.tenant_id && project.tenant_id !== effectiveTenantId) {
      res.writeHead(403, { 'Content-Type': 'application/json', ...PREVIEW_SECURITY_HEADERS });
      res.end(JSON.stringify({ error: `Forbidden: Tenant "${effectiveTenantId}" is not authorized to access project "${projectId}" preview` }));
      return;
    }

    const session = await this.getOrCreateSession(projectId);
    session.touch();

    // If running an isolated server, reverse-proxy HTTP request
    if (session.port && session.process && session.status === 'ready') {
      return this._proxyRequest(req, res, session, subpath);
    }

    // Static SPA file resolution with hot-reload bridge injection
    return this._serveStaticOrSynthetic(req, res, session, projectId, subpath);
  }

  /**
   * Reverse-proxy request to running internal server
   */
  _proxyRequest(req, res, session, subpath) {
    const targetPath = '/' + (subpath ? subpath.replace(/^\//, '') : '');
    const options = {
      hostname: '127.0.0.1',
      port: session.port,
      path: targetPath,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${session.port}` }
    };

    const proxyReq = http.request(options, (proxyRes) => {
      // Check for malicious redirects to cloud metadata or private IPs
      if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        const loc = proxyRes.headers.location;
        try {
          const parsed = new URL(loc, `http://127.0.0.1:${session.port}`);
          if (SSRFGuard.isRestrictedIp(parsed.hostname) && parsed.hostname !== '127.0.0.1') {
            res.writeHead(403, { 'Content-Type': 'application/json', ...PREVIEW_SECURITY_HEADERS });
            res.end(JSON.stringify({ error: `SSRF Blocked: Redirect to restricted destination "${loc}" is forbidden` }));
            return;
          }
        } catch (_) {}
      }

      // Check if text/html to inject hot reload bridge
      const contentType = proxyRes.headers['content-type'] || '';
      if (contentType.includes('text/html')) {
        let body = '';
        proxyRes.on('data', chunk => { body += chunk; });
        proxyRes.on('end', () => {
          const injected = this._injectBridgeScript(body, session.projectId);
          const headers = { ...proxyRes.headers, ...PREVIEW_SECURITY_HEADERS };
          delete headers['content-length'];
          headers['content-type'] = 'text/html; charset=utf-8';
          res.writeHead(proxyRes.statusCode, headers);
          res.end(injected);
        });
      } else {
        res.writeHead(proxyRes.statusCode, { ...proxyRes.headers, ...PREVIEW_SECURITY_HEADERS });
        proxyRes.pipe(res);
      }
    });

    proxyReq.on('error', (err) => {
      session.addLog(`Proxy error: ${err.message}`, 'stderr');
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', ...PREVIEW_SECURITY_HEADERS });
      res.end(`<h3>502 Bad Gateway</h3><p>Internal preview process not reachable: ${err.message}</p>`);
    });

    req.pipe(proxyReq);
  }

  /**
   * Serve static project files or dynamic synthetic preview
   */
  _serveStaticOrSynthetic(req, res, session, projectId, subpath) {
    const project = this.storage.getProject(projectId);
    if (!project) {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...PREVIEW_SECURITY_HEADERS });
      res.end('Project not found');
      return;
    }

    const files = this.sandbox.listFiles(projectId);
    let cleanSub = subpath ? subpath.replace(/^\/+/, '') : '';

    // If root or route navigation, look for index.html (SPA Fallback)
    let isHtmlRoute = !cleanSub || !path.extname(cleanSub);
    let targetFile = cleanSub;

    if (isHtmlRoute) {
      targetFile = files.find(f => f === 'public/index.html' || f === 'index.html');
      if (cleanSub) session.activeRoute = '/' + cleanSub;
    } else {
      if (!files.includes(targetFile) && files.includes(`public/${targetFile}`)) {
        targetFile = `public/${targetFile}`;
      }
    }

    if (targetFile && files.includes(targetFile)) {
      try {
        const content = this.sandbox.readFileSafely(projectId, targetFile);
        const ext = path.extname(targetFile).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.mjs': 'application/javascript; charset=utf-8',
          '.json': 'application/json',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.ico': 'image/x-icon'
        };

        if (ext === '.html' || isHtmlRoute) {
          const injected = this._injectBridgeScript(content, projectId);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            ...PREVIEW_SECURITY_HEADERS,
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          });
          res.end(injected);
          return;
        }

        res.writeHead(200, {
          'Content-Type': mimeTypes[ext] || 'text/plain; charset=utf-8',
          ...PREVIEW_SECURITY_HEADERS,
          'Cache-Control': 'no-cache'
        });
        res.end(content);
        return;
      } catch (err) {
        session.addLog(`Error reading static file: ${err.message}`, 'stderr');
      }
    }

    // Dynamic interactive fallback application when no custom HTML is created yet
    const syntheticHtml = this._buildSyntheticPreviewHtml(project, files, session);
    const injected = this._injectBridgeScript(syntheticHtml, projectId);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      ...PREVIEW_SECURITY_HEADERS,
      'Cache-Control': 'no-cache'
    });
    res.end(injected);
  }

  /**
   * Inject real-time browser preview bridge script into served HTML
   */
  _injectBridgeScript(html, projectId) {
    const bridgeScript = `
<!-- __SYNAPSE_LIVE_PREVIEW_BRIDGE__ -->
<script id="__synapse_bridge__">
(function() {
  function sendRoute() {
    try {
      window.parent.postMessage({
        type: 'SYNAPSE_ROUTE_CHANGED',
        projectId: '${projectId}',
        pathname: window.location.pathname,
        search: window.location.search,
        title: document.title
      }, '*');
    } catch (_) {}
  }

  window.addEventListener('load', sendRoute);
  window.addEventListener('popstate', sendRoute);

  document.addEventListener('click', function(e) {
    const a = e.target.closest('a');
    if (a && a.href && a.origin === window.location.origin) {
      setTimeout(sendRoute, 60);
    }
  });

  window.addEventListener('message', function(e) {
    if (!e.data || typeof e.data !== 'object') return;
    if (e.data.type === 'SYNAPSE_NAVIGATE') {
      const target = e.data.path || '/';
      if (window.location.pathname !== target) {
        if (window.history && window.history.pushState) {
          window.history.pushState({}, '', target);
          sendRoute();
        } else {
          window.location.pathname = target;
        }
      }
    } else if (e.data.type === 'SYNAPSE_HOT_RELOAD') {
      window.location.reload();
    }
  });

  window.addEventListener('error', function(err) {
    try {
      window.parent.postMessage({
        type: 'SYNAPSE_RUNTIME_ERROR',
        projectId: '${projectId}',
        message: err.message,
        filename: err.filename,
        lineno: err.lineno
      }, '*');
    } catch (_) {}
  });
})();
</script>
`;
    if (html.includes('</body>')) {
      return html.replace('</body>', `${bridgeScript}</body>`);
    }
    return html + bridgeScript;
  }

  /**
   * Dynamic synthetic preview when project code is in progress
   */
  _buildSyntheticPreviewHtml(project, files, session) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(project.name)} — Live Software Preview</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #080c14; color: #f1f5f9; padding: 24px; min-height: 100vh; }
    .badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); margin-bottom: 12px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; box-shadow: 0 0 8px #10b981; }
    h1 { font-size: 24px; font-weight: 800; background: linear-gradient(135deg, #38bdf8, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 8px; }
    p { color: #94a3b8; font-size: 14px; margin-bottom: 20px; line-height: 1.5; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
    .card { background: rgba(18, 26, 43, 0.7); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 18px; backdrop-filter: blur(8px); }
    .card h3 { font-size: 15px; font-weight: 600; color: #e2e8f0; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; }
    .file-pill { display: inline-block; background: rgba(255, 255, 255, 0.06); padding: 4px 8px; border-radius: 6px; font-size: 12px; font-family: monospace; color: #cbd5e1; margin: 3px; }
    .btn { display: inline-block; background: linear-gradient(135deg, #38bdf8, #6366f1); color: #fff; font-weight: 600; padding: 8px 16px; border-radius: 8px; text-decoration: none; border: none; cursor: pointer; font-size: 13px; }
    .btn:hover { opacity: 0.9; transform: translateY(-1px); }
  </style>
</head>
<body>
  <div class="badge"><span class="status-dot"></span>Live Virtual Software House Build</div>
  <h1>${escapeHtml(project.name)}</h1>
  <p>${escapeHtml(project.description || 'Autonomous application running inside secure isolated sandbox environment.')}</p>
  <div class="grid">
    <div class="card">
      <h3><span>Synthesized Workspace Files (${files.length})</span></h3>
      <div>${files.map(f => `<span class="file-pill">${escapeHtml(f)}</span>`).join('')}</div>
      <div style="margin-top: 16px;">
        <button class="btn" onclick="alert('Live preview active and connected.')">Ping Preview Health</button>
      </div>
    </div>
    <div class="card">
      <h3><span>Runtime Environment</span></h3>
      <p style="font-size: 13px; color: #cbd5e1; line-height: 1.6;">
        Framework: <strong>${escapeHtml(session.framework)}</strong><br>
        Mode: <strong>${escapeHtml(session.runtimeType)}</strong><br>
        Status: <strong style="color: #10b981;">● ${escapeHtml(session.status.toUpperCase())}</strong>
      </p>
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * Periodic idle session cleanup
   */
  cleanupIdleSessions() {
    const now = Date.now();
    for (const [projectId, session] of this.sessions.entries()) {
      if (now - session.lastAccessed > this.idleTimeoutMs) {
        this.stopSession(projectId).catch(() => {});
        this.sessions.delete(projectId);
      }
    }
  }

  /**
   * Stop all active preview processes on server shutdown
   */
  async shutdownAll() {
    clearInterval(this.cleanupTimer);
    for (const projectId of this.sessions.keys()) {
      await this.stopSession(projectId).catch(() => {});
    }
    this.sessions.clear();
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}
