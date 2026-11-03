/**
 * Markdown Chunker for PRDs, ADRs, and Architecture Documentation
 * Hierarchically partitions markdown text into semantic sections based on header boundaries.
 */

export class MarkdownChunker {
  /**
   * Chunks a markdown document into distinct sections preserving header context
   * @param {string} text - Full markdown document content
   * @param {Object} [options]
   * @param {number} [options.maxChunkChars=2000] - Soft ceiling for chunk size
   * @returns {Array<{ title: string, sectionHeading: string, content: string, level: number }>}
   */
  static chunk(text, options = {}) {
    if (!text || typeof text !== 'string') return [];

    const maxChars = options.maxChunkChars || 2000;
    const lines = text.split('\n');
    const sections = [];

    let currentTitle = 'Document Root';
    let currentHeading = 'Overview';
    let currentLevel = 1;
    let currentBuffer = [];

    const flush = () => {
      const content = currentBuffer.join('\n').trim();
      if (content.length > 0) {
        sections.push({
          title: currentTitle,
          sectionHeading: currentHeading,
          content,
          level: currentLevel
        });
      }
      currentBuffer = [];
    };

    for (const line of lines) {
      const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headerMatch) {
        const level = headerMatch[1].length;
        const headingText = headerMatch[2].trim();

        if (level === 1 && currentTitle === 'Document Root') {
          currentTitle = headingText;
        }

        // If we accumulated meaningful content, flush prior section
        if (currentBuffer.length > 0) {
          flush();
        }

        currentHeading = headingText;
        currentLevel = level;
      } else {
        currentBuffer.push(line);
        // If buffer grows excessively long, split gracefully
        if (currentBuffer.join('\n').length >= maxChars && line.trim() === '') {
          flush();
        }
      }
    }

    flush();

    // If no headers existed, return entire content as single chunk
    if (sections.length === 0 && text.trim().length > 0) {
      sections.push({
        title: 'Document',
        sectionHeading: 'General',
        content: text.trim(),
        level: 1
      });
    }

    return sections;
  }
}

