import { toKey, type ArenaModel } from '../arena';
import { GAME_CONFIG } from '../config';
import type { DeterministicRng } from '../rng';
import type { GridPosition } from '../types';

export interface BossNodeMetadata {
  anchorKey: string;
  anomalousKeys: string[];
}

export function generateBossNodeStones(arena: ArenaModel, rng: DeterministicRng, desiredCount: number): BossNodeMetadata {
  const candidates: GridPosition[] = [];
  for (let y = 1; y < GAME_CONFIG.gridHeight - 1; y += 1) {
    for (let x = 1; x < GAME_CONFIG.gridWidth - 1; x += 1) {
      if (arena.isSpawnCell(x, y)) continue;
      if (arena.tiles[y][x] !== 'Floor') continue;
      candidates.push({ x, y });
    }
  }

  if (candidates.length === 0) {
    return { anchorKey: '', anomalousKeys: [] };
  }

  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(i + 1);
    const tmp = candidates[i];
    candidates[i] = candidates[j];
    candidates[j] = tmp;
  }

  const count = Math.max(1, Math.min(desiredCount, candidates.length));
  const selected = candidates.slice(0, count);
  const anomalousKeys: string[] = [];

  for (const cell of selected) {
    arena.tiles[cell.y][cell.x] = 'ANOMALOUS_STONE';
    anomalousKeys.push(toKey(cell.x, cell.y));
  }

  const anchorIndex = rng.nextInt(selected.length);
  const anchor = selected[anchorIndex];
  return {
    anchorKey: toKey(anchor.x, anchor.y),
    anomalousKeys,
  };
}
