import Phaser from 'phaser';
import type { TileType } from './types';

type TileVisualType = 'floor' | 'pillar' | 'breakable' | 'border';

type ThemePalette = {
  floorBaseA: number;
  floorBaseB: number;
  floorPanel: number;
  floorPanelAccent: number;

  pillarBaseA: number;
  pillarBaseB: number;
  pillarLine: number;

  breakBaseA: number;
  breakBaseB: number;
  breakHighlight: number;

  borderBaseA: number;
  borderBaseB: number;
  borderGlow: number;
};

const THEMES: ThemePalette[] = [
  // Theme 0: neutral stone sci-fi
  {
    floorBaseA: 0x575a56,
    floorBaseB: 0x646864,
    floorPanel: 0x4a4d4a,
    floorPanelAccent: 0x7f8a86,

    pillarBaseA: 0x3f3c34,
    pillarBaseB: 0x4a463d,
    pillarLine: 0x2a2722,

    breakBaseA: 0x8a5a2a,
    breakBaseB: 0xa56a31,
    breakHighlight: 0xc4813a,

    borderBaseA: 0x160a0a,
    borderBaseB: 0x240d0d,
    borderGlow: 0xd12a2a,
  },
  // Theme 1: colder “rift” (bluish steel)
  {
    floorBaseA: 0x3e4652,
    floorBaseB: 0x4b5563,
    floorPanel: 0x323a45,
    floorPanelAccent: 0x7da6c7,

    pillarBaseA: 0x2e343e,
    pillarBaseB: 0x3a424d,
    pillarLine: 0x1e232b,

    breakBaseA: 0x6b5a3c,
    breakBaseB: 0x7c6946,
    breakHighlight: 0xb8a27a,

    borderBaseA: 0x0a0e14,
    borderBaseB: 0x121a24,
    borderGlow: 0x3cc7ff,
  },
  // Theme 2: warmer “industrial” (amber)
  {
    floorBaseA: 0x4a463b,
    floorBaseB: 0x5a5547,
    floorPanel: 0x3a372f,
    floorPanelAccent: 0xd8b15a,

    pillarBaseA: 0x3a3329,
    pillarBaseB: 0x4a4134,
    pillarLine: 0x241f19,

    breakBaseA: 0x8b4b28,
    breakBaseB: 0xa25a2e,
    breakHighlight: 0xe0b067,

    borderBaseA: 0x17110a,
    borderBaseB: 0x241a0e,
    borderGlow: 0xffc24d,
  },
];

const getTheme = (themeId: number): ThemePalette => {
  const id = Number.isFinite(themeId) ? Math.max(0, Math.floor(themeId)) : 0;
  return THEMES[id % THEMES.length] ?? THEMES[0];
};

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

const drawPanelSeams = (g: Phaser.GameObjects.Graphics, size: number, base: number, seam: number, accent: number, rand: () => number) => {
  // Subtle panel grid INSIDE tile, so we can render full tileSize without gaps.
  const inset = Math.max(1, Math.floor(size * 0.08));
  g.lineStyle(Math.max(1, Math.floor(size * 0.04)), seam, 0.22);
  g.strokeRect(inset, inset, size - inset * 2, size - inset * 2);

  // Small cross seam
  if (rand() > 0.35) {
    const mid = size / 2;
    g.lineStyle(Math.max(1, Math.floor(size * 0.03)), seam, 0.2);
    g.lineBetween(inset, mid, size - inset, mid);
    g.lineBetween(mid, inset, mid, size - inset);
  }

  // Accent bolt points
  const bolts = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < bolts; i += 1) {
    const x = inset + rand() * (size - inset * 2);
    const y = inset + rand() * (size - inset * 2);
    g.fillStyle(accent, 0.18 + rand() * 0.09);
    g.fillCircle(x, y, Math.max(1, Math.floor(size * 0.035)));
  }

  // Tiny noise (restrained: keep floor mostly panel-like)
  const noiseCount = 6 + Math.floor(rand() * 6);
  for (let i = 0; i < noiseCount; i += 1) {
    g.fillStyle(varyColor(base, Math.floor(rand() * 14) - 7), 0.03 + rand() * 0.03);
    g.fillRect(Math.floor(rand() * size), Math.floor(rand() * size), 1, 1);
  }
};

const drawFloorTile = (g: Phaser.GameObjects.Graphics, size: number, theme: ThemePalette, rand: () => number): void => {
  const base = rand() > 0.5 ? theme.floorBaseA : theme.floorBaseB;
  g.fillStyle(base, 1);
  g.fillRect(0, 0, size, size);

  // Inner seams
  drawPanelSeams(g, size, base, theme.floorPanel, theme.floorPanelAccent, rand);

  // A couple of “plates”
  const plates = 1 + Math.floor(rand() * 2);
  for (let i = 0; i < plates; i += 1) {
    const plateW = Math.floor(size * (0.38 + rand() * 0.24));
    const plateH = Math.floor(size * (0.22 + rand() * 0.16));
    const x = Math.floor(size * 0.08 + rand() * (size - plateW - size * 0.16));
    const y = Math.floor(size * 0.08 + rand() * (size - plateH - size * 0.16));
    g.fillStyle(varyColor(theme.floorPanel, Math.floor(rand() * 10) - 5), 0.3);
    g.fillRect(x, y, plateW, plateH);
    g.lineStyle(Math.max(1, Math.floor(size * 0.03)), theme.floorPanel, 0.3);
    g.strokeRect(x, y, plateW, plateH);
    g.lineStyle(Math.max(1, Math.floor(size * 0.02)), theme.floorPanelAccent, 0.28);
    g.strokeRect(x + 1, y + 1, Math.max(1, plateW - 2), Math.max(1, plateH - 2));
  }
};

const drawPillarTile = (g: Phaser.GameObjects.Graphics, size: number, theme: ThemePalette, rand: () => number): void => {
  const base = rand() > 0.5 ? theme.pillarBaseA : theme.pillarBaseB;
  g.fillStyle(base, 1);
  g.fillRect(0, 0, size, size);

  const slabs = 2 + Math.floor(rand() * 2);
  for (let i = 0; i < slabs; i += 1) {
    const w = size * (0.42 + rand() * 0.22);
    const h = size * (0.22 + rand() * 0.28);
    const x = rand() * (size - w);
    const y = rand() * (size - h);
    g.fillStyle(varyColor(base, Math.floor(rand() * 18) - 9), 0.95);
    g.fillRect(x, y, w, h);
  }

  const seamX = Math.floor(size * (0.35 + rand() * 0.3));
  g.lineStyle(Math.max(1, Math.floor(size * 0.03)), theme.pillarLine, 0.5);
  g.lineBetween(seamX, 2, seamX, size - 2);
  g.lineStyle(Math.max(1, Math.floor(size * 0.02)), varyColor(theme.pillarBaseB, 16), 0.28);
  g.lineBetween(seamX + 1, 2, seamX + 1, size - 2);

  g.lineStyle(Math.max(2, Math.floor(size * 0.07)), theme.pillarLine, 0.72);
  g.strokeRect(1, 1, size - 2, size - 2);
};

const drawBreakableTile = (g: Phaser.GameObjects.Graphics, size: number, theme: ThemePalette, rand: () => number): void => {
  const base = varyColor(rand() > 0.5 ? theme.breakBaseA : theme.breakBaseB, -8);
  g.fillStyle(base, 1);
  g.fillRect(0, 0, size, size);

  const chunks = 3 + Math.floor(rand() * 2);
  for (let i = 0; i < chunks; i += 1) {
    const w = size * (0.18 + rand() * 0.16);
    const h = size * (0.14 + rand() * 0.12);
    const x = rand() * (size - w);
    const y = rand() * (size - h);
    g.fillStyle(varyColor(base, Math.floor(rand() * 22) - 11), 0.9);
    g.fillRect(x, y, w, h);
    g.lineStyle(Math.max(1, Math.floor(size * 0.02)), theme.breakHighlight, 0.24);
    g.strokeRect(x + 1, y + 1, Math.max(1, w - 2), Math.max(1, h - 2));
  }

  // Central container/crystal for readability
  const cx = size * 0.5;
  const cy = size * 0.5;
  const halfW = size * (0.16 + rand() * 0.05);
  const halfH = size * (0.2 + rand() * 0.05);
  g.fillStyle(varyColor(theme.breakHighlight, 18), 0.35);
  g.beginPath();
  g.moveTo(cx, cy - halfH);
  g.lineTo(cx + halfW, cy);
  g.lineTo(cx, cy + halfH);
  g.lineTo(cx - halfW, cy);
  g.closePath();
  g.fillPath();
  g.lineStyle(Math.max(1, Math.floor(size * 0.035)), theme.breakHighlight, 0.72);
  g.strokePath();
  g.lineStyle(Math.max(1, Math.floor(size * 0.02)), varyColor(theme.breakHighlight, 30), 0.45);
  g.lineBetween(cx - halfW * 0.55, cy, cx + halfW * 0.55, cy);
  g.lineBetween(cx, cy - halfH * 0.55, cx, cy + halfH * 0.55);

  // Mild outline
  g.lineStyle(Math.max(1, Math.floor(size * 0.04)), 0x2a1a0c, 0.45);
  g.strokeRect(1, 1, size - 2, size - 2);
};

const drawBorderTile = (g: Phaser.GameObjects.Graphics, size: number, theme: ThemePalette, rand: () => number): void => {
  const base = rand() > 0.5 ? theme.borderBaseA : theme.borderBaseB;
  g.fillStyle(base, 1);
  g.fillRect(0, 0, size, size);

  // Shards/noise
  const shards = 10 + Math.floor(rand() * 10);
  for (let i = 0; i < shards; i += 1) {
    g.fillStyle(varyColor(base, Math.floor(rand() * 16) - 8), 0.25 + rand() * 0.25);
    if (rand() > 0.5) g.fillRect(rand() * size, rand() * size, 1 + rand() * 3, 1 + rand() * 3);
    else g.fillEllipse(rand() * size, rand() * size, 1 + rand() * 3, 1 + rand() * 3);
  }

  // Veins / glow lines
  const veins = 1 + Math.floor(rand() * 2);
  for (let i = 0; i < veins; i += 1) {
    const points = 3 + Math.floor(rand() * 2);
    let px = rand() * size;
    let py = rand() * size;
    g.lineStyle(Math.max(1, Math.floor(size * 0.08)), theme.borderGlow, 0.08);
    for (let p = 0; p < points; p += 1) {
      const nx = Phaser.Math.Clamp(px + rand() * (size * 0.3) - size * 0.15, 0, size);
      const ny = Phaser.Math.Clamp(py + rand() * (size * 0.3) - size * 0.15, 0, size);
      g.lineBetween(px, py, nx, ny);
      px = nx;
      py = ny;
    }
    px = rand() * size;
    py = rand() * size;
    g.lineStyle(Math.max(1, Math.floor(size * 0.04)), theme.borderGlow, 0.32);
    for (let p = 0; p < points; p += 1) {
      const nx = Phaser.Math.Clamp(px + rand() * (size * 0.3) - size * 0.15, 0, size);
      const ny = Phaser.Math.Clamp(py + rand() * (size * 0.3) - size * 0.15, 0, size);
      g.lineBetween(px, py, nx, ny);
      px = nx;
      py = ny;
    }
  }

  const glowSegments = 1 + Math.floor(rand() * 2);
  const insetA = Math.max(2, Math.floor(size * 0.12));
  const insetB = Math.max(insetA + 1, Math.floor(size * 0.2));
  for (let i = 0; i < glowSegments; i += 1) {
    const side = Math.floor(rand() * 4);
    const len = size * (0.24 + rand() * 0.24);
    const start = size * (0.12 + rand() * 0.52);
    g.lineStyle(Math.max(1, Math.floor(size * 0.04)), theme.borderGlow, 0.36);
    g.beginPath();
    if (side === 0) {
      g.moveTo(start, insetA);
      g.lineTo(Math.min(size - insetA, start + len), insetA);
    } else if (side === 1) {
      g.moveTo(size - insetA, start);
      g.lineTo(size - insetA, Math.min(size - insetA, start + len));
    } else if (side === 2) {
      g.moveTo(start, size - insetA);
      g.lineTo(Math.min(size - insetA, start + len), size - insetA);
    } else {
      g.moveTo(insetA, start);
      g.lineTo(insetA, Math.min(size - insetA, start + len));
    }
    g.strokePath();

    g.lineStyle(Math.max(1, Math.floor(size * 0.02)), varyColor(theme.borderGlow, 36), 0.42);
    g.beginPath();
    if (side === 0) {
      g.moveTo(start, insetB);
      g.lineTo(Math.min(size - insetB, start + len * 0.85), insetB);
    } else if (side === 1) {
      g.moveTo(size - insetB, start);
      g.lineTo(size - insetB, Math.min(size - insetB, start + len * 0.85));
    } else if (side === 2) {
      g.moveTo(start, size - insetB);
      g.lineTo(Math.min(size - insetB, start + len * 0.85), size - insetB);
    } else {
      g.moveTo(insetB, start);
      g.lineTo(insetB, Math.min(size - insetB, start + len * 0.85));
    }
    g.strokePath();
  }

  g.lineStyle(Math.max(1, Math.floor(size * 0.06)), 0x0a0606, 0.7);
  g.strokeRect(1, 1, size - 2, size - 2);
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

const VARIANT_COUNTS: Record<TileVisualType, number> = {
  floor: 10,
  breakable: 6,
  pillar: 3,
  border: 3,
};

export const getDeterministicArenaTileTexture = (
  scene: Phaser.Scene,
  tile: TileType,
  x: number,
  y: number,
  tileSize: number,
  arenaWidth: number,
  arenaHeight: number,
  themeId: number = 0,
): string => {
  const visualType = getVisualType(tile, x, y, arenaWidth, arenaHeight);
  const variants = VARIANT_COUNTS[visualType] ?? 6;

  // Choose variant by coord (deterministic), but DRAW key is per-variant (bounded cache).
  const coordSeed = hashString(`${visualType}|t${themeId}|${x}|${y}`);
  const variantIndex = coordSeed % variants;

  const key = `tile_${visualType}_t${themeId}_v${variantIndex}_${tileSize}`;
  if (scene.textures.exists(key)) return key;

  // Variant seed should NOT depend on x/y, otherwise we'd still get per-cell visuals.
  const variantSeed = hashString(`${visualType}|t${themeId}|v${variantIndex}`);
  const rand = createSeededRng(variantSeed);
  const theme = getTheme(themeId);

  const g = scene.add.graphics().setVisible(false);

  if (visualType === 'floor') drawFloorTile(g, tileSize, theme, rand);
  if (visualType === 'pillar') drawPillarTile(g, tileSize, theme, rand);
  if (visualType === 'breakable') drawBreakableTile(g, tileSize, theme, rand);
  if (visualType === 'border') drawBorderTile(g, tileSize, theme, rand);

  g.generateTexture(key, tileSize, tileSize);
  g.destroy();
  ensureNearest(scene, key);
  return key;
};
