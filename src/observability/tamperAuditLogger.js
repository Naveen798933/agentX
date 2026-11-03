import crypto from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

/**
 * TamperAuditLogger
 * Cryptographic, append-only, SHA-256 hash-chained audit logging engine.
 * Ensures strict non-repudiation, tamper detection, and SOC 2 Type II compliance.
 * Each entry is cryptographically linked to its predecessor and signed with HMAC-SHA256.
 */
export class TamperAuditLogger {
  /**
   * @param {Object} options
   * @param {import('../storage/db.js').StorageEngine} options.storage
   * @param {string} [options.signingKey] HMAC secret key for log authenticity signatures
   */
  constructor(options = {}) {
    if (!options.storage) {
      throw new Error('TamperAuditLogger requires a storage engine instance');
    }
    this.storage = options.storage;
    this.signingKey = options.signingKey || process.env.AUDIT_SIGNING_KEY || 'default-audit-signing-secret-key-32b';
  }

  /**
   * Calculates SHA-256 hash over canonical audit entry attributes
   * @param {Object} params
   * @returns {string} Hex hash string
   */
  static computeEntryHash({ previousHash, sequenceNumber, eventType, actor, payloadJson, timestamp }) {
    const canonical = [
      previousHash,
      sequenceNumber,
      eventType,
      actor,
      payloadJson,
      timestamp
    ].join(':');

    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Generates HMAC-SHA256 signature for current entry hash
   * @param {string} currentHash
   * @returns {string} Hex HMAC signature
   */
  signHash(currentHash) {
    return crypto.createHmac('sha256', this.signingKey).update(currentHash).digest('hex');
  }

  /**
   * Verifies HMAC signature using timingSafeEqual to prevent side-channel timing attacks
   */
  verifySignature(currentHash, signature) {
    const expected = this.signHash(currentHash);
    if (!signature || expected.length !== signature.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  /**
   * Appends an audit event to the tamper-evident hash chain
   * @param {Object} event
   * @param {string} [event.tenantId='tenant-default']
   * @param {string} event.eventType
   * @param {string} event.actor
   * @param {Object|string} event.payload
   * @returns {Object} Stored log entry
   */
  log({ tenantId = 'tenant-default', eventType, actor, payload }) {
    if (!eventType || !actor) {
      throw new Error('Audit log requires eventType and actor');
    }

    const payloadJson = typeof payload === 'object' ? JSON.stringify(payload) : String(payload || '{}');
    const timestamp = new Date().toISOString();

    // Retrieve previous head of chain
    const lastEntry = this.storage.getLatestTamperAuditLog(tenantId);
    const sequenceNumber = lastEntry ? Number(lastEntry.sequence_number) + 1 : 1;
    const previousHash = lastEntry ? lastEntry.current_hash : GENESIS_HASH;

    const currentHash = TamperAuditLogger.computeEntryHash({
      previousHash,
      sequenceNumber,
      eventType,
      actor,
      payloadJson,
      timestamp
    });

    const signature = this.signHash(currentHash);

    const record = {
      id: `taudit_${crypto.randomUUID().slice(0, 10)}`,
      tenantId,
      sequenceNumber,
      eventType,
      actor,
      payloadJson,
      previousHash,
      currentHash,
      signature,
      timestamp
    };

    this.storage.appendTamperAuditLog(record);
    return record;
  }

  /**
   * Cryptographically verifies the unbroken integrity of the entire log chain for a tenant
   * @param {string} [tenantId='tenant-default']
   * @returns {Object} Integrity verification report
   */
  verifyChainIntegrity(tenantId = 'tenant-default') {
    const logs = this.storage.listTamperAuditLogs(tenantId, { limit: 100000, offset: 0 });

    if (!logs || logs.length === 0) {
      return {
        valid: true,
        totalEntries: 0,
        lastHash: GENESIS_HASH,
        verifiedAt: new Date().toISOString()
      };
    }

    let expectedPrevHash = GENESIS_HASH;

    for (let i = 0; i < logs.length; i++) {
      const entry = logs[i];
      const seq = Number(entry.sequence_number);
      const expectedSeq = i + 1;

      // 1. Sequence continuity check
      if (seq !== expectedSeq) {
        return {
          valid: false,
          brokenAtSequence: seq,
          reason: `Broken sequence continuity: expected #${expectedSeq}, found #${seq}`,
          entry
        };
      }

      // 2. Hash chaining linkage check
      if (entry.previous_hash !== expectedPrevHash) {
        return {
          valid: false,
          brokenAtSequence: seq,
          reason: `Previous hash linkage mismatch at #${seq}: expected "${expectedPrevHash}", found "${entry.previous_hash}"`,
          entry
        };
      }

      // 3. Cryptographic hash validity check
      const recomputedHash = TamperAuditLogger.computeEntryHash({
        previousHash: entry.previous_hash,
        sequenceNumber: seq,
        eventType: entry.event_type,
        actor: entry.actor,
        payloadJson: entry.payload_json,
        timestamp: entry.timestamp
      });

      if (recomputedHash !== entry.current_hash) {
        return {
          valid: false,
          brokenAtSequence: seq,
          reason: `Hash tampering detected at #${seq}: payload or metadata was altered`,
          entry
        };
      }

      // 4. Cryptographic signature check
      if (!this.verifySignature(entry.current_hash, entry.signature)) {
        return {
          valid: false,
          brokenAtSequence: seq,
          reason: `Cryptographic signature forgery detected at #${seq}`,
          entry
        };
      }

      expectedPrevHash = entry.current_hash;
    }

    return {
      valid: true,
      totalEntries: logs.length,
      lastHash: expectedPrevHash,
      verifiedAt: new Date().toISOString()
    };
  }
}

