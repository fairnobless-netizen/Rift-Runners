const RESUME_WINDOW_MS = 60_000;
const LAST_SESSION_KEY = 'rr_last_session_v1';

export type SessionMode = 'mp' | 'sp';

export type LastSessionMeta = {
  roomCode: string;
  tgUserId: string | null;
  mode: SessionMode;
  matchId: string | null;
  lastActivityAtMs: number;
};

export function saveLastSession(meta: LastSessionMeta): void {
  localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(meta));
}

export function loadLastSession(): LastSessionMeta | null {
  const raw = localStorage.getItem(LAST_SESSION_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<LastSessionMeta>;
    if (typeof parsed.roomCode !== 'string' || !parsed.roomCode) {
      return null;
    }

    if (parsed.tgUserId != null && (typeof parsed.tgUserId !== 'string' || !parsed.tgUserId)) {
      return null;
    }

    const mode = parsed.mode ?? 'mp';
    if (mode !== 'mp' && mode !== 'sp') {
      return null;
    }

    const matchId = parsed.matchId ?? null;
    if (typeof matchId !== 'string' && matchId !== null) {
      return null;
    }

    if (typeof parsed.lastActivityAtMs !== 'number' || !Number.isFinite(parsed.lastActivityAtMs)) {
      return null;
    }

    return {
      roomCode: parsed.roomCode,
      tgUserId: parsed.tgUserId ?? null,
      mode,
      matchId,
      lastActivityAtMs: parsed.lastActivityAtMs,
    };
  } catch {
    return null;
  }
}

export function clearLastSession(): void {
  localStorage.removeItem(LAST_SESSION_KEY);
}

export function canResumeSession(meta: LastSessionMeta, nowMs = Date.now()): boolean {
  return nowMs - meta.lastActivityAtMs <= RESUME_WINDOW_MS;
}
