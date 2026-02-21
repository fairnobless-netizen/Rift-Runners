const RESUME_KEY = 'rr_resume_v1';
const WINDOW_MS = 60_000;

export type MultiplayerResumeMeta = {
  kind: 'multiplayer';
  tgUserId: string;
  roomCode: string;
  matchId: string;
  disconnectedAt: number;
  expiresAt: number;
};

export type SingleplayerResumeMeta = {
  kind: 'singleplayer';
  tgUserId: string;
  createdAt: number;
  expiresAt: number;
  snapshot: unknown;
};

export type ResumeMeta = MultiplayerResumeMeta | SingleplayerResumeMeta;

export function getResumeWindowMs(): number { return WINDOW_MS; }

export function loadResumeMeta(): ResumeMeta | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ResumeMeta;
    if (!parsed || typeof parsed !== 'object') return null;
    if (Date.now() > Number((parsed as any).expiresAt ?? 0)) {
      clearResumeMeta();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveResumeMeta(meta: ResumeMeta): void {
  localStorage.setItem(RESUME_KEY, JSON.stringify(meta));
}

export function clearResumeMeta(): void {
  localStorage.removeItem(RESUME_KEY);
}

export function buildMultiplayerResumeMeta(params: { tgUserId: string; roomCode: string; matchId: string; disconnectedAt?: number }): MultiplayerResumeMeta {
  const disconnectedAt = params.disconnectedAt ?? Date.now();
  return {
    kind: 'multiplayer',
    tgUserId: params.tgUserId,
    roomCode: params.roomCode,
    matchId: params.matchId,
    disconnectedAt,
    expiresAt: disconnectedAt + WINDOW_MS,
  };
}

export function buildSingleplayerResumeMeta(params: { tgUserId: string; snapshot: unknown }): SingleplayerResumeMeta {
  const now = Date.now();
  return {
    kind: 'singleplayer',
    tgUserId: params.tgUserId,
    snapshot: params.snapshot,
    createdAt: now,
    expiresAt: now + WINDOW_MS,
  };
}
