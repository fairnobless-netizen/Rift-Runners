import { Router } from 'express';
import { memoryDb } from '../db/memoryDb';
import { getOrCreateWallet, grantWallet, listWalletLedger } from '../services/walletService';

export const walletRouter = Router();

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

walletRouter.get('/wallet/me', (req, res) => {
  const s = requireSession(req);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const wallet = getOrCreateWallet(s.tgUserId);
  return res.status(200).json({ ok: true, wallet });
});

walletRouter.get('/wallet/ledger', (req, res) => {
  const s = requireSession(req);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const limitRaw = Number(req.query?.limit ?? 50);
  const entries = listWalletLedger(s.tgUserId, Number.isFinite(limitRaw) ? limitRaw : 50);
  return res.status(200).json({ ok: true, entries });
});

walletRouter.post('/wallet/grant', (req, res) => {
  const s = requireSession(req);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const internalKey = process.env.INTERNAL_KEY;
  const internalHeader = String(req.headers?.['x-internal-key'] ?? '');
  const allowNonProd = process.env.NODE_ENV !== 'production';
  const authorizedInternal = Boolean(internalKey && internalHeader && internalHeader === internalKey);

  if (!allowNonProd && !authorizedInternal) {
    return res.status(403).json({
      ok: false,
      error: 'forbidden',
      note: 'TODO: replace /wallet/grant with server-side rewards/payment webhooks',
    });
  }

  const stars = Number(req.body?.stars ?? 0);
  const crystals = Number(req.body?.crystals ?? 0);

  const result = grantWallet(
    s.tgUserId,
    {
      stars: Number.isFinite(stars) ? Math.floor(stars) : 0,
      crystals: Number.isFinite(crystals) ? Math.floor(crystals) : 0,
    },
    { source: 'wallet_grant_internal' },
  );

  return res.status(200).json({ ok: true, wallet: result.wallet, entries: result.entries });
});
