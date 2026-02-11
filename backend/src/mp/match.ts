import { MatchSnapshot } from './protocol';
import { MatchState } from './types';

const TICK_RATE_MS = 50; // 20 Hz

export function startMatch(match: MatchState, broadcast: (snapshot: MatchSnapshot) => void) {
  match.interval = setInterval(() => {
    tick(match, broadcast);
  }, TICK_RATE_MS);
}

export function stopMatch(match: MatchState) {
  if (match.interval) {
    clearInterval(match.interval);
    match.interval = undefined;
  }
}

function tick(match: MatchState, broadcast: (snapshot: MatchSnapshot) => void) {
  match.tick++;

  // Apply inputs (NO-OP, just update lastInputSeq)
  while (match.inputQueue.length > 0) {
    const input = match.inputQueue.shift()!;
    const player = match.players.get(input.tgUserId);
    if (player) {
      player.lastInputSeq = Math.max(player.lastInputSeq, input.seq);
    }
  }

  const snapshot: MatchSnapshot = {
    version: 'match_v1',
    matchId: match.matchId,
    tick: match.tick,
    serverTime: Date.now(),
    players: Array.from(match.players.values()).map((p) => ({
      tgUserId: p.tgUserId,
      lastInputSeq: p.lastInputSeq,
    })),
  };

  broadcast(snapshot);
}
