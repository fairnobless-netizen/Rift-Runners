import { Router } from 'express';
import crypto from 'crypto';
import { resolveSessionFromRequest } from '../auth/session';
import { createPurchaseIntent, deletePurchaseIntent, getPurchaseIntent } from '../db/repos';
import { grantWallet } from '../services/walletService';

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

function newIntentId(): string {
  return `intent_${crypto.randomBytes(8).toString('hex')}`;
}

shopRouter.get('/shop/catalog', (_req, res) => {
  return res.status(200).json({ ok: true, items: CATALOG });
});

shopRouter.post('/shop/purchase-intent', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const sku = String((req as any).body?.sku ?? '');
  const item = CATALOG.find((candidate) => candidate.sku === sku);

  if (!item || !item.available) {
    return res.status(404).json({ ok: false, error: 'sku_not_available' });
  }

  const intentId = newIntentId();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 min

  await createPurchaseIntent({
    id: intentId,
    tgUserId: s.tgUserId,
    sku,
    provider: 'telegram_stars',
    expiresAt,
  });

  return res.status(200).json({
    ok: true,
    intentId,
    provider: 'telegram_stars',
    payloadStub: {
      sku,
      priceStars: item.priceStars,
      simulated: true,
    },
  });
});

shopRouter.post('/shop/purchase-confirm', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const intentId = String((req as any).body?.intentId ?? '');
  const intent = await getPurchaseIntent({ id: intentId, tgUserId: s.tgUserId });
  if (!intent) {
    return res.status(404).json({ ok: false, error: 'intent_not_found' });
  }

  const now = Date.now();
  if (Number(intent.expires_at) <= now) {
    await deletePurchaseIntent({ id: intentId, tgUserId: s.tgUserId });
    return res.status(409).json({ ok: false, error: 'intent_expired' });
  }

  const item = CATALOG.find((candidate) => candidate.sku === String(intent.sku));
  if (!item || !item.available) {
    return res.status(409).json({ ok: false, error: 'sku_not_available' });
  }

  // Stub confirm: we assume payment succeeded.
  // N2 will validate via Stars receipt/webhook + idempotency by provider_txn_id.
  // Here we still write authoritative ledger+wallet via transaction.
  const spendStars = -Math.max(0, Math.floor(item.priceStars));
  const grantStars = Math.floor(item.grants.stars ?? 0);
  const grantCrystals = Math.floor(item.grants.crystals ?? 0);

  const result = await grantWallet(
    s.tgUserId,
    { stars: spendStars + grantStars, crystals: grantCrystals },
    {
      source: 'purchase_stub_confirm',
      intentId,
      sku: item.sku,
      provider: 'telegram_stars',
      providerPayload: (req as any).body?.providerPayload ?? null,
    },
  );

  await deletePurchaseIntent({ id: intentId, tgUserId: s.tgUserId });

  return res.status(200).json({ ok: true, wallet: result.wallet, entries: result.entries });
});
