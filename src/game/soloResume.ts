import type { CampaignState } from './campaign';
import type { EnemyKind } from './types';

export const SOLO_RESUME_STORAGE_KEY = 'rr_solo_resume_v1';
export const SOLO_RESUME_TTL_MS = 60_000;

export interface SoloResumeSnapshotV1 {
  version: 1;
  savedAtMs: number;
  levelIndex: number;
  runSeed: number;
  lives: number;
  stats: {
    score: number;
    capacity: number;
    range: number;
    remoteDetonateUnlocked: boolean;
  };
  player: { x: number; y: number };
  arena: { width: number; height: number; tiles: number[] };
  enemies: Array<{ kind: EnemyKind; x: number; y: number; hp?: number }>;
  door: { revealed: boolean; entered: boolean; cell?: { x: number; y: number } | null };
  campaignState: Pick<CampaignState, 'stage' | 'zone' | 'trophies' | 'score' | 'soloGameOver' | 'lastActiveAtMs'>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSnapshotV1(value: unknown): value is SoloResumeSnapshotV1 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SoloResumeSnapshotV1>;
  return candidate.version === 1
    && isFiniteNumber(candidate.savedAtMs)
    && Number.isInteger(candidate.levelIndex)
    && isFiniteNumber(candidate.runSeed)
    && Number.isInteger(candidate.lives)
    && Array.isArray(candidate.enemies)
    && Array.isArray(candidate.arena?.tiles)
    && isFiniteNumber(candidate.player?.x)
    && isFiniteNumber(candidate.player?.y)
    && isFiniteNumber(candidate.arena?.width)
    && isFiniteNumber(candidate.arena?.height);
}

export function saveSoloResumeSnapshot(snapshot: SoloResumeSnapshotV1): void {
  try {
    window.localStorage.setItem(SOLO_RESUME_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore write failures
  }
}

export function clearSoloResumeSnapshot(): void {
  try {
    window.localStorage.removeItem(SOLO_RESUME_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function loadSoloResumeSnapshot(nowMs: number = Date.now()): SoloResumeSnapshotV1 | null {
  try {
    const raw = window.localStorage.getItem(SOLO_RESUME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isSnapshotV1(parsed)) {
      clearSoloResumeSnapshot();
      return null;
    }
    if (nowMs - parsed.savedAtMs > SOLO_RESUME_TTL_MS) {
      clearSoloResumeSnapshot();
      return null;
    }
    return parsed;
  } catch {
    clearSoloResumeSnapshot();
    return null;
  }
}
