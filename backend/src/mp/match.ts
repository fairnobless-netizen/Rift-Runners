import type { MatchState, BombState, PlayerState } from './types';
import type { MatchSnapshot, MatchInputPayload, MatchBombExplodedEvent, MatchBombPlacedEvent } from './protocol';

const TICK_RATE_MS = 50; // 20 Hz
const BOMB_FUSE_TICKS = 30;
const BOMB_RANGE = 1;
const MAX_ACTIVE_BOMBS_PER_PLAYER = 3;

type MatchTickEvents = {
  bombPlaced: MatchBombPlacedEvent[];
  bombExploded: MatchBombExplodedEvent[];
};

export function startMatch(
  match: MatchState,
  broadcast: (snapshot: MatchSnapshot, events: MatchTickEvents) => void,
) {
  match.interval = setInterval(() => tick(match, broadcast), TICK_RATE_MS);
}

export function stopMatch(match: MatchState) {
  if (match.interval) {
    clearInterval(match.interval);
    match.interval = undefined;
  }
}

function tick(match: MatchState, broadcast: (snapshot: MatchSnapshot, events: MatchTickEvents) => void) {
  match.tick++;

  const events: MatchTickEvents = {
    bombPlaced: [],
    bombExploded: [],
  };

  // Apply queued inputs deterministically: FIFO
  while (match.inputQueue.length > 0) {
    const input = match.inputQueue.shift()!;
    const player = match.players.get(input.tgUserId);
    if (!player) continue;

    // Ignore old/out-of-order seq
    if (input.seq <= player.lastInputSeq) continue;

    applyInput(match, player, input.seq, input.payload, events);
  }

  processBombs(match, events);

  const snapshot: MatchSnapshot = {
    version: 'match_v1',
    roomCode: match.roomId,
    matchId: match.matchId,
    tick: match.tick,
    serverTime: Date.now(),
    world: {
      gridW: match.world.gridW,
      gridH: match.world.gridH,
      worldHash: match.world.worldHash,
      bombs: Array.from(match.bombs.values()).map((bomb) => ({
        id: bomb.id,
        x: bomb.x,
        y: bomb.y,
        ownerId: bomb.ownerId,
        explodeTick: bomb.explodeTick,
      })),
    },
    players: Array.from(match.players.values()).map((p) => ({
      tgUserId: p.tgUserId,
      displayName: p.displayName,
      colorId: p.colorId,
      skinId: p.skinId,
      lastInputSeq: p.lastInputSeq,
      x: p.x,
      y: p.y,
    })),
  };

  broadcast(snapshot, events);
}

function canOccupyWorldCell(match: MatchState, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= match.world.gridW || y >= match.world.gridH) {
    return false;
  }

  const idx = y * match.world.gridW + x;
  const tile = match.world.tiles[idx] ?? 1;
  if (tile !== 0) {
    return false;
  }

  for (const bomb of match.bombs.values()) {
    if (bomb.x === x && bomb.y === y) {
      return false;
    }
  }

  return true;
}

function applyInput(
  match: MatchState,
  player: PlayerState,
  seq: number,
  payload: MatchInputPayload,
  events: MatchTickEvents,
) {
  if (payload.kind === 'move') {
    let nx = player.x;
    let ny = player.y;

    switch (payload.dir) {
      case 'up': ny -= 1; break;
      case 'down': ny += 1; break;
      case 'left': nx -= 1; break;
      case 'right': nx += 1; break;
    }

    nx = clamp(nx, 0, match.world.gridW - 1);
    ny = clamp(ny, 0, match.world.gridH - 1);

    if (!canOccupyWorldCell(match, nx, ny)) {
      player.lastInputSeq = seq;
      return;
    }

    player.x = nx;
    player.y = ny;
    player.lastInputSeq = seq;
    return;
  }

  if (payload.kind === 'place_bomb') {
    tryPlaceBomb(match, player, seq, events);
  }
}

function tryPlaceBomb(match: MatchState, player: PlayerState, seq: number, events: MatchTickEvents) {
  player.lastInputSeq = seq;

  const x = player.x;
  const y = player.y;
  const tile = match.world.tiles[y * match.world.gridW + x] ?? 1;
  if (tile !== 0) {
    return;
  }

  const activeBombsByOwner = Array.from(match.bombs.values()).filter((bomb) => bomb.ownerId === player.tgUserId).length;
  if (activeBombsByOwner >= MAX_ACTIVE_BOMBS_PER_PLAYER) {
    return;
  }

  for (const bomb of match.bombs.values()) {
    if (bomb.x === x && bomb.y === y) {
      return;
    }
  }

  const id = `${x},${y}`;
  const bomb: BombState = {
    id,
    x,
    y,
    ownerId: player.tgUserId,
    placedTick: match.tick,
    explodeTick: match.tick + BOMB_FUSE_TICKS,
  };
  match.bombs.set(id, bomb);

  events.bombPlaced.push({
    type: 'match:bomb_placed',
    eventId: buildEventId(match.matchId, match.tick, 'bomb_placed', bomb.id),
    roomCode: match.roomId,
    matchId: match.matchId,
    tick: match.tick,
    bomb: {
      id: bomb.id,
      x: bomb.x,
      y: bomb.y,
      ownerId: bomb.ownerId,
      explodeTick: bomb.explodeTick,
    },
  });
}

function processBombs(match: MatchState, events: MatchTickEvents) {
  while (true) {
    const dueBomb = Array.from(match.bombs.values())
      .filter((bomb) => bomb.explodeTick <= match.tick)
      .sort((a, b) => a.explodeTick - b.explodeTick || a.id.localeCompare(b.id))[0];

    if (!dueBomb) {
      return;
    }

    const removed = match.bombs.get(dueBomb.id);
    if (!removed) {
      continue;
    }
    match.bombs.delete(dueBomb.id);

    const { affected, destroyed } = getExplosionCells(match, removed);
    for (const cell of destroyed) {
      const idx = cell.y * match.world.gridW + cell.x;
      match.world.tiles[idx] = 0;
    }

    if (destroyed.length > 0) {
      match.world.worldHash = hashWorldTiles(match.world.tiles);
    }

    events.bombExploded.push({
      type: 'match:bomb_exploded',
      eventId: buildEventId(match.matchId, match.tick, 'bomb_exploded', removed.id),
      roomCode: match.roomId,
      matchId: match.matchId,
      tick: match.tick,
      bombId: removed.id,
      destroyed,
      affected,
    });
  }
}

function getExplosionCells(match: MatchState, bomb: BombState): {
  affected: Array<{ x: number; y: number }>;
  destroyed: Array<{ x: number; y: number }>;
} {
  const affected: Array<{ x: number; y: number }> = [{ x: bomb.x, y: bomb.y }];
  const destroyed: Array<{ x: number; y: number }> = [];

  const dirs = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];

  for (const dir of dirs) {
    for (let i = 1; i <= BOMB_RANGE; i += 1) {
      const x = bomb.x + dir.dx * i;
      const y = bomb.y + dir.dy * i;
      if (x < 0 || y < 0 || x >= match.world.gridW || y >= match.world.gridH) {
        break;
      }

      const idx = y * match.world.gridW + x;
      const tile = match.world.tiles[idx] ?? 1;
      if (tile === 1) {
        break;
      }

      affected.push({ x, y });
      if (tile === 2) {
        destroyed.push({ x, y });
        break;
      }
    }
  }

  return { affected, destroyed };
}

function hashWorldTiles(tiles: number[]): string {
  let hash = 2166136261;
  for (const tile of tiles) {
    hash ^= tile & 0xff;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function buildEventId(matchId: string, tick: number, type: string, bombId: string): string {
  return `${matchId}:${tick}:${type}:${bombId}`;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
