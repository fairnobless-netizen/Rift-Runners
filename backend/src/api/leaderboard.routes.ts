import { Router } from 'express';
import { resolveSessionFromRequest } from '../auth/session';
import {
  checkAndTouchLeaderboardSubmitLimit,
  getMyLeaderboardEntry,
  listLeaderboardTop,
  submitLeaderboardScore,
} from '../db/repos';

export const leaderboardRouter = Router();

const ALLOWED_MODES = new Set(['solo', 'duo', 'trio', 'squad']);

function isValidMode(mode: string): boolean {
  return ALLOWED_MODES.has(mode);
}

leaderboardRouter.get('/:mode', async (req, res) => {
  const mode = String(req.params.mode ?? '').trim().toLowerCase();
  if (!isValidMode(mode)) {
    return res.status(400).json({ ok: false, error: 'invalid_mode' });
  }

  const session = await resolveSessionFromRequest(req as any);
  const top = await listLeaderboardTop(mode, 50);
  const me = session ? await getMyLeaderboardEntry(session.tgUserId, mode) : null;

  return res.status(200).json({ ok: true, mode, top, me });
});

leaderboardRouter.post('/submit', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const mode = String((req as any).body?.mode ?? '').trim().toLowerCase();
  const scoreRaw = (req as any).body?.score;
  const score = Number(scoreRaw);

  if (!isValidMode(mode)) {
    return res.status(400).json({ ok: false, error: 'invalid_mode' });
  }

  if (!Number.isInteger(score) || score < 0) {
    return res.status(400).json({ ok: false, error: 'invalid_score' });
  }

  const allowed = await checkAndTouchLeaderboardSubmitLimit(session.tgUserId, 30_000);
  if (!allowed) {
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  await submitLeaderboardScore(session.tgUserId, mode, score);
  const me = await getMyLeaderboardEntry(session.tgUserId, mode);

  return res.status(200).json({ ok: true, mode, me });
});
