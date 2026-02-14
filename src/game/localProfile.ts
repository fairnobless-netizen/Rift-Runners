export type StoredPlayerProfile = {
  tgUserId: string;
  playerName: string;
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = 'rift_player_profiles_v1';
const MAX_NAME_LENGTH = 24;
const MIN_NAME_LENGTH = 2;

function readAllProfiles(): Record<string, StoredPlayerProfile> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, StoredPlayerProfile>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAllProfiles(next: Record<string, StoredPlayerProfile>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // no-op
  }
}

export function resolvePlayerStorageKey(tgUserId?: string): string {
  return tgUserId && tgUserId.trim() ? tgUserId.trim() : '__local__';
}

export function getStoredPlayerProfile(tgUserId?: string): StoredPlayerProfile | null {
  const key = resolvePlayerStorageKey(tgUserId);
  const all = readAllProfiles();
  return all[key] ?? null;
}

export function validatePlayerName(nameRaw: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = nameRaw.trim();
  const length = Array.from(trimmed).length;

  if (length < MIN_NAME_LENGTH) {
    return { ok: false, error: 'Name must be at least 2 characters.' };
  }

  if (length > MAX_NAME_LENGTH) {
    return { ok: false, error: 'Name must be 24 characters or less.' };
  }

  return { ok: true, value: trimmed };
}

export function upsertStoredPlayerProfile(tgUserId: string | undefined, playerNameRaw: string): StoredPlayerProfile | null {
  const validation = validatePlayerName(playerNameRaw);
  if (!validation.ok) return null;

  const key = resolvePlayerStorageKey(tgUserId);
  const now = Date.now();
  const all = readAllProfiles();
  const prev = all[key];
  const next: StoredPlayerProfile = {
    tgUserId: key,
    playerName: validation.value,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };

  all[key] = next;
  writeAllProfiles(all);
  return next;
}
