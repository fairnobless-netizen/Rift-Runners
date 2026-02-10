export type TileType = 'Floor' | 'HardWall' | 'BreakableBlock';

export type ItemType = 'BombUp' | 'FireUp';

export interface PlayerStats {
  capacity: number;
  placed: number;
  range: number;
  score: number;
}

export interface ControlsState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  placeBombRequested: boolean;
}
