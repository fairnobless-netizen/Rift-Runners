import type { LeaderboardMeEntry, LeaderboardMode, LeaderboardTopEntry } from './wallet';

const LOCAL_LEADERBOARD_KEY = 'rr_local_leaderboard_v1';

type LocalLeaderboardRecord = {
  key: string;
  names: string[];
  ids: string[];
  score: number;
  updatedAt: number;
};

type LocalLeaderboardStore = Record<LeaderboardMode, LocalLeaderboardRecord[]>;

const EMPTY_STORE: LocalLeaderboardStore = {
  solo: [],
  duo: [],
  trio: [],
  squad: [],
};

function normalizeName(value: string): string {
  return value.trim() || 'Unknown';
}

function readStore(): LocalLeaderboardStore {
  try {
    const raw = localStorage.getItem(LOCAL_LEADERBOARD_KEY);
    if (!raw) return { ...EMPTY_STORE };
    const parsed = JSON.parse(raw) as Partial<LocalLeaderboardStore>;
    return {
      solo: Array.isArray(parsed.solo) ? parsed.solo : [],
      duo: Array.isArray(parsed.duo) ? parsed.duo : [],
      trio: Array.isArray(parsed.trio) ? parsed.trio : [],
      squad: Array.isArray(parsed.squad) ? parsed.squad : [],
    };
  } catch {
    return { ...EMPTY_STORE };
  }
}

function writeStore(store: LocalLeaderboardStore): void {
  localStorage.setItem(LOCAL_LEADERBOARD_KEY, JSON.stringify(store));
}

function sortAndRank(records: LocalLeaderboardRecord[]): LocalLeaderboardRecord[] {
  return [...records]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.updatedAt - a.updatedAt;
    })
    .slice(0, 100);
}

function makeEntryKey(mode: LeaderboardMode, ids: string[], names: string[]): string {
  if (mode === 'solo') {
    return `solo:${ids[0] ?? names[0] ?? 'local'}`;
  }

  const parts = ids.map((id, index) => id || names[index] || 'unknown').sort();
  return `${mode}:${parts.join('|')}`;
}

function toTop(records: LocalLeaderboardRecord[]): LeaderboardTopEntry[] {
  return records.map((record, index) => ({
    rank: index + 1,
    tgUserId: record.ids.join(','),
    displayName: record.names.join(' + '),
    score: record.score,
  }));
}

export function submitLocalLeaderboard(params: {
  mode: LeaderboardMode;
  score: number;
  ids: string[];
  names: string[];
  localPlayerId: string;
}): LeaderboardMeEntry {
  const { mode, score, ids, names, localPlayerId } = params;
  const cleanNames = names.map(normalizeName);
  const entryIds = ids.map((id, index) => (id?.trim() || cleanNames[index] || 'unknown'));
  const key = makeEntryKey(mode, entryIds, cleanNames);

  const store = readStore();
  const records = [...store[mode]];
  const found = records.find((row) => row.key === key);

  if (!found) {
    records.push({ key, ids: entryIds, names: cleanNames, score, updatedAt: Date.now() });
  } else if (score > found.score) {
    found.score = score;
    found.updatedAt = Date.now();
    found.ids = entryIds;
    found.names = cleanNames;
  }

  const ranked = sortAndRank(records);
  store[mode] = ranked;
  writeStore(store);

  const myRank = ranked.findIndex((row) => row.ids.includes(localPlayerId));
  return {
    rank: myRank >= 0 ? myRank + 1 : null,
    score,
  };
}

export function fetchLocalLeaderboard(mode: LeaderboardMode, localPlayerId: string): { top: LeaderboardTopEntry[]; me: LeaderboardMeEntry | null } {
  const store = readStore();
  const ranked = sortAndRank(store[mode]);
  const meRecord = ranked.find((row) => row.ids.includes(localPlayerId));

  return {
    top: toTop(ranked),
    me: meRecord
      ? {
        rank: ranked.findIndex((row) => row.key === meRecord.key) + 1,
        score: meRecord.score,
      }
      : null,
  };
}
