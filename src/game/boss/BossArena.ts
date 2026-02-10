import { GAME_CONFIG } from '../config';
import { toKey, type ArenaModel } from '../arena';
import type { TileType } from '../types';

export function createBossArena(): ArenaModel {
  const { gridWidth, gridHeight } = GAME_CONFIG;
  const tiles: TileType[][] = [];

  for (let y = 0; y < gridHeight; y += 1) {
    const row: TileType[] = [];
    for (let x = 0; x < gridWidth; x += 1) {
      const edge = x === 0 || y === 0 || x === gridWidth - 1 || y === gridHeight - 1;
      const pillar = x % 2 === 0 && y % 2 === 0;
      row.push(edge || pillar ? 'HardWall' : 'Floor');
    }
    tiles.push(row);
  }

  const doorX = gridWidth - 2;
  const doorY = gridHeight - 2;

  return {
    tiles,
    bombs: new Map(),
    items: new Map(),
    hiddenDoorKey: toKey(doorX, doorY),
    isSpawnCell: (x: number, y: number) => x === 1 && y === 1,
  };
}
