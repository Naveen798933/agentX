/**
 * AccessibilityAuditor
 * Automated WCAG 2.1 Level AA compliance engine.
 * Inspects HTML/DOM structure for semantic defects, missing ARIA bindings,
 * unlabeled form inputs, missing image alt attributes, duplicate IDs,
 * and broken heading hierarchies.
 */
export class AccessibilityAuditor {
  static ImpactLevels = Object.freeze({
    CRITICAL: 'CRITICAL',
    SERIOUS: 'SERIOUS',
    MODERATE: 'MODERATE',
    MINOR: 'MINOR'
  });

  /**
   * Evaluates an HTML string against WCAG 2.1 AA rules
   * @param {string} html Raw HTML document or fragment
   * @param {Object} [options]
   * @param {string} [options.url]
   * @returns {Object} Audit report
   */
  static audit(html, options = {}) {
    if (!html || typeof html !== 'string') {
      return {
        passed: false,
        score: 0,
        violations: [{
          id: 'A11Y-EMPTY-HTML',
          rule: 'VALID_MARKUP',
          impact: AccessibilityAuditor.ImpactLevels.CRITICAL,
          description: 'No HTML content provided for accessibility evaluation',
          selector: 'document'
        }],
        passes: [],
        summary: 'Evaluation failed: Empty or invalid HTML markup'
      };
    }

    const violations = [];
    const passes = [];
    let score = 100;

    // 1. HTML lang attribute
    const htmlTagMatch = html.match(/<html\b([^>]*)>/i);
    if (htmlTagMatch) {
      const htmlAttrs = htmlTagMatch[1];
      if (/lang\s*=\s*["'][a-z0-9_-]+["']/i.test(htmlAttrs)) {
        passes.push({ rule: 'HTML_LANG', description: '<html> tag specifies a valid lang attribute' });
      } else {
        violations.push({
          id: 'A11Y-LANG-MISSING',
          rule: 'HTML_LANG',
          impact: AccessibilityAuditor.ImpactLevels.MODERATE,
          description: 'The <html> tag is missing a valid lang attribute (e.g. lang="en")',
          selector: 'html',
          helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/language-of-page.html'
        });
        score -= 5;
      }
    }

    // 2. Page title
    if (/<html/i.test(html)) {
      const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
      if (titleMatch && titleMatch[1].trim().length > 0) {
        passes.push({ rule: 'PAGE_TITLE', description: 'Document includes a non-empty <title> element' });
      } else {
        violations.push({
          id: 'A11Y-TITLE-MISSING',
          rule: 'PAGE_TITLE',
          impact: AccessibilityAuditor.ImpactLevels.SERIOUS,
          description: 'Document has no <title> tag or the title is empty',
          selector: 'head > title',
          helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/page-titled.html'
        });
        score -= 15;
      }
    }

    // 3. Image alt attributes
    const imgRegex = /<img\b([^>]*)\/?>/gi;
    let imgMatch;
    let allImgsHaveAlt = true;
    while ((imgMatch = imgRegex.exec(html)) !== null) {
      const attrs = imgMatch[1];
      const hasAlt = /alt\s*=\s*["']([^"']*)["']/i.test(attrs);
      const isAriaHidden = /aria-hidden\s*=\s*["']true["']/i.test(attrs) || /role\s*=\s*["']presentation["']/i.test(attrs);

      if (!hasAlt && !isAriaHidden) {
        allImgsHaveAlt = false;
        const srcMatch = attrs.match(/src\s*=\s*["']([^"']*)["']/i);
        const src = srcMatch ? srcMatch[1] : 'unknown';
        violations.push({
          id: 'A11Y-IMG-ALT-MISSING',
          rule: 'IMAGE_ALT',
          impact: AccessibilityAuditor.ImpactLevels.CRITICAL,
          description: `Image element is missing an alt attribute: src="${src}"`,
          selector: `img[src="${src}"]`,
          helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/non-text-content.html'
        });
        score -= 25;
      }
    }
    if (allImgsHaveAlt) {
      passes.push({ rule: 'IMAGE_ALT', description: 'All <img> elements provide accessible alternative text or are hidden' });
    }

    // 4. Form control labels
    const inputRegex = /<input\b([^>]*)\/?>/gi;
    let inputMatch;
    while ((inputMatch = inputRegex.exec(html)) !== null) {
      const attrs = inputMatch[1];
      const typeMatch = attrs.match(/type\s*=\s*["']([^"']+)["']/i);
      const inputType = typeMatch ? typeMatch[1].toLowerCase() : 'text';

      // Skip non-interactive or self-labeled input types
      if (['hidden', 'submit', 'reset', 'button', 'image'].includes(inputType)) {
        continue;
      }

      const idMatch = attrs.match(/id\s*=\s*["']([^"']+)["']/i);
      const id = idMatch ? idMatch[1] : null;

      const hasAriaLabel = /aria-label\s*=\s*["']([^"']+)["']/i.test(attrs) ||
                           /aria-labelledby\s*=\s*["']([^"']+)["']/i.test(attrs) ||
                           /title\s*=\s*["']([^"']+)["']/i.test(attrs);

      let hasAssociatedLabel = false;
      if (id) {
        const labelForRegex = new RegExp(`<label\\b[^>]*for\\s*=\\s*["']${id}["'][^>]*>`, 'i');
        hasAssociatedLabel = labelForRegex.test(html);
      }

      if (!hasAriaLabel && !hasAssociatedLabel) {
        violations.push({
          id: 'A11Y-INPUT-LABEL-MISSING',
          rule: 'FORM_LABEL',
          impact: AccessibilityAuditor.ImpactLevels.SERIOUS,
          description: `Form input (type="${inputType}"${id ? ', id="' + id + '"' : ''}) has no associated <label> or aria-label`,
          selector: id ? `#${id}` : `input[type="${inputType}"]`,
          helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/labels-or-instructions.html'
        });
        score -= 15;
      }
    }

    // 5. Empty Buttons
    const buttonRegex = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
    let btnMatch;
    while ((btnMatch = buttonRegex.exec(html)) !== null) {
      const attrs = btnMatch[1];
      const content = btnMatch[2].replace(/<[^>]+>/g, '').trim();
      const hasAriaLabel = /aria-label\s*=\s*["']([^"']+)["']/i.test(attrs);
      const hasImageWithAlt = /<img\b[^>]*alt\s*=\s*["'][^"']+["']/i.test(btnMatch[2]);

      if (!content && !hasAriaLabel && !hasImageWithAlt) {
        violations.push({
          id: 'A11Y-BUTTON-EMPTY',
          rule: 'EMPTY_BUTTON',
          impact: AccessibilityAuditor.ImpactLevels.SERIOUS,
          description: 'Button element has no accessible text label or icon description',
          selector: 'button',
          helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html'
        });
        score -= 15;
      }
    }

    // 6. Duplicate IDs
    const idRegex = /\bid\s*=\s*["']([^"']+)["']/gi;
    const seenIds = new Set();
    const duplicateIds = new Set();
    let idM;
    while ((idM = idRegex.exec(html)) !== null) {
      const idVal = idM[1];
      if (seenIds.has(idVal)) {
        duplicateIds.add(idVal);
      } else {
        seenIds.add(idVal);
      }
    }
    for (const dupId of duplicateIds) {
      violations.push({
        id: 'A11Y-DUPLICATE-ID',
        rule: 'DUPLICATE_ID',
        impact: AccessibilityAuditor.ImpactLevels.SERIOUS,
        description: `Duplicate HTML ID found on multiple elements: id="${dupId}"`,
        selector: `#${dupId}`,
        helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/parsing.html'
      });
      score -= 15;
    }
    if (duplicateIds.size === 0) {
      passes.push({ rule: 'DUPLICATE_ID', description: 'All HTML ID attributes are unique across the document' });
    }

    // 7. Heading hierarchy skips
    const headingRegex = /<h([1-6])\b[^>]*>/gi;
    let hMatch;
    let prevLevel = 0;
    let hierarchySkipped = false;
    while ((hMatch = headingRegex.exec(html)) !== null) {
      const level = parseInt(hMatch[1], 10);
      if (prevLevel > 0 && level > prevLevel + 1) {
        hierarchySkipped = true;
        violations.push({
          id: 'A11Y-HEADING-SKIP',
          rule: 'HEADING_HIERARCHY',
          impact: AccessibilityAuditor.ImpactLevels.MODERATE,
          description: `Heading level skipped: jumped from <h${prevLevel}> to <h${level}> without intermediate level`,
          selector: `h${level}`,
          helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships.html'
        });
        score -= 5;
      }
      prevLevel = level;
    }
    if (!hierarchySkipped) {
      passes.push({ rule: 'HEADING_HIERARCHY', description: 'Heading structure follows standard sequential order' });
    }

    const finalScore = Math.max(0, Math.min(100, score));
    const hasCritical = violations.some(v => v.impact === AccessibilityAuditor.ImpactLevels.CRITICAL);
    const hasSerious = violations.some(v => v.impact === AccessibilityAuditor.ImpactLevels.SERIOUS);
    const passed = !hasCritical && !hasSerious && finalScore >= 80;

    const summary = passed
      ? `WCAG 2.1 AA Audit Passed (Score: ${finalScore}/100 with ${passes.length} verified checks)`
      : `WCAG 2.1 AA Audit Failed (Score: ${finalScore}/100 with ${violations.length} violations: ${violations.filter(v => v.impact === 'CRITICAL').length} Critical, ${violations.filter(v => v.impact === 'SERIOUS').length} Serious)`;

    return {
      passed,
      score: finalScore,
      violations,
      passes,
      summary
    };
  }

  /**
   * Formats audit findings into actionable Markdown for developer remediation
   * @param {Object} report Output from AccessibilityAuditor.audit()
   * @returns {string} Markdown text
   */
  static formatReportMarkdown(report) {
    const lines = [
      `### WCAG 2.1 Accessibility Audit Report (Score: ${report.score}/100 - ${report.passed ? 'PASSED' : 'FAILED'})`,
      '',
      `**Summary:** ${report.summary}`,
      ''
    ];

    if (report.violations && report.violations.length > 0) {
      lines.push('#### Violations:');
      for (const v of report.violations) {
        lines.push(`- **[${v.impact}] ${v.rule}** (\`${v.selector}\`): ${v.description}`);
        if (v.helpUrl) {
          lines.push(`  *Reference:* ${v.helpUrl}`);
        }
      }
      lines.push('');
    }

    if (report.passes && report.passes.length > 0) {
      lines.push('#### Passing Checks:');
      for (const p of report.passes) {
        lines.push(`- ✔ **${p.rule}**: ${p.description}`);
      }
    }

    return lines.join('\n');
  }
}

