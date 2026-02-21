const RESUME_WINDOW_MS = 60_000;
const LAST_SESSION_KEY = 'rr_last_session_v1';

export type LastSessionMeta = {
  roomCode: string;
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

    if (typeof parsed.lastActivityAtMs !== 'number' || !Number.isFinite(parsed.lastActivityAtMs)) {
      return null;
    }

    return {
      roomCode: parsed.roomCode,
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
