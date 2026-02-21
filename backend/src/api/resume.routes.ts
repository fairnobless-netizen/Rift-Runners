import { Router } from 'express';
import { resolveSessionFromRequest } from '../auth/session';
import { getRoomByCode, listRoomMembers } from '../db/repos';
import { getMatchByRoom } from '../mp/matchManager';
import { resolveResumeEligibility } from '../services/resumeEligibilityService';
import {
  clearActiveSession,
  consumeMultiplayerResume,
  getActiveSession,
  markSingleplayerSessionActivity,
} from '../services/resumeService';

export const resumeRouter = Router();

resumeRouter.get('/resume/eligibility', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const record = getActiveSession(session.tgUserId);
  const eligibility = await resolveResumeEligibility(session.tgUserId, record);
  return res.status(200).json(eligibility);
});

resumeRouter.post('/resume/multiplayer', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const roomCode = String((req as any).body?.roomCode ?? '').trim().toUpperCase();
  const matchId = String((req as any).body?.matchId ?? '').trim();
  if (!roomCode || !matchId) return res.status(400).json({ ok: false, error: 'invalid_request' });

  const validation = consumeMultiplayerResume({ tgUserId: session.tgUserId, roomCode, matchId });
  if (!validation.ok) {
    clearActiveSession(session.tgUserId, `denied:${validation.reason ?? 'invalid'}`);
    return res.status(409).json({ ok: false, error: 'resume_denied', reason: validation.reason ?? 'invalid' });
  }

  const room = await getRoomByCode(roomCode);
  if (!room) {
    clearActiveSession(session.tgUserId, 'room_missing');
    return res.status(404).json({ ok: false, error: 'room_not_found' });
  }

  const members = await listRoomMembers(roomCode);
  if (!members.some((member) => String(member.tgUserId) === String(session.tgUserId))) {
    clearActiveSession(session.tgUserId, 'not_member');
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  const match = getMatchByRoom(roomCode);
  if (!match || match.matchId !== matchId || match.ended) {
    clearActiveSession(session.tgUserId, 'match_missing');
    return res.status(409).json({ ok: false, error: 'match_ended' });
  }

  return res.status(200).json({
    ok: true,
    room: { roomCode: room.roomCode, ownerTgUserId: room.ownerTgUserId, capacity: room.capacity, status: room.status, phase: room.phase ?? 'LOBBY', createdAt: room.createdAt },
    members: members.map((member) => ({ ...member, ready: member.ready ?? false })),
    matchId,
  });
});

resumeRouter.post('/resume/discard', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });
  clearActiveSession(session.tgUserId, 'client_discarded');
  return res.status(200).json({ ok: true });
});

resumeRouter.post('/resume/singleplayer/activity', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });
  markSingleplayerSessionActivity({ tgUserId: session.tgUserId });
  return res.status(200).json({ ok: true });
});
