#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

import { StorageEngine } from '../src/storage/db.js';
import { AuthManager } from '../src/auth/authManager.js';
import { SystemRoles } from '../src/auth/rbac.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    email: process.env.BOOTSTRAP_ADMIN_EMAIL || null,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD || null,
    name: process.env.BOOTSTRAP_ADMIN_NAME || 'Platform Administrator',
    force: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--email' && args[i + 1]) options.email = args[++i];
    else if (arg === '--password' && args[i + 1]) options.password = args[++i];
    else if (arg === '--name' && args[i + 1]) options.name = args[++i];
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: node bin/bootstrap-admin.js [options]

Options:
  --email <email>        Admin email (default: env BOOTSTRAP_ADMIN_EMAIL or admin@pulse.local)
  --password <password>  Admin password (default: env BOOTSTRAP_ADMIN_PASSWORD or random generation)
  --name <name>          Admin full name (default: Platform Administrator)
  --force                Force re-create or overwrite admin user
  -h, --help             Show this help message
      `);
      process.exit(0);
    }
  }

  if (!options.email) {
    options.email = 'admin@pulse.local';
  }

  return options;
}

async function main() {
  const options = parseArgs();

  console.log('──────────────────────────────────────────────────────────────────');
  console.log('  PULSE PLATFORM — Initial Platform Admin Bootstrap');
  console.log('──────────────────────────────────────────────────────────────────');

  const dbPath = process.env.DATABASE_URL || path.resolve('data/virtual_company.db');
  const storage = new StorageEngine(dbPath);
  const authManager = new AuthManager({ storage });

  try {
    const existing = await storage.getUserByEmail(options.email);
    if (existing && !options.force) {
      console.log(`[BOOTSTRAP] Administrator already exists with email: ${options.email}`);
      console.log(`[BOOTSTRAP] Role: ${existing.role} | Tenant: ${existing.tenant_id || existing.tenantId}`);
      console.log(`[BOOTSTRAP] If you wish to reset or re-create, pass --force.`);
      process.exit(0);
    }

    const result = await authManager.bootstrapPlatformAdmin({
      email: options.email,
      password: options.password,
      name: options.name
    });

    console.log(`\n✔ Platform Administrator successfully initialized!`);
    console.log(`  User ID:      ${result.user.id}`);
    console.log(`  Email:        ${result.user.email}`);
    console.log(`  Role:         ${result.user.role}`);
    console.log(`  Tenant:       ${result.user.tenantId}`);

    if (result.temporaryPassword) {
      console.log(`\n  ==============================================================`);
      console.log(`  GENERATED ADMIN PASSWORD: ${result.temporaryPassword}`);
      console.log(`  ==============================================================`);
      console.log(`  IMPORTANT: Record this password in a secure vault immediately.`);
      console.log(`  This generated password will NOT be displayed again.\n`);
    } else {
      console.log(`\n  Password set from environment / command-line arguments.\n`);
    }

    storage.close();
    process.exit(0);
  } catch (err) {
    console.error(`\n✖ Bootstrap failed: ${err.message}`);
    storage.close();
    process.exit(1);
  }
}

main();
