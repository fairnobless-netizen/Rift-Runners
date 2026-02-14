import { GAME_CONFIG } from './config';
import type { DeterministicRng } from './rng';
import type { BombModel, GridPosition, ItemModel, ItemType, TileType } from './types';

export interface ArenaModel {
  tiles: TileType[][];
  bombs: Map<string, BombModel>;
  items: Map<string, ItemModel>;
  hiddenDoorKey: string;
  isSpawnCell: (x: number, y: number) => boolean;
}

export interface ExplosionImpact {
  key: string;
  x: number;
  y: number;
  distance: number;
}

export interface ExplosionResult {
  impacts: ExplosionImpact[];
  destroyedBreakables: GridPosition[];
  chainBombKeys: string[];
}

export function toKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function fromKey(key: string): GridPosition {
  const [x, y] = key.split(',').map(Number);
  return { x, y };
}

function getBreakableDensity(levelIndex: number): number {
  const next = GAME_CONFIG.levelBreakableDensityStart + levelIndex * GAME_CONFIG.levelBreakableDensityStep;
  return Math.min(GAME_CONFIG.levelBreakableDensityMax, Math.max(0, next));
}

function getSpawnSafeSet(): Set<string> {
  return new Set(['1,1', '1,2', '2,1', '2,2']);
}

export function getEnemyCountForLevel(levelIndex: number): number {
  return Math.max(1, Math.min(GAME_CONFIG.maxEnemyCount, GAME_CONFIG.baseEnemyCount + levelIndex));
}

function getEnemyReserveSafeCells(enemyCount: number): Set<string> {
  const reserveCandidates = ['5,5', '5,4', '4,5', '3,5', '5,3', '1,5', '5,1', '3,1', '1,3'];
  return new Set(reserveCandidates.slice(0, Math.max(enemyCount + 2, 3)));
}

export function createArena(levelIndex = 0, rng?: DeterministicRng): ArenaModel {
  const { gridWidth, gridHeight } = GAME_CONFIG;
  const tiles: TileType[][] = [];
  const spawnSafe = getSpawnSafeSet();
  const enemyCount = getEnemyCountForLevel(levelIndex);
  const enemyReserve = getEnemyReserveSafeCells(enemyCount);
  const breakableDensity = getBreakableDensity(levelIndex);
  const breakableCells: GridPosition[] = [];

  for (let y = 0; y < gridHeight; y += 1) {
    const row: TileType[] = [];
    for (let x = 0; x < gridWidth; x += 1) {
      const edge = x === 0 || y === 0 || x === gridWidth - 1 || y === gridHeight - 1;
      const pillar = x % 2 === 0 && y % 2 === 0;
      if (edge || pillar) {
        row.push('HardWall');
        continue;
      }

      const key = toKey(x, y);
      if (spawnSafe.has(key) || enemyReserve.has(key)) {
        row.push('Floor');
        continue;
      }

      const roll = rng?.nextFloat() ?? 0.5;
      const tile: TileType = roll < breakableDensity ? 'BreakableBlock' : 'Floor';
      row.push(tile);
      if (tile === 'BreakableBlock') {
        breakableCells.push({ x, y });
      }
    }
    tiles.push(row);
  }

  if (breakableCells.length === 0) {
    for (let y = 1; y < gridHeight - 1; y += 1) {
      for (let x = 1; x < gridWidth - 1; x += 1) {
        const key = toKey(x, y);
        if (spawnSafe.has(key) || enemyReserve.has(key)) continue;
        if (tiles[y][x] !== 'Floor') continue;
        tiles[y][x] = 'BreakableBlock';
        breakableCells.push({ x, y });
        break;
      }
      if (breakableCells.length > 0) break;
    }
  }

  const hiddenDoorCell = breakableCells[rng?.nextInt(breakableCells.length) ?? 0] ?? { x: 1, y: 1 };
  // Keep the hidden door under a real breakable block so blast resolution treats it like any other brick.
  tiles[hiddenDoorCell.y][hiddenDoorCell.x] = 'BreakableBlock';

  return {
    tiles,
    bombs: new Map<string, BombModel>(),
    items: new Map<string, ItemModel>(),
    hiddenDoorKey: toKey(hiddenDoorCell.x, hiddenDoorCell.y),
    isSpawnCell: (x: number, y: number) => spawnSafe.has(toKey(x, y)),
  };
}

export function getEnemySpawnCells(arena: ArenaModel): GridPosition[] {
  const spawnSafe = getSpawnSafeSet();
  const cells: GridPosition[] = [];

  for (let y = 1; y < GAME_CONFIG.gridHeight - 1; y += 1) {
    for (let x = 1; x < GAME_CONFIG.gridWidth - 1; x += 1) {
      if (spawnSafe.has(toKey(x, y))) continue;
      if (tileAt(arena, x, y) !== 'Floor') continue;
      cells.push({ x, y });
    }
  }

  return cells;
}

export function isInsideArena(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < GAME_CONFIG.gridWidth && y < GAME_CONFIG.gridHeight;
}

export function tileAt(arena: ArenaModel, x: number, y: number): TileType {
  return arena.tiles[y][x];
}

export function canOccupyCell(arena: ArenaModel, x: number, y: number): boolean {
  if (!isInsideArena(x, y)) return false;
  const tile = tileAt(arena, x, y);
  if (tile === 'HardWall' || tile === 'BreakableBlock' || tile === 'ANOMALOUS_STONE') return false;
  return !arena.bombs.has(toKey(x, y));
}

export function placeBomb(arena: ArenaModel, x: number, y: number, range: number, ownerId: string, detonateAt: number): BombModel | null {
  const key = toKey(x, y);
  if (arena.bombs.has(key)) return null;

  const bomb: BombModel = { key, x, y, range, ownerId, escapedByOwner: false, detonateAt };
  arena.bombs.set(key, bomb);
  return bomb;
}

export function removeBomb(arena: ArenaModel, key: string): BombModel | null {
  const bomb = arena.bombs.get(key);
  if (!bomb) return null;
  arena.bombs.delete(key);
  return bomb;
}

export function setBombOwnerEscaped(arena: ArenaModel, key: string): void {
  const bomb = arena.bombs.get(key);
  if (!bomb) return;
  bomb.escapedByOwner = true;
}

export function getExplosionResult(arena: ArenaModel, bomb: BombModel): ExplosionResult {
  const impactsByKey = new Map<string, ExplosionImpact>();
  impactsByKey.set(bomb.key, { key: bomb.key, x: bomb.x, y: bomb.y, distance: 0 });
  const destroyedBreakables: GridPosition[] = [];
  const chainBombs = new Set<string>();

  const directions: Array<[number, number]> = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];

  for (const [dx, dy] of directions) {
    for (let step = 1; step <= bomb.range; step += 1) {
      const tx = bomb.x + dx * step;
      const ty = bomb.y + dy * step;
      if (!isInsideArena(tx, ty)) break;

      const key = toKey(tx, ty);
      const tile = tileAt(arena, tx, ty);
      if (tile === 'HardWall') break;

      if (!impactsByKey.has(key)) {
        impactsByKey.set(key, { key, x: tx, y: ty, distance: step });
      }

      if (arena.bombs.has(key) && key !== bomb.key) {
        chainBombs.add(key);
      }

      if (tile === 'BreakableBlock' || tile === 'ANOMALOUS_STONE') {
        destroyedBreakables.push({ x: tx, y: ty });
        break;
      }
    }
  }

  const impacts = [...impactsByKey.values()].sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);

  return {
    impacts,
    destroyedBreakables,
    chainBombKeys: [...chainBombs],
  };
}

export function destroyBreakable(arena: ArenaModel, x: number, y: number): void {
  arena.tiles[y][x] = 'Floor';
}

export function maybeDropItem(arena: ArenaModel, x: number, y: number, dropRoll: number, typeRoll: number): ItemModel | null {
  if (dropRoll > GAME_CONFIG.itemDropChance) return null;
  const key = toKey(x, y);
  const type: ItemType = typeRoll < 0.5 ? 'BombUp' : 'FireUp';
  const item: ItemModel = { key, x, y, type };
  arena.items.set(key, item);
  return item;
}

export function pickupItem(arena: ArenaModel, x: number, y: number): ItemModel | null {
  const key = toKey(x, y);
  const item = arena.items.get(key);
  if (!item) return null;
  arena.items.delete(key);
  return item;
}
