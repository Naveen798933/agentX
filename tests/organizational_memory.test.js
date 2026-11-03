import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { MemoryService, MemoryTypes, MarkdownChunker, AstCodeChunker } from '../src/memory/index.js';
import { StorageEngine } from '../src/storage/db.js';

describe('V2.0 — Persistent Organizational Vector Memory Suite', () => {
  let tmpDir;
  let dbPath;
  let storage;
  let memoryService;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-memory-test-'));
    dbPath = path.join(tmpDir, 'test_memory.db');
    storage = new StorageEngine(dbPath);
    memoryService = new MemoryService({ storage });
  });

  after(() => {
    try {
      storage.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  describe('1. Document & Code Chunking Engines', () => {
    test('MarkdownChunker partitions markdown documents preserving hierarchical headers', () => {
      const doc = `
# System Architecture Plan

Overview of platform components.

## Subsystem 1: Gateway
Details on the REST API and WebSocket gateway.

### 1.1 Authentication
Scrypt password hashing and JWT access tokens.

## Subsystem 2: Worker Queues
BullMQ and Redis background processors.
      `.trim();

      const chunks = MarkdownChunker.chunk(doc);
      assert.ok(chunks.length >= 3, 'Must extract at least 3 semantic chunks');

      const headings = chunks.map(c => c.sectionHeading);
      assert.ok(headings.includes('Subsystem 1: Gateway'));
      assert.ok(headings.includes('1.1 Authentication'));
      assert.ok(headings.includes('Subsystem 2: Worker Queues'));

      for (const chunk of chunks) {
        assert.strictEqual(chunk.title, 'System Architecture Plan');
        assert.ok(chunk.content.length > 0);
      }
    });

    test('AstCodeChunker extracts top-level functions and classes with line boundaries', () => {
      const code = `
export class UserService {
  constructor() {
    this.name = 'user';
  }

  getUser(id) {
    return { id, active: true };
  }
}

export async function hashPassword(plain) {
  const salt = 'salt123';
  return plain + salt;
}
      `.trim();

      const chunks = AstCodeChunker.chunk(code, 'src/user.js');
      assert.strictEqual(chunks.length, 2, 'Must extract class and function chunks');

      const classChunk = chunks.find(c => c.name === 'UserService');
      assert.ok(classChunk);
      assert.strictEqual(classChunk.type, 'CLASS');
      assert.ok(classChunk.content.includes('class UserService'));

      const funcChunk = chunks.find(c => c.name === 'hashPassword');
      assert.ok(funcChunk);
      assert.strictEqual(funcChunk.type, 'FUNCTION');
      assert.ok(funcChunk.content.includes('async function hashPassword'));
    });
  });

  describe('2. Vector Embeddings & Math Engine', () => {
    test('generateEmbedding produces deterministic normalized 64-dimensional unit vectors', () => {
      const textA = 'Authentication and password security using scrypt hashing';
      const vec1 = memoryService.generateEmbedding(textA);
      const vec2 = memoryService.generateEmbedding(textA);

      assert.strictEqual(vec1.length, 64);
      assert.deepStrictEqual(vec1, vec2, 'Embedding generation must be deterministic');

      // Verify unit length (magnitude ≈ 1.0)
      let magnitude = 0;
      for (const v of vec1) magnitude += v * v;
      assert.ok(Math.abs(Math.sqrt(magnitude) - 1.0) < 0.01, 'Vector must have unit length');
    });

    test('cosineSimilarity calculates 1.0 for identical vectors and lower score for distinct concepts', () => {
      const vecAuth = memoryService.generateEmbedding('jwt refresh token authentication');
      const vecAuthDuplicate = memoryService.generateEmbedding('jwt refresh token authentication');
      const vecDocker = memoryService.generateEmbedding('docker container cgroups alpine linux');

      const scoreIdentical = memoryService.cosineSimilarity(vecAuth, vecAuthDuplicate);
      assert.ok(Math.abs(scoreIdentical - 1.0) < 0.001, 'Identical vectors must score ~1.0');

      const scoreDistinct = memoryService.cosineSimilarity(vecAuth, vecDocker);
      assert.ok(scoreDistinct < 0.6, `Distinct concepts must have low similarity: ${scoreDistinct}`);
    });
  });

  describe('3. Ingestion, Semantic Vector Search & Tenant Partitioning', () => {
    test('ingests ADRs, Security Rules, and Bug Fixes, and retrieves top match semantically', async () => {
      // Ingest ADR
      await memoryService.ingest({
        tenantId: 'tenant-memory-test',
        memoryType: MemoryTypes.ADR,
        title: 'ADR-008: Multi-Model Gateway Failover',
        content: 'Implement circuit breaker pattern and automatic fallback cascade across Claude, Gemini and DeepSeek.',
        sourceFile: 'docs/ADR-008.md'
      });

      // Ingest Security Rule
      await memoryService.ingest({
        tenantId: 'tenant-memory-test',
        memoryType: MemoryTypes.SECURITY_RULE,
        title: 'SEC-004: Scrypt Password Hashing and Brute Force Lockout',
        content: 'Passwords must be hashed using scrypt with unique salts. Trigger 15-minute lockout after 5 failed login attempts.',
        sourceFile: 'docs/SECURITY.md'
      });

      // Ingest Bug Fix
      await memoryService.ingest({
        tenantId: 'tenant-memory-test',
        memoryType: MemoryTypes.BUG_FIX,
        title: 'BUG-014: Cookie Splitting Base64 Truncation Fix',
        content: 'Fixed cookie parsing by using slice at indexOf("=") instead of split("=") to preserve base64 padding characters.',
        sourceFile: 'src/auth/tokenService.js'
      });

      // Query 1: Security & Password Search
      const searchSec = await memoryService.search({
        tenantId: 'tenant-memory-test',
        query: 'how to hash passwords securely and handle lockout',
        limit: 3
      });

      assert.ok(searchSec.length > 0, 'Must return at least 1 match');
      const topSec = searchSec[0];
      assert.strictEqual(topSec.memoryType, MemoryTypes.SECURITY_RULE);
      assert.ok(topSec.title.includes('Scrypt Password Hashing'));
      assert.ok(topSec.similarityScore > 0.6);

      // Query 2: Cookie Bug Fix Search
      const searchBug = await memoryService.search({
        tenantId: 'tenant-memory-test',
        query: 'cookie base64 padding truncation bug with equals sign',
        limit: 3
      });

      assert.ok(searchBug.length > 0);
      const topBug = searchBug[0];
      assert.strictEqual(topBug.memoryType, MemoryTypes.BUG_FIX);
      assert.ok(topBug.title.includes('Cookie Splitting'));
    });

    test('enforces strict tenant isolation during memory searches', async () => {
      await memoryService.ingest({
        tenantId: 'tenant-alpha',
        memoryType: MemoryTypes.ADR,
        title: 'Tenant Alpha Proprietary Core Formula',
        content: 'Secret algorithmic proprietary formula for Alpha organization.'
      });

      // Search from Tenant Beta
      const searchBeta = await memoryService.search({
        tenantId: 'tenant-beta',
        query: 'Proprietary Core Formula',
        limit: 5
      });

      assert.strictEqual(searchBeta.length, 0, 'Tenant Beta must NEVER retrieve Tenant Alpha memories');
    });
  });

  describe('4. Prompt Context Formatting & Memory Associations', () => {
    test('formatContextForPrompt formats retrieved memories into markdown block', () => {
      const mockMemories = [
        {
          id: 'm1',
          memoryType: 'ADR',
          title: 'ADR-001: Architecture Standard',
          similarityScore: 0.88,
          content: 'Use Node.js ES Modules with WHATWG URLs.'
        }
      ];

      const formatted = memoryService.formatContextForPrompt(mockMemories);
      assert.ok(formatted.includes('### Relevant Institutional Knowledge'));
      assert.ok(formatted.includes('ADR-001: Architecture Standard'));
      assert.ok(formatted.includes('relevance: 88%'));
      assert.ok(formatted.includes('Use Node.js ES Modules'));
    });

    test('persists memory associations in database', () => {
      const assoc = storage.createMemoryAssociation({
        sourceMemoryId: 'mem_source_01',
        targetMemoryId: 'mem_target_01',
        relationshipType: 'SUPERSEDES',
        notes: 'V2 replaces legacy V1 implementation'
      });

      assert.ok(assoc);
      const list = storage.listMemoryAssociations('mem_source_01');
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].relationship_type, 'SUPERSEDES');
    });
  });
});

