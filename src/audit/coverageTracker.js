import fs from 'node:fs';
import path from 'node:path';

/**
 * Requirement Status Enum
 */
export const RequirementStatus = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  IMPLEMENTED: 'IMPLEMENTED',
  TESTING: 'TESTING',
  VERIFIED: 'VERIFIED',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED'
};

/**
 * CoverageTracker
 * Tracks requirement coverage throughout the entire engineering lifecycle:
 * ANALYZE → PLAN → IMPLEMENT → INSPECT → TEST → FIX → RETEST → VERIFY → REPORT.
 * Maintains immutable traceability between original user prompt, REQ IDs, files, tests, and verification evidence.
 */
export class CoverageTracker {
  /**
   * @param {Object} requirementLock From RequirementParser
   */
  constructor(requirementLock) {
    this.lock = requirementLock;
    this.instruction = requirementLock.instruction || '';
    this.featureName = requirementLock.featureName || 'Application';
    this.domain = requirementLock.domain || 'CUSTOM';
    this.timestamp = requirementLock.timestamp || Date.now();

    // Initialize items with full traceability
    this.requirements = new Map();
    const list = requirementLock.explicitRequirements || [];

    for (const req of list) {
      this.requirements.set(req.id, {
        id: req.id,
        category: req.category || 'FUNCTIONAL',
        text: req.text,
        targetFile: req.targetFile || 'src/api.js',
        acceptanceCriteria: req.acceptanceCriteria || `AC: ${req.text} verified operational.`,
        status: RequirementStatus.PENDING,
        assignedAgent: null,
        implementedIn: null,
        testedIn: null,
        evidence: null,
        updatedAt: new Date().toISOString()
      });
    }
  }

  get(reqId) {
    return this.requirements.get(reqId);
  }

  getAll() {
    return Array.from(this.requirements.values());
  }

  updateStatus(reqId, status, details = {}) {
    const item = this.requirements.get(reqId);
    if (!item) return null;

    item.status = status;
    item.updatedAt = new Date().toISOString();

    if (details.assignedAgent) item.assignedAgent = details.assignedAgent;
    if (details.targetFile) item.implementedIn = details.targetFile;
    if (details.testId) item.testedIn = details.testId;
    if (details.evidence) item.evidence = details.evidence;

    return item;
  }

  markInProgress(reqId, agentRole) {
    return this.updateStatus(reqId, RequirementStatus.IN_PROGRESS, { assignedAgent: agentRole });
  }

  markImplemented(reqId, targetFile) {
    return this.updateStatus(reqId, RequirementStatus.IMPLEMENTED, { targetFile });
  }

  markTesting(reqId, testId) {
    return this.updateStatus(reqId, RequirementStatus.TESTING, { testId });
  }

  markVerified(reqId, evidence) {
    return this.updateStatus(reqId, RequirementStatus.VERIFIED, { evidence });
  }

  markBlocked(reqId, reason) {
    return this.updateStatus(reqId, RequirementStatus.BLOCKED, { evidence: reason });
  }

  markFailed(reqId, error) {
    return this.updateStatus(reqId, RequirementStatus.FAILED, { evidence: error });
  }

  /**
   * Verify all requirements against workspace files, test run output, and syntax
   * @param {Object} sandbox SandboxExecutor instance
   * @param {string} projectId
   * @param {Object} [testResult] Output from node --test execution
   */
  verifyAgainstWorkspace(sandbox, projectId, testResult = {}) {
    const allFiles = sandbox.listFiles(projectId);
    const testsPassed = Boolean(testResult.passed ?? (testResult.exitCode === 0));

    for (const [id, req] of this.requirements.entries()) {
      const fileExists = allFiles.includes(req.targetFile);

      if (!fileExists) {
        req.status = RequirementStatus.FAILED;
        req.evidence = `Target file "${req.targetFile}" not created in workspace`;
        continue;
      }

      // Read file content safely
      let fileContent = '';
      try {
        fileContent = sandbox.readFileSafely(projectId, req.targetFile);
      } catch (_) {}

      // Basic semantic content checks
      const hasContent = fileContent && fileContent.length > 50;

      if (!hasContent) {
        req.status = RequirementStatus.FAILED;
        req.evidence = `Target file "${req.targetFile}" is empty or placeholder`;
        continue;
      }

      const errorSnippet = (testResult.stderr || testResult.stdout || 'Non-zero exit code').trim().slice(0, 150);

      // For testing requirements, check if automated tests passed
      if (req.category === 'TESTING') {
        if (testsPassed) {
          req.status = RequirementStatus.VERIFIED;
          req.evidence = 'Automated sandboxed test runner passed with exit code 0';
        } else {
          req.status = RequirementStatus.FAILED;
          req.evidence = `Automated test suite failed execution in sandbox: ${errorSnippet}`;
        }
        continue;
      }

      // Check for rogue exclusions (e.g. Shopping cart in Auth Portal)
      if (this.domain === 'AUTH' && (fileContent.includes('shopping-cart') || fileContent.includes('checkout-button'))) {
        req.status = RequirementStatus.FAILED;
        req.evidence = 'Strict scope violation: Rogue shopping cart detected in Authentication module';
        continue;
      }

      // If tests passed and file has implementation, mark verified
      if (testsPassed) {
        req.status = RequirementStatus.VERIFIED;
        req.evidence = `Implemented in "${req.targetFile}" and verified via sandboxed automated test pass`;
      } else {
        if (req.category === 'API' || req.category === 'DATABASE') {
          req.status = RequirementStatus.BLOCKED;
          req.evidence = `Implemented in "${req.targetFile}", but blocked pending test resolution: ${errorSnippet}`;
        } else {
          req.status = RequirementStatus.IMPLEMENTED;
          req.evidence = `Code written in "${req.targetFile}", awaiting test verification`;
        }
      }
    }

    return this.generateReport();
  }

  /**
   * Generate structured coverage metrics
   */
  generateReport() {
    const list = this.getAll();
    const total = list.length;
    const verified = list.filter(r => r.status === RequirementStatus.VERIFIED).length;
    const implemented = list.filter(r => r.status === RequirementStatus.IMPLEMENTED).length;
    const inProgress = list.filter(r => r.status === RequirementStatus.IN_PROGRESS).length;
    const pending = list.filter(r => r.status === RequirementStatus.PENDING).length;
    const failed = list.filter(r => r.status === RequirementStatus.FAILED).length;
    const blocked = list.filter(r => r.status === RequirementStatus.BLOCKED).length;

    const coveragePercentage = total > 0 ? Math.round((verified / total) * 100) : 0;
    const isFullyVerified = total > 0 && verified === total;

    return {
      title: this.featureName,
      domain: this.domain,
      originalPrompt: this.instruction,
      timestamp: new Date().toISOString(),
      summary: {
        total,
        verified,
        implemented,
        inProgress,
        pending,
        failed,
        blocked,
        coveragePercentage,
        isFullyVerified
      },
      requirements: list
    };
  }

  /**
   * Generate Markdown coverage matrix for docs/REQUIREMENT_COVERAGE.md
   */
  generateMarkdownReport() {
    const report = this.generateReport();
    const { summary, requirements } = report;

    const statusBadge = (s) => {
      switch (s) {
        case RequirementStatus.VERIFIED: return '🟢 **VERIFIED**';
        case RequirementStatus.IMPLEMENTED: return '🟡 **IMPLEMENTED**';
        case RequirementStatus.IN_PROGRESS: return '🔵 **IN_PROGRESS**';
        case RequirementStatus.TESTING: return '🟣 **TESTING**';
        case RequirementStatus.FAILED: return '🔴 **FAILED**';
        case RequirementStatus.BLOCKED: return '⚪ **BLOCKED**';
        default: return '⚪ **PENDING**';
      }
    };

    let md = `# Requirement Coverage & Traceability Report\n\n`;
    md += `**Project:** ${this.featureName}  \n`;
    md += `**Domain:** \`${this.domain}\`  \n`;
    md += `**Generated:** ${report.timestamp}  \n`;
    md += `**Coverage Score:** **${summary.coveragePercentage}% Verified** (${summary.verified}/${summary.total} requirements)  \n\n`;

    md += `### Original User Prompt\n`;
    md += `> "${this.instruction}"\n\n`;

    md += `### Summary Metrics\n\n`;
    md += `| Total Requirements | Verified | Implemented | Pending | Failed / Blocked |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- |\n`;
    md += `| **${summary.total}** | **${summary.verified}** | ${summary.implemented} | ${summary.pending} | ${summary.failed + summary.blocked} |\n\n`;

    md += `### Traceability Matrix\n\n`;
    md += `| Requirement ID | Category | Description | Target File | Acceptance Criteria | Status |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;

    for (const r of requirements) {
      md += `| **${r.id}** | \`${r.category}\` | ${r.text.replace(/\|/g, '-')} | \`${r.targetFile}\` | ${r.acceptanceCriteria.replace(/\|/g, '-')} | ${statusBadge(r.status)} |\n`;
    }

    md += `\n---\n*Report generated deterministically by AI Virtual Software House Requirement Engine.*\n`;
    return md;
  }

  /**
   * Persist coverage report into project workspace files
   */
  persist(sandbox, projectId) {
    const report = this.generateReport();
    const md = this.generateMarkdownReport();

    sandbox.writeFileSafely(projectId, 'reports/requirement-coverage.json', JSON.stringify(report, null, 2));
    sandbox.writeFileSafely(projectId, 'docs/REQUIREMENT_COVERAGE.md', md);

    return report;
  }
}
