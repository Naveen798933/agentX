import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { PulseStorage } from './storage.js';
import { EventStreamManager } from './eventStream.js';

export class PulseServer {
  constructor(options = {}) {
    this.port = options.port || Number(process.env.PORT) || 3001;
    this.host = options.host || '127.0.0.1';
    this.dbPath = options.dbPath || path.resolve('data/pulse_workspace.db');
    this.publicDir = options.publicDir || path.resolve('apps/collaborative-workspace/public');

    this.storage = new PulseStorage(this.dbPath);
    this.events = new EventStreamManager();

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  async handleRequest(req, res) {
    const parsed = new URL(req.url, 'http://localhost');
    const pathname = parsed.pathname;
    const method = req.method;

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // ── SSE Real-Time Stream ──────────────────────────────────────────────
      if (pathname === '/api/stream' && method === 'GET') {
        const lastId = req.headers['last-event-id'] || parsed.searchParams.get('lastEventId') || null;
        this.events.addClient(req, res, lastId);
        return;
      }

      // ── App Bootstrap (Instant Hydration) ─────────────────────────────────
      if (pathname === '/api/bootstrap' && method === 'GET') {
        const users = this.storage.getUsers();
        const channels = this.storage.getChannels();
        const tasks = this.storage.getTasks();
        const stats = this.storage.getStats();
        const recentActivity = this.storage.getActivityLogs(15);

        this.sendJson(res, 200, {
          status: 'ONLINE',
          connectedClients: this.events.getConnectedCount(),
          users,
          channels,
          tasks,
          stats,
          recentActivity
        });
        return;
      }

      // ── Users & Presence ──────────────────────────────────────────────────
      if (pathname === '/api/users' && method === 'GET') {
        this.sendJson(res, 200, this.storage.getUsers());
        return;
      }

      const userStatusMatch = pathname.match(/^\/api\/users\/([^/]+)\/status$/);
      if (userStatusMatch && method === 'POST') {
        const userId = userStatusMatch[1];
        const body = await this.readJsonBody(req);
        const updated = this.storage.updateUserStatus(userId, body.status);
        this.events.broadcast('USER_STATUS_CHANGED', updated);
        this.sendJson(res, 200, updated);
        return;
      }

      // ── Channels ──────────────────────────────────────────────────────────
      if (pathname === '/api/channels' && method === 'GET') {
        this.sendJson(res, 200, this.storage.getChannels());
        return;
      }

      if (pathname === '/api/channels' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const channel = this.storage.createChannel(body);
        this.storage.logActivity(body.creatorId || 'usr-marcus', 'CHANNEL_CREATED', `Created channel #${channel.name}`);
        this.events.broadcast('CHANNEL_CREATED', channel);
        this.sendJson(res, 201, channel);
        return;
      }

      // ── Messages ──────────────────────────────────────────────────────────
      const channelMsgsMatch = pathname.match(/^\/api\/channels\/([^/]+)\/messages$/);
      if (channelMsgsMatch && method === 'GET') {
        const channelId = channelMsgsMatch[1];
        const messages = this.storage.getMessages(channelId);
        this.sendJson(res, 200, messages);
        return;
      }

      if (channelMsgsMatch && method === 'POST') {
        const channelId = channelMsgsMatch[1];
        const body = await this.readJsonBody(req);
        const message = this.storage.createMessage({
          channelId,
          userId: body.userId || 'usr-sofia',
          content: body.content
        });

        this.storage.logActivity(message.user_id, 'MESSAGE_SENT', `Posted message in #${channelId}`);
        this.events.broadcast('MESSAGE_NEW', message);
        this.sendJson(res, 201, message);
        return;
      }

      // ── Typing Indicator ──────────────────────────────────────────────────
      const typingMatch = pathname.match(/^\/api\/channels\/([^/]+)\/typing$/);
      if (typingMatch && method === 'POST') {
        const channelId = typingMatch[1];
        const body = await this.readJsonBody(req);
        this.events.broadcast('TYPING_INDICATOR', {
          channelId,
          userId: body.userId,
          userName: body.userName || 'Someone'
        });
        this.sendJson(res, 200, { ok: true });
        return;
      }

      // ── Reactions ─────────────────────────────────────────────────────────
      const reactMatch = pathname.match(/^\/api\/messages\/([^/]+)\/react$/);
      if (reactMatch && method === 'POST') {
        const messageId = reactMatch[1];
        const body = await this.readJsonBody(req);
        const result = this.storage.toggleReaction({
          messageId,
          userId: body.userId || 'usr-sofia',
          emoji: body.emoji || '👍'
        });
        this.events.broadcast('REACTION_UPDATED', result);
        this.sendJson(res, 200, result);
        return;
      }

      // ── Tasks (Kanban) ────────────────────────────────────────────────────
      if (pathname === '/api/tasks' && method === 'GET') {
        this.sendJson(res, 200, this.storage.getTasks());
        return;
      }

      if (pathname === '/api/tasks' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const task = this.storage.createTask(body);
        this.storage.logActivity(body.creatorId || 'usr-sofia', 'TASK_CREATED', `Created task "${task.title}"`);
        this.events.broadcast('TASK_CREATED', task);
        this.sendJson(res, 201, task);
        return;
      }

      const taskStageMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/stage$/);
      if (taskStageMatch && method === 'PATCH') {
        const taskId = taskStageMatch[1];
        const body = await this.readJsonBody(req);
        const updated = this.storage.updateTaskStage(taskId, body.stage);
        this.storage.logActivity(body.userId || 'usr-marcus', 'TASK_MOVED', `Moved "${updated.title}" to ${body.stage.toUpperCase()}`);
        this.events.broadcast('TASK_MOVED', updated);
        this.sendJson(res, 200, updated);
        return;
      }

      const taskDeleteMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskDeleteMatch && method === 'DELETE') {
        const taskId = taskDeleteMatch[1];
        const result = this.storage.deleteTask(taskId);
        this.events.broadcast('TASK_DELETED', { id: taskId });
        this.sendJson(res, 200, result);
        return;
      }

      // ── Activity & Telemetry ──────────────────────────────────────────────
      if (pathname === '/api/activity' && method === 'GET') {
        this.sendJson(res, 200, this.storage.getActivityLogs(50));
        return;
      }

      if (pathname === '/api/stats' && method === 'GET') {
        this.sendJson(res, 200, {
          ...this.storage.getStats(),
          connectedClients: this.events.getConnectedCount()
        });
        return;
      }

      // ── Static Web UI ─────────────────────────────────────────────────────
      if (method === 'GET' || method === 'HEAD') {
        return this.serveStatic(req, res, pathname);
      }

      this.sendJson(res, 404, { error: 'Route not found' });
    } catch (err) {
      console.error('[PulseServer Error]', err);
      this.sendJson(res, 500, { error: err.message });
    }
  }

  serveStatic(req, res, pathname) {
    let relPath = pathname === '/' ? 'index.html' : pathname;
    let filePath = path.join(this.publicDir, relPath);

    if (!filePath.startsWith(this.publicDir + path.sep) && filePath !== this.publicDir) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      if (ext && ext !== '.html') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('File not found');
        return;
      }
      filePath = path.join(this.publicDir, 'index.html');
    }

    const finalExt = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon'
    };

    try {
      const headers = { 'Content-Type': mimeTypes[finalExt] || 'text/plain' };
      if (['.js', '.css', '.png', '.svg', '.ico'].includes(finalExt)) {
        headers['Cache-Control'] = 'public, max-age=3600';
      }
      res.writeHead(200, headers);
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      stream.on('error', () => {
        if (!res.headersSent) res.writeHead(500);
        res.end('Read error');
      });
    } catch (err) {
      if (!res.headersSent) res.writeHead(404);
      res.end('File not found');
    }
  }

  sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => {
        data += chunk;
        if (data.length > 1e6) {
          req.destroy();
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(new Error('Invalid JSON payload'));
        }
      });
      req.on('error', reject);
    });
  }

  start() {
    return new Promise(resolve => {
      this.server.listen(this.port, this.host, () => {
        console.log(`[Pulse Workspace] Real-Time Platform active at http://${this.host}:${this.port}`);
        resolve(`http://${this.host}:${this.port}`);
      });
    });
  }

  stop() {
    return new Promise(resolve => {
      this.events.close();
      this.server.close(() => {
        this.storage.close();
        resolve();
      });
    });
  }
}

// Standalone execution entrypoint
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('apps/collaborative-workspace/src/server.js')) {
  const port = process.env.PORT || 3001;
  const srv = new PulseServer({ port });
  srv.start();
}
