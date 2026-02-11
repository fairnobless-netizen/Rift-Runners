import { Router } from 'express';
import { resolveSessionFromRequest } from '../auth/session';
import { getOrCreateWallet, grantWallet, listWalletLedger } from '../services/walletService';

export const walletRouter = Router();

walletRouter.get('/wallet/me', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const wallet = await getOrCreateWallet(s.tgUserId);
  return res.status(200).json({ ok: true, wallet });
});

walletRouter.get('/wallet/ledger', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const limitRaw = Number((req as any).query?.limit ?? 50);
  const entries = await listWalletLedger(s.tgUserId, Number.isFinite(limitRaw) ? limitRaw : 50);
  return res.status(200).json({ ok: true, entries });
});

walletRouter.post('/wallet/grant', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const internalKey = process.env.INTERNAL_KEY;
  const internalHeader = String((req.headers as any)?.['x-internal-key'] ?? '');
  const allowNonProd = process.env.NODE_ENV !== 'production';
  const authorizedInternal = Boolean(internalKey && internalHeader && internalHeader === internalKey);

  if (!allowNonProd && !authorizedInternal) {
    return res.status(403).json({
      ok: false,
      error: 'forbidden',
      note: 'TODO: replace /wallet/grant with server-side rewards/payment webhooks',
    });
  }

  const stars = Number((req as any).body?.stars ?? 0);
  const crystals = Number((req as any).body?.crystals ?? 0);

  const result = await grantWallet(
    s.tgUserId,
    {
      stars: Number.isFinite(stars) ? Math.floor(stars) : 0,
      crystals: Number.isFinite(crystals) ? Math.floor(crystals) : 0,
    },
    { source: 'wallet_grant_internal' },
  );

  return res.status(200).json({ ok: true, wallet: result.wallet, entries: result.entries });
});
