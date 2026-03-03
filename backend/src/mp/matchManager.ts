import crypto from 'crypto';

import { stopMatch } from './match';
import { EnemyState, MatchState, PlayerState } from './types';

const matches = new Map<string, MatchState>();
const roomToMatch = new Map<string, string>();

type Cell = { x: number; y: number };

function getSpawnSafeCells(gridW: number, gridH: number): Set<string> {
  const cells: Cell[] = [
    // top-left
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 1, y: 2 },
    // top-right
    { x: gridW - 2, y: 1 },
    { x: gridW - 3, y: 1 },
    { x: gridW - 2, y: 2 },
    // bottom-left
    { x: 1, y: gridH - 3 },
    { x: 2, y: gridH - 3 },
    { x: 1, y: gridH - 4 },
    // bottom-right
    { x: gridW - 2, y: gridH - 3 },
    { x: gridW - 3, y: gridH - 3 },
    { x: gridW - 2, y: gridH - 4 },
  ];

  return new Set(cells.map(({ x, y }) => `${x},${y}`));
}

function createSeededRng(seed: string): () => number {
  let state = 0;
  for (let i = 0; i < seed.length; i += 1) {
    state = Math.imul(state ^ seed.charCodeAt(i), 16777619) >>> 0;
  }
  if (state === 0) {
    state = 0x9e3779b9;
  }

  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function getCornerSpawnPosition(idx: number, gridW: number, gridH: number): Cell {
  switch (idx) {
    case 0:
      return { x: 1, y: 1 };
    case 1:
      return { x: gridW - 2, y: 1 };
    case 2:
      return { x: 1, y: gridH - 3 };
    case 3:
      return { x: gridW - 2, y: gridH - 3 };
    default:
      return { x: 1, y: 1 };
  }
}


function shuffleCells(cells: Cell[], rng: () => number): Cell[] {
  const shuffled = [...cells];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function buildInitialEnemies(gridW: number, gridH: number, tiles: number[], seed: string): Map<string, EnemyState> {
  const enemies = new Map<string, EnemyState>();
  const desiredCount = 6;
  const spawnSafeCells = getSpawnSafeCells(gridW, gridH);
  const rng = createSeededRng(seed);
  const candidates: Cell[] = [];

  for (let y = 1; y < gridH - 1; y += 1) {
    for (let x = 1; x < gridW - 1; x += 1) {
      const idx = y * gridW + x;
      const tile = tiles[idx] ?? 1;
      if (tile !== 0) continue;
      if (spawnSafeCells.has(`${x},${y}`)) continue;
      candidates.push({ x, y });
    }
  }

  const shuffledCandidates = shuffleCells(candidates, rng);
  const midY = Math.floor(gridH / 2);
  const topHalf = shuffledCandidates.filter(({ y }) => y < midY);
  const bottomHalf = shuffledCandidates.filter(({ y }) => y >= midY);
  const topTarget = Math.ceil(desiredCount / 2);
  const bottomTarget = desiredCount - topTarget;

  const selected: Cell[] = [];
  selected.push(...topHalf.slice(0, topTarget));
  selected.push(...bottomHalf.slice(0, bottomTarget));

  if (selected.length < desiredCount) {
    const remainingTop = topHalf.slice(topTarget);
    const remainingBottom = bottomHalf.slice(bottomTarget);
    const fallback = [...remainingTop, ...remainingBottom];
    selected.push(...fallback.slice(0, desiredCount - selected.length));
  }

  for (const { x, y } of selected) {
    const id = `enemy_${enemies.size + 1}`;
    enemies.set(id, {
      id,
      x,
      y,
      facing: 'left',
      alive: true,
      isMoving: false,
      moveFromX: x,
      moveFromY: y,
      moveToX: x,
      moveToY: y,
      moveStartTick: 0,
      moveDurationTicks: 0,
      moveStartServerTimeMs: Date.now(),
    });
  }

  return enemies;
}

function buildWorldTiles(gridW: number, gridH: number, seed: string): number[] {
  const spawnSafeCells = getSpawnSafeCells(gridW, gridH);
  const rng = createSeededRng(seed);
  const breakableProbability = 0.32;
  const tiles: number[] = [];

  for (let y = 0; y < gridH; y += 1) {
    for (let x = 0; x < gridW; x += 1) {
      const edge = x === 0 || y === 0 || x === gridW - 1 || y === gridH - 1;
      const pillar = x % 2 === 0 && y % 2 === 0;
      if (edge || pillar) {
        if (spawnSafeCells.has(`${x},${y}`)) {
          tiles.push(0);
          continue;
        }
        tiles.push(1); // hard wall
        continue;
      }

      if (spawnSafeCells.has(`${x},${y}`)) {
        tiles.push(0);
        continue;
      }

      const isBrick = rng() < breakableProbability;
      tiles.push(isBrick ? 2 : 0);
    }
  }

  for (const cell of spawnSafeCells) {
    const [xStr, yStr] = cell.split(',');
    const x = Number(xStr);
    const y = Number(yStr);
    const idx = y * gridW + x;
    if (tiles[idx] !== 0) {
      tiles[idx] = 0;
    }
  }

  return tiles;
}

function hashWorldTiles(tiles: number[]): string {
  let hash = 2166136261;
  for (const tile of tiles) {
    hash ^= tile & 0xff;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function newMatchId(): string {
  return `match_${crypto.randomBytes(6).toString('hex')}`;
}

export function createMatch(roomId: string, players: string[]): MatchState {
  const existingId = roomToMatch.get(roomId);
  if (existingId) {
    endMatch(existingId);
  }

  const matchId = newMatchId();

  const gridW = 27;
  const gridH = 14;

  const worldTiles = buildWorldTiles(gridW, gridH, matchId);
  const worldHash = hashWorldTiles(worldTiles);

  const state: MatchState = {
    matchId,
    roomId,
    tick: 0,
    world: { gridW, gridH, tiles: worldTiles, worldHash },
    players: new Map<string, PlayerState>(),
    disconnectedPlayers: new Set<string>(),
    disconnectedAtMsByUserId: new Map<string, number>(),
    playerLives: new Map<string, number>(),
    eliminatedPlayers: new Set<string>(),
    bombs: new Map(),
    maxBombsPerPlayer: 1,
    bombFuseTicks: 40,
    bombRange: 2,
    enemies: buildInitialEnemies(gridW, gridH, worldTiles, `${matchId}:enemies`),
    enemyMoveIntervalTicks: 5,
    eventSeq: 0,
    seenEventIds: [],
    inputQueue: [],
    ended: false,
  };

  // Deterministic corner spawns by join order
  players.forEach((tgUserId, idx) => {
    const { x, y } = getCornerSpawnPosition(idx, gridW, gridH);

    state.players.set(tgUserId, {
      tgUserId,
      displayName: tgUserId,
      colorId: idx % 4,
      skinId: 'default',
      lastInputSeq: 0,
      x,
      y,
      isMoving: false,
      moveFromX: x,
      moveFromY: y,
      moveToX: x,
      moveToY: y,
      moveStartTick: state.tick,
      moveDurationTicks: 0,
      moveStartServerTimeMs: Date.now(),
      intentDir: null,
      state: 'alive',
      respawnAtTick: null,
      invulnUntilTick: 0,
      lastEnemyHitTick: Number.NEGATIVE_INFINITY,
      spawnX: x,
      spawnY: y,
    });
    state.playerLives.set(tgUserId, 3);
  });

  matches.set(matchId, state);
  roomToMatch.set(roomId, matchId);
  return state;
}

export function getMatch(matchId: string): MatchState | null {
  return matches.get(matchId) ?? null;
}

export function getMatchByRoom(roomId: string): MatchState | null {
  const matchId = roomToMatch.get(roomId);
  if (!matchId) {
    return null;
  }

  return matches.get(matchId) ?? null;
}

export function endMatch(matchId: string) {
  const match = matches.get(matchId);
  if (!match) {
    return;
  }

  stopMatch(match);
  matches.delete(matchId);
  roomToMatch.delete(match.roomId);
}
