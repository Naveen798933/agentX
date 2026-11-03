import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class PulseStorage {
  constructor(dbPath = ':memory:') {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this._initSchema();
    this._seedDefaults();
  }

  _initSchema() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        avatar TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'online', -- online, away, busy, offline
        color TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        topic TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT '#',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES channels(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS reactions (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (message_id, user_id, emoji),
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        stage TEXT NOT NULL DEFAULT 'backlog', -- backlog, in_progress, review, done
        priority TEXT NOT NULL DEFAULT 'medium', -- low, medium, high, urgent
        assigned_to TEXT,
        tags TEXT, -- comma separated
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (assigned_to) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        type TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  _seedDefaults() {
    const channelCount = this.db.prepare('SELECT COUNT(*) as count FROM channels').get().count;
    if (channelCount > 0) return;

    // Seed default team members
    const seedUsers = [
      { id: 'usr-sofia', name: 'Sofia Ramos', role: 'Product Lead', avatar: '👩‍💼', status: 'online', color: '#f472b6' },
      { id: 'usr-marcus', name: 'Marcus Vance', role: 'System Architect', avatar: '👨‍💻', status: 'online', color: '#a78bfa' },
      { id: 'usr-david', name: 'David Chen', role: 'Senior Backend Engineer', avatar: '🚀', status: 'busy', color: '#60a5fa' },
      { id: 'usr-aria', name: 'Aria Patel', role: 'Lead Frontend UI/UX', avatar: '🎨', status: 'online', color: '#2dd4bf' },
      { id: 'usr-quinn', name: 'Quinn Sterling', role: 'QA Automation Lead', avatar: '🧪', status: 'away', color: '#fbbf24' },
      { id: 'usr-devon', name: 'Devon Kross', role: 'DevOps & SecOps', avatar: '🛡️', status: 'online', color: '#f87171' }
    ];

    const insertUser = this.db.prepare(`
      INSERT INTO users (id, name, role, avatar, status, color, last_active_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const u of seedUsers) {
      insertUser.run(u.id, u.name, u.role, u.avatar, u.status, u.color, now);
    }

    // Seed channels
    const seedChannels = [
      { id: 'c-general', name: 'general', topic: 'Company-wide announcements and team updates', icon: '📢' },
      { id: 'c-engineering', name: 'engineering', topic: 'Architecture discussions, API contracts, and PR reviews', icon: '⚡' },
      { id: 'c-design', name: 'design-systems', topic: 'UI/UX mockups, glassmorphic tokens, and micro-interactions', icon: '🎨' },
      { id: 'c-product', name: 'product-roadmap', topic: 'User stories, sprint backlogs, and metrics telemetry', icon: '📋' },
      { id: 'c-releases', name: 'releases-deploy', topic: 'Automated CI/CD pipelines and production gate signoffs', icon: '🚀' }
    ];

    const insertChannel = this.db.prepare(`
      INSERT INTO channels (id, name, topic, icon, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const c of seedChannels) {
      insertChannel.run(c.id, c.name, c.topic, c.icon, now);
    }

    // Seed initial messages in #engineering
    const seedMessages = [
      {
        id: 'msg-01', channel_id: 'c-engineering', user_id: 'usr-marcus',
        content: 'System architecture definition complete: EventBus + SSE stream provides sub-5ms broadcast latency with zero external npm dependencies. 📐',
        pinned: 1, created_at: new Date(Date.now() - 3600000).toISOString()
      },
      {
        id: 'msg-02', channel_id: 'c-engineering', user_id: 'usr-david',
        content: 'SQLite in WAL mode is configured with prepared statement pooling. Read throughput benchmarks look blazing fast.',
        pinned: 0, created_at: new Date(Date.now() - 2400000).toISOString()
      },
      {
        id: 'msg-03', channel_id: 'c-engineering', user_id: 'usr-aria',
        content: 'I hooked up the glassmorphic theme tokens. We have real-time typing indicators and optimistic UI updates for chat & Kanban! ✨',
        pinned: 0, created_at: new Date(Date.now() - 1200000).toISOString()
      },
      {
        id: 'msg-04', channel_id: 'c-general', user_id: 'usr-sofia',
        content: 'Welcome to the Pulse Collaborative Workspace! All teams can coordinate live across channels and the synchronized task board.',
        pinned: 1, created_at: new Date(Date.now() - 5000000).toISOString()
      }
    ];

    const insertMsg = this.db.prepare(`
      INSERT INTO messages (id, channel_id, user_id, content, pinned, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const m of seedMessages) {
      insertMsg.run(m.id, m.channel_id, m.user_id, m.content, m.pinned, m.created_at);
    }

    // Seed reactions
    const insertReaction = this.db.prepare(`
      INSERT INTO reactions (id, message_id, user_id, emoji, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertReaction.run('rx-1', 'msg-01', 'usr-david', '🚀', now);
    insertReaction.run('rx-2', 'msg-01', 'usr-aria', '🔥', now);
    insertReaction.run('rx-3', 'msg-03', 'usr-sofia', '❤️', now);

    // Seed initial tasks
    const seedTasks = [
      {
        id: 'task-101', title: 'Real-Time SSE Event Broadcast Engine',
        description: 'Multiplex channel messages, presence status, and Kanban stage changes over keep-alive connection.',
        stage: 'done', priority: 'urgent', assigned_to: 'usr-david', tags: 'core,backend,realtime'
      },
      {
        id: 'task-102', title: 'Interactive Multi-Column Kanban Board',
        description: 'Drag & drop task stage movements with optimistic updates and live multi-client broadcast.',
        stage: 'in_progress', priority: 'high', assigned_to: 'usr-aria', tags: 'frontend,ui,kanban'
      },
      {
        id: 'task-103', title: 'End-to-End WebSocket & SSE Stress Tests',
        description: 'Simulate 50 concurrent client connections with message bursting and latency measurement.',
        stage: 'review', priority: 'medium', assigned_to: 'usr-quinn', tags: 'qa,load-testing'
      },
      {
        id: 'task-104', title: 'Role-Based Operator Approval Modal',
        description: 'Cryptographic signature checkpoint before staging deployments reach production cluster.',
        stage: 'backlog', priority: 'high', assigned_to: 'usr-devon', tags: 'security,devops'
      },
      {
        id: 'task-105', title: 'Multi-Channel Emoji Reactions & Mentions',
        description: 'Allow instant reactions with emoji counter aggregates and @team mentions.',
        stage: 'done', priority: 'medium', assigned_to: 'usr-marcus', tags: 'chat,ux'
      }
    ];

    const insertTask = this.db.prepare(`
      INSERT INTO tasks (id, title, description, stage, priority, assigned_to, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const t of seedTasks) {
      insertTask.run(t.id, t.title, t.description, t.stage, t.priority, t.assigned_to, t.tags, now, now);
    }

    // Seed activity log
    this.logActivity('usr-sofia', 'WORKSPACE_INITIALIZED', 'Pulse Collaborative Workspace created with default channels and team members.');
  }

  // --- Users ---
  getUsers() {
    return this.db.prepare('SELECT * FROM users ORDER BY name ASC').all();
  }

  getUser(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
  }

  updateUserStatus(id, status) {
    const valid = ['online', 'away', 'busy', 'offline'];
    if (!valid.includes(status)) status = 'online';
    const now = new Date().toISOString();
    this.db.prepare('UPDATE users SET status = ?, last_active_at = ? WHERE id = ?').run(status, now, id);
    return this.getUser(id);
  }

  // --- Channels ---
  getChannels() {
    const channels = this.db.prepare('SELECT * FROM channels ORDER BY name ASC').all();
    const countStmt = this.db.prepare('SELECT COUNT(*) as msgCount FROM messages WHERE channel_id = ?');
    return channels.map(c => ({
      ...c,
      messageCount: countStmt.get(c.id).msgCount
    }));
  }

  getChannel(id) {
    return this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) || null;
  }

  createChannel({ name, topic, icon = '#' }) {
    const cleanName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const existing = this.db.prepare('SELECT * FROM channels WHERE name = ?').get(cleanName);
    if (existing) return existing;

    const id = 'c-' + crypto.randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO channels (id, name, topic, icon, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, cleanName, topic || '', icon, now);
    return this.getChannel(id);
  }

  // --- Messages ---
  getMessages(channelId, limit = 100) {
    const msgs = this.db.prepare(`
      SELECT m.*, u.name as user_name, u.role as user_role, u.avatar as user_avatar, u.color as user_color
      FROM messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = ?
      ORDER BY m.created_at ASC
      LIMIT ?
    `).all(channelId, limit);

    const rxStmt = this.db.prepare(`
      SELECT emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as user_ids
      FROM reactions
      WHERE message_id = ?
      GROUP BY emoji
    `);

    return msgs.map(m => {
      const reactions = rxStmt.all(m.id).map(r => ({
        emoji: r.emoji,
        count: Number(r.count),
        users: r.user_ids ? r.user_ids.split(',') : []
      }));
      return { ...m, reactions };
    });
  }

  createMessage({ channelId, userId, content }) {
    if (!content || !content.trim()) throw new Error('Message content cannot be empty');
    const id = 'msg-' + crypto.randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO messages (id, channel_id, user_id, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, channelId, userId, content.trim(), now);

    const user = this.getUser(userId);
    return {
      id,
      channel_id: channelId,
      user_id: userId,
      user_name: user?.name || 'User',
      user_role: user?.role || 'Member',
      user_avatar: user?.avatar || '👤',
      user_color: user?.color || '#38bdf8',
      content: content.trim(),
      pinned: 0,
      created_at: now,
      reactions: []
    };
  }

  toggleReaction({ messageId, userId, emoji }) {
    const existing = this.db.prepare(`
      SELECT id FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?
    `).get(messageId, userId, emoji);

    if (existing) {
      this.db.prepare('DELETE FROM reactions WHERE id = ?').run(existing.id);
      return { action: 'REMOVED', emoji, messageId, userId };
    } else {
      const id = 'rx-' + crypto.randomUUID().slice(0, 8);
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO reactions (id, message_id, user_id, emoji, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, messageId, userId, emoji, now);
      return { action: 'ADDED', emoji, messageId, userId };
    }
  }

  // --- Tasks (Kanban) ---
  getTasks() {
    return this.db.prepare(`
      SELECT t.*, u.name as assignee_name, u.avatar as assignee_avatar, u.color as assignee_color
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      ORDER BY t.updated_at DESC
    `).all();
  }

  createTask({ title, description, stage = 'backlog', priority = 'medium', assignedTo, tags = '' }) {
    if (!title || !title.trim()) throw new Error('Task title cannot be empty');
    const id = 'task-' + crypto.randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO tasks (id, title, description, stage, priority, assigned_to, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title.trim(), description || '', stage, priority, assignedTo || null, tags || '', now, now);

    return this.getTask(id);
  }

  getTask(id) {
    return this.db.prepare(`
      SELECT t.*, u.name as assignee_name, u.avatar as assignee_avatar, u.color as assignee_color
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.id = ?
    `).get(id) || null;
  }

  updateTaskStage(id, stage) {
    const valid = ['backlog', 'in_progress', 'review', 'done'];
    if (!valid.includes(stage)) throw new Error(`Invalid stage: ${stage}`);
    const now = new Date().toISOString();
    this.db.prepare('UPDATE tasks SET stage = ?, updated_at = ? WHERE id = ?').run(stage, now, id);
    return this.getTask(id);
  }

  deleteTask(id) {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return { id, deleted: true };
  }

  // --- Activity Log ---
  logActivity(userId, type, description) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO activity_log (user_id, type, description, created_at)
      VALUES (?, ?, ?, ?)
    `).run(userId || null, type, description, now);
  }

  getActivityLogs(limit = 30) {
    return this.db.prepare(`
      SELECT a.*, u.name as user_name, u.avatar as user_avatar, u.color as user_color
      FROM activity_log a
      LEFT JOIN users u ON a.user_id = u.id
      ORDER BY a.id DESC
      LIMIT ?
    `).all(limit);
  }

  // --- Stats Telemetry ---
  getStats() {
    const totalUsers = this.db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const onlineUsers = this.db.prepare("SELECT COUNT(*) as c FROM users WHERE status = 'online'").get().c;
    const totalChannels = this.db.prepare('SELECT COUNT(*) as c FROM channels').get().c;
    const totalMessages = this.db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
    const totalTasks = this.db.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
    const doneTasks = this.db.prepare("SELECT COUNT(*) as c FROM tasks WHERE stage = 'done'").get().c;

    return {
      totalUsers,
      onlineUsers,
      totalChannels,
      totalMessages,
      totalTasks,
      doneTasks,
      taskCompletionRate: totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0
    };
  }

  close() {
    this.db.close();
  }
}
