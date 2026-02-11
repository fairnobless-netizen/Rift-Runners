import {
  memoryDb,
  type WalletCurrency,
  type WalletLedgerEntryRecord,
  type WalletLedgerType,
  type WalletRecord,
} from '../db/memoryDb';

let ledgerSeq = 1;

function nextLedgerId(): string {
  const id = `led_${String(ledgerSeq).padStart(8, '0')}`;
  ledgerSeq += 1;
  return id;
}

export function getOrCreateWallet(tgUserId: string): WalletRecord {
  const existing = memoryDb.wallets.get(tgUserId);
  if (existing) return existing;

  const wallet: WalletRecord = { tgUserId, stars: 0, crystals: 0 };
  memoryDb.wallets.set(tgUserId, wallet);
  return wallet;
}

function applyDelta(wallet: WalletRecord, delta: { stars?: number; crystals?: number }): WalletRecord {
  return {
    tgUserId: wallet.tgUserId,
    stars: Math.max(0, (wallet.stars ?? 0) + (delta.stars ?? 0)),
    crystals: Math.max(0, (wallet.crystals ?? 0) + (delta.crystals ?? 0)),
  };
}

export function appendWalletLedgerEntry(params: {
  tgUserId: string;
  type: WalletLedgerType;
  currency: WalletCurrency;
  amount: number;
  meta?: Record<string, unknown>;
}): WalletLedgerEntryRecord {
  const entry: WalletLedgerEntryRecord = {
    id: nextLedgerId(),
    tgUserId: params.tgUserId,
    type: params.type,
    currency: params.currency,
    amount: Math.floor(params.amount),
    meta: params.meta ?? {},
    createdAt: Date.now(),
  };
  memoryDb.walletLedger.unshift(entry);
  return entry;
}

export function listWalletLedger(tgUserId: string, limit = 50): WalletLedgerEntryRecord[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  return memoryDb.walletLedger.filter((entry) => entry.tgUserId === tgUserId).slice(0, safeLimit);
}

export function grantWallet(
  tgUserId: string,
  delta: { stars?: number; crystals?: number },
  meta: Record<string, unknown> = {},
): { wallet: WalletRecord; entries: WalletLedgerEntryRecord[] } {
  const wallet = getOrCreateWallet(tgUserId);
  const next = applyDelta(wallet, delta);
  memoryDb.wallets.set(tgUserId, next);

  const entries: WalletLedgerEntryRecord[] = [];
  const stars = Math.floor(delta.stars ?? 0);
  const crystals = Math.floor(delta.crystals ?? 0);

  if (stars !== 0) {
    entries.push(appendWalletLedgerEntry({
      tgUserId,
      type: stars > 0 ? 'reward' : 'adjustment',
      currency: 'stars',
      amount: stars,
      meta,
    }));
  }

  if (crystals !== 0) {
    entries.push(appendWalletLedgerEntry({
      tgUserId,
      type: crystals > 0 ? 'reward' : 'adjustment',
      currency: 'crystals',
      amount: crystals,
      meta,
    }));
  }

  return { wallet: next, entries };
}

// TODO backend-relevant: move wallet mutation to DB-backed transactional updates.
