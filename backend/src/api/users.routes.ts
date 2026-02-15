import { Router } from 'express';
import { resolveSessionFromRequest } from '../auth/session';
import { searchUsersByUsername } from '../db/repos';

export const usersRouter = Router();

usersRouter.get('/users/search', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const q = String(req.query?.q ?? '').trim();
  if (!q) return res.status(400).json({ ok: false, error: 'q_required' });

  const users = await searchUsersByUsername(q);
  return res.status(200).json({ users });
});
