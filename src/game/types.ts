export type TileType = 'Floor' | 'HardWall' | 'BreakableBlock';

export type ItemType = 'BombUp' | 'FireUp';

export type Direction = 'up' | 'down' | 'left' | 'right';

export type EntityKind = 'tile' | 'player' | 'bomb' | 'flame' | 'item' | 'enemy';

export type EntityState =
  | 'idle'
  | 'move'
  | 'placeBomb'
  | 'detonate'
  | 'active'
  | 'pickup';

export type TileAssetKey = TileType;

export type FlameSegmentKind = 'center' | 'arm';

export type FlameArmAxis = 'horizontal' | 'vertical';

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
  segment: FlameSegmentKind;
  axis?: FlameArmAxis;
}

export type EnemyKind = 'normal' | 'elite';

export interface EnemyModel {
  key: string;
  gridX: number;
  gridY: number;
  facing: Facing;
  state: Extract<EntityState, 'idle' | 'move'>;
  kind: EnemyKind;
  moveIntervalMs: number;
}

export interface PlayerStats {
  capacity: number;
  placed: number;
  range: number;
  score: number;
  remoteDetonateUnlocked: boolean;
}

export interface ControlsState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  placeBombRequested: boolean;
  detonateRequested: boolean;
}

export interface AssetStyle {
  textureKey: string;
  path: string;
  origin?: { x: number; y: number };
  alpha?: number;
  scale?: number;
  depth?: number;
}

export type FacingAssetRegistry = Partial<Record<Facing | 'none', AssetStyle>>;

export type EntityStateAssetRegistry = Partial<Record<EntityState, FacingAssetRegistry>>;

export type EntityAssetRegistry = Partial<Record<Exclude<EntityKind, 'tile'>, EntityStateAssetRegistry>>;

export type TileAssetRegistry = Partial<Record<TileAssetKey, Partial<Record<'none', AssetStyle>>>>;

export type AssetRegistry = EntityAssetRegistry & {
  tile?: TileAssetRegistry;
};


/**
 * Backend-relevant simulation tick snapshot.
 * This is safe to serialize for deterministic replay/debug tooling.
 */

export interface LevelProgressModel {
  zoneIndex: number;
  levelInZone: number;
  levelIndex: number;
  isBossLevel: boolean;
  isEndless: boolean;
  doorRevealed: boolean;
  doorEntered: boolean;
  levelCleared: boolean;
}

export interface SimulationTickModel {
  tick: number;
  timeMs: number;
}

/**
 * Backend-relevant event envelope emitted from the simulation loop.
 * UI can subscribe to these events without owning arena mutation.
 */
export interface SimulationEvent<TPayload = Record<string, unknown>> {
  type: string;
  tick: number;
  timeMs: number;
  payload: TPayload;
}
