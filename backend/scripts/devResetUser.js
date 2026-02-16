#!/usr/bin/env node

const { Pool } = require('pg');

function fail(message) {
  console.error(`[dev-reset-user] ERROR: ${message}`);
  process.exit(1);
}

function parseAllowlist(raw) {
  return new Set(
    raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

async function main() {
  const tgUserId = process.argv[2]?.trim();
  if (!tgUserId) {
    fail('Usage: node scripts/devResetUser.js <tg_user_id>');
  }

  const nodeEnv = (process.env.NODE_ENV || '').toLowerCase();
  const environment = (process.env.ENVIRONMENT || '').toLowerCase();
  if (nodeEnv === 'production' || environment === 'production') {
    fail('Refusing to run in production environment.');
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    fail('Missing required env var: DATABASE_URL');
  }

  const resetSecret = process.env.DEV_RESET_SECRET;
  if (!resetSecret) {
    fail('Missing required env var: DEV_RESET_SECRET');
  }

  const allowlistRaw = process.env.DEV_RESET_ALLOWLIST;
  if (!allowlistRaw) {
    fail('Missing required env var: DEV_RESET_ALLOWLIST');
  }

  const allowlist = parseAllowlist(allowlistRaw);
  if (!allowlist.has(tgUserId)) {
    fail(`tg_user_id ${tgUserId} is not in DEV_RESET_ALLOWLIST`);
  }

  const pool = new Pool({ connectionString: dbUrl, max: 1 });

  const deletions = [
    ['referrals_invitee', 'DELETE FROM referrals WHERE invitee_user_id = $1'],
    ['referrals_referrer', 'DELETE FROM referrals WHERE referrer_user_id = $1'],
    ['leaderboard_scores', 'DELETE FROM leaderboard_scores WHERE tg_user_id = $1'],
    ['purchase_intents', 'DELETE FROM purchase_intents WHERE tg_user_id = $1'],
    ['store_ownership', 'DELETE FROM store_ownership WHERE tg_user_id = $1'],
    ['ledger_entries', 'DELETE FROM ledger_entries WHERE tg_user_id = $1'],
    ['campaign_progress', 'DELETE FROM campaign_progress WHERE tg_user_id = $1'],
    ['leaderboard_submit_limits', 'DELETE FROM leaderboard_submit_limits WHERE tg_user_id = $1'],
    ['user_name_limits', 'DELETE FROM user_name_limits WHERE tg_user_id = $1'],
    ['user_settings', 'DELETE FROM user_settings WHERE tg_user_id = $1'],
    ['friend_requests_from', 'DELETE FROM friend_requests WHERE from_tg_user_id = $1'],
    ['friend_requests_to', 'DELETE FROM friend_requests WHERE to_tg_user_id = $1'],
    ['friend_edges_a', 'DELETE FROM friend_edges WHERE tg_user_id_a = $1'],
    ['friend_edges_b', 'DELETE FROM friend_edges WHERE tg_user_id_b = $1'],
    ['room_members', 'DELETE FROM room_members WHERE tg_user_id = $1'],
    ['rooms_owner', 'DELETE FROM rooms WHERE owner_tg_user_id = $1'],
    ['sessions', 'DELETE FROM sessions WHERE tg_user_id = $1'],
    ['wallets', 'DELETE FROM wallets WHERE tg_user_id = $1'],
    ['users', 'DELETE FROM users WHERE tg_user_id = $1'],
  ];

  const deleted = {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const [key, query] of deletions) {
      const result = await client.query(query, [tgUserId]);
      deleted[key] = result.rowCount;
    }

    await client.query('COMMIT');
    console.log('[dev-reset-user] deleted:', deleted);
    console.log('[dev-reset-user] ok');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
});
