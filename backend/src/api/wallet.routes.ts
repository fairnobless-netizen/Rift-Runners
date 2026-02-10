import { Router } from 'express';
import { memoryDb } from '../db/memoryDb';
import { getOrCreateWallet, grantWallet } from '../services/walletService';

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

walletRouter.post('/wallet/grant', (req, res) => {
  const s = requireSession(req);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  // TEMP: allow client-triggered grants for MVP wiring.
  // TODO security: restrict this endpoint (server-side only / admin / signed events)
  const stars = Number(req.body?.stars ?? 0);
  const crystals = Number(req.body?.crystals ?? 0);

  const wallet = grantWallet(s.tgUserId, {
    stars: Number.isFinite(stars) ? Math.floor(stars) : 0,
    crystals: Number.isFinite(crystals) ? Math.floor(crystals) : 0,
  });

  return res.status(200).json({ ok: true, wallet });
});
