#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';

import { StorageEngine } from './storage/db.js';
import { BudgetManager } from './budget/budgetManager.js';
import { SandboxExecutor } from './sandbox/sandboxExecutor.js';
import { ApprovalManager, GatedActions } from './approval/approvalManager.js';
import { AgentFactory } from './agents/agentFactory.js';

console.log('='.repeat(65));
console.log('   AI VIRTUAL SOFTWARE HOUSE - CORE ENGINE (Milestone 0)');
console.log('='.repeat(65));

const dbDir = path.resolve('data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.resolve('data/virtual_company.db');
const workspacesDir = path.resolve('data/workspaces');

console.log(`[Storage] Initializing SQLite database at: ${dbPath}`);
const storage = new StorageEngine(dbPath);

console.log(`[Budget] Initializing Budget Manager (rate: $0.002 / 1k tokens)`);
const budgetManager = new BudgetManager(storage, { costPer1kTokens: 0.002 });

console.log(`[Sandbox] Initializing Sandbox Executor (workspace jail: ${workspacesDir})`);
const sandbox = new SandboxExecutor(workspacesDir, storage, {
  defaultTimeoutMs: 15000,
  maxTimeoutMs: 30000
});

console.log(`[Approval] Initializing Explicit Approval Manager (Enforcing Human Sign-Off)`);
const approvalManager = new ApprovalManager(storage);

console.log(`[Agents] Initializing Specialized Software House Agent Squad`);
const agentFactory = new AgentFactory({
  storage,
  budgetManager,
  sandbox,
  approvalManager
});

const team = agentFactory.createFullTeam();

console.log('\nActive Agent Roster:');
console.log(`  * ${team.pm.name} [${team.pm.role}]`);
console.log(`  * ${team.architect.name} [${team.architect.role}]`);
console.log(`  * ${team.backend.name} [${team.backend.role}]`);
console.log(`  * ${team.frontend.name} [${team.frontend.role}]`);
console.log(`  * ${team.qa.name} [${team.qa.role}]`);
console.log(`  * ${team.devops.name} [${team.devops.role}]`);

console.log('\nSystem Health: OPTIMAL. All Milestone 0 governance layers active.');
console.log('='.repeat(65));

export {
  storage,
  budgetManager,
  sandbox,
  approvalManager,
  agentFactory,
  team
};
