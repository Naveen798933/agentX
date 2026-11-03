/**
 * AST Code Chunker for Source Code Files
 * Extracts top-level classes, exported functions, and major code blocks.
 */

export class AstCodeChunker {
  /**
   * Splits code content into semantic units with line metadata
   * @param {string} code - Source code
   * @param {string} [filePath] - Target file path
   * @returns {Array<{ name: string, type: string, content: string, startLine: number, endLine: number }>}
   */
  static chunk(code, filePath = 'src/index.js') {
    if (!code || typeof code !== 'string') return [];

    const lines = code.split('\n');
    const chunks = [];

    let currentChunk = null;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // Detect start of class, function, or export statement
      const classMatch = trimmed.match(/^(?:export\s+)?class\s+([A-Za-z0-9_$]+)/);
      const funcMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s*([A-Za-z0-9_$]*)/);
      const constFuncMatch = trimmed.match(/^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/);

      if (braceDepth === 0 && (classMatch || funcMatch || constFuncMatch)) {
        if (currentChunk && currentChunk.lines.length > 0) {
          chunks.push({
            name: currentChunk.name,
            type: currentChunk.type,
            content: currentChunk.lines.join('\n').trim(),
            startLine: currentChunk.startLine,
            endLine: i
          });
        }

        const name = (classMatch && classMatch[1]) || (funcMatch && funcMatch[1]) || (constFuncMatch && constFuncMatch[1]) || 'anonymous';
        const type = classMatch ? 'CLASS' : 'FUNCTION';

        currentChunk = {
          name,
          type,
          lines: [line],
          startLine: lineNum
        };
      } else if (currentChunk) {
        currentChunk.lines.push(line);
      }

      // Track brace depth
      for (const char of line) {
        if (char === '{') braceDepth++;
        else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
      }

      // If closed top-level block
      if (currentChunk && braceDepth === 0 && trimmed.endsWith('}')) {
        chunks.push({
          name: currentChunk.name,
          type: currentChunk.type,
          content: currentChunk.lines.join('\n').trim(),
          startLine: currentChunk.startLine,
          endLine: lineNum
        });
        currentChunk = null;
      }
    }

    if (currentChunk && currentChunk.lines.length > 0) {
      chunks.push({
        name: currentChunk.name,
        type: currentChunk.type,
        content: currentChunk.lines.join('\n').trim(),
        startLine: currentChunk.startLine,
        endLine: lines.length
      });
    }

    // Fallback: If no structured class/function was found, chunk by 50-line blocks
    if (chunks.length === 0 && code.trim().length > 0) {
      const step = 50;
      for (let i = 0; i < lines.length; i += step) {
        const slice = lines.slice(i, i + step).join('\n').trim();
        if (slice.length > 0) {
          chunks.push({
            name: `${filePath}#L${i + 1}-L${Math.min(i + step, lines.length)}`,
            type: 'CODE_BLOCK',
            content: slice,
            startLine: i + 1,
            endLine: Math.min(i + step, lines.length)
          });
        }
      }
    }

    return chunks;
  }
}

