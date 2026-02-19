import type { MatchState } from './types';
import type { MatchSnapshot, MatchInputPayload, MatchServerMessage } from './protocol';

const TICK_RATE_MS = 50; // 20 Hz
const BOMB_FUSE_TICKS = 30;
const BOMB_RANGE = 2;
const MAX_ACTIVE_BOMBS_PER_PLAYER = 2;

type BombModel = {
  id: string;
  x: number;
  y: number;
  ownerId: string;
  tickPlaced: number;
  explodeAtTick: number;
  range: number;
};

type RuntimeMatchState = MatchState & {
  bombs?: Map<string, BombModel>;
  ended?: boolean;
};

type PlayerRuntime = {
  tgUserId: string;
  lastInputSeq: number;
  x: number;
  y: number;
  lives?: number;
  eliminated?: boolean;
};

function runtime(match: MatchState): RuntimeMatchState {
  const r = match as RuntimeMatchState;
  if (!r.bombs) {
    r.bombs = new Map<string, BombModel>();
  }
  return r;
}

function ensurePlayerRuntime(player: PlayerRuntime): void {
  if (!Number.isFinite(player.lives)) {
    player.lives = 3;
  }
  if (typeof player.eliminated !== 'boolean') {
    player.eliminated = false;
  }
}

function logMatchEvent(evt: string, payload: Record<string, unknown>) {
  console.log(JSON.stringify({ evt, ...payload, ts: Date.now() }));
}

function nextEventId(match: MatchState): string {
  match.eventSeq += 1;
  return `evt_${match.matchId}_${match.eventSeq}`;
}

function emit(
  match: MatchState,
  message: MatchServerMessage,
  broadcastMessage?: (message: MatchServerMessage) => void,
): void {
  if (broadcastMessage) {
    broadcastMessage(message);
  }
}

export function startMatch(
  match: MatchState,
  broadcastSnapshot: (snapshot: MatchSnapshot) => void,
  broadcastMessage?: (message: MatchServerMessage) => void,
  onEnded?: (roomCode: string, matchId: string) => void,
) {
  runtime(match);
  match.interval = setInterval(() => tick(match, broadcastSnapshot, broadcastMessage, onEnded), TICK_RATE_MS);
}

export function stopMatch(match: MatchState) {
  if (match.interval) {
    clearInterval(match.interval);
    match.interval = undefined;
  }
}

function tick(
  match: MatchState,
  broadcastSnapshot: (snapshot: MatchSnapshot) => void,
  broadcastMessage?: (message: MatchServerMessage) => void,
  onEnded?: (roomCode: string, matchId: string) => void,
) {
  const r = runtime(match);
  if (r.ended) {
    return;
  }

  match.tick++;

  while (match.inputQueue.length > 0) {
    const input = match.inputQueue.shift();
    if (!input) continue;
    const player = match.players.get(input.tgUserId) as PlayerRuntime | undefined;
    if (!player) continue;

    ensurePlayerRuntime(player);

    if (player.eliminated) {
      player.lastInputSeq = Math.max(player.lastInputSeq, input.seq);
      continue;
    }

    if (input.seq <= player.lastInputSeq) continue;

    applyInput(match, player.tgUserId, input.seq, input.payload, broadcastMessage);
  }

  resolveBombs(match, broadcastMessage);

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
      bombs: Array.from(r.bombs?.values() ?? []).map((bomb) => ({
        id: bomb.id,
        x: bomb.x,
        y: bomb.y,
        ownerId: bomb.ownerId,
        tickPlaced: bomb.tickPlaced,
        explodeAtTick: bomb.explodeAtTick,
      })),
    },
    players: Array.from(match.players.values()).map((p) => {
      const player = p as PlayerRuntime;
      ensurePlayerRuntime(player);
      return {
        tgUserId: player.tgUserId,
        displayName: (p as any).displayName,
        colorId: (p as any).colorId,
        skinId: (p as any).skinId,
        lastInputSeq: player.lastInputSeq,
        x: player.x,
        y: player.y,
        lives: player.lives ?? 0,
        eliminated: player.eliminated ?? false,
      };
    }),
  };

  broadcastSnapshot(snapshot);
  maybeEndMatch(match, broadcastMessage, onEnded);
}

function maybeEndMatch(
  match: MatchState,
  broadcastMessage?: (message: MatchServerMessage) => void,
  onEnded?: (roomCode: string, matchId: string) => void,
): void {
  const r = runtime(match);
  if (r.ended) return;

  const players = Array.from(match.players.values()) as PlayerRuntime[];
  players.forEach(ensurePlayerRuntime);

  const alive = players.filter((p) => !p.eliminated);
  if (alive.length > 1) return;

  r.ended = true;
  const winnerTgUserId = alive.length === 1 ? alive[0].tgUserId : undefined;
  const eventId = nextEventId(match);

  emit(match, {
    type: 'match:ended',
    roomCode: match.roomId,
    matchId: match.matchId,
    reason: 'all_eliminated',
    winnerTgUserId,
  } as unknown as MatchServerMessage, broadcastMessage);

  logMatchEvent('mp_match_ended', {
    roomCode: match.roomId,
    matchId: match.matchId,
    tick: match.tick,
    eventId,
    winnerTgUserId: winnerTgUserId ?? null,
  });

  stopMatch(match);
  onEnded?.(match.roomId, match.matchId);
}

function resolveBombs(match: MatchState, broadcastMessage?: (message: MatchServerMessage) => void): void {
  const r = runtime(match);
  const bombs = Array.from(r.bombs?.values() ?? [])
    .filter((bomb) => bomb.explodeAtTick <= match.tick)
    .sort((a, b) => a.explodeAtTick - b.explodeAtTick || a.id.localeCompare(b.id));

  for (const bomb of bombs) {
    r.bombs?.delete(bomb.id);

    const blast = computeBlastCells(match, bomb);
    const tilesDestroyed: Array<{ x: number; y: number }> = [];
    for (const cell of blast) {
      const idx = cell.y * match.world.gridW + cell.x;
      if ((match.world.tiles[idx] ?? 1) === 2) {
        match.world.tiles[idx] = 0;
        tilesDestroyed.push({ x: cell.x, y: cell.y });
      }
    }

    const blasted = new Set(blast.map((cell) => `${cell.x},${cell.y}`));
    for (const p of match.players.values()) {
      const player = p as PlayerRuntime;
      ensurePlayerRuntime(player);
      if (player.eliminated) continue;
      if (!blasted.has(`${player.x},${player.y}`)) continue;

      player.lives = Math.max(0, (player.lives ?? 0) - 1);
      if ((player.lives ?? 0) === 0) {
        player.eliminated = true;
      }

      logMatchEvent('mp_damage_applied', {
        roomCode: match.roomId,
        matchId: match.matchId,
        tick: match.tick,
        targetTgUserId: player.tgUserId,
        lives: player.lives,
        eliminated: player.eliminated,
      });
    }

    const eventId = nextEventId(match);
    emit(match, {
      type: 'match:bomb_exploded',
      roomCode: match.roomId,
      matchId: match.matchId,
      eventId,
      serverTick: match.tick,
      tick: match.tick,
      bombId: bomb.id,
      x: bomb.x,
      y: bomb.y,
      tilesDestroyed,
    }, broadcastMessage);

    logMatchEvent('mp_bomb_exploded', {
      roomCode: match.roomId,
      matchId: match.matchId,
      tick: match.tick,
      eventId,
      bombId: bomb.id,
      x: bomb.x,
      y: bomb.y,
      tilesDestroyed: tilesDestroyed.length,
    });
  }
}

function computeBlastCells(match: MatchState, bomb: BombModel): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = [{ x: bomb.x, y: bomb.y }];
  const directions = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
  ];

  for (const dir of directions) {
    for (let i = 1; i <= bomb.range; i += 1) {
      const x = bomb.x + dir.x * i;
      const y = bomb.y + dir.y * i;
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
  tgUserId: string,
  seq: number,
  payload: MatchInputPayload,
  broadcastMessage?: (message: MatchServerMessage) => void,
) {
  const p = match.players.get(tgUserId) as PlayerRuntime | undefined;
  if (!p) return;
  ensurePlayerRuntime(p);

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
    const r = runtime(match);
    const activeForPlayer = Array.from(r.bombs?.values() ?? []).filter((bomb) => bomb.ownerId === tgUserId).length;
    const bombOnCell = Array.from(r.bombs?.values() ?? []).some((bomb) => bomb.x === p.x && bomb.y === p.y);
    if (activeForPlayer >= MAX_ACTIVE_BOMBS_PER_PLAYER || bombOnCell) {
      p.lastInputSeq = seq;
      return;
    }

    const eventId = nextEventId(match);
    const bombId = `bomb_${match.matchId}_${eventId}`;
    const bomb: BombModel = {
      id: bombId,
      x: p.x,
      y: p.y,
      ownerId: tgUserId,
      tickPlaced: match.tick,
      explodeAtTick: match.tick + BOMB_FUSE_TICKS,
      range: BOMB_RANGE,
    };

    r.bombs?.set(bomb.id, bomb);
    p.lastInputSeq = seq;

    emit(match, {
      type: 'match:bomb_placed',
      roomCode: match.roomId,
      matchId: match.matchId,
      eventId,
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
    }, broadcastMessage);

    logMatchEvent('mp_bomb_placed', {
      roomCode: match.roomId,
      matchId: match.matchId,
      tick: match.tick,
      eventId,
      bombId: bomb.id,
      ownerTgUserId: tgUserId,
      x: bomb.x,
      y: bomb.y,
    });
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
