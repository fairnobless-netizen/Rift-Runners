export type TileType = 'Floor' | 'HardWall' | 'BreakableBlock';

export type ItemType = 'BombUp' | 'FireUp';

export type Direction = 'up' | 'down' | 'left' | 'right';

export type EntityKind = 'player' | 'bomb' | 'flame' | 'item' | 'enemy';

export type EntityState = 'idle' | 'move' | 'placeBomb' | 'detonate' | 'active' | 'pickup';

export type Facing = Direction;

export interface GridPosition {
  x: number;
  y: number;
}

export interface PlayerModel {
  gridX: number;
  gridY: number;
  targetX: number | null;
  targetY: number | null;
  moveFromX: number;
  moveFromY: number;
  moveStartedAt: number;
  facing: Facing;
  state: EntityState;
  graceBombKey: string | null;
}

export interface BombModel extends GridPosition {
  key: string;
  range: number;
  ownerId: string;
  escapedByOwner: boolean;
  detonateAt: number;
}

export interface ItemModel extends GridPosition {
  key: string;
  type: ItemType;
}

export interface FlameModel extends GridPosition {
  key: string;
  expiresAt: number;
}

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

export interface AssetStyle {
  fillColor: number;
  strokeColor?: number;
  alpha?: number;
  scale?: number;
}

export type AssetRegistry = Partial<Record<EntityKind, Partial<Record<EntityState, Partial<Record<Facing | 'none', AssetStyle>>>>>>;
