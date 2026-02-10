import { GAME_CONFIG } from './config';
import type { BombModel, GridPosition, ItemModel, ItemType, TileType } from './types';

export interface ArenaModel {
  tiles: TileType[][];
  bombs: Map<string, BombModel>;
  items: Map<string, ItemModel>;
  isSpawnCell: (x: number, y: number) => boolean;
}

export interface ExplosionResult {
  impactedKeys: string[];
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

export function createArena(): ArenaModel {
  const { gridWidth, gridHeight } = GAME_CONFIG;
  const tiles: TileType[][] = [];

  const spawnSafe = new Set(['1,1', '1,2', '2,1']);
  const enemySpawnSafe = new Set([
    `${gridWidth - 2},${gridHeight - 2}`,
    `${gridWidth - 2},${gridHeight - 3}`,
    `${gridWidth - 3},${gridHeight - 2}`,
  ]);

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
      const keepFloor = spawnSafe.has(key) || enemySpawnSafe.has(key);
      row.push(keepFloor ? 'Floor' : 'BreakableBlock');
    }
    tiles.push(row);
  }

  return {
    tiles,
    bombs: new Map<string, BombModel>(),
    items: new Map<string, ItemModel>(),
    isSpawnCell: (x: number, y: number) => spawnSafe.has(toKey(x, y)),
  };
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
  if (tile === 'HardWall' || tile === 'BreakableBlock') return false;
  return !arena.bombs.has(toKey(x, y));
}

export function placeBomb(
  arena: ArenaModel,
  x: number,
  y: number,
  range: number,
  ownerId: string,
  detonateAt: number,
): BombModel | null {
  const key = toKey(x, y);
  if (arena.bombs.has(key)) return null;

  const bomb: BombModel = {
    key,
    x,
    y,
    range,
    ownerId,
    escapedByOwner: false,
    detonateAt,
  };

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
  const impacted = new Set<string>([bomb.key]);
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

      impacted.add(key);

      if (arena.bombs.has(key) && key !== bomb.key) {
        chainBombs.add(key);
      }

      if (tile === 'BreakableBlock') {
        destroyedBreakables.push({ x: tx, y: ty });
        break;
      }
    }
  }

  return {
    impactedKeys: [...impacted],
    destroyedBreakables,
    chainBombKeys: [...chainBombs],
  };
}

export function destroyBreakable(arena: ArenaModel, x: number, y: number): void {
  arena.tiles[y][x] = 'Floor';
}

export function maybeDropItem(
  arena: ArenaModel,
  x: number,
  y: number,
  dropRoll: number,
  typeRoll: number,
): ItemModel | null {
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
