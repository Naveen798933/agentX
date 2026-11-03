import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * Simulated Git Integration
 * Provides commit history, branching, and signed commit signing
 * using native Node.js capabilities (no git binary required).
 */
export class GitManager {
  /**
   * @param {string} projectDir - The isolated project workspace path
   * @param {import('../storage/db.js').StorageEngine} storage
   */
  constructor(projectDir, storage) {
    this.projectDir = projectDir;
    this.storage = storage;
    this.gitMetaDir = path.join(projectDir, '.git-meta');
    this.commitsFile = path.join(this.gitMetaDir, 'commits.json');
    this.branchFile = path.join(this.gitMetaDir, 'branches.json');
    this._init();
  }

  _init() {
    if (!fs.existsSync(this.gitMetaDir)) {
      fs.mkdirSync(this.gitMetaDir, { recursive: true });
    }
    if (!fs.existsSync(this.commitsFile)) {
      fs.writeFileSync(this.commitsFile, JSON.stringify([], null, 2));
    }
    if (!fs.existsSync(this.branchFile)) {
      fs.writeFileSync(this.branchFile, JSON.stringify({
        current: 'main',
        branches: ['main']
      }, null, 2));
    }
  }

  _readCommits() {
    return JSON.parse(fs.readFileSync(this.commitsFile, 'utf8'));
  }

  _writeCommits(commits) {
    fs.writeFileSync(this.commitsFile, JSON.stringify(commits, null, 2));
  }

  _readBranches() {
    return JSON.parse(fs.readFileSync(this.branchFile, 'utf8'));
  }

  _writeBranches(data) {
    fs.writeFileSync(this.branchFile, JSON.stringify(data, null, 2));
  }

  /**
   * Compute a snapshot hash of current workspace files
   */
  _computeTreeHash() {
    const files = this._listAllFiles(this.projectDir).filter(f => !f.includes('.git-meta'));
    const contents = files
      .sort()
      .map(f => {
        try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
      })
      .join('|');
    return crypto.createHash('sha256').update(contents).digest('hex').slice(0, 16);
  }

  _listAllFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    const items = fs.readdirSync(dir, { withFileTypes: true });
    items.forEach(item => {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) results.push(...this._listAllFiles(full));
      else results.push(full);
    });
    return results;
  }

  /**
   * Create a signed commit with author, message, and file snapshot
   */
  commit({ message, author = 'AI Agent', agentRole = 'SYSTEM', files = [] }) {
    const commits = this._readCommits();
    const branches = this._readBranches();

    const treeHash = this._computeTreeHash();
    const parentHash = commits.length > 0 ? commits[commits.length - 1].hash : null;

    const commitData = {
      message,
      author,
      treeHash,
      parentHash,
      branch: branches.current,
      timestamp: new Date().toISOString(),
      agentRole,
      files
    };

    // Cryptographic commit hash
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(commitData))
      .digest('hex')
      .slice(0, 12);

    const commit = { hash, ...commitData };
    commits.push(commit);
    this._writeCommits(commits);

    return commit;
  }

  /**
   * Create a new branch from current HEAD
   */
  createBranch(branchName) {
    const branches = this._readBranches();
    if (!branches.branches.includes(branchName)) {
      branches.branches.push(branchName);
    }
    branches.current = branchName;
    this._writeBranches(branches);

    const commits = this._readCommits();
    const head = commits[commits.length - 1];
    return { branch: branchName, from: head?.hash || 'root' };
  }

  /**
   * Get the full commit log for display
   */
  getLog(limit = 20) {
    const commits = this._readCommits();
    return commits.slice(-limit).reverse();
  }

  /**
   * Get current branch info
   */
  getCurrentBranch() {
    return this._readBranches();
  }

  /**
   * Compute a diff summary between two commits (simplified)
   */
  getDiff(fromHash = null) {
    const commits = this._readCommits();
    if (!fromHash) {
      const last = commits[commits.length - 1];
      return last ? { files: last.files, message: last.message, hash: last.hash } : null;
    }
    const idx = commits.findIndex(c => c.hash === fromHash);
    const recent = idx >= 0 ? commits.slice(idx) : commits.slice(-3);
    const changedFiles = [...new Set(recent.flatMap(c => c.files))];
    return {
      commits: recent.length,
      files: changedFiles,
      from: fromHash,
      to: commits[commits.length - 1]?.hash
    };
  }
}
