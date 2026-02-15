-- Rift Runners N1 schema (epoch ms timestamps)

CREATE TABLE IF NOT EXISTS users (
  tg_user_id TEXT PRIMARY KEY,
  tg_username TEXT,
  display_name TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_tg_username
  ON users (LOWER(tg_username));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  tg_user_id TEXT NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_tg_user_id ON sessions(tg_user_id);

CREATE TABLE IF NOT EXISTS wallets (
  tg_user_id TEXT PRIMARY KEY REFERENCES users(tg_user_id) ON DELETE CASCADE,
  stars INTEGER NOT NULL DEFAULT 0,
  crystals INTEGER NOT NULL DEFAULT 0,
  plasma INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS plasma INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  tg_user_id TEXT NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount INTEGER NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_user_time ON ledger_entries(tg_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS campaign_progress (
  tg_user_id TEXT PRIMARY KEY REFERENCES users(tg_user_id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL DEFAULT 'rift_campaign_v1',
  stage INTEGER NOT NULL,
  zone INTEGER NOT NULL,
  score INTEGER NOT NULL,
  trophies JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_intents (
  id TEXT PRIMARY KEY,
  tg_user_id TEXT NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  provider_txn_id TEXT NULL,
  applied_at BIGINT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_provider_txn_id ON purchase_intents(provider_txn_id) WHERE provider_txn_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_user_created ON purchase_intents(tg_user_id, created_at DESC);

-- =========================================
-- STORE (Stage 2)
-- =========================================

CREATE TABLE IF NOT EXISTS store_items (
  sku TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_stars INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  purchase_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  grants_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE store_items
  ADD COLUMN IF NOT EXISTS purchase_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_store_items_active_sort
  ON store_items (active, category, sort_order);

CREATE TABLE IF NOT EXISTS store_ownership (
  tg_user_id TEXT NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  sku TEXT NOT NULL REFERENCES store_items(sku) ON DELETE CASCADE,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tg_user_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_store_ownership_user
  ON store_ownership (tg_user_id);

-- =========================================
-- STORE SEED (Stage 2.1) — idempotent
-- =========================================
-- Note: ON CONFLICT DO NOTHING makes this safe to run on every startup migration.

INSERT INTO store_items (sku, category, title, description, price_stars, active, purchase_enabled, sort_order, grants_json)
VALUES
  -- Packs (visible but not purchasable until Stars)
  ('pack.stars.50',   'packs', 'Stars x50',   'Small star pack',   0, TRUE, FALSE, 10, '{"stars":50}'::jsonb),
  ('pack.stars.200',  'packs', 'Stars x200',  'Medium star pack',  0, TRUE, FALSE, 20, '{"stars":200}'::jsonb),
  ('pack.stars.500',  'packs', 'Stars x500',  'Large star pack',   0, TRUE, FALSE, 30, '{"stars":500}'::jsonb),

  -- Boosts (example consumables / unlocks; MVP: still treat as owned = true, can evolve later)
  ('boost.bomb.plus1', 'boosts', 'Bomb +1', 'Adds one extra bomb charge (MVP)', 25, TRUE, TRUE, 10, '{"boost":"bomb_plus1","value":1}'::jsonb),
  ('boost.score.5pct', 'boosts', 'Score +5%', 'Permanent score bonus (MVP)',    75, TRUE, TRUE, 20, '{"boost":"score_bonus","value":5}'::jsonb),

  -- Cosmetics
  ('cosmetic.frame.dark', 'cosmetics', 'Dark Frame', 'Cosmetic frame style (MVP)', 40, TRUE, TRUE, 10, '{"cosmetic":"frame_dark"}'::jsonb),
  ('cosmetic.trail.spark', 'cosmetics', 'Spark Trail', 'Cosmetic trail effect (MVP)', 60, TRUE, TRUE, 20, '{"cosmetic":"trail_spark"}'::jsonb)

ON CONFLICT (sku) DO NOTHING;

-- =========================
-- Settings + Account meta
-- =========================

CREATE TABLE IF NOT EXISTS user_settings (
  tg_user_id TEXT PRIMARY KEY REFERENCES users(tg_user_id) ON DELETE CASCADE,
  music_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sfx_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at BIGINT NOT NULL
);

-- daily rate-limit for display name change (3/day)
CREATE TABLE IF NOT EXISTS user_name_limits (
  tg_user_id TEXT NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  day_key TEXT NOT NULL,
  change_count INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tg_user_id, day_key)
);

-- =========================================
-- LEADERBOARD (Stage 3)
-- =========================================

CREATE TABLE IF NOT EXISTS leaderboard_scores (
  tg_user_id TEXT NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  best_score INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tg_user_id, mode)
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_mode_score
  ON leaderboard_scores (mode, best_score DESC);

CREATE TABLE IF NOT EXISTS leaderboard_submit_limits (
  tg_user_id TEXT PRIMARY KEY REFERENCES users(tg_user_id) ON DELETE CASCADE,
  last_submit_at BIGINT NOT NULL DEFAULT 0
);

-- =========================================
-- MULTIPLAYER ROOMS (Stage 4.1A)
-- =========================================

CREATE TABLE IF NOT EXISTS rooms (
  room_code TEXT PRIMARY KEY,                 -- short code used for join
  owner_tg_user_id TEXT NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  name TEXT,
  capacity INTEGER NOT NULL,                  -- 2/3/4
  password_hash TEXT,
  password_salt TEXT,
  has_password BOOLEAN NOT NULL DEFAULT FALSE,
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'OPEN',        -- OPEN | CLOSED
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rooms_owner_created
  ON rooms (owner_tg_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS room_members (
  room_code TEXT NOT NULL REFERENCES rooms(room_code) ON DELETE CASCADE,
  tg_user_id TEXT NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_code, tg_user_id)
);

CREATE INDEX IF NOT EXISTS idx_room_members_room
  ON room_members (room_code);

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'LOBBY';

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NULL;

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS started_by_tg_user_id TEXT NULL REFERENCES users(tg_user_id) ON DELETE SET NULL;

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS name TEXT;

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS password_salt TEXT;

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS has_password BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_rooms_public_name
  ON rooms (is_public, LOWER(name));

ALTER TABLE room_members
  ADD COLUMN IF NOT EXISTS ready BOOLEAN NOT NULL DEFAULT FALSE;

-- =========================================
-- FRIENDS (Stage 4.1B)
-- =========================================

CREATE TABLE IF NOT EXISTS friend_edges (
  tg_user_id_a TEXT NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  tg_user_id_b TEXT NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tg_user_id_a, tg_user_id_b)
);

-- Store requests as directional (from -> to)
CREATE TABLE IF NOT EXISTS friend_requests (
  from_tg_user_id TEXT NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  to_tg_user_id   TEXT NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | ACCEPTED | DECLINED
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_tg_user_id, to_tg_user_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_requests_to_status_created
  ON friend_requests (to_tg_user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_friend_requests_from_status_created
  ON friend_requests (from_tg_user_id, status, created_at DESC);

-- =========================================
-- REFERRALS (Stage M17.10)
-- =========================================

CREATE TABLE IF NOT EXISTS referrals (
  invitee_user_id TEXT PRIMARY KEY REFERENCES users(tg_user_id) ON DELETE CASCADE,
  referrer_user_id TEXT NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer
  ON referrals (referrer_user_id, created_at DESC);
