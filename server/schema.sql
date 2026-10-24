-- PostgreSQL starting schema. Apply manually when backend persistence is implemented.
CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nickname VARCHAR(18) NOT NULL UNIQUE,
  password_hash TEXT,
  currency BIGINT NOT NULL DEFAULT 500 CHECK (currency >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS skins (
  id TEXT PRIMARY KEY,
  weapon_id TEXT NOT NULL CHECK (weapon_id IN ('rifle','shotgun','pistol','knife')),
  name TEXT NOT NULL,
  rarity TEXT NOT NULL CHECK (rarity IN ('common','uncommon','rare','mythical','legendary','ancient'))
);
CREATE TABLE IF NOT EXISTS inventory_items (
  instance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  skin_id TEXT NOT NULL REFERENCES skins(id),
  wear REAL NOT NULL CHECK (wear >= 0 AND wear <= 1),
  pattern_seed INTEGER NOT NULL DEFAULT 0,
  is_equipped BOOLEAN NOT NULL DEFAULT FALSE,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS currency_transactions (
  id BIGSERIAL PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- TODO: use transactions/row locks for every currency mutation and enforce reward idempotency.