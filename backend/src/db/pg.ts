import { Pool } from 'pg';
import { requireDatabaseUrl } from '../config/env';

let _pool: Pool | null = null;

export function getPgPool(): Pool {
  if (_pool) return _pool;

  _pool = new Pool({
    connectionString: requireDatabaseUrl(),
    max: 10,
  });

  _pool.on('error', (err: Error) => {
    // eslint-disable-next-line no-console
    console.error('PG pool error:', err);
  });

  return _pool;
}

export async function pgQuery<T = any>(text: string, params: any[] = []): Promise<{ rows: T[] }> {
  const pool = getPgPool();
  const result = await pool.query(text, params);
  return { rows: result.rows as T[] };
}
