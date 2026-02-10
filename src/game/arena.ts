import { GAME_CONFIG } from './config';
import type { TileType } from './types';

export interface ArenaData {
  tiles: TileType[][];
  isSpawnCell: (x: number, y: number) => boolean;
}

export function createArena(): ArenaData {
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

      const key = `${x},${y}`;
      const keepFloor = spawnSafe.has(key) || enemySpawnSafe.has(key);
      row.push(keepFloor ? 'Floor' : 'BreakableBlock');
    }
    tiles.push(row);
  }

  return {
    tiles,
    isSpawnCell: (x: number, y: number) => spawnSafe.has(`${x},${y}`),
  };
}
