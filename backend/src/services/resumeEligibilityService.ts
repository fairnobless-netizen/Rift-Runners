import { getRoomByCode, listRoomMembers } from '../db/repos';
import { getMatchByRoom } from '../mp/matchManager';
import { clearActiveSession, type ActiveSessionRecord } from './resumeService';

export type ResumeEligibilityResult =
  | { ok: true; eligible: false; reason?: string }
  | { ok: true; eligible: true; kind: 'singleplayer'; expiresAt: number }
  | { ok: true; eligible: true; kind: 'multiplayer'; roomCode: string; matchId: string; expiresAt: number };

export async function resolveResumeEligibility(tgUserId: string, record: ActiveSessionRecord | null): Promise<ResumeEligibilityResult> {
  if (!record) return { ok: true, eligible: false };

  if (record.mode === 'SINGLEPLAYER') {
    return { ok: true, eligible: true, kind: 'singleplayer', expiresAt: record.expiresAt };
  }

  const room = await getRoomByCode(record.roomCode);
  if (!room) {
    clearActiveSession(tgUserId, 'room_missing');
    return { ok: true, eligible: false, reason: 'room_missing' };
  }

  if (String(room.phase ?? 'LOBBY') !== 'STARTED') {
    clearActiveSession(tgUserId, 'room_not_started');
    return { ok: true, eligible: false, reason: 'match_ended' };
  }

  const members = await listRoomMembers(record.roomCode);
  if (!members.some((member) => String(member.tgUserId) === String(tgUserId))) {
    clearActiveSession(tgUserId, 'not_member');
    return { ok: true, eligible: false, reason: 'not_member' };
  }

  const match = getMatchByRoom(record.roomCode);
  if (!match || match.matchId !== record.matchId || match.ended) {
    clearActiveSession(tgUserId, 'match_missing');
    return { ok: true, eligible: false, reason: 'match_ended' };
  }

  return {
    ok: true,
    eligible: true,
    kind: 'multiplayer',
    roomCode: record.roomCode,
    matchId: record.matchId,
    expiresAt: record.expiresAt,
  };
}
