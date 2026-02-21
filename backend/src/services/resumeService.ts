const RESUME_WINDOW_MS = 60_000;

type MultiplayerResumeRecord = {
  kind: 'multiplayer';
  tgUserId: string;
  roomCode: string;
  matchId: string;
  disconnectedAt: number;
  expiresAt: number;
};

const multiplayerResumeByUser = new Map<string, MultiplayerResumeRecord>();

function logResumeEvent(evt: string, payload: Record<string, unknown>) {
  console.log(JSON.stringify({ evt, ...payload, ts: Date.now() }));
}

export function markMultiplayerResumeEligible(params: { tgUserId: string; roomCode: string; matchId: string; disconnectedAt?: number }): MultiplayerResumeRecord {
  const disconnectedAt = Number(params.disconnectedAt ?? Date.now());
  const record: MultiplayerResumeRecord = {
    kind: 'multiplayer',
    tgUserId: params.tgUserId,
    roomCode: params.roomCode,
    matchId: params.matchId,
    disconnectedAt,
    expiresAt: disconnectedAt + RESUME_WINDOW_MS,
  };
  multiplayerResumeByUser.set(params.tgUserId, record);
  logResumeEvent('resume_eligible', { kind: record.kind, tgUserId: record.tgUserId, roomCode: record.roomCode, matchId: record.matchId, expiresAt: record.expiresAt });
  return record;
}

export function getMultiplayerResume(tgUserId: string): MultiplayerResumeRecord | null {
  const existing = multiplayerResumeByUser.get(tgUserId);
  if (!existing) return null;
  if (Date.now() > existing.expiresAt) {
    multiplayerResumeByUser.delete(tgUserId);
    logResumeEvent('resume_denied_expired', { kind: existing.kind, tgUserId: existing.tgUserId, roomCode: existing.roomCode, matchId: existing.matchId });
    return null;
  }
  return existing;
}

export function clearMultiplayerResume(tgUserId: string, reason: string): void {
  const existing = multiplayerResumeByUser.get(tgUserId);
  if (!existing) return;
  multiplayerResumeByUser.delete(tgUserId);
  logResumeEvent('resume_cleared', { kind: existing.kind, tgUserId: existing.tgUserId, roomCode: existing.roomCode, matchId: existing.matchId, reason });
}

export function clearRoomMultiplayerResume(roomCode: string, reason: string): void {
  for (const [tgUserId, record] of multiplayerResumeByUser.entries()) {
    if (record.roomCode !== roomCode) continue;
    multiplayerResumeByUser.delete(tgUserId);
    logResumeEvent('resume_cleared', { kind: record.kind, tgUserId: record.tgUserId, roomCode: record.roomCode, matchId: record.matchId, reason });
  }
}

export function validateMultiplayerResume(params: { tgUserId: string; roomCode: string; matchId?: string | null }): { ok: boolean; reason?: string; record?: MultiplayerResumeRecord } {
  const record = getMultiplayerResume(params.tgUserId);
  if (!record) return { ok: false, reason: 'expired_or_missing' };
  if (record.tgUserId !== params.tgUserId) {
    logResumeEvent('resume_identity_mismatch', { expectedTgUserId: record.tgUserId, gotTgUserId: params.tgUserId });
    return { ok: false, reason: 'identity_mismatch' };
  }
  if (record.roomCode !== params.roomCode) {
    logResumeEvent('resume_denied_invalid', { tgUserId: params.tgUserId, roomCode: params.roomCode, expectedRoomCode: record.roomCode, reason: 'room_mismatch' });
    return { ok: false, reason: 'room_mismatch' };
  }
  if (params.matchId && record.matchId !== params.matchId) {
    logResumeEvent('resume_denied_invalid', { tgUserId: params.tgUserId, roomCode: params.roomCode, matchId: params.matchId, expectedMatchId: record.matchId, reason: 'match_mismatch' });
    return { ok: false, reason: 'match_mismatch' };
  }
  return { ok: true, record };
}

export function markMultiplayerResumeSuccess(params: { tgUserId: string; roomCode: string; matchId: string }): void {
  logResumeEvent('resume_success', { kind: 'multiplayer', tgUserId: params.tgUserId, roomCode: params.roomCode, matchId: params.matchId });
}

export function getResumeWindowMs(): number {
  return RESUME_WINDOW_MS;
}
