import type { MatchState } from './types';
import type { MatchSnapshot, MatchInputPayload, MatchServerMessage } from './protocol';

const TICK_RATE_MS = 50; // 20 Hz
const BOMB_FUSE_TICKS = 40;
const BLAST_RANGE = 2;
const INITIAL_LIVES = 3;

type BombModel = {
  id: string;
  gridX: number;
  gridY: number;
  placedBy: string;
  placedAtTick: number;
  explodeAtTick: number;
};

type RuntimePlayerState = {
  lives: number;
  eliminated: boolean;
};

type MatchRuntimeState = {
  ended: boolean;
  players: Map<string, RuntimePlayerState>;
  bombs: Map<string, BombModel>;
  bombSeq: number;
};

const runtimeByMatch = new Map<string, MatchRuntimeState>();

export function startMatch(
  match: MatchState,
  broadcastSnapshot: (snapshot: MatchSnapshot) => void,
  broadcastEvent?: (msg: MatchServerMessage) => void,
) {
  runtimeByMatch.set(match.matchId, {
    ended: false,
    players: new Map(Array.from(match.players.keys()).map((id) => [id, { lives: INITIAL_LIVES, eliminated: false }])),
    bombs: new Map(),
    bombSeq: 0,
  });

  match.interval = setInterval(() => tick(match, broadcastSnapshot, broadcastEvent), TICK_RATE_MS);
}

export function stopMatch(match: MatchState) {
  if (match.interval) {
    clearInterval(match.interval);
    match.interval = undefined;
  }
  runtimeByMatch.delete(match.matchId);
}

function tick(
  match: MatchState,
  broadcastSnapshot: (snapshot: MatchSnapshot) => void,
  broadcastEvent?: (msg: MatchServerMessage) => void,
) {
  const runtime = runtimeByMatch.get(match.matchId);
  if (!runtime || runtime.ended) {
    return;
  }

  match.tick++;

  // Apply queued inputs deterministically: FIFO
  while (match.inputQueue.length > 0) {
    const input = match.inputQueue.shift()!;
    const player = match.players.get(input.tgUserId);
    if (!player) continue;

    // Ignore old/out-of-order seq
    if (input.seq <= player.lastInputSeq) continue;

    applyInput(match, runtime, player.tgUserId, input.seq, input.payload, broadcastEvent);
  }

  const exploded = explodeDueBombs(match, runtime, broadcastEvent);
  if (exploded && shouldEndMatch(runtime)) {
    runtime.ended = true;
    broadcastEvent?.({
      type: 'match:ended',
      roomCode: match.roomId,
      matchId: match.matchId,
      reason: 'all_eliminated',
    });
  }

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
      bombs: Array.from(runtime.bombs.values()).map((b) => ({
        id: b.id,
        x: b.gridX,
        y: b.gridY,
        ownerId: b.placedBy,
        tickPlaced: b.placedAtTick,
        explodeAtTick: b.explodeAtTick,
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
      lives: runtime.players.get(p.tgUserId)?.lives ?? INITIAL_LIVES,
      eliminated: runtime.players.get(p.tgUserId)?.eliminated ?? false,
    })),
  };

  broadcastSnapshot(snapshot);
}

function canOccupyWorldCell(match: MatchState, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= match.world.gridW || y >= match.world.gridH) {
    return false;
  }

  const idx = y * match.world.gridW + x;
  const tile = match.world.tiles[idx] ?? 1;
  return tile === 0;
}

function applyInput(
  match: MatchState,
  runtime: MatchRuntimeState,
  tgUserId: string,
  seq: number,
  payload: MatchInputPayload,
  broadcastEvent?: (msg: MatchServerMessage) => void,
) {
  const p = match.players.get(tgUserId);
  if (!p) return;

  const rp = runtime.players.get(tgUserId);
  if (!rp || rp.eliminated) {
    p.lastInputSeq = seq;
    return;
  }

  if (payload.kind === 'place_bomb') {
    const bombId = `${match.matchId}_bomb_${++runtime.bombSeq}`;
    runtime.bombs.set(bombId, {
      id: bombId,
      gridX: p.x,
      gridY: p.y,
      placedBy: tgUserId,
      placedAtTick: match.tick,
      explodeAtTick: match.tick + BOMB_FUSE_TICKS,
    });

    p.lastInputSeq = seq;

    broadcastEvent?.({
      type: 'match:bomb_placed',
      roomCode: match.roomId,
      matchId: match.matchId,
      eventId: `${match.matchId}:bp:${match.tick}:${bombId}`,
      serverTick: match.tick,
      tick: match.tick,
      bomb: {
        id: bombId,
        x: p.x,
        y: p.y,
        ownerId: tgUserId,
        tickPlaced: match.tick,
        explodeAtTick: match.tick + BOMB_FUSE_TICKS,
      },
    });
    return;
  }

  if (payload.kind === 'move') {
    let nx = p.x;
    let ny = p.y;

    switch (payload.dir) {
      case 'up': ny -= 1; break;
      case 'down': ny += 1; break;
      case 'left': nx -= 1; break;
      case 'right': nx += 1; break;
    }

    // Clamp to world bounds
    nx = clamp(nx, 0, match.world.gridW - 1);
    ny = clamp(ny, 0, match.world.gridH - 1);

    if (!canOccupyWorldCell(match, nx, ny)) {
      p.lastInputSeq = seq;
      return;
    }

    p.x = nx;
    p.y = ny;
    p.lastInputSeq = seq;
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function explodeDueBombs(match: MatchState, runtime: MatchRuntimeState, broadcastEvent?: (msg: MatchServerMessage) => void): boolean {
  const due = Array.from(runtime.bombs.values()).filter((bomb) => bomb.explodeAtTick <= match.tick);
  if (due.length === 0) return false;

  for (const bomb of due) {
    runtime.bombs.delete(bomb.id);

    const blastCells = computeBlastCells(match, bomb);
    const tilesDestroyed: Array<{ x: number; y: number }> = [];
    const damageApplied: Array<{ tgUserId: string; newLives: number; eliminated: boolean }> = [];

    for (const cell of blastCells) {
      const idx = cell.y * match.world.gridW + cell.x;
      if (match.world.tiles[idx] === 2) {
        match.world.tiles[idx] = 0;
        tilesDestroyed.push({ x: cell.x, y: cell.y });
      }
    }

    for (const [playerId, p] of match.players.entries()) {
      const rp = runtime.players.get(playerId);
      if (!rp || rp.eliminated) continue;

      const hit = blastCells.some((cell) => cell.x === p.x && cell.y === p.y);
      if (!hit) continue;

      rp.lives = Math.max(0, rp.lives - 1);
      rp.eliminated = rp.lives === 0;
      damageApplied.push({ tgUserId: playerId, newLives: rp.lives, eliminated: rp.eliminated });
    }

    broadcastEvent?.({
      type: 'match:bomb_exploded',
      roomCode: match.roomId,
      matchId: match.matchId,
      eventId: `${match.matchId}:be:${match.tick}:${bomb.id}`,
      serverTick: match.tick,
      tick: match.tick,
      bombId: bomb.id,
      x: bomb.gridX,
      y: bomb.gridY,
      tilesDestroyed,
      blastCells,
      damageApplied,
    });
  }

  return true;
}

function computeBlastCells(match: MatchState, bomb: BombModel): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = [{ x: bomb.gridX, y: bomb.gridY }];
  const dirs = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];

  for (const dir of dirs) {
    for (let step = 1; step <= BLAST_RANGE; step += 1) {
      const x = bomb.gridX + dir.dx * step;
      const y = bomb.gridY + dir.dy * step;
      if (x < 0 || y < 0 || x >= match.world.gridW || y >= match.world.gridH) break;
      const idx = y * match.world.gridW + x;
      const tile = match.world.tiles[idx] ?? 1;
      if (tile === 1) break;
      cells.push({ x, y });
      if (tile === 2) break;
    }
  }

  return cells;
}

function shouldEndMatch(runtime: MatchRuntimeState): boolean {
  const alive = Array.from(runtime.players.values()).filter((p) => !p.eliminated);
  return alive.length === 0;
}
