import type { LeaderboardMode } from './wallet';

export type LeaderboardTeamMember = {
  tgUserId: string;
  displayName: string;
};

export type LeaderboardRecord = {
  id: string;
  mode: LeaderboardMode;
  teamKey: string;
  players: LeaderboardTeamMember[];
  score: number;
  updatedAt: number;
};

const STORAGE_KEY = 'rift_local_leaderboard_v1';

function readAll(): LeaderboardRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LeaderboardRecord[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry && typeof entry === 'object');
  } catch {
    return [];
  }
}

function writeAll(records: LeaderboardRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // no-op
  }
}

export function sanitizeTeamMembers(players: LeaderboardTeamMember[]): LeaderboardTeamMember[] {
  const filtered = players
    .map((player) => ({
      tgUserId: String(player.tgUserId || '').trim(),
      displayName: String(player.displayName || '').trim() || 'Unknown',
    }))
    .filter((player) => Boolean(player.tgUserId));

  const seen = new Set<string>();
  const deduped: LeaderboardTeamMember[] = [];
  for (const player of filtered) {
    if (seen.has(player.tgUserId)) continue;
    seen.add(player.tgUserId);
    deduped.push(player);
  }
  return deduped;
}

export function modeFromTeamSize(size: number): LeaderboardMode {
  if (size <= 1) return 'solo';
  if (size === 2) return 'duo';
  if (size === 3) return 'trio';
  return 'squad';
}

export function makeTeamKey(mode: LeaderboardMode, players: LeaderboardTeamMember[]): string {
  const ids = sanitizeTeamMembers(players).map((p) => p.tgUserId).sort();
  return `${mode}:${ids.join('|')}`;
}

export function upsertLeaderboardScore(params: {
  mode: LeaderboardMode;
  players: LeaderboardTeamMember[];
  score: number;
}): LeaderboardRecord | null {
  const score = Math.max(0, Math.floor(params.score));
  const players = sanitizeTeamMembers(params.players);
  if (players.length === 0) return null;

  const mode = params.mode;
  const teamKey = makeTeamKey(mode, players);
  const all = readAll();
  const existing = all.find((entry) => entry.mode === mode && entry.teamKey === teamKey);

  if (existing && score <= existing.score) {
    return existing;
  }

  const now = Date.now();
  const next: LeaderboardRecord = {
    id: existing?.id ?? `${teamKey}:${now}`,
    mode,
    teamKey,
    players,
    score,
    updatedAt: now,
  };

  const merged = existing
    ? all.map((entry) => (entry.id === existing.id ? next : entry))
    : [...all, next];
  writeAll(merged);
  return next;
}

export function listLeaderboardTop(mode: LeaderboardMode, limit = 10): LeaderboardRecord[] {
  const safeLimit = Math.max(1, Math.floor(limit));
  return readAll()
    .filter((entry) => entry.mode === mode)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
      return a.teamKey.localeCompare(b.teamKey);
    })
    .slice(0, safeLimit);
}

export function getPersonalBest(mode: LeaderboardMode, tgUserId?: string): { rank: number; score: number } | null {
  if (!tgUserId) return null;
  const top = listLeaderboardTop(mode, 1000);
  const index = top.findIndex((entry) => entry.players.some((player) => player.tgUserId === tgUserId));
  if (index < 0) return null;
  return { rank: index + 1, score: top[index].score };
}
