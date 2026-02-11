import crypto from 'crypto';
import { applyWalletDeltaTx, ensureWallet, listLedger } from '../db/repos';

export type WalletCurrency = 'stars' | 'crystals';
export type WalletLedgerType = 'reward' | 'purchase' | 'refund' | 'adjustment';

export type WalletRecord = {
  tgUserId: string;
  stars: number;
  crystals: number;
};

export type WalletLedgerEntryRecord = {
  id: string;
  tgUserId: string;
  type: WalletLedgerType;
  currency: WalletCurrency;
  amount: number;
  meta: Record<string, unknown>;
  createdAt: number;
};

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export async function getOrCreateWallet(tgUserId: string): Promise<WalletRecord> {
  const w = await ensureWallet(tgUserId);
  return { tgUserId: w.tgUserId, stars: w.stars, crystals: w.crystals };
}

export async function listWalletLedger(tgUserId: string, limit = 50): Promise<WalletLedgerEntryRecord[]> {
  const rows = await listLedger(tgUserId, limit);
  return rows.map((r: any) => ({
    id: String(r.id),
    tgUserId: String(r.tg_user_id),
    type: String(r.type) as WalletLedgerType,
    currency: String(r.currency) as WalletCurrency,
    amount: Number(r.amount),
    meta: (r.meta ?? {}) as Record<string, unknown>,
    createdAt: Number(r.created_at),
  }));
}

/**
 * Atomic mutation path for wallet + ledger.
 * This is the ONLY correct way to grant/spend currency.
 */
export async function grantWallet(
  tgUserId: string,
  delta: { stars?: number; crystals?: number },
  meta: Record<string, unknown> = {},
): Promise<{ wallet: WalletRecord; entries: WalletLedgerEntryRecord[] }> {
  const now = Date.now();

  const entries: WalletLedgerEntryRecord[] = [];
  const stars = Math.floor(delta.stars ?? 0);
  const crystals = Math.floor(delta.crystals ?? 0);

  if (stars !== 0) {
    entries.push({
      id: newId('led'),
      tgUserId,
      type: stars > 0 ? 'reward' : 'adjustment',
      currency: 'stars',
      amount: stars,
      meta,
      createdAt: now,
    });
  }

  if (crystals !== 0) {
    entries.push({
      id: newId('led'),
      tgUserId,
      type: crystals > 0 ? 'reward' : 'adjustment',
      currency: 'crystals',
      amount: crystals,
      meta,
      createdAt: now,
    });
  }

  const w = await applyWalletDeltaTx({
    tgUserId,
    delta: { stars, crystals },
    ledgerEntries: entries.map((e) => ({
      id: e.id,
      type: e.type,
      currency: e.currency,
      amount: e.amount,
      meta: e.meta,
      createdAt: e.createdAt,
    })),
  });

  return { wallet: { tgUserId: w.tgUserId, stars: w.stars, crystals: w.crystals }, entries };
}
