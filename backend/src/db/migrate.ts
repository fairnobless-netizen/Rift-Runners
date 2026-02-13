import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { getPgPool } from './pg';

const MIGRATION_LOCK_KEY = 987654321;

async function ensureAdvisoryLock(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
}

async function releaseAdvisoryLock(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
}

function resolveSchemaPath(): string {
  const schemaPath = path.resolve(process.cwd(), 'sql', 'schema.sql');
  if (fs.existsSync(schemaPath)) return schemaPath;

  const altPath = path.resolve(process.cwd(), 'backend', 'sql', 'schema.sql');
  if (fs.existsSync(altPath)) return altPath;

  throw new Error('schema.sql not found (checked ./sql/schema.sql and ./backend/sql/schema.sql)');
}

export async function runMigrationsFromSchemaSql(): Promise<void> {
  const pool = getPgPool();
  const client = await pool.connect();

  try {
    await ensureAdvisoryLock(client);

    const sql = fs.readFileSync(resolveSchemaPath(), 'utf8');

    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failures
    }
    throw error;
  } finally {
    try {
      await releaseAdvisoryLock(client);
    } catch {
      // ignore unlock failures
    }
    client.release();
  }
}
