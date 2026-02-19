import crypto from 'crypto';

import { stopMatch } from './match';
import { MatchState, PlayerState } from './types';

const matches = new Map<string, MatchState>();
const roomToMatch = new Map<string, string>();


function buildWorldTiles(gridW: number, gridH: number): number[] {
  const tiles: number[] = [];
  for (let y = 0; y < gridH; y += 1) {
    for (let x = 0; x < gridW; x += 1) {
      const edge = x === 0 || y === 0 || x === gridW - 1 || y === gridH - 1;
      const pillar = x % 2 === 0 && y % 2 === 0;
      if (edge || pillar) {
        tiles.push(1); // hard wall
        continue;
      }

      const spawnSafe = (x <= 2 && y <= 2);
      if (spawnSafe) {
        tiles.push(0);
        continue;
      }

      // deterministic checker brick pattern for v1 sync
      const isBrick = (x + y) % 3 === 0;
      tiles.push(isBrick ? 2 : 0);
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

  const worldTiles = buildWorldTiles(gridW, gridH);
  const worldHash = hashWorldTiles(worldTiles);

  const state: MatchState = {
    matchId,
    roomId,
    tick: 0,
    world: { gridW, gridH, tiles: worldTiles, worldHash },
    players: new Map<string, PlayerState>(),
    playerLives: new Map<string, number>(),
    eliminatedPlayers: new Set<string>(),
    bombs: new Map(),
    maxBombsPerPlayer: 1,
    bombFuseTicks: 40,
    bombRange: 2,
    eventSeq: 0,
    seenEventIds: [],
    inputQueue: [],
    ended: false,
  };

  // Deterministic spawns by join order: spread along top row
  players.forEach((tgUserId, idx) => {
    const x = Math.min(gridW - 1, 1 + idx * 2);
    const y = 1;

    state.players.set(tgUserId, {
      tgUserId,
      displayName: tgUserId,
      colorId: idx % 4,
      skinId: 'default',
      lastInputSeq: 0,
      x,
      y,
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
