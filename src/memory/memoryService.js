import crypto from 'node:crypto';
import { MarkdownChunker } from './chunking/markdownChunker.js';
import { AstCodeChunker } from './chunking/astChunker.js';

export const MemoryTypes = Object.freeze({
  ADR: 'ADR',
  PRD: 'PRD',
  BUG_FIX: 'BUG_FIX',
  CODING_STANDARD: 'CODING_STANDARD',
  SECURITY_RULE: 'SECURITY_RULE',
  GENERAL: 'GENERAL'
});

export class MemoryService {
  /**
   * @param {Object} options
   * @param {import('../storage/db.js').StorageEngine} options.storage
   * @param {number} [options.vectorDimensions=64]
   */
  constructor(options = {}) {
    this.storage = options.storage || null;
    this.vectorDimensions = options.vectorDimensions || 64;
    this.inMemoryStore = new Map(); // id -> MemoryObject
  }

  /**
   * Computes a deterministic normalized unit embedding vector from text.
   * Uses token hashing and character n-grams (3-grams, 4-grams) to capture
   * both exact keywords and subword / morphological variants (e.g. hash / hashing / hashed).
   * @param {string} text
   * @returns {number[]} Normalized float vector
   */
  generateEmbedding(text) {
    if (!text || typeof text !== 'string') {
      return new Array(this.vectorDimensions).fill(0);
    }

    const vector = new Array(this.vectorDimensions).fill(0);
    const cleaned = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const words = cleaned.split(/\s+/).filter(w => w.length >= 2);

    const stopWords = new Set([
      'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'how', 'to', 'after', 'must', 'using'
    ]);

    for (const word of words) {
      const isStop = stopWords.has(word);
      const weight = isStop ? 0.05 : 1.0;

      // Whole word token hash
      const wordHash = crypto.createHash('md5').update('w:' + word).digest();
      const wordBucket = wordHash.readUInt16BE(0) % this.vectorDimensions;
      vector[wordBucket] += weight * 3.0;

      // Character 3-grams and 4-grams for subword matching & stemming tolerance
      if (!isStop && word.length >= 3) {
        for (let i = 0; i <= word.length - 3; i++) {
          const gram3 = word.slice(i, i + 3);
          const gHash = crypto.createHash('md5').update('g3:' + gram3).digest();
          const b = gHash.readUInt16BE(0) % this.vectorDimensions;
          vector[b] += 0.6;
        }
        for (let i = 0; i <= word.length - 4; i++) {
          const gram4 = word.slice(i, i + 4);
          const gHash = crypto.createHash('md5').update('g4:' + gram4).digest();
          const b = gHash.readUInt16BE(0) % this.vectorDimensions;
          vector[b] += 1.0;
        }
      }
    }

    // Normalize to unit length (L2 norm) so dot product equals cosine similarity
    let magnitude = 0;
    for (let i = 0; i < vector.length; i++) {
      magnitude += vector[i] * vector[i];
    }
    magnitude = Math.sqrt(magnitude);

    if (magnitude > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] = Number((vector[i] / magnitude).toFixed(6));
      }
    }

    return vector;
  }

  /**
   * Computes cosine similarity between two normalized unit vectors
   */
  cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0.0;
    let dotProduct = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
    }
    return Math.max(0, Math.min(1.0, dotProduct));
  }

  /**
   * Ingests, chunks, embeds, and stores organizational knowledge
   */
  async ingest({
    tenantId = 'tenant-default',
    projectId = null,
    memoryType = MemoryTypes.GENERAL,
    title,
    content,
    sourceFile = null,
    metadata = {}
  }) {
    if (!title || !content) {
      throw new Error('Title and content are required to ingest organizational memory');
    }

    let chunks = [];
    if (sourceFile && (sourceFile.endsWith('.md') || sourceFile.endsWith('.markdown'))) {
      chunks = MarkdownChunker.chunk(content);
    } else if (sourceFile && (sourceFile.endsWith('.js') || sourceFile.endsWith('.ts'))) {
      chunks = AstCodeChunker.chunk(content, sourceFile);
    } else {
      chunks = [{ title, sectionHeading: 'Main', content }];
    }

    const createdMemories = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkTitle = chunks.length > 1 ? `${title} — ${chunk.sectionHeading || chunk.name || 'Part ' + (i + 1)}` : title;
      const chunkContent = chunk.content;
      const embedding = this.generateEmbedding(`${chunkTitle}\n\n${chunkContent}`);

      const memoryId = `mem_${crypto.randomUUID().slice(0, 12)}`;
      const record = {
        id: memoryId,
        tenantId,
        projectId,
        memoryType,
        title: chunkTitle,
        content: chunkContent,
        metadata: { ...metadata, sectionIndex: i, totalSections: chunks.length },
        embeddingJson: JSON.stringify(embedding),
        sourceFile,
        confidenceScore: 1.0,
        accessCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      this.inMemoryStore.set(memoryId, { ...record, embeddingVector: embedding });

      if (this.storage && typeof this.storage.createOrganizationalMemory === 'function') {
        try {
          this.storage.createOrganizationalMemory(record);
        } catch (err) {
          console.warn(`[MemoryService] Could not persist memory: ${err.message}`);
        }
      }

      createdMemories.push(record);
    }

    return createdMemories;
  }

  /**
   * Performs semantic vector search over organizational memory
   */
  async search({
    tenantId = 'tenant-default',
    query,
    memoryType = null,
    limit = 5,
    minScore = 0.35
  }) {
    if (!query || typeof query !== 'string') {
      return [];
    }

    const queryVector = this.generateEmbedding(query);
    const scoredResults = [];

    // Retrieve candidates from DB or in-memory map
    let candidates = Array.from(this.inMemoryStore.values());
    if (this.storage && typeof this.storage.listOrganizationalMemories === 'function') {
      try {
        const dbRows = this.storage.listOrganizationalMemories(tenantId, { memoryType });
        if (dbRows && dbRows.length > 0) {
          candidates = dbRows.map(r => {
            let vec = null;
            if (r.embedding_json) {
              try { vec = JSON.parse(r.embedding_json); } catch (_) {}
            }
            return {
              id: r.id,
              tenantId: r.tenant_id,
              projectId: r.project_id,
              memoryType: r.memory_type,
              title: r.title,
              content: r.content,
              metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata || '{}') : r.metadata,
              sourceFile: r.source_file,
              confidenceScore: Number(r.confidence_score || 1.0),
              embeddingVector: vec || this.generateEmbedding(r.content)
            };
          });
        }
      } catch (err) {
        console.warn(`[MemoryService] DB search fallback to memory: ${err.message}`);
      }
    }

    for (const cand of candidates) {
      if (cand.tenantId && cand.tenantId !== tenantId) {
        continue;
      }
      if (memoryType && cand.memoryType !== memoryType) {
        continue;
      }

      const score = this.cosineSimilarity(queryVector, cand.embeddingVector);
      if (score >= minScore) {
        scoredResults.push({
          id: cand.id,
          memoryType: cand.memoryType,
          title: cand.title,
          content: cand.content,
          sourceFile: cand.sourceFile,
          similarityScore: Number(score.toFixed(4)),
          metadata: cand.metadata
        });
      }
    }

    // Sort descending by similarity
    scoredResults.sort((a, b) => b.similarityScore - a.similarityScore);
    return scoredResults.slice(0, limit);
  }

  /**
   * Formats retrieved organizational memories into markdown prompt context
   */
  formatContextForPrompt(memories = []) {
    if (!memories || memories.length === 0) return '';
    const lines = [
      '### Relevant Institutional Knowledge & Historical Memory:',
      ''
    ];
    for (const m of memories) {
      lines.push(`**[${m.memoryType}] ${m.title}** (relevance: ${(m.similarityScore * 100).toFixed(0)}%)`);
      lines.push(m.content);
      lines.push('');
    }
    return lines.join('\n');
  }
}
