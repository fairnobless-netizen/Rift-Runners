export const GAME_CONFIG = {
  gridWidth: 7,
  gridHeight: 7,
  tileSize: 64,
  moveDurationMs: 120,
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
