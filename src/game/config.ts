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
  defaultBombCapacity: 1,
  defaultRange: 2,
  maxBombCapacity: 5,
  maxRange: 6,
  itemDropChance: 0.25,
  minZoom: 0.8,
  maxZoom: 2.5,
  startZoom: 1.25,
} as const;

export const LAYERS = {
  floor: 0,
  breakable: 1,
  bomb: 2,
  item: 3,
  player: 4,
  flame: 5,
} as const;

export const ASSET_REGISTRY: AssetRegistry = {
  player: {
    idle: {
      up: { fillColor: 0x50d3ff, strokeColor: 0x0b1a2e, scale: 0.5 },
      down: { fillColor: 0x50d3ff, strokeColor: 0x0b1a2e, scale: 0.5 },
      left: { fillColor: 0x50d3ff, strokeColor: 0x0b1a2e, scale: 0.5 },
      right: { fillColor: 0x50d3ff, strokeColor: 0x0b1a2e, scale: 0.5 },
    },
    move: {
      up: { fillColor: 0x7de2ff, strokeColor: 0x0b1a2e, scale: 0.52 },
      down: { fillColor: 0x7de2ff, strokeColor: 0x0b1a2e, scale: 0.52 },
      left: { fillColor: 0x7de2ff, strokeColor: 0x0b1a2e, scale: 0.52 },
      right: { fillColor: 0x7de2ff, strokeColor: 0x0b1a2e, scale: 0.52 },
    },
    placeBomb: {
      up: { fillColor: 0x8de9ff, strokeColor: 0x0b1a2e, scale: 0.5 },
      down: { fillColor: 0x8de9ff, strokeColor: 0x0b1a2e, scale: 0.5 },
      left: { fillColor: 0x8de9ff, strokeColor: 0x0b1a2e, scale: 0.5 },
      right: { fillColor: 0x8de9ff, strokeColor: 0x0b1a2e, scale: 0.5 },
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
  },
  item: {
    active: {
      none: { fillColor: 0xffc457, strokeColor: 0x101010, scale: 0.3 },
    },
    pickup: {
      none: { fillColor: 0xffffff, strokeColor: 0x101010, scale: 0.3 },
    },
  },
};
