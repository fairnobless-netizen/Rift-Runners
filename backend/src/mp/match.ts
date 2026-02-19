import type {
  MatchBombExploded,
  MatchBombPlaced,
  MatchInputPayload,
  MatchServerMessage,
  MatchSnapshot,
} from './protocol';
import type { MatchState } from './types';

const TICK_RATE_MS = 50; // 20 Hz
const BOMB_FUSE_TICKS = 40;
const BOMB_RANGE = 2;
const MAX_ACTIVE_BOMBS_PER_PLAYER = 2;
const INITIAL_LIVES = 3;

type BombModel = {
  id: string;
  x: number;
  y: number;
  ownerId: string;
  tickPlaced: number;
  explodeAtTick: number;
};

type RuntimePlayerState = {
  lives: number;
  eliminated: boolean;
};

type MatchRuntimeState = {
  bombs: Map<string, BombModel>;
  playerState: Map<string, RuntimePlayerState>;
  ended: boolean;
  endedReason: 'all_eliminated' | 'manual_restart' | null;
};

function getRuntime(match: MatchState): MatchRuntimeState {
  const runtimeHost = match as MatchState & { __runtime?: MatchRuntimeState };
  if (!runtimeHost.__runtime) {
    runtimeHost.__runtime = {
      bombs: new Map<string, BombModel>(),
      playerState: new Map<string, RuntimePlayerState>(),
      ended: false,
      endedReason: null,
    };
  }

  for (const tgUserId of match.players.keys()) {
    if (!runtimeHost.__runtime.playerState.has(tgUserId)) {
      runtimeHost.__runtime.playerState.set(tgUserId, {
        lives: INITIAL_LIVES,
        eliminated: false,
      });
    }
  }

  return runtimeHost.__runtime;
}

function nextEventId(match: MatchState, kind: string): string {
  match.eventSeq += 1;
  return `${match.matchId}:${kind}:${match.eventSeq}`;
}

function logMatchEvent(event: string, payload: Record<string, unknown>): void {
  console.info(event, payload);
}

export function startMatch(match: MatchState, broadcast: (message: MatchServerMessage) => void) {
  const runtime = getRuntime(match);
  runtime.ended = false;
  runtime.endedReason = null;
  match.interval = setInterval(() => tick(match, broadcast), TICK_RATE_MS);
}

export function stopMatch(match: MatchState) {
  if (match.interval) {
    clearInterval(match.interval);
    match.interval = undefined;
  }
}

function tick(match: MatchState, broadcast: (message: MatchServerMessage) => void) {
  const runtime = getRuntime(match);
  if (runtime.ended) {
    return;
  }

  match.tick++;

  while (match.inputQueue.length > 0) {
    const input = match.inputQueue.shift()!;
    const player = match.players.get(input.tgUserId);
    if (!player) continue;

    if (input.seq <= player.lastInputSeq) continue;

    applyInput(match, player.tgUserId, input.seq, input.payload, broadcast);
  }

  processBombs(match, broadcast);
  maybeEndMatch(match, broadcast);

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
      bombs: Array.from(runtime.bombs.values()).map((bomb) => ({
        id: bomb.id,
        x: bomb.x,
        y: bomb.y,
        ownerId: bomb.ownerId,
        tickPlaced: bomb.tickPlaced,
        explodeAtTick: bomb.explodeAtTick,
      })),
    },
    players: Array.from(match.players.values()).map((p) => {
      const playerState = runtime.playerState.get(p.tgUserId) ?? { lives: INITIAL_LIVES, eliminated: false };
      return {
        tgUserId: p.tgUserId,
        displayName: p.displayName,
        colorId: p.colorId,
        skinId: p.skinId,
        lastInputSeq: p.lastInputSeq,
        x: p.x,
        y: p.y,
        lives: playerState.lives,
        eliminated: playerState.eliminated,
      };
    }),
  };

  broadcast({ type: 'match:snapshot', snapshot });
}

function processBombs(match: MatchState, broadcast: (message: MatchServerMessage) => void): void {
  const runtime = getRuntime(match);
  const dueBombs = Array.from(runtime.bombs.values())
    .filter((bomb) => bomb.explodeAtTick <= match.tick)
    .sort((a, b) => a.explodeAtTick - b.explodeAtTick || a.id.localeCompare(b.id));

  for (const bomb of dueBombs) {
    if (!runtime.bombs.has(bomb.id)) continue;

    runtime.bombs.delete(bomb.id);

    const blastCells = computeBlastCells(match, bomb.x, bomb.y, BOMB_RANGE);
    const tilesDestroyed = applyBlastToTiles(match, blastCells);
    applyBlastDamage(match, blastCells);

    const event: MatchBombExploded = {
      type: 'match:bomb_exploded',
      roomCode: match.roomId,
      matchId: match.matchId,
      eventId: nextEventId(match, 'bomb_exploded'),
      serverTick: match.tick,
      tick: match.tick,
      bombId: bomb.id,
      x: bomb.x,
      y: bomb.y,
      tilesDestroyed,
    };

    logMatchEvent('mp_bomb_exploded', {
      roomCode: match.roomId,
      matchId: match.matchId,
      tick: match.tick,
      bombId: bomb.id,
      x: bomb.x,
      y: bomb.y,
      tilesDestroyed: tilesDestroyed.length,
    });

    broadcast(event);
  }
}

function computeBlastCells(match: MatchState, x: number, y: number, range: number): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = [{ x, y }];
  const directions = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];

  for (const dir of directions) {
    for (let step = 1; step <= range; step += 1) {
      const nx = x + dir.dx * step;
      const ny = y + dir.dy * step;
      if (nx < 0 || ny < 0 || nx >= match.world.gridW || ny >= match.world.gridH) {
        break;
      }

      const idx = ny * match.world.gridW + nx;
      const tile = match.world.tiles[idx] ?? 1;
      if (tile === 1) {
        break;
      }

      cells.push({ x: nx, y: ny });

      if (tile === 2) {
        break;
      }
    }
  }

  return cells;
}

function applyBlastToTiles(match: MatchState, blastCells: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const tilesDestroyed: Array<{ x: number; y: number }> = [];
  for (const cell of blastCells) {
    const idx = cell.y * match.world.gridW + cell.x;
    const tile = match.world.tiles[idx] ?? 1;
    if (tile !== 2) continue;
    match.world.tiles[idx] = 0;
    tilesDestroyed.push(cell);
  }
  return tilesDestroyed;
}

function applyBlastDamage(match: MatchState, blastCells: Array<{ x: number; y: number }>): void {
  const runtime = getRuntime(match);
  const blastSet = new Set(blastCells.map((cell) => `${cell.x}:${cell.y}`));

  for (const player of match.players.values()) {
    const pState = runtime.playerState.get(player.tgUserId);
    if (!pState || pState.eliminated) continue;

    const hit = blastSet.has(`${player.x}:${player.y}`);
    if (!hit) continue;

    pState.lives = Math.max(0, pState.lives - 1);
    if (pState.lives === 0) {
      pState.eliminated = true;
    }

    logMatchEvent('mp_damage_applied', {
      roomCode: match.roomId,
      matchId: match.matchId,
      tick: match.tick,
      tgUserId: player.tgUserId,
      lives: pState.lives,
      eliminated: pState.eliminated,
    });
  }
}

function maybeEndMatch(match: MatchState, broadcast: (message: MatchServerMessage) => void): void {
  const runtime = getRuntime(match);
  if (runtime.ended) return;

  const alivePlayers = Array.from(match.players.keys()).filter((tgUserId) => {
    const state = runtime.playerState.get(tgUserId);
    return state && !state.eliminated;
  });

  if (alivePlayers.length > 1) {
    return;
  }

  runtime.ended = true;
  runtime.endedReason = 'all_eliminated';

  const endedMessage = {
    type: 'match:ended',
    roomCode: match.roomId,
    matchId: match.matchId,
    reason: 'all_eliminated',
    winnerTgUserId: alivePlayers.length === 1 ? alivePlayers[0] : undefined,
  };

  logMatchEvent('mp_match_ended', {
    roomCode: match.roomId,
    matchId: match.matchId,
    tick: match.tick,
    reason: (endedMessage as any).reason,
    winnerTgUserId: (endedMessage as any).winnerTgUserId ?? null,
  });

  broadcast(endedMessage as MatchServerMessage);
  stopMatch(match);
}

function canOccupyWorldCell(match: MatchState, x: number, y: number): boolean {
  const runtime = getRuntime(match);

  if (x < 0 || y < 0 || x >= match.world.gridW || y >= match.world.gridH) {
    return false;
  }

  const idx = y * match.world.gridW + x;
  const tile = match.world.tiles[idx] ?? 1;
  if (tile !== 0) {
    return false;
  }

  for (const bomb of runtime.bombs.values()) {
    if (bomb.x === x && bomb.y === y) {
      return false;
    }
  }

  return true;
}

function applyInput(
  match: MatchState,
  tgUserId: string,
  seq: number,
  payload: MatchInputPayload | { kind: 'place_bomb' },
  broadcast: (message: MatchServerMessage) => void,
) {
  const p = match.players.get(tgUserId);
  if (!p) return;

  const runtime = getRuntime(match);
  const playerState = runtime.playerState.get(tgUserId);
  if (!playerState || playerState.eliminated) {
    p.lastInputSeq = seq;
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

    nx = clamp(nx, 0, match.world.gridW - 1);
    ny = clamp(ny, 0, match.world.gridH - 1);

    if (!canOccupyWorldCell(match, nx, ny)) {
      p.lastInputSeq = seq;
      return;
    }

    p.x = nx;
    p.y = ny;
    p.lastInputSeq = seq;
    return;
  }

  if (payload.kind === 'place_bomb') {
    const activeOwnBombs = Array.from(runtime.bombs.values()).filter((bomb) => bomb.ownerId === tgUserId).length;
    if (activeOwnBombs >= MAX_ACTIVE_BOMBS_PER_PLAYER) {
      p.lastInputSeq = seq;
      return;
    }

    const occupied = Array.from(runtime.bombs.values()).some((bomb) => bomb.x === p.x && bomb.y === p.y);
    if (occupied) {
      p.lastInputSeq = seq;
      return;
    }

    const bombId = `${match.matchId}:bomb:${tgUserId}:${match.tick}:${seq}`;
    const bomb: BombModel = {
      id: bombId,
      x: p.x,
      y: p.y,
      ownerId: tgUserId,
      tickPlaced: match.tick,
      explodeAtTick: match.tick + BOMB_FUSE_TICKS,
    };

    runtime.bombs.set(bomb.id, bomb);
    p.lastInputSeq = seq;

    const event: MatchBombPlaced = {
      type: 'match:bomb_placed',
      roomCode: match.roomId,
      matchId: match.matchId,
      eventId: nextEventId(match, 'bomb_placed'),
      serverTick: match.tick,
      tick: match.tick,
      bomb: {
        id: bomb.id,
        x: bomb.x,
        y: bomb.y,
        ownerId: bomb.ownerId,
        tickPlaced: bomb.tickPlaced,
        explodeAtTick: bomb.explodeAtTick,
      },
    };

    logMatchEvent('mp_bomb_placed', {
      roomCode: match.roomId,
      matchId: match.matchId,
      tick: match.tick,
      bombId: bomb.id,
      tgUserId,
      x: bomb.x,
      y: bomb.y,
    });

    broadcast(event);
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
