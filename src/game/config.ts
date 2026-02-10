import type { AssetRegistry } from './types';

export const GAME_CONFIG = {
  gridWidth: 7,
  gridHeight: 7,
  tileSize: 64,
  moveDurationMs: 120,
  moveRepeatDelayMs: 170,
  moveRepeatIntervalMs: 95,
  bombFuseMs: 2200,
  flameLifetimeMs: 400,
  enemyMoveIntervalMs: 260,
  enemyForwardBias: 0.65,
  baseEnemyCount: 1,
  maxEnemyCount: 6,
  enemyScore: 75,
  playerDeathPenalty: 50,
  defaultBombCapacity: 1,
  defaultRange: 2,
  maxBombCapacity: 5,
  maxRange: 6,
  itemDropChance: 0.25,
  levelBreakableDensityStart: 0.7,
  levelBreakableDensityStep: 0.05,
  levelBreakableDensityMax: 0.9,
  minZoom: 0.8,
  maxZoom: 2.5,
  startZoom: 1.25,
} as const;

export const BOMB_PULSE_CONFIG = {
  warningThresholdMs: 900,
  pulseMinScale: 0.88,
  pulseMaxScale: 1.15,
  minAlpha: 0.6,
  maxAlpha: 1,
} as const;

export const FLAME_SEGMENT_SCALE = {
  center: 0.68,
  armHorizontal: { width: 0.8, height: 0.38 },
  armVertical: { width: 0.38, height: 0.8 },
} as const;

export const DEPTH_FLOOR = 0;
export const DEPTH_BREAKABLE = 1;
export const DEPTH_BOMB = 2;
export const DEPTH_ITEM = 3;
export const DEPTH_PLAYER = 4;
export const DEPTH_ENEMY = 5;
export const DEPTH_FLAME = 6;
export const DEPTH_OVERLAY = 10;

export const ASSET_REGISTRY: AssetRegistry = {
  tile: {
    floor: {
      none: { textureKey: 'tile-floor', path: '/assets/sprites/tile-floor.svg', origin: { x: 0.5, y: 0.5 }, scale: 1, depth: DEPTH_FLOOR },
    },
    hardWall: {
      none: {
        textureKey: 'tile-hard-wall',
        path: '/assets/sprites/tile-hard-wall.svg',
        origin: { x: 0.5, y: 0.5 },
        scale: 1,
        depth: DEPTH_BREAKABLE,
      },
    },
    breakable: {
      none: {
        textureKey: 'tile-breakable',
        path: '/assets/sprites/tile-breakable.svg',
        origin: { x: 0.5, y: 0.5 },
        scale: 1,
        depth: DEPTH_BREAKABLE,
      },
    },
  },
  player: {
    idle: {
      up: { textureKey: 'player-up', path: '/assets/sprites/player-up.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.74, depth: DEPTH_PLAYER },
      down: { textureKey: 'player-down', path: '/assets/sprites/player-down.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.74, depth: DEPTH_PLAYER },
      left: { textureKey: 'player-left', path: '/assets/sprites/player-left.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.74, depth: DEPTH_PLAYER },
      right: { textureKey: 'player-right', path: '/assets/sprites/player-right.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.74, depth: DEPTH_PLAYER },
    },
    move: {
      up: { textureKey: 'player-up', path: '/assets/sprites/player-up.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.8, depth: DEPTH_PLAYER },
      down: { textureKey: 'player-down', path: '/assets/sprites/player-down.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.8, depth: DEPTH_PLAYER },
      left: { textureKey: 'player-left', path: '/assets/sprites/player-left.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.8, depth: DEPTH_PLAYER },
      right: { textureKey: 'player-right', path: '/assets/sprites/player-right.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.8, depth: DEPTH_PLAYER },
    },
    placeBomb: {
      up: { textureKey: 'player-up', path: '/assets/sprites/player-up.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.76, depth: DEPTH_PLAYER },
      down: { textureKey: 'player-down', path: '/assets/sprites/player-down.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.76, depth: DEPTH_PLAYER },
      left: { textureKey: 'player-left', path: '/assets/sprites/player-left.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.76, depth: DEPTH_PLAYER },
      right: { textureKey: 'player-right', path: '/assets/sprites/player-right.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.76, depth: DEPTH_PLAYER },
    },
  },
  bomb: {
    active: {
      none: { textureKey: 'bomb-active', path: '/assets/sprites/bomb.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.7, depth: DEPTH_BOMB },
    },
    detonate: {
      none: { textureKey: 'bomb-active', path: '/assets/sprites/bomb.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.74, depth: DEPTH_BOMB },
    },
  },
  flame: {
    active: {
      none: { textureKey: 'flame-center', path: '/assets/sprites/flame-center.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.68, depth: DEPTH_FLAME, alpha: 0.95 },
    },
    idle: {
      none: { textureKey: 'flame-arm-h', path: '/assets/sprites/flame-arm-h.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.6, depth: DEPTH_FLAME, alpha: 0.9 },
    },
    move: {
      none: { textureKey: 'flame-arm-v', path: '/assets/sprites/flame-arm-v.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.6, depth: DEPTH_FLAME, alpha: 0.9 },
    },
  },
  item: {
    active: {
      none: { textureKey: 'pickup-fire', path: '/assets/sprites/pickup-fire.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.48, depth: DEPTH_ITEM },
    },
    pickup: {
      none: { textureKey: 'pickup-bomb', path: '/assets/sprites/pickup-bomb.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.48, depth: DEPTH_ITEM },
    },
  },
  enemy: {
    idle: {
      up: { textureKey: 'enemy-up', path: '/assets/sprites/enemy-up.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.72, depth: DEPTH_ENEMY },
      down: { textureKey: 'enemy-down', path: '/assets/sprites/enemy-down.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.72, depth: DEPTH_ENEMY },
      left: { textureKey: 'enemy-left', path: '/assets/sprites/enemy-left.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.72, depth: DEPTH_ENEMY },
      right: { textureKey: 'enemy-right', path: '/assets/sprites/enemy-right.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.72, depth: DEPTH_ENEMY },
    },
    move: {
      up: { textureKey: 'enemy-up', path: '/assets/sprites/enemy-up.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.78, depth: DEPTH_ENEMY },
      down: { textureKey: 'enemy-down', path: '/assets/sprites/enemy-down.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.78, depth: DEPTH_ENEMY },
      left: { textureKey: 'enemy-left', path: '/assets/sprites/enemy-left.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.78, depth: DEPTH_ENEMY },
      right: { textureKey: 'enemy-right', path: '/assets/sprites/enemy-right.svg', origin: { x: 0.5, y: 0.5 }, scale: 0.78, depth: DEPTH_ENEMY },
    },
  },
};
