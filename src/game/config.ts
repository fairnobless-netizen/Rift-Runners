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

export const LAYERS = {
  floor: 0,
  breakable: 1,
  bomb: 2,
  item: 3,
  player: 4,
  enemy: 5,
  flame: 6,
  overlay: 10,
} as const;

export const ASSET_REGISTRY: AssetRegistry = {
  player: {
    idle: {
      up: { fillColor: 0x50d3ff, strokeColor: 0x0b1a2e, scale: 0.5 },
      down: { fillColor: 0x2bb1e7, strokeColor: 0x0b1a2e, scale: 0.5 },
      left: { fillColor: 0x7bc8ff, strokeColor: 0x0b1a2e, scale: 0.5 },
      right: { fillColor: 0x2fdefa, strokeColor: 0x0b1a2e, scale: 0.5 },
    },
    move: {
      up: { fillColor: 0x7de2ff, strokeColor: 0x0b1a2e, scale: 0.52 },
      down: { fillColor: 0x67ccee, strokeColor: 0x0b1a2e, scale: 0.52 },
      left: { fillColor: 0x98eaff, strokeColor: 0x0b1a2e, scale: 0.52 },
      right: { fillColor: 0x56e0ff, strokeColor: 0x0b1a2e, scale: 0.52 },
    },
    placeBomb: {
      up: { fillColor: 0x8de9ff, strokeColor: 0x0b1a2e, scale: 0.5 },
      down: { fillColor: 0x6ad6f4, strokeColor: 0x0b1a2e, scale: 0.5 },
      left: { fillColor: 0x9eeeff, strokeColor: 0x0b1a2e, scale: 0.5 },
      right: { fillColor: 0x6ce8ff, strokeColor: 0x0b1a2e, scale: 0.5 },
    },
  },
  bomb: {
    active: {
      none: { fillColor: 0x222222, strokeColor: 0xbac2d7, scale: 0.46 },
    },
    detonate: {
      none: { fillColor: 0x333333, strokeColor: 0xffc457, scale: 0.5 },
    },
  },
  flame: {
    active: {
      none: { fillColor: 0xff6a3d, alpha: 0.95, scale: 0.68 },
    },
    idle: {
      none: { fillColor: 0xffb15c, alpha: 0.9, scale: 0.6 },
    },
  },
  item: {
    active: {
      none: { fillColor: 0xffc457, strokeColor: 0x101010, scale: 0.3 },
    },
    pickup: {
      none: { fillColor: 0xffffff, strokeColor: 0x101010, scale: 0.3 },
    },
  },
  enemy: {
    idle: {
      up: { fillColor: 0xff7a7a, strokeColor: 0x2e0b0b, scale: 0.45 },
      down: { fillColor: 0xff5757, strokeColor: 0x2e0b0b, scale: 0.45 },
      left: { fillColor: 0xff8b64, strokeColor: 0x2e0b0b, scale: 0.45 },
      right: { fillColor: 0xff9f6f, strokeColor: 0x2e0b0b, scale: 0.45 },
    },
    move: {
      up: { fillColor: 0xff8989, strokeColor: 0x2e0b0b, scale: 0.48 },
      down: { fillColor: 0xff6d6d, strokeColor: 0x2e0b0b, scale: 0.48 },
      left: { fillColor: 0xff9b79, strokeColor: 0x2e0b0b, scale: 0.48 },
      right: { fillColor: 0xffb081, strokeColor: 0x2e0b0b, scale: 0.48 },
    },
  },
};
