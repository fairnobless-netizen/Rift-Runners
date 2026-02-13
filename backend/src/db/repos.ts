import crypto from 'crypto';
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



export type StoreCatalogItemRecord = {
  sku: string;
  category: string;
  title: string;
  description: string;
  priceStars: number;
  active: boolean;
  purchaseEnabled: boolean;
  sortOrder: number;
};

export async function listStoreCatalog(): Promise<StoreCatalogItemRecord[]> {
  const { rows } = await pgQuery<{
    sku: string;
    category: string;
    title: string;
    description: string;
    price_stars: number;
    active: boolean;
    purchase_enabled: boolean;
    sort_order: number;
  }>(
    `
    SELECT sku, category, title, description, price_stars, active, purchase_enabled, sort_order
    FROM store_items
    WHERE active = TRUE
    ORDER BY category ASC, sort_order ASC, sku ASC
    `,
  );

  return rows.map((row) => ({
    sku: String(row.sku),
    category: String(row.category),
    title: String(row.title),
    description: String(row.description ?? ''),
    priceStars: Number(row.price_stars ?? 0),
    active: Boolean(row.active),
    purchaseEnabled: Boolean(row.purchase_enabled),
    sortOrder: Number(row.sort_order ?? 0),
  }));
}

export async function listOwnedSkus(tgUserId: string): Promise<string[]> {
  const { rows } = await pgQuery<{ sku: string }>(
    `SELECT sku FROM store_ownership WHERE tg_user_id = $1 ORDER BY acquired_at DESC`,
    [tgUserId],
  );
  return rows.map((row) => String(row.sku));
}

export async function buyStoreSkuTx(params: {
  tgUserId: string;
  sku: string;
}): Promise<{ wallet: { tgUserId: string; stars: number; crystals: number }; ownedSkus: string[] }> {
  const pool = getPgPool();
  const client = await pool.connect();
  const now = Date.now();

  try {
    await client.query('BEGIN');

    const itemRes = await client.query<{
      sku: string;
      active: boolean;
      purchase_enabled: boolean;
      price_stars: number;
    }>(
      `SELECT sku, active, purchase_enabled, price_stars FROM store_items WHERE sku = $1 LIMIT 1`,
      [params.sku],
    );

    const item = itemRes.rows[0];
    if (!item || !item.active) {
      await client.query('ROLLBACK');
      const error = new Error('sku_not_found');
      (error as any).code = 'SKU_NOT_FOUND';
      throw error;
    }

    if (!item.purchase_enabled) {
      await client.query('ROLLBACK');
      const error = new Error('not_purchasable');
      (error as any).code = 'NOT_PURCHASABLE';
      throw error;
    }

    const ownRes = await client.query<{ sku: string }>(
      `SELECT sku FROM store_ownership WHERE tg_user_id = $1 AND sku = $2 LIMIT 1`,
      [params.tgUserId, params.sku],
    );

    if (ownRes.rows[0]) {
      await client.query('ROLLBACK');
      const error = new Error('already_owned');
      (error as any).code = 'ALREADY_OWNED';
      throw error;
    }

    await client.query(`INSERT INTO wallets (tg_user_id, stars, crystals) VALUES ($1, 0, 0) ON CONFLICT DO NOTHING`, [params.tgUserId]);
    const walletRes = await client.query<{ stars: number; crystals: number }>(
      `SELECT stars, crystals FROM wallets WHERE tg_user_id = $1 FOR UPDATE`,
      [params.tgUserId],
    );

    const stars0 = Number(walletRes.rows[0]?.stars ?? 0);
    const crystals0 = Number(walletRes.rows[0]?.crystals ?? 0);
    const priceStars = Math.max(0, Math.floor(Number(item.price_stars ?? 0)));

    if (priceStars > stars0) {
      await client.query('ROLLBACK');
      const error = new Error('insufficient_funds');
      (error as any).code = 'INSUFFICIENT_FUNDS';
      throw error;
    }

    const stars1 = stars0 - priceStars;

    await client.query(
      `UPDATE wallets SET stars = $2, crystals = $3 WHERE tg_user_id = $1`,
      [params.tgUserId, stars1, crystals0],
    );

    await client.query(
      `
      INSERT INTO ledger_entries (id, tg_user_id, type, currency, amount, meta, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        `led_store_${now}_${Math.random().toString(16).slice(2, 8)}`,
        params.tgUserId,
        'purchase',
        'stars',
        -priceStars,
        { source: 'store_buy', sku: params.sku },
        now,
      ],
    );

    await client.query(
      `INSERT INTO store_ownership (tg_user_id, sku) VALUES ($1, $2)`,
      [params.tgUserId, params.sku],
    );

    const ownedRows = await client.query<{ sku: string }>(
      `SELECT sku FROM store_ownership WHERE tg_user_id = $1 ORDER BY acquired_at DESC`,
      [params.tgUserId],
    );

    await client.query('COMMIT');
    return {
      wallet: { tgUserId: params.tgUserId, stars: stars1, crystals: crystals0 },
      ownedSkus: ownedRows.rows.map((row) => String(row.sku)),
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
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

export async function getUserSettings(tgUserId: string): Promise<{ musicEnabled: boolean; sfxEnabled: boolean }> {
  const { rows } = await pgQuery<{ music_enabled: boolean; sfx_enabled: boolean }>(
    `SELECT music_enabled, sfx_enabled FROM user_settings WHERE tg_user_id = $1 LIMIT 1`,
    [tgUserId],
  );

  const row = rows[0];
  if (!row) {
    return { musicEnabled: true, sfxEnabled: true };
  }

  return {
    musicEnabled: Boolean(row.music_enabled),
    sfxEnabled: Boolean(row.sfx_enabled),
  };
}

export async function upsertUserSettings(params: {
  tgUserId: string;
  musicEnabled: boolean;
  sfxEnabled: boolean;
}): Promise<{ musicEnabled: boolean; sfxEnabled: boolean; updatedAt: number }> {
  const now = Date.now();
  const { rows } = await pgQuery<{ music_enabled: boolean; sfx_enabled: boolean; updated_at: number }>(
    `
    INSERT INTO user_settings (tg_user_id, music_enabled, sfx_enabled, updated_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (tg_user_id)
    DO UPDATE SET
      music_enabled = EXCLUDED.music_enabled,
      sfx_enabled = EXCLUDED.sfx_enabled,
      updated_at = EXCLUDED.updated_at
    RETURNING music_enabled, sfx_enabled, updated_at
    `,
    [params.tgUserId, params.musicEnabled, params.sfxEnabled, now],
  );

  const row = rows[0];
  return {
    musicEnabled: Boolean(row.music_enabled),
    sfxEnabled: Boolean(row.sfx_enabled),
    updatedAt: Number(row.updated_at),
  };
}

export type LeaderboardTopEntry = {
  rank: number;
  tgUserId: string;
  displayName: string;
  score: number;
};

export type LeaderboardMeEntry = {
  rank: number | null;
  score: number;
};

export async function listLeaderboardTop(mode: string, limit: number): Promise<LeaderboardTopEntry[]> {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const { rows } = await pgQuery<{
    rank: number;
    tg_user_id: string;
    display_name: string;
    best_score: number;
  }>(
    `
    SELECT
      ROW_NUMBER() OVER (ORDER BY ls.best_score DESC, ls.updated_at ASC, ls.tg_user_id ASC) AS rank,
      ls.tg_user_id,
      u.display_name,
      ls.best_score
    FROM leaderboard_scores ls
    JOIN users u ON u.tg_user_id = ls.tg_user_id
    WHERE ls.mode = $1
    ORDER BY ls.best_score DESC, ls.updated_at ASC, ls.tg_user_id ASC
    LIMIT $2
    `,
    [mode, safeLimit],
  );

  return rows.map((row) => ({
    rank: Number(row.rank),
    tgUserId: String(row.tg_user_id),
    displayName: String(row.display_name ?? 'Unknown'),
    score: Number(row.best_score ?? 0),
  }));
}

export async function getMyLeaderboardEntry(tgUserId: string, mode: string): Promise<LeaderboardMeEntry | null> {
  const { rows } = await pgQuery<{
    best_score: number;
    rank: number;
  }>(
    `
    SELECT
      mine.best_score,
      (
        SELECT COUNT(*)::int
        FROM leaderboard_scores all_scores
        WHERE all_scores.mode = mine.mode
          AND (
            all_scores.best_score > mine.best_score
            OR (all_scores.best_score = mine.best_score AND all_scores.updated_at < mine.updated_at)
            OR (all_scores.best_score = mine.best_score AND all_scores.updated_at = mine.updated_at AND all_scores.tg_user_id < mine.tg_user_id)
          )
      ) + 1 AS rank
    FROM leaderboard_scores mine
    WHERE mine.tg_user_id = $1 AND mine.mode = $2
    LIMIT 1
    `,
    [tgUserId, mode],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    rank: Number(row.rank),
    score: Number(row.best_score ?? 0),
  };
}

export async function submitLeaderboardScore(tgUserId: string, mode: string, score: number): Promise<void> {
  const safeScore = Math.max(0, Math.floor(score));
  await pgQuery(
    `
    INSERT INTO leaderboard_scores (tg_user_id, mode, best_score, updated_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (tg_user_id, mode)
    DO UPDATE SET
      best_score = GREATEST(leaderboard_scores.best_score, EXCLUDED.best_score),
      updated_at = now()
    `,
    [tgUserId, mode, safeScore],
  );
}

export async function checkAndTouchLeaderboardSubmitLimit(tgUserId: string, cooldownMs = 30_000): Promise<boolean> {
  const safeCooldownMs = Math.max(0, Math.floor(cooldownMs));
  const now = Date.now();
  const { rows } = await pgQuery<{ last_submit_at: number }>(
    `SELECT last_submit_at FROM leaderboard_submit_limits WHERE tg_user_id = $1 LIMIT 1`,
    [tgUserId],
  );

  const lastSubmitAt = Number(rows[0]?.last_submit_at ?? 0);
  if (now - lastSubmitAt < safeCooldownMs) {
    return false;
  }

  await pgQuery(
    `
    INSERT INTO leaderboard_submit_limits (tg_user_id, last_submit_at)
    VALUES ($1, $2)
    ON CONFLICT (tg_user_id)
    DO UPDATE SET last_submit_at = EXCLUDED.last_submit_at
    `,
    [tgUserId, now],
  );

  return true;
}




export type FriendRecord = {
  tgUserId: string;
  displayName: string;
  createdAt: string;
};

export type IncomingFriendRequestRecord = {
  fromTgUserId: string;
  displayName: string;
  createdAt: string;
};

export type OutgoingFriendRequestRecord = {
  toTgUserId: string;
  displayName: string;
  createdAt: string;
  status: string;
};

export async function listFriends(tgUserId: string): Promise<FriendRecord[]> {
  const { rows } = await pgQuery<{ tg_user_id_b: string; display_name: string; created_at: string }>(
    `
    SELECT fe.tg_user_id_b, u.display_name, fe.created_at
    FROM friend_edges fe
    JOIN users u ON u.tg_user_id = fe.tg_user_id_b
    WHERE fe.tg_user_id_a = $1
    ORDER BY u.display_name ASC, fe.created_at DESC
    `,
    [tgUserId],
  );

  return rows.map((row) => ({
    tgUserId: String(row.tg_user_id_b),
    displayName: String(row.display_name ?? 'Unknown'),
    createdAt: String(row.created_at),
  }));
}

export async function listIncomingRequests(tgUserId: string): Promise<IncomingFriendRequestRecord[]> {
  const { rows } = await pgQuery<{ from_tg_user_id: string; display_name: string; created_at: string }>(
    `
    SELECT fr.from_tg_user_id, u.display_name, fr.created_at
    FROM friend_requests fr
    JOIN users u ON u.tg_user_id = fr.from_tg_user_id
    WHERE fr.to_tg_user_id = $1 AND fr.status = 'PENDING'
    ORDER BY fr.created_at DESC
    `,
    [tgUserId],
  );

  return rows.map((row) => ({
    fromTgUserId: String(row.from_tg_user_id),
    displayName: String(row.display_name ?? 'Unknown'),
    createdAt: String(row.created_at),
  }));
}

export async function listOutgoingRequests(tgUserId: string): Promise<OutgoingFriendRequestRecord[]> {
  const { rows } = await pgQuery<{ to_tg_user_id: string; display_name: string; created_at: string; status: string }>(
    `
    SELECT fr.to_tg_user_id, u.display_name, fr.created_at, fr.status
    FROM friend_requests fr
    JOIN users u ON u.tg_user_id = fr.to_tg_user_id
    WHERE fr.from_tg_user_id = $1 AND fr.status = 'PENDING'
    ORDER BY fr.created_at DESC
    `,
    [tgUserId],
  );

  return rows.map((row) => ({
    toTgUserId: String(row.to_tg_user_id),
    displayName: String(row.display_name ?? 'Unknown'),
    createdAt: String(row.created_at),
    status: String(row.status),
  }));
}

export async function requestFriend(fromId: string, toId: string): Promise<void> {
  const fromTgUserId = String(fromId ?? '').trim();
  const toTgUserId = String(toId ?? '').trim();
  if (!toTgUserId || fromTgUserId === toTgUserId) {
    const error = new Error('invalid_target');
    (error as any).code = 'INVALID_TARGET';
    throw error;
  }

  const [targetExistsRes, edgeRes, existingPendingRes] = await Promise.all([
    pgQuery<{ tg_user_id: string }>(`SELECT tg_user_id FROM users WHERE tg_user_id = $1 LIMIT 1`, [toTgUserId]),
    pgQuery<{ tg_user_id_a: string }>(
      `SELECT tg_user_id_a FROM friend_edges WHERE tg_user_id_a = $1 AND tg_user_id_b = $2 LIMIT 1`,
      [fromTgUserId, toTgUserId],
    ),
    pgQuery<{ from_tg_user_id: string }>(
      `SELECT from_tg_user_id FROM friend_requests WHERE from_tg_user_id = $1 AND to_tg_user_id = $2 AND status = 'PENDING' LIMIT 1`,
      [fromTgUserId, toTgUserId],
    ),
  ]);

  if (!targetExistsRes.rows[0]) {
    const error = new Error('invalid_target');
    (error as any).code = 'INVALID_TARGET';
    throw error;
  }

  if (edgeRes.rows[0]) {
    const error = new Error('already_friends');
    (error as any).code = 'ALREADY_FRIENDS';
    throw error;
  }

  if (existingPendingRes.rows[0]) {
    const error = new Error('already_requested');
    (error as any).code = 'ALREADY_REQUESTED';
    throw error;
  }

  await pgQuery(
    `
    INSERT INTO friend_requests (from_tg_user_id, to_tg_user_id, status, created_at, updated_at)
    VALUES ($1, $2, 'PENDING', now(), now())
    ON CONFLICT (from_tg_user_id, to_tg_user_id)
    DO UPDATE SET
      status = 'PENDING',
      created_at = now(),
      updated_at = now()
    `,
    [fromTgUserId, toTgUserId],
  );
}

export async function respondFriendRequest(toId: string, fromId: string, action: 'accept' | 'decline'): Promise<void> {
  const toTgUserId = String(toId ?? '').trim();
  const fromTgUserId = String(fromId ?? '').trim();
  if (!toTgUserId || !fromTgUserId || !['accept', 'decline'].includes(action)) {
    const error = new Error('request_not_found');
    (error as any).code = 'REQUEST_NOT_FOUND';
    throw error;
  }

  const pool = getPgPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reqRes = await client.query<{ from_tg_user_id: string }>(
      `
      SELECT from_tg_user_id
      FROM friend_requests
      WHERE from_tg_user_id = $1 AND to_tg_user_id = $2 AND status = 'PENDING'
      FOR UPDATE
      `,
      [fromTgUserId, toTgUserId],
    );

    if (!reqRes.rows[0]) {
      const error = new Error('request_not_found');
      (error as any).code = 'REQUEST_NOT_FOUND';
      throw error;
    }

    if (action === 'accept') {
      await client.query(
        `
        UPDATE friend_requests
        SET status = 'ACCEPTED', updated_at = now()
        WHERE from_tg_user_id = $1 AND to_tg_user_id = $2
        `,
        [fromTgUserId, toTgUserId],
      );

      await client.query(
        `
        INSERT INTO friend_edges (tg_user_id_a, tg_user_id_b)
        VALUES ($1, $2), ($2, $1)
        ON CONFLICT DO NOTHING
        `,
        [fromTgUserId, toTgUserId],
      );
    } else {
      await client.query(
        `
        UPDATE friend_requests
        SET status = 'DECLINED', updated_at = now()
        WHERE from_tg_user_id = $1 AND to_tg_user_id = $2
        `,
        [fromTgUserId, toTgUserId],
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export type RoomRecord = {
  roomCode: string;
  ownerTgUserId: string;
  capacity: number;
  status: string;
  createdAt: string;
};

export type RoomMemberRecord = {
  tgUserId: string;
  displayName: string;
  joinedAt: string;
};

export type MyRoomRecord = {
  roomCode: string;
  capacity: number;
  status: string;
  createdAt: string;
  memberCount: number;
};

function newRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return out;
}

export async function createRoomTx(ownerTgUserId: string, capacity: number): Promise<{ roomCode: string }> {
  const safeCapacity = Math.floor(capacity);
  if (![2, 3, 4].includes(safeCapacity)) {
    const error = new Error('capacity_invalid');
    (error as any).code = 'CAPACITY_INVALID';
    throw error;
  }

  const pool = getPgPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let roomCode = '';
    let created = false;
    for (let i = 0; i < 8; i += 1) {
      roomCode = newRoomCode();
      try {
        await client.query(
          `
          INSERT INTO rooms (room_code, owner_tg_user_id, capacity, status)
          VALUES ($1, $2, $3, 'OPEN')
          `,
          [roomCode, ownerTgUserId, safeCapacity],
        );
        created = true;
        break;
      } catch (error: any) {
        if (error?.code !== '23505') {
          throw error;
        }
      }
    }

    if (!created || !roomCode) {
      throw new Error('room_code_conflict');
    }

    await client.query(
      `INSERT INTO room_members (room_code, tg_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [roomCode, ownerTgUserId],
    );

    await client.query('COMMIT');
    return { roomCode };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getRoomByCode(roomCode: string): Promise<RoomRecord | null> {
  const { rows } = await pgQuery<{
    room_code: string;
    owner_tg_user_id: string;
    capacity: number;
    status: string;
    created_at: string;
  }>(
    `
    SELECT room_code, owner_tg_user_id, capacity, status, created_at
    FROM rooms
    WHERE room_code = $1
    LIMIT 1
    `,
    [roomCode],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    roomCode: String(row.room_code),
    ownerTgUserId: String(row.owner_tg_user_id),
    capacity: Number(row.capacity),
    status: String(row.status),
    createdAt: String(row.created_at),
  };
}

export async function listRoomMembers(roomCode: string): Promise<RoomMemberRecord[]> {
  const { rows } = await pgQuery<{ tg_user_id: string; display_name: string; joined_at: string }>(
    `
    SELECT rm.tg_user_id, u.display_name, rm.joined_at
    FROM room_members rm
    JOIN users u ON u.tg_user_id = rm.tg_user_id
    WHERE rm.room_code = $1
    ORDER BY rm.joined_at ASC
    `,
    [roomCode],
  );

  return rows.map((row) => ({
    tgUserId: String(row.tg_user_id),
    displayName: String(row.display_name ?? 'Unknown'),
    joinedAt: String(row.joined_at),
  }));
}

export async function listMyRooms(tgUserId: string): Promise<MyRoomRecord[]> {
  const { rows } = await pgQuery<{
    room_code: string;
    capacity: number;
    status: string;
    created_at: string;
    member_count: number;
  }>(
    `
    SELECT r.room_code, r.capacity, r.status, r.created_at, COUNT(rm.tg_user_id)::int AS member_count
    FROM room_members m
    JOIN rooms r ON r.room_code = m.room_code
    LEFT JOIN room_members rm ON rm.room_code = r.room_code
    WHERE m.tg_user_id = $1
    GROUP BY r.room_code, r.capacity, r.status, r.created_at
    ORDER BY r.created_at DESC
    LIMIT 10
    `,
    [tgUserId],
  );

  return rows.map((row) => ({
    roomCode: String(row.room_code),
    capacity: Number(row.capacity),
    status: String(row.status),
    createdAt: String(row.created_at),
    memberCount: Number(row.member_count ?? 0),
  }));
}

export async function joinRoomTx(tgUserId: string, roomCode: string): Promise<{ roomCode: string; capacity: number; members: RoomMemberRecord[] }> {
  const pool = getPgPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const roomRes = await client.query<{ room_code: string; capacity: number; status: string }>(
      `SELECT room_code, capacity, status FROM rooms WHERE room_code = $1 FOR UPDATE`,
      [roomCode],
    );

    const room = roomRes.rows[0];
    if (!room) {
      const error = new Error('room_not_found');
      (error as any).code = 'ROOM_NOT_FOUND';
      throw error;
    }

    if (String(room.status) !== 'OPEN') {
      const error = new Error('room_closed');
      (error as any).code = 'ROOM_CLOSED';
      throw error;
    }

    const existsRes = await client.query<{ exists: number }>(
      `SELECT 1 AS exists FROM room_members WHERE room_code = $1 AND tg_user_id = $2 LIMIT 1`,
      [roomCode, tgUserId],
    );

    if (!existsRes.rows[0]) {
      const countRes = await client.query<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM room_members WHERE room_code = $1`,
        [roomCode],
      );

      const memberCount = Number(countRes.rows[0]?.count ?? 0);
      const capacity = Number(room.capacity ?? 0);
      if (memberCount >= capacity) {
        const error = new Error('room_full');
        (error as any).code = 'ROOM_FULL';
        throw error;
      }

      await client.query(
        `INSERT INTO room_members (room_code, tg_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [roomCode, tgUserId],
      );
    }

    const memberRows = await client.query<{ tg_user_id: string; display_name: string; joined_at: string }>(
      `
      SELECT rm.tg_user_id, u.display_name, rm.joined_at
      FROM room_members rm
      JOIN users u ON u.tg_user_id = rm.tg_user_id
      WHERE rm.room_code = $1
      ORDER BY rm.joined_at ASC
      `,
      [roomCode],
    );

    await client.query('COMMIT');

    return {
      roomCode: String(room.room_code),
      capacity: Number(room.capacity),
      members: memberRows.rows.map((row) => ({
        tgUserId: String(row.tg_user_id),
        displayName: String(row.display_name ?? 'Unknown'),
        joinedAt: String(row.joined_at),
      })),
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function leaveRoomTx(tgUserId: string): Promise<{ closedRoomCode?: string; leftRoomCode?: string }> {
  const pool = getPgPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const membershipRes = await client.query<{ room_code: string; owner_tg_user_id: string }>(
      `
      SELECT rm.room_code, r.owner_tg_user_id
      FROM room_members rm
      JOIN rooms r ON r.room_code = rm.room_code
      WHERE rm.tg_user_id = $1 AND r.status = 'OPEN'
      ORDER BY rm.joined_at DESC
      LIMIT 1
      FOR UPDATE
      `,
      [tgUserId],
    );

    const membership = membershipRes.rows[0];
    if (!membership) {
      const error = new Error('room_not_joined');
      (error as any).code = 'ROOM_NOT_JOINED';
      throw error;
    }

    const roomCode = String(membership.room_code);
    const ownerTgUserId = String(membership.owner_tg_user_id);

    if (ownerTgUserId === tgUserId) {
      await client.query(`UPDATE rooms SET status = 'CLOSED' WHERE room_code = $1`, [roomCode]);
      await client.query(`DELETE FROM room_members WHERE room_code = $1`, [roomCode]);
      await client.query('COMMIT');
      return { closedRoomCode: roomCode };
    }

    await client.query(`DELETE FROM room_members WHERE room_code = $1 AND tg_user_id = $2`, [roomCode, tgUserId]);
    await client.query('COMMIT');
    return { leftRoomCode: roomCode };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function closeRoomTx(ownerTgUserId: string, roomCode: string): Promise<void> {
  const pool = getPgPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const roomRes = await client.query<{ owner_tg_user_id: string }>(
      `SELECT owner_tg_user_id FROM rooms WHERE room_code = $1 FOR UPDATE`,
      [roomCode],
    );

    const room = roomRes.rows[0];
    if (!room) {
      const error = new Error('room_not_found');
      (error as any).code = 'ROOM_NOT_FOUND';
      throw error;
    }

    if (String(room.owner_tg_user_id) !== ownerTgUserId) {
      const error = new Error('forbidden');
      (error as any).code = 'FORBIDDEN';
      throw error;
    }

    await client.query(`UPDATE rooms SET status = 'CLOSED' WHERE room_code = $1`, [roomCode]);
    await client.query(`DELETE FROM room_members WHERE room_code = $1`, [roomCode]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function getUtcDayKey(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function computeNameChangeRemaining(tgUserId: string): Promise<number> {
  const dayKey = getUtcDayKey();
  const { rows } = await pgQuery<{ change_count: number }>(
    `SELECT change_count FROM user_name_limits WHERE tg_user_id = $1 AND day_key = $2 LIMIT 1`,
    [tgUserId, dayKey],
  );

  const used = Math.max(0, Number(rows[0]?.change_count ?? 0));
  return Math.max(0, 3 - used);
}

export async function updateDisplayNameWithLimit(params: {
  tgUserId: string;
  displayName: string;
}): Promise<{ ok: boolean; remaining: number }> {
  const pool = getPgPool();
  const client = await pool.connect();
  const dayKey = getUtcDayKey();
  const now = Date.now();

  try {
    await client.query('BEGIN');

    const limitRes = await client.query<{ change_count: number }>(
      `SELECT change_count FROM user_name_limits WHERE tg_user_id = $1 AND day_key = $2 FOR UPDATE`,
      [params.tgUserId, dayKey],
    );

    const used = Number(limitRes.rows[0]?.change_count ?? 0);
    if (used >= 3) {
      await client.query('ROLLBACK');
      return { ok: false, remaining: 0 };
    }

    await client.query(
      `UPDATE users SET display_name = $2, updated_at = $3 WHERE tg_user_id = $1`,
      [params.tgUserId, params.displayName, now],
    );

    if (limitRes.rows[0]) {
      await client.query(
        `UPDATE user_name_limits SET change_count = change_count + 1, updated_at = $3 WHERE tg_user_id = $1 AND day_key = $2`,
        [params.tgUserId, dayKey, now],
      );
    } else {
      await client.query(
        `INSERT INTO user_name_limits (tg_user_id, day_key, change_count, updated_at) VALUES ($1, $2, 1, $3)`,
        [params.tgUserId, dayKey, now],
      );
    }

    const nextUsedRes = await client.query<{ change_count: number }>(
      `SELECT change_count FROM user_name_limits WHERE tg_user_id = $1 AND day_key = $2 LIMIT 1`,
      [params.tgUserId, dayKey],
    );

    await client.query('COMMIT');
    const remaining = Math.max(0, 3 - Number(nextUsedRes.rows[0]?.change_count ?? 0));
    return { ok: true, remaining };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
