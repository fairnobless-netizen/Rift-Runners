import { pgQuery, getPgPool } from './pg';

export async function upsertUser(params: {
  tgUserId: string;
  displayName: string;
}): Promise<{ tgUserId: string; displayName: string; createdAt: number; updatedAt: number }> {
  const now = Date.now();

  const { rows } = await pgQuery<{
    tg_user_id: string;
    display_name: string;
    created_at: number;
    updated_at: number;
  }>(
    `
    INSERT INTO users (tg_user_id, display_name, created_at, updated_at)
    VALUES ($1, $2, $3, $3)
    ON CONFLICT (tg_user_id)
    DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at
    RETURNING tg_user_id, display_name, created_at, updated_at
    `,
    [params.tgUserId, params.displayName, now],
  );

  const u = rows[0];
  return {
    tgUserId: String(u.tg_user_id),
    displayName: String(u.display_name),
    createdAt: Number(u.created_at),
    updatedAt: Number(u.updated_at),
  };
}

export async function ensureWallet(tgUserId: string): Promise<{ tgUserId: string; stars: number; crystals: number }> {
  const { rows } = await pgQuery<{ tg_user_id: string; stars: number; crystals: number }>(
    `
    INSERT INTO wallets (tg_user_id, stars, crystals)
    VALUES ($1, 0, 0)
    ON CONFLICT (tg_user_id) DO NOTHING
    RETURNING tg_user_id, stars, crystals
    `,
    [tgUserId],
  );

  if (rows[0]) {
    return { tgUserId: String(rows[0].tg_user_id), stars: Number(rows[0].stars), crystals: Number(rows[0].crystals) };
  }

  const r2 = await pgQuery<{ tg_user_id: string; stars: number; crystals: number }>(
    `SELECT tg_user_id, stars, crystals FROM wallets WHERE tg_user_id = $1 LIMIT 1`,
    [tgUserId],
  );

  const w = r2.rows[0];
  return { tgUserId: String(w.tg_user_id), stars: Number(w.stars), crystals: Number(w.crystals) };
}

export async function createSession(params: {
  tokenHash: string;
  tgUserId: string;
  expiresAt: number;
}): Promise<void> {
  const now = Date.now();
  await pgQuery(
    `
    INSERT INTO sessions (token_hash, tg_user_id, created_at, expires_at)
    VALUES ($1, $2, $3, $4)
    `,
    [params.tokenHash, params.tgUserId, now, params.expiresAt],
  );
}

export async function getUserAndWallet(tgUserId: string): Promise<{
  user: { tgUserId: string; displayName: string; createdAt: number; updatedAt: number };
  wallet: { tgUserId: string; stars: number; crystals: number };
} | null> {
  const { rows } = await pgQuery<any>(
    `
    SELECT
      u.tg_user_id, u.display_name, u.created_at, u.updated_at,
      w.stars, w.crystals
    FROM users u
    LEFT JOIN wallets w ON w.tg_user_id = u.tg_user_id
    WHERE u.tg_user_id = $1
    LIMIT 1
    `,
    [tgUserId],
  );

  const r = rows[0];
  if (!r) return null;

  return {
    user: {
      tgUserId: String(r.tg_user_id),
      displayName: String(r.display_name),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    },
    wallet: {
      tgUserId: String(r.tg_user_id),
      stars: Number(r.stars ?? 0),
      crystals: Number(r.crystals ?? 0),
    },
  };
}

export async function listLedger(tgUserId: string, limit = 50): Promise<any[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const { rows } = await pgQuery(
    `
    SELECT id, tg_user_id, type, currency, amount, meta, created_at
    FROM ledger_entries
    WHERE tg_user_id = $1
    ORDER BY created_at DESC
    LIMIT $2
    `,
    [tgUserId, safeLimit],
  );
  return rows;
}

/**
 * Transactional wallet mutation + ledger append (atomic).
 * This is the "source of truth" path.
 */
export async function applyWalletDeltaTx(params: {
  tgUserId: string;
  delta: { stars?: number; crystals?: number };
  ledgerEntries: Array<{
    id: string;
    type: string;
    currency: string;
    amount: number;
    meta: Record<string, unknown>;
    createdAt: number;
  }>;
}): Promise<{ tgUserId: string; stars: number; crystals: number }> {
  const pool = getPgPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // lock row
    await client.query(`INSERT INTO wallets (tg_user_id, stars, crystals) VALUES ($1, 0, 0) ON CONFLICT DO NOTHING`, [params.tgUserId]);
    const w0 = await client.query(`SELECT stars, crystals FROM wallets WHERE tg_user_id = $1 FOR UPDATE`, [params.tgUserId]);

    const stars0 = Number(w0.rows[0]?.stars ?? 0);
    const crystals0 = Number(w0.rows[0]?.crystals ?? 0);

    const stars1 = Math.max(0, stars0 + Math.floor(params.delta.stars ?? 0));
    const crystals1 = Math.max(0, crystals0 + Math.floor(params.delta.crystals ?? 0));

    await client.query(
      `UPDATE wallets SET stars = $2, crystals = $3 WHERE tg_user_id = $1`,
      [params.tgUserId, stars1, crystals1],
    );

    for (const e of params.ledgerEntries) {
      await client.query(
        `
        INSERT INTO ledger_entries (id, tg_user_id, type, currency, amount, meta, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [e.id, params.tgUserId, e.type, e.currency, Math.floor(e.amount), e.meta, e.createdAt],
      );
    }

    await client.query('COMMIT');
    return { tgUserId: params.tgUserId, stars: stars1, crystals: crystals1 };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getCampaign(tgUserId: string): Promise<{
  schemaVersion: string;
  stage: number;
  zone: number;
  score: number;
  trophies: string[];
  updatedAt: number;
} | null> {
  const { rows } = await pgQuery<any>(
    `
    SELECT schema_version, stage, zone, score, trophies, updated_at
    FROM campaign_progress
    WHERE tg_user_id = $1
    LIMIT 1
    `,
    [tgUserId],
  );

  const r = rows[0];
  if (!r) return null;

  const trophies = Array.isArray(r.trophies) ? r.trophies : (r.trophies?.trophies ?? r.trophies ?? []);
  return {
    schemaVersion: String(r.schema_version ?? 'rift_campaign_v1'),
    stage: Number(r.stage ?? 1),
    zone: Number(r.zone ?? 1),
    score: Number(r.score ?? 0),
    trophies: Array.isArray(trophies) ? trophies.map(String) : [],
    updatedAt: Number(r.updated_at ?? 0),
  };
}

export async function saveCampaign(params: {
  tgUserId: string;
  stage: number;
  zone: number;
  score: number;
  trophies: string[];
  schemaVersion?: string;
}): Promise<{ updatedAt: number }> {
  const now = Date.now();
  const schemaVersion = params.schemaVersion ?? 'rift_campaign_v1';

  await pgQuery(
    `
    INSERT INTO campaign_progress (tg_user_id, schema_version, stage, zone, score, trophies, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (tg_user_id)
    DO UPDATE SET
      schema_version = EXCLUDED.schema_version,
      stage = EXCLUDED.stage,
      zone = EXCLUDED.zone,
      score = EXCLUDED.score,
      trophies = EXCLUDED.trophies,
      updated_at = EXCLUDED.updated_at
    `,
    [params.tgUserId, schemaVersion, params.stage, params.zone, params.score, JSON.stringify(params.trophies ?? []), now],
  );

  return { updatedAt: now };
}

export async function createPurchaseIntent(params: {
  id: string;
  tgUserId: string;
  sku: string;
  provider: string;
  expiresAt: number;
}): Promise<void> {
  const now = Date.now();
  await pgQuery(
    `
    INSERT INTO purchase_intents (id, tg_user_id, sku, provider, status, created_at, expires_at)
    VALUES ($1, $2, $3, $4, 'CREATED', $5, $6)
    `,
    [params.id, params.tgUserId, params.sku, params.provider, now, params.expiresAt],
  );
}

export async function getPurchaseIntent(params: { id: string; tgUserId: string }): Promise<any | null> {
  const { rows } = await pgQuery(
    `
    SELECT id, tg_user_id, sku, provider, status, created_at, expires_at, provider_txn_id, applied_at
    FROM purchase_intents
    WHERE id = $1 AND tg_user_id = $2
    LIMIT 1
    `,
    [params.id, params.tgUserId],
  );
  return rows[0] ?? null;
}

export async function deletePurchaseIntent(params: { id: string; tgUserId: string }): Promise<void> {
  await pgQuery(`DELETE FROM purchase_intents WHERE id = $1 AND tg_user_id = $2`, [params.id, params.tgUserId]);
}
