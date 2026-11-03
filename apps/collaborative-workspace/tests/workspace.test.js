import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { PulseStorage } from '../src/storage.js';
import { EventStreamManager } from '../src/eventStream.js';
import { PulseServer } from '../src/server.js';

describe('Pulse Real-Time Workspace: Storage Engine', () => {
  let storage;

  before(() => {
    storage = new PulseStorage(':memory:');
  });

  after(() => {
    storage.close();
  });

  test('seeds default users and channels on initialization', () => {
    const users = storage.getUsers();
    assert.ok(users.length >= 6);
    assert.ok(users.some(u => u.name === 'Sofia Ramos'));

    const channels = storage.getChannels();
    assert.ok(channels.length >= 5);
    assert.ok(channels.some(c => c.name === 'engineering'));
  });

  test('updates user presence status', () => {
    const updated = storage.updateUserStatus('usr-marcus', 'away');
    assert.equal(updated.status, 'away');

    const reset = storage.updateUserStatus('usr-marcus', 'online');
    assert.equal(reset.status, 'online');
  });

  test('creates new channel and prevents duplicates', () => {
    const ch = storage.createChannel({ name: 'infra-security', topic: 'K8s and container hardening' });
    assert.ok(ch.id.startsWith('c-'));
    assert.equal(ch.name, 'infra-security');

    const duplicate = storage.createChannel({ name: 'infra-security', topic: 'Different topic' });
    assert.equal(duplicate.id, ch.id);
  });

  test('creates message and calculates reactions', () => {
    const msg = storage.createMessage({
      channelId: 'c-engineering',
      userId: 'usr-david',
      content: 'Zero-latency SSE broadcast test message'
    });
    assert.ok(msg.id.startsWith('msg-'));
    assert.equal(msg.content, 'Zero-latency SSE broadcast test message');

    // Add reaction
    const rx1 = storage.toggleReaction({ messageId: msg.id, userId: 'usr-aria', emoji: '🚀' });
    assert.equal(rx1.action, 'ADDED');

    // Toggle same reaction removes it
    const rx2 = storage.toggleReaction({ messageId: msg.id, userId: 'usr-aria', emoji: '🚀' });
    assert.equal(rx2.action, 'REMOVED');
  });

  test('manages Kanban tasks across lifecycle stages', () => {
    const task = storage.createTask({
      title: 'Implement WebRTC audio rooms',
      description: 'Peer-to-peer audio channels for team huddles',
      stage: 'backlog',
      priority: 'high',
      assignedTo: 'usr-david',
      tags: 'webrtc,audio'
    });
    assert.equal(task.stage, 'backlog');
    assert.equal(task.priority, 'high');

    // Move to in_progress
    const inProg = storage.updateTaskStage(task.id, 'in_progress');
    assert.equal(inProg.stage, 'in_progress');

    // Move to done
    const done = storage.updateTaskStage(task.id, 'done');
    assert.equal(done.stage, 'done');

    // Delete task
    const del = storage.deleteTask(task.id);
    assert.equal(del.deleted, true);
    assert.equal(storage.getTask(task.id), null);
  });

  test('computes real-time workspace statistics', () => {
    const stats = storage.getStats();
    assert.ok(typeof stats.totalUsers === 'number');
    assert.ok(typeof stats.onlineUsers === 'number');
    assert.ok(typeof stats.totalChannels === 'number');
    assert.ok(typeof stats.totalMessages === 'number');
    assert.ok(typeof stats.totalTasks === 'number');
    assert.ok(typeof stats.taskCompletionRate === 'number');
  });
});

describe('Pulse Real-Time Workspace: SSE EventStream Manager', () => {
  let stream;

  before(() => {
    stream = new EventStreamManager();
  });

  after(() => {
    stream.close();
  });

  test('broadcasts events and buffers them for replay', () => {
    const evt1 = stream.broadcast('TEST_PULSE', { sample: 123 });
    assert.ok(evt1.id > 0);
    assert.equal(evt1.type, 'TEST_PULSE');

    const evt2 = stream.broadcast('TEST_PULSE_2', { sample: 456 });
    assert.ok(evt2.id > evt1.id);
    assert.equal(stream.eventBuffer.length >= 2, true);
  });
});

describe('Pulse Real-Time Workspace: Server & Endpoints', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = new PulseServer({ port: 3042, dbPath: ':memory:' });
    baseUrl = await server.start();
  });

  after(async () => {
    await server.stop();
  });

  test('GET /api/bootstrap returns full hydrated state', async () => {
    const res = await fetch(`${baseUrl}/api/bootstrap`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ONLINE');
    assert.ok(Array.isArray(data.users));
    assert.ok(Array.isArray(data.channels));
    assert.ok(Array.isArray(data.tasks));
    assert.ok(data.stats.totalUsers > 0);
  });

  test('POST /api/channels/:id/messages broadcasts message', async () => {
    const res = await fetch(`${baseUrl}/api/channels/c-engineering/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'usr-sofia', content: 'Testing live chat broadcast API' })
    });
    assert.equal(res.status, 201);
    const msg = await res.json();
    assert.equal(msg.content, 'Testing live chat broadcast API');
    assert.equal(msg.user_name, 'Sofia Ramos');
  });

  test('POST /api/tasks creates task and PATCH /api/tasks/:id/stage moves it', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Real-time sync test task',
        description: 'Verify live patch via API',
        stage: 'backlog',
        priority: 'urgent',
        assignedTo: 'usr-aria'
      })
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();

    const patchRes = await fetch(`${baseUrl}/api/tasks/${task.id}/stage`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'in_progress', userId: 'usr-aria' })
    });
    assert.equal(patchRes.status, 200);
    const updated = await patchRes.json();
    assert.equal(updated.stage, 'in_progress');
  });

  test('GET /api/stream establishes SSE keep-alive connection', async () => {
    return new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}/api/stream`, res => {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'text/event-stream');

        let received = '';
        res.on('data', chunk => {
          received += chunk.toString();
          if (received.includes(': connected at')) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on('error', reject);
    });
  });
});
