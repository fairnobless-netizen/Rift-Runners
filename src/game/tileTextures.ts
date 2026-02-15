import Phaser from 'phaser';
import type { TileType } from './types';

type TileVisualType = 'floor' | 'pillar' | 'breakable' | 'border';

const hashString = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const createSeededRng = (seed: number): (() => number) => {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let v = Math.imul(t ^ (t >>> 15), 1 | t);
    v ^= v + Math.imul(v ^ (v >>> 7), 61 | v);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
};

const clampChannel = (value: number): number => Phaser.Math.Clamp(Math.round(value), 0, 255);

const varyColor = (hex: number, delta: number): number => {
  const r = clampChannel((hex >> 16) + delta);
  const g = clampChannel(((hex >> 8) & 0xff) + delta);
  const b = clampChannel((hex & 0xff) + delta);
  return (r << 16) | (g << 8) | b;
};

const ensureNearest = (scene: Phaser.Scene, key: string): void => {
  scene.textures.get(key)?.setFilter(Phaser.Textures.FilterMode.NEAREST);
};

const drawFloorTile = (g: Phaser.GameObjects.Graphics, size: number, rand: () => number): void => {
  g.fillStyle(rand() > 0.5 ? 0x5d5f55 : 0x6a6d60, 1);
  g.fillRect(0, 0, size, size);

  const stones = 5 + Math.floor(rand() * 4);
  for (let i = 0; i < stones; i += 1) {
    const w = size * (0.22 + rand() * 0.22);
    const h = size * (0.18 + rand() * 0.24);
    const x = rand() * (size - w);
    const y = rand() * (size - h);
    const r = Math.max(3, Math.round(Math.min(w, h) * (0.25 + rand() * 0.2)));
    g.fillStyle(varyColor(0x65685d, Math.floor(rand() * 16) - 8), 0.9);
    g.fillRoundedRect(x, y, w, h, r);
    g.lineStyle(1, 0x3c3f38, 0.25);
    g.strokeRoundedRect(x, y, w, h, r);
  }

  const noiseCount = 30 + Math.floor(rand() * 31);
  for (let i = 0; i < noiseCount; i += 1) {
    g.fillStyle(varyColor(0x707367, Math.floor(rand() * 30) - 15), 0.05 + rand() * 0.05);
    g.fillRect(Math.floor(rand() * size), Math.floor(rand() * size), 1, 1);
  }
};

const drawPillarTile = (g: Phaser.GameObjects.Graphics, size: number, rand: () => number): void => {
  g.fillStyle(rand() > 0.5 ? 0x3f3c34 : 0x4a463d, 1);
  g.fillRect(0, 0, size, size);

  const slabs = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < slabs; i += 1) {
    const w = size * (0.35 + rand() * 0.28);
    const h = size * (0.22 + rand() * 0.3);
    const x = rand() * (size - w);
    const y = rand() * (size - h);
    g.fillStyle(varyColor(0x48443b, Math.floor(rand() * 20) - 10), 0.95);
    g.fillRect(x, y, w, h);
  }

  g.lineStyle(1.5, 0x2a2722, 0.35);
  const cracks = 2 + Math.floor(rand() * 2);
  for (let i = 0; i < cracks; i += 1) {
    const x1 = rand() * size;
    const y1 = rand() * size;
    const x2 = Phaser.Math.Clamp(x1 + (rand() * size * 0.5 - size * 0.25), 0, size);
    const y2 = Phaser.Math.Clamp(y1 + (rand() * size * 0.5 - size * 0.25), 0, size);
    g.lineBetween(x1, y1, x2, y2);
  }

  g.lineStyle(2, 0x27231f, 0.55);
  g.strokeRect(1, 1, size - 2, size - 2);
};

const drawBreakableTile = (g: Phaser.GameObjects.Graphics, size: number, rand: () => number): void => {
  g.fillStyle(rand() > 0.5 ? 0x8a5a2a : 0xa56a31, 1);
  g.fillRect(0, 0, size, size);

  const stones = 6 + Math.floor(rand() * 5);
  for (let i = 0; i < stones; i += 1) {
    const rx = size * (0.08 + rand() * 0.1);
    const ry = size * (0.08 + rand() * 0.1);
    const cx = rx + rand() * (size - rx * 2);
    const cy = ry + rand() * (size - ry * 2);
    g.fillStyle(varyColor(0x9a632f, Math.floor(rand() * 26) - 13), 0.95);
    g.fillEllipse(cx, cy, rx * 2, ry * 2);
    g.fillStyle(0xc4813a, 0.35);
    g.fillEllipse(cx - rx * 0.25, cy - ry * 0.25, rx * 0.9, ry * 0.65);
  }

  g.lineStyle(1.25, 0x5a3719, 0.3);
  for (let i = 0; i < 4; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    g.lineBetween(x, y, x + (rand() * 8 - 4), y + (rand() * 8 - 4));
  }
};

const drawBorderTile = (g: Phaser.GameObjects.Graphics, size: number, rand: () => number): void => {
  g.fillStyle(rand() > 0.5 ? 0x1a0b0b : 0x230d0d, 1);
  g.fillRect(0, 0, size, size);

  const shards = 20 + Math.floor(rand() * 21);
  for (let i = 0; i < shards; i += 1) {
    g.fillStyle(varyColor(0x140909, Math.floor(rand() * 20) - 10), 0.35 + rand() * 0.35);
    if (rand() > 0.5) {
      g.fillRect(rand() * size, rand() * size, 1 + rand() * 3, 1 + rand() * 3);
    } else {
      g.fillEllipse(rand() * size, rand() * size, 1 + rand() * 3, 1 + rand() * 3);
    }
  }

  const veins = 3 + Math.floor(rand() * 3);
  for (let i = 0; i < veins; i += 1) {
    const points = 3 + Math.floor(rand() * 3);
    let px = rand() * size;
    let py = rand() * size;
    g.lineStyle(3, 0xd12a2a, 0.2);
    for (let p = 0; p < points; p += 1) {
      const nx = Phaser.Math.Clamp(px + rand() * (size * 0.3) - size * 0.15, 0, size);
      const ny = Phaser.Math.Clamp(py + rand() * (size * 0.3) - size * 0.15, 0, size);
      g.lineBetween(px, py, nx, ny);
      px = nx;
      py = ny;
    }

    px = rand() * size;
    py = rand() * size;
    g.lineStyle(1.25, 0xd12a2a, 0.55);
    for (let p = 0; p < points; p += 1) {
      const nx = Phaser.Math.Clamp(px + rand() * (size * 0.3) - size * 0.15, 0, size);
      const ny = Phaser.Math.Clamp(py + rand() * (size * 0.3) - size * 0.15, 0, size);
      g.lineBetween(px, py, nx, ny);
      px = nx;
      py = ny;
    }
  }
};

const getVisualType = (tile: TileType, x: number, y: number, width: number, height: number): TileVisualType => {
  if (tile === 'Floor') return 'floor';
  if (tile === 'BreakableBlock') return 'breakable';
  if (tile === 'HardWall') {
    const isBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
    return isBorder ? 'border' : 'pillar';
  }
  return 'pillar';
};

export const getDeterministicArenaTileTexture = (
  scene: Phaser.Scene,
  tile: TileType,
  x: number,
  y: number,
  tileSize: number,
  arenaWidth: number,
  arenaHeight: number,
): string => {
  const visualType = getVisualType(tile, x, y, arenaWidth, arenaHeight);
  const key = `tile_${visualType}_${x}_${y}_${tileSize}`;
  if (scene.textures.exists(key)) return key;

  const seed = hashString(`${visualType}|${x}|${y}`);
  const rand = createSeededRng(seed);
  const g = scene.add.graphics().setVisible(false);

  if (visualType === 'floor') drawFloorTile(g, tileSize, rand);
  if (visualType === 'pillar') drawPillarTile(g, tileSize, rand);
  if (visualType === 'breakable') drawBreakableTile(g, tileSize, rand);
  if (visualType === 'border') drawBorderTile(g, tileSize, rand);

  g.generateTexture(key, tileSize, tileSize);
  g.destroy();
  ensureNearest(scene, key);
  return key;
};
