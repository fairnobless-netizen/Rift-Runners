import { Router } from 'express';
import crypto from 'crypto';
import { resolveSessionFromRequest } from '../auth/session';
import {
  buyStoreSkuTx,
  createPurchaseIntent,
  deletePurchaseIntent,
  getPurchaseIntent,
  listOwnedSkus,
  listStoreCatalog,
} from '../db/repos';
import { grantWallet } from '../services/walletService';

export const shopRouter = Router();

function newIntentId(): string {
  return `intent_${crypto.randomBytes(8).toString('hex')}`;
}

shopRouter.get('/shop/catalog', async (_req, res) => {
  const items = await listStoreCatalog();
  return res.status(200).json({ ok: true, items });
});

shopRouter.get('/shop/owned', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const ownedSkus = await listOwnedSkus(s.tgUserId);
  return res.status(200).json({ ok: true, ownedSkus });
});

shopRouter.post('/shop/buy', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const sku = String((req as any).body?.sku ?? '').trim();
  if (!sku) return res.status(400).json({ ok: false, error: 'sku_required' });

  try {
    const result = await buyStoreSkuTx({ tgUserId: s.tgUserId, sku });
    return res.status(200).json({ ok: true, wallet: result.wallet, ownedSkus: result.ownedSkus });
  } catch (error: any) {
    if (error?.code === 'SKU_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'sku_not_found' });
    }
    if (error?.code === 'ALREADY_OWNED') {
      return res.status(409).json({ ok: false, error: 'already_owned' });
    }
    if (error?.code === 'NOT_PURCHASABLE') {
      return res.status(409).json({ ok: false, error: 'not_purchasable' });
    }
    if (error?.code === 'INSUFFICIENT_FUNDS') {
      return res.status(409).json({ ok: false, error: 'insufficient_funds' });
    }
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

shopRouter.post('/shop/purchase-intent', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const sku = String((req as any).body?.sku ?? '');
  const items = await listStoreCatalog();
  const item = items.find((candidate) => candidate.sku === sku);

  if (!item || !item.active) {
    return res.status(404).json({ ok: false, error: 'sku_not_available' });
  }

  const intentId = newIntentId();
  const expiresAt = Date.now() + 10 * 60 * 1000;

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

  const items = await listStoreCatalog();
  const item = items.find((candidate) => candidate.sku === String(intent.sku));
  if (!item || !item.active) {
    return res.status(409).json({ ok: false, error: 'sku_not_available' });
  }

  const spendStars = -Math.max(0, Math.floor(item.priceStars));

  const result = await grantWallet(
    s.tgUserId,
    { stars: spendStars, crystals: 0 },
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
