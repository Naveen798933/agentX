import crypto from 'node:crypto';

/**
 * VisualRegression
 * High-performance, zero-dependency pixel-level visual regression engine.
 * Compares baseline and candidate image pixel buffers, detects layout shifts,
 * color changes, asset render errors, and outputs a visual diff mask buffer.
 */
export class VisualRegression {
  /**
   * Creates an RGBA pixel buffer (4 bytes per pixel: R, G, B, A).
   * @param {number} width
   * @param {number} height
   * @param {number[]} [fillRgba=[255, 255, 255, 255]] Default solid white
   * @returns {Buffer}
   */
  static createSyntheticCanvas(width, height, fillRgba = [255, 255, 255, 255]) {
    const buffer = Buffer.alloc(width * height * 4);
    const [r, g, b, a] = fillRgba;
    for (let i = 0; i < buffer.length; i += 4) {
      buffer[i] = r;
      buffer[i + 1] = g;
      buffer[i + 2] = b;
      buffer[i + 3] = a;
    }
    return buffer;
  }

  /**
   * Draws a filled rectangle on an RGBA buffer.
   * Useful for synthetic UI layout and component simulation.
   * @param {Buffer} buffer
   * @param {number} canvasWidth
   * @param {Object} rect
   * @param {number} rect.x
   * @param {number} rect.y
   * @param {number} rect.w
   * @param {number} rect.h
   * @param {number[]} rect.color [R, G, B, A]
   */
  static drawRect(buffer, canvasWidth, { x, y, w, h, color = [0, 0, 0, 255] }) {
    const totalPixels = buffer.length / 4;
    const canvasHeight = Math.floor(totalPixels / canvasWidth);

    const startX = Math.max(0, Math.min(canvasWidth, x));
    const startY = Math.max(0, Math.min(canvasHeight, y));
    const endX = Math.max(0, Math.min(canvasWidth, x + w));
    const endY = Math.max(0, Math.min(canvasHeight, y + h));

    const [r, g, b, a] = color;

    for (let py = startY; py < endY; py++) {
      for (let px = startX; px < endX; px++) {
        const offset = (py * canvasWidth + px) * 4;
        buffer[offset] = r;
        buffer[offset + 1] = g;
        buffer[offset + 2] = b;
        buffer[offset + 3] = a;
      }
    }
  }

  /**
   * Compares two RGBA buffers pixel-by-pixel.
   * Highlights mismatches in bright magenta/pink ([255, 0, 128, 255]).
   *
   * @param {Buffer} baselineBuffer
   * @param {Buffer} candidateBuffer
   * @param {Object} [options]
   * @param {number} [options.threshold=0.1] Per-channel delta tolerance (0.0 to 1.0)
   * @param {number} [options.maxDiffPercent=0.01] Maximum acceptable diff ratio (0.01 = 1%)
   * @returns {Object} Comparison report
   */
  static compareBuffers(baselineBuffer, candidateBuffer, options = {}) {
    const threshold = options.threshold !== undefined ? options.threshold : 0.1;
    const maxDiffPercent = options.maxDiffPercent !== undefined ? options.maxDiffPercent : 0.01;

    if (!Buffer.isBuffer(baselineBuffer) || !Buffer.isBuffer(candidateBuffer)) {
      throw new Error('Both baseline and candidate inputs must be Buffer instances');
    }

    if (baselineBuffer.length !== candidateBuffer.length) {
      return {
        passed: false,
        totalPixels: Math.floor(Math.max(baselineBuffer.length, candidateBuffer.length) / 4),
        mismatchedPixels: Math.floor(Math.max(baselineBuffer.length, candidateBuffer.length) / 4),
        diffPercentage: 1.0,
        maxAllowedDiffPercent: maxDiffPercent,
        error: `Buffer byte length mismatch: baseline=${baselineBuffer.length}, candidate=${candidateBuffer.length}`,
        diffBuffer: null
      };
    }

    const totalPixels = baselineBuffer.length / 4;
    let mismatchedPixels = 0;
    const diffBuffer = Buffer.alloc(baselineBuffer.length);
    const channelTolerance = Math.round(threshold * 255);

    for (let i = 0; i < baselineBuffer.length; i += 4) {
      const r1 = baselineBuffer[i];
      const g1 = baselineBuffer[i + 1];
      const b1 = baselineBuffer[i + 2];
      const a1 = baselineBuffer[i + 3];

      const r2 = candidateBuffer[i];
      const g2 = candidateBuffer[i + 1];
      const b2 = candidateBuffer[i + 2];
      const a2 = candidateBuffer[i + 3];

      const diffR = Math.abs(r1 - r2);
      const diffG = Math.abs(g1 - g2);
      const diffB = Math.abs(b1 - b2);
      const diffA = Math.abs(a1 - a2);

      const isMismatch = (
        diffR > channelTolerance ||
        diffG > channelTolerance ||
        diffB > channelTolerance ||
        diffA > channelTolerance
      );

      if (isMismatch) {
        mismatchedPixels++;
        // Highlight mismatch in bright magenta
        diffBuffer[i] = 255;
        diffBuffer[i + 1] = 0;
        diffBuffer[i + 2] = 128;
        diffBuffer[i + 3] = 255;
      } else {
        // Dim unchanged pixels for contrast
        diffBuffer[i] = Math.floor(r2 * 0.3);
        diffBuffer[i + 1] = Math.floor(g2 * 0.3);
        diffBuffer[i + 2] = Math.floor(b2 * 0.3);
        diffBuffer[i + 3] = 180;
      }
    }

    const diffPercentage = totalPixels > 0 ? (mismatchedPixels / totalPixels) : 0;
    const passed = diffPercentage <= maxDiffPercent;

    return {
      passed,
      totalPixels,
      mismatchedPixels,
      diffPercentage: Number(diffPercentage.toFixed(6)),
      maxAllowedDiffPercent: maxDiffPercent,
      diffBuffer,
      error: passed ? null : `Visual regression diff ${(diffPercentage * 100).toFixed(2)}% exceeds threshold ${(maxDiffPercent * 100).toFixed(2)}%`
    };
  }

  /**
   * Generates a deterministic hash checksum of a buffer for quick equality checks
   * @param {Buffer} buffer
   * @returns {string} SHA-256 hash
   */
  static computeChecksum(buffer) {
    if (!Buffer.isBuffer(buffer)) return '';
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}

