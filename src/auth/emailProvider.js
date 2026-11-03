/**
 * Configurable Email Provider Interface
 * Provides email delivery abstraction for account verification and password reset.
 */

export class EmailProvider {
  /**
   * @param {string} to
   * @param {string} token
   * @param {string} verificationUrl
   * @returns {Promise<boolean>}
   */
  async sendVerificationEmail(to, token, verificationUrl) {
    throw new Error('sendVerificationEmail must be implemented by subclass');
  }

  /**
   * @param {string} to
   * @param {string} token
   * @param {string} resetUrl
   * @returns {Promise<boolean>}
   */
  async sendPasswordResetEmail(to, token, resetUrl) {
    throw new Error('sendPasswordResetEmail must be implemented by subclass');
  }
}

/**
 * In-memory provider for testing and development environments
 */
export class MemoryEmailProvider extends EmailProvider {
  constructor() {
    super();
    this.outbox = [];
  }

  async sendVerificationEmail(to, token, verificationUrl) {
    const record = {
      type: 'VERIFICATION',
      to,
      token,
      verificationUrl,
      sentAt: new Date(),
      subject: 'Verify your PULSE Account'
    };
    this.outbox.push(record);
    return true;
  }

  async sendPasswordResetEmail(to, token, resetUrl) {
    const record = {
      type: 'PASSWORD_RESET',
      to,
      token,
      resetUrl,
      sentAt: new Date(),
      subject: 'Reset your PULSE Password'
    };
    this.outbox.push(record);
    return true;
  }

  getLatestEmail(to, type = null) {
    return this.outbox
      .filter(e => (!to || e.to === to) && (!type || e.type === type))
      .pop() || null;
  }

  clear() {
    this.outbox = [];
  }
}

/**
 * Standard console provider for local development
 */
export class ConsoleEmailProvider extends EmailProvider {
  async sendVerificationEmail(to, token, verificationUrl) {
    console.log(`[AUTH:EMAIL] Verification email sent to ${to}: URL=${verificationUrl} (Token: ${token})`);
    return true;
  }

  async sendPasswordResetEmail(to, token, resetUrl) {
    console.log(`[AUTH:EMAIL] Password reset email sent to ${to}: URL=${resetUrl} (Token: ${token})`);
    return true;
  }
}
