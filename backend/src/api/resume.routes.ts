import { Router } from 'express';

import { resolveSessionFromRequest } from '../auth/session';
import { getRoomByCode } from '../db/repos';
import { getLastMpSessionIfEligible } from '../mp/lastSessionStore';
import { getMatchByRoom } from '../mp/matchManager';

export const resumeRouter = Router();

resumeRouter.get('/resume', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const lastSession = getLastMpSessionIfEligible(session.tgUserId);
  if (!lastSession) {
    return res.status(200).json({ canResume: false });
  }

  const room = await getRoomByCode(lastSession.roomCode);
  if (!room) {
    return res.status(200).json({ canResume: false });
  }

  const match = getMatchByRoom(lastSession.roomCode);
  if (!match || match.ended || match.players.has(session.tgUserId) === false) {
    return res.status(200).json({ canResume: false });
  }

  return res.status(200).json({
    canResume: true,
    mode: 'mp',
    roomCode: lastSession.roomCode,
    matchId: match.matchId ?? lastSession.matchId ?? null,
    lastActiveAtMs: lastSession.lastActiveAtMs,
  });
});
