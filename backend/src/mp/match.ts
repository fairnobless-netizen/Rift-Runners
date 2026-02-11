import type { MatchState } from './types';
import type { MatchSnapshot, MatchInputPayload } from './protocol';

const TICK_RATE_MS = 50; // 20 Hz

export function startMatch(match: MatchState, broadcast: (snapshot: MatchSnapshot) => void) {
  match.interval = setInterval(() => tick(match, broadcast), TICK_RATE_MS);
}

export function stopMatch(match: MatchState) {
  if (match.interval) {
    clearInterval(match.interval);
    match.interval = undefined;
  }
}

function tick(match: MatchState, broadcast: (snapshot: MatchSnapshot) => void) {
  match.tick++;

  // Apply queued inputs deterministically: FIFO
  while (match.inputQueue.length > 0) {
    const input = match.inputQueue.shift()!;
    const player = match.players.get(input.tgUserId);
    if (!player) continue;

    // Ignore old/out-of-order seq
    if (input.seq <= player.lastInputSeq) continue;

    applyInput(match, player.tgUserId, input.seq, input.payload);
  }

  const snapshot: MatchSnapshot = {
    version: 'match_v1',
    matchId: match.matchId,
    tick: match.tick,
    serverTime: Date.now(),
    world: { ...match.world },
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

  broadcast(snapshot);
}

function applyInput(match: MatchState, tgUserId: string, seq: number, payload: MatchInputPayload) {
  const p = match.players.get(tgUserId);
  if (!p) return;

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

    p.x = nx;
    p.y = ny;
    p.lastInputSeq = seq;
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
