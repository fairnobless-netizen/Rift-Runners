import { Router } from 'express';
import { resolveSessionFromRequest } from '../auth/session';
import { getUserAndWallet } from '../db/repos';

export const profileRouter = Router();

profileRouter.get('/profile/me', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const uw = await getUserAndWallet(s.tgUserId);
  if (!uw) return res.status(404).json({ ok: false, error: 'User not found' });

  return res.status(200).json({ ok: true, user: uw.user, wallet: uw.wallet });
});
