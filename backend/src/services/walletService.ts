import { memoryDb, WalletRecord } from '../db/memoryDb';

export function getOrCreateWallet(tgUserId: string): WalletRecord {
  const existing = memoryDb.wallets.get(tgUserId);
  if (existing) return existing;

  const wallet: WalletRecord = { tgUserId, stars: 0, crystals: 0 };
  memoryDb.wallets.set(tgUserId, wallet);
  return wallet;
}

export function grantWallet(tgUserId: string, delta: { stars?: number; crystals?: number }): WalletRecord {
  const wallet = getOrCreateWallet(tgUserId);
  const next: WalletRecord = {
    tgUserId,
    stars: Math.max(0, (wallet.stars ?? 0) + (delta.stars ?? 0)),
    crystals: Math.max(0, (wallet.crystals ?? 0) + (delta.crystals ?? 0)),
  };
  memoryDb.wallets.set(tgUserId, next);
  return next;
}

// TODO backend-relevant: move wallet mutation to DB-backed transactional updates.
