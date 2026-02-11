import { Router } from 'express';
import { memoryDb, type PurchaseIntentRecord } from '../db/memoryDb';
import { appendWalletLedgerEntry, getOrCreateWallet } from '../services/walletService';

export const shopRouter = Router();

type CatalogItem = {
  sku: string;
  title: string;
  desc: string;
  priceStars: number;
  grants: { stars?: number; crystals?: number };
  available: boolean;
};

const CATALOG: CatalogItem[] = [
  {
    sku: 'pack.crystals.100',
    title: 'Crystals x100',
    desc: 'Starter crystal pack',
    priceStars: 10,
    grants: { crystals: 100 },
    available: true,
  },
  {
    sku: 'pack.crystals.500',
    title: 'Crystals x500',
    desc: 'Value crystal bundle',
    priceStars: 45,
    grants: { crystals: 500 },
    available: true,
  },
  {
    sku: 'pack.stars.50',
    title: 'Bonus Stars x50',
    desc: 'Promotional top-up',
    priceStars: 30,
    grants: { stars: 50 },
    available: true,
  },
];

let intentSeq = 1;

function nextIntentId(): string {
  const id = `intent_${String(intentSeq).padStart(8, '0')}`;
  intentSeq += 1;
  return id;
}

function getBearerToken(req: any): string | null {
  const h = String(req.headers?.authorization ?? '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function requireSession(req: any): { tgUserId: string } | null {
  const token = getBearerToken(req);
  if (!token) return null;
  const session = memoryDb.sessions.get(token);
  if (!session) return null;
  return { tgUserId: session.tgUserId };
}

shopRouter.get('/shop/catalog', (_req, res) => {
  return res.status(200).json({ ok: true, items: CATALOG });
});

shopRouter.post('/shop/purchase-intent', (req, res) => {
  const s = requireSession(req);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const sku = String(req.body?.sku ?? '');
  const item = CATALOG.find((candidate) => candidate.sku === sku);

  if (!item || !item.available) {
    return res.status(404).json({ ok: false, error: 'sku_not_available' });
  }

  const intent: PurchaseIntentRecord = {
    id: nextIntentId(),
    tgUserId: s.tgUserId,
    sku,
    provider: 'telegram_stars',
    createdAt: Date.now(),
  };

  memoryDb.purchaseIntents.set(intent.id, intent);

  return res.status(200).json({
    ok: true,
    intentId: intent.id,
    provider: intent.provider,
    payloadStub: {
      sku,
      priceStars: item.priceStars,
      // TODO stars: replace stub payload with Telegram Stars invoice payload
      simulated: true,
    },
  });
});

shopRouter.post('/shop/purchase-confirm', (req, res) => {
  const s = requireSession(req);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const intentId = String(req.body?.intentId ?? '');
  const intent = memoryDb.purchaseIntents.get(intentId);
  if (!intent || intent.tgUserId !== s.tgUserId) {
    return res.status(404).json({ ok: false, error: 'intent_not_found' });
  }

  const item = CATALOG.find((candidate) => candidate.sku === intent.sku);
  if (!item || !item.available) {
    return res.status(409).json({ ok: false, error: 'sku_not_available' });
  }

  const wallet = getOrCreateWallet(s.tgUserId);
  const nextWallet = {
    tgUserId: wallet.tgUserId,
    stars: Math.max(0, wallet.stars + Math.floor(item.grants.stars ?? 0)),
    crystals: Math.max(0, wallet.crystals + Math.floor(item.grants.crystals ?? 0)),
  };
  memoryDb.wallets.set(s.tgUserId, nextWallet);

  let ledgerEntry = appendWalletLedgerEntry({
    tgUserId: s.tgUserId,
    type: 'purchase',
    currency: 'stars',
    amount: -Math.max(0, item.priceStars),
    meta: {
      intentId,
      sku: item.sku,
      provider: intent.provider,
      providerPayload: req.body?.providerPayload ?? null,
      // TODO stars: replace stub confirm with validated webhook / provider receipt
    },
  });

  if (item.grants.crystals) {
    ledgerEntry = appendWalletLedgerEntry({
      tgUserId: s.tgUserId,
      type: 'purchase',
      currency: 'crystals',
      amount: Math.floor(item.grants.crystals),
      meta: { intentId, sku: item.sku, provider: intent.provider },
    });
  }

  if (item.grants.stars) {
    ledgerEntry = appendWalletLedgerEntry({
      tgUserId: s.tgUserId,
      type: 'purchase',
      currency: 'stars',
      amount: Math.floor(item.grants.stars),
      meta: { intentId, sku: item.sku, provider: intent.provider },
    });
  }

  memoryDb.purchaseIntents.delete(intentId);

  return res.status(200).json({ ok: true, wallet: nextWallet, ledgerEntry });
});
