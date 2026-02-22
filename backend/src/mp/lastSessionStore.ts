export type LastMpSessionRecord = {
  tgUserId: string;
  roomCode: string;
  matchId: string | null;
  lastActiveAtMs: number;
};

const RESUME_ELIGIBLE_WINDOW_MS = 60_000;
const lastMpSessions = new Map<string, LastMpSessionRecord>();

export function touchLastMpSession(input: {
  tgUserId: string;
  roomCode: string;
  matchId?: string | null;
  atMs?: number;
}): LastMpSessionRecord {
  const key = String(input.tgUserId);
  const prev = lastMpSessions.get(key);
  const next: LastMpSessionRecord = {
    tgUserId: key,
    roomCode: String(input.roomCode).toUpperCase(),
    matchId: input.matchId === undefined ? (prev?.matchId ?? null) : (input.matchId ?? null),
    lastActiveAtMs: Number.isFinite(input.atMs) ? Number(input.atMs) : Date.now(),
  };

  lastMpSessions.set(key, next);
  return next;
}

export function getLastMpSessionIfEligible(tgUserId: string, nowMs = Date.now()): LastMpSessionRecord | null {
  const record = lastMpSessions.get(String(tgUserId));
  if (!record) {
    return null;
  }

  if (nowMs - record.lastActiveAtMs > RESUME_ELIGIBLE_WINDOW_MS) {
    lastMpSessions.delete(String(tgUserId));
    return null;
  }

  return record;
}

export function clearLastMpSession(tgUserId: string): void {
  lastMpSessions.delete(String(tgUserId));
}
