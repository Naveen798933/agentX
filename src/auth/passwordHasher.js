import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

const SCRYPT_PARAMS = {
  N: 16384, // CPU/memory cost
  r: 8,     // Block size
  p: 1,     // Parallelization
  maxmem: 32 * 1024 * 1024 // 32MB
};

const KEY_LENGTH = 64; // 512 bits derived key
const SALT_BYTES = 16; // 128 bits cryptographic salt

/**
 * Modern password hashing utility using Node.js native crypto.scrypt
 * Output format: scrypt:<saltHex>:<derivedKeyHex>
 */
export class PasswordHasher {
  /**
   * Validates password strength
   * Minimum 8 characters, contains at least one letter and one number
   * @param {string} password
   * @returns {{ valid: boolean, reason?: string }}
   */
  static validateComplexity(password) {
    if (typeof password !== 'string' || password.length < 8) {
      return { valid: false, reason: 'Password must be at least 8 characters long.' };
    }
    if (password.length > 128) {
      return { valid: false, reason: 'Password must not exceed 128 characters.' };
    }
    const hasLetter = /[a-zA-Z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    if (!hasLetter || !hasNumber) {
      return { valid: false, reason: 'Password must contain at least one letter and one number.' };
    }
    return { valid: true };
  }

  /**
   * Hashes a plaintext password using scrypt with a unique random salt
   * @param {string} password
   * @returns {Promise<string>} Format: scrypt:<saltHex>:<derivedKeyHex>
   */
  static async hash(password) {
    if (typeof password !== 'string' || !password) {
      throw new Error('Password must be a non-empty string');
    }

    const salt = crypto.randomBytes(SALT_BYTES);
    const derivedKey = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);

    return `scrypt:${salt.toString('hex')}:${derivedKey.toString('hex')}`;
  }

  /**
   * Verifies a candidate password against a stored scrypt hash using timingSafeEqual
   * @param {string} password - Candidate plaintext password
   * @param {string} storedHash - Stored hash in format scrypt:<saltHex>:<derivedKeyHex>
   * @returns {Promise<boolean>} True if password matches, false otherwise
   */
  static async verify(password, storedHash) {
    if (typeof password !== 'string' || typeof storedHash !== 'string') {
      return false;
    }

    const parts = storedHash.split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') {
      return false;
    }

    const salt = Buffer.from(parts[1], 'hex');
    const storedDerivedKey = Buffer.from(parts[2], 'hex');

    if (salt.length !== SALT_BYTES || storedDerivedKey.length !== KEY_LENGTH) {
      return false;
    }

    const candidateDerivedKey = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);

    // Timing-safe comparison to prevent timing side-channel attacks
    return crypto.timingSafeEqual(candidateDerivedKey, storedDerivedKey);
  }
}
