import { Router } from 'express';
import { memoryDb } from '../db/memoryDb';

export const profileRouter = Router();

function getBearerToken(req: any): string | null {
  const h = String(req.headers?.authorization ?? '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

profileRouter.get('/profile/me', (req, res) => {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ ok: false, error: 'Missing Authorization Bearer token' });

  const session = memoryDb.sessions.get(token);
  if (!session) return res.status(401).json({ ok: false, error: 'Invalid session token' });

  const user = memoryDb.users.get(session.tgUserId);
  const wallet = memoryDb.wallets.get(session.tgUserId);

  if (!user || !wallet) {
    return res.status(404).json({ ok: false, error: 'User not found' });
  }

  return res.status(200).json({ ok: true, user, wallet });
});
