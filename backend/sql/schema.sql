-- Rift Runners N1 schema (epoch ms timestamps)

CREATE TABLE IF NOT EXISTS users (
  tg_user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

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
  crystals INTEGER NOT NULL DEFAULT 0
);

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
