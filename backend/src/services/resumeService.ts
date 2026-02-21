const RESUME_WINDOW_MS = 60_000;

type SessionMode = 'MULTIPLAYER' | 'SINGLEPLAYER';

type ActiveSessionBase = {
  tgUserId: string;
  mode: SessionMode;
  lastActivityAt: number;
  expiresAt: number;
  intentionallyTerminated: boolean;
};

export type ActiveMultiplayerSession = ActiveSessionBase & {
  mode: 'MULTIPLAYER';
  roomCode: string;
  matchId: string;
};

export type ActiveSingleplayerSession = ActiveSessionBase & {
  mode: 'SINGLEPLAYER';
};

export type ActiveSessionRecord = ActiveMultiplayerSession | ActiveSingleplayerSession;

const activeSessionByUser = new Map<string, ActiveSessionRecord>();

function logResumeEvent(evt: string, payload: Record<string, unknown>) {
  console.log(JSON.stringify({ evt, ...payload, ts: Date.now() }));
}

function withTtl<T extends ActiveSessionRecord>(record: T, atMs: number): T {
  return {
    ...record,
    lastActivityAt: atMs,
    expiresAt: atMs + RESUME_WINDOW_MS,
  };
}

export function getResumeWindowMs(): number {
  return RESUME_WINDOW_MS;
}

export function upsertMultiplayerSessionActivity(params: { tgUserId: string; roomCode: string; matchId: string; atMs?: number }): ActiveMultiplayerSession {
  const atMs = Number(params.atMs ?? Date.now());
  const next = withTtl({
    tgUserId: params.tgUserId,
    mode: 'MULTIPLAYER',
    roomCode: params.roomCode,
    matchId: params.matchId,
    intentionallyTerminated: false,
    lastActivityAt: atMs,
    expiresAt: atMs + RESUME_WINDOW_MS,
  }, atMs);
  activeSessionByUser.set(params.tgUserId, next);
  return next;
}

export function touchMultiplayerSessionsByRoom(params: { roomCode: string; matchId: string; atMs?: number }): void {
  const atMs = Number(params.atMs ?? Date.now());
  for (const [tgUserId, record] of activeSessionByUser.entries()) {
    if (record.mode !== 'MULTIPLAYER') continue;
    if (record.roomCode !== params.roomCode || record.matchId !== params.matchId) continue;
    if (record.intentionallyTerminated) continue;
    activeSessionByUser.set(tgUserId, withTtl(record, atMs));
  }
}

export function markSingleplayerSessionActivity(params: { tgUserId: string; atMs?: number }): ActiveSingleplayerSession {
  const atMs = Number(params.atMs ?? Date.now());
  const next = withTtl({
    tgUserId: params.tgUserId,
    mode: 'SINGLEPLAYER',
    intentionallyTerminated: false,
    lastActivityAt: atMs,
    expiresAt: atMs + RESUME_WINDOW_MS,
  }, atMs);
  activeSessionByUser.set(params.tgUserId, next);
  return next;
}

export function getActiveSession(tgUserId: string): ActiveSessionRecord | null {
  const existing = activeSessionByUser.get(tgUserId);
  if (!existing) return null;
  if (Date.now() > existing.expiresAt) {
    activeSessionByUser.delete(tgUserId);
    logResumeEvent('resume_session_expired', { tgUserId, mode: existing.mode });
    return null;
  }
  return existing;
}

export function clearActiveSession(tgUserId: string, reason: string): void {
  const existing = activeSessionByUser.get(tgUserId);
  if (!existing) return;
  activeSessionByUser.delete(tgUserId);
  logResumeEvent('resume_session_cleared', { tgUserId, mode: existing.mode, reason });
}

export function clearRoomActiveSessions(roomCode: string, reason: string): void {
  for (const [tgUserId, record] of activeSessionByUser.entries()) {
    if (record.mode !== 'MULTIPLAYER' || record.roomCode !== roomCode) continue;
    activeSessionByUser.delete(tgUserId);
    logResumeEvent('resume_session_cleared', { tgUserId, mode: record.mode, roomCode: record.roomCode, matchId: record.matchId, reason });
  }
}

export function markSessionIntentionallyTerminated(tgUserId: string, reason: string): void {
  const existing = activeSessionByUser.get(tgUserId);
  if (!existing) return;
  const next: ActiveSessionRecord = {
    ...existing,
    intentionallyTerminated: true,
    expiresAt: Date.now(),
  };
  activeSessionByUser.set(tgUserId, next);
  clearActiveSession(tgUserId, reason);
}

export function consumeMultiplayerResume(params: { tgUserId: string; roomCode: string; matchId: string }): { ok: true; record: ActiveMultiplayerSession } | { ok: false; reason: string } {
  const record = getActiveSession(params.tgUserId);
  if (!record || record.mode !== 'MULTIPLAYER') return { ok: false, reason: 'expired_or_missing' };
  if (record.intentionallyTerminated) return { ok: false, reason: 'intentionally_terminated' };
  if (record.roomCode !== params.roomCode) return { ok: false, reason: 'room_mismatch' };
  if (record.matchId !== params.matchId) return { ok: false, reason: 'match_mismatch' };
  clearActiveSession(params.tgUserId, 'resume_consumed');
  logResumeEvent('resume_success', { tgUserId: params.tgUserId, roomCode: params.roomCode, matchId: params.matchId });
  return { ok: true, record };
}
