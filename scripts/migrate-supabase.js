#!/usr/bin/env node
import { PostgresStorageAdapter } from '../src/storage/postgresAdapter.js';
import { MigrationRunner } from '../src/storage/migrations/migrationRunner.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env if present
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...vals] = trimmed.split('=');
    if (key && !process.env[key.trim()]) {
      process.env[key.trim()] = vals.join('=').trim();
    }
  }
}

async function run() {
  const connStr = process.env.DATABASE_URL;
  if (!connStr || connStr.includes('[YOUR-PASSWORD]')) {
    console.error('❌ Error: DATABASE_URL is not set or still contains [YOUR-PASSWORD].');
    console.error('Please configure your database password in .env or provide DATABASE_URL.');
    console.error('Example: DATABASE_URL="postgresql://postgres:<password>@db.lzzmwtwnhijexjgoibic.supabase.co:5432/postgres" node scripts/migrate-supabase.js');
    process.exit(1);
  }

  console.log('⚡ Connecting to Supabase PostgreSQL at:', connStr.replace(/:([^:@]+)@/, ':****@'));
  const adapter = new PostgresStorageAdapter({ connectionString: connStr });
  await adapter.connect();

  try {
    const migrationsDir = path.resolve(__dirname, '../src/storage/migrations');
    const runner = new MigrationRunner(adapter, migrationsDir);
    console.log('🔄 Checking pending migrations...');
    const result = await runner.migrateUp();
    if (result.appliedCount === 0) {
      console.log('✅ Supabase database is already up-to-date. (0 migrations applied)');
    } else {
      console.log(`🎉 Successfully applied ${result.appliedCount} migrations to Supabase:`);
      for (const m of result.applied) {
        console.log(`   - v${m.version}: ${m.name} (${m.durationMs}ms)`);
      }
    }
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await adapter.close();
  }
}

run();
