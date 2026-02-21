import { Router } from 'express';
import { resolveSessionFromRequest } from '../auth/session';
import { getRoomByCode, listRoomMembers } from '../db/repos';
import { getMatchByRoom } from '../mp/matchManager';
import {
  clearMultiplayerResume,
  getMultiplayerResume,
  markMultiplayerResumeSuccess,
  validateMultiplayerResume,
} from '../services/resumeService';

export const resumeRouter = Router();

resumeRouter.get('/resume/eligibility', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const record = getMultiplayerResume(session.tgUserId);
  if (!record) return res.status(200).json({ ok: true, eligible: false });

  const room = await getRoomByCode(record.roomCode);
  if (!room) {
    clearMultiplayerResume(session.tgUserId, 'room_missing');
    return res.status(200).json({ ok: true, eligible: false, reason: 'room_missing' });
  }

  if (String(room.phase ?? 'LOBBY') !== 'STARTED') {
    clearMultiplayerResume(session.tgUserId, 'room_not_started');
    return res.status(200).json({ ok: true, eligible: false, reason: 'match_ended' });
  }

  const members = await listRoomMembers(record.roomCode);
  if (!members.some((member) => String(member.tgUserId) === String(session.tgUserId))) {
    clearMultiplayerResume(session.tgUserId, 'not_member');
    return res.status(200).json({ ok: true, eligible: false, reason: 'not_member' });
  }

  const match = getMatchByRoom(record.roomCode);
  if (!match || match.matchId !== record.matchId || match.ended) {
    clearMultiplayerResume(session.tgUserId, 'match_missing');
    return res.status(200).json({ ok: true, eligible: false, reason: 'match_ended' });
  }

  return res.status(200).json({
    ok: true,
    eligible: true,
    kind: 'multiplayer',
    roomCode: record.roomCode,
    matchId: record.matchId,
    expiresAt: record.expiresAt,
  });
});

resumeRouter.post('/resume/multiplayer', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const roomCode = String((req as any).body?.roomCode ?? '').trim().toUpperCase();
  const matchId = String((req as any).body?.matchId ?? '').trim();
  if (!roomCode || !matchId) return res.status(400).json({ ok: false, error: 'invalid_request' });

  const validation = validateMultiplayerResume({ tgUserId: session.tgUserId, roomCode, matchId });
  if (!validation.ok) {
    clearMultiplayerResume(session.tgUserId, `denied:${validation.reason ?? 'invalid'}`);
    return res.status(409).json({ ok: false, error: 'resume_denied', reason: validation.reason ?? 'invalid' });
  }

  const room = await getRoomByCode(roomCode);
  if (!room) {
    clearMultiplayerResume(session.tgUserId, 'room_missing');
    return res.status(404).json({ ok: false, error: 'room_not_found' });
  }

  const members = await listRoomMembers(roomCode);
  if (!members.some((member) => String(member.tgUserId) === String(session.tgUserId))) {
    clearMultiplayerResume(session.tgUserId, 'not_member');
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  const match = getMatchByRoom(roomCode);
  if (!match || match.matchId !== matchId || match.ended) {
    clearMultiplayerResume(session.tgUserId, 'match_missing');
    return res.status(409).json({ ok: false, error: 'match_ended' });
  }

  markMultiplayerResumeSuccess({ tgUserId: session.tgUserId, roomCode, matchId });

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
  clearMultiplayerResume(session.tgUserId, 'client_discarded');
  return res.status(200).json({ ok: true });
});
