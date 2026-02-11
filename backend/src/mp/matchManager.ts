import crypto from 'crypto';

import { stopMatch } from './match';
import { MatchState, PlayerState } from './types';

const matches = new Map<string, MatchState>();
const roomToMatch = new Map<string, string>();

function newMatchId(): string {
  return `match_${crypto.randomBytes(6).toString('hex')}`;
}

export function createMatch(roomId: string, players: string[]): MatchState {
  const existingId = roomToMatch.get(roomId);
  if (existingId) {
    endMatch(existingId);
  }

  const matchId = newMatchId();

  const gridW = 15;
  const gridH = 15;

  const state: MatchState = {
    matchId,
    roomId,
    tick: 0,
    world: { gridW, gridH },
    players: new Map<string, PlayerState>(),
    inputQueue: [],
  };

  // Deterministic spawns by join order: spread along top row
  players.forEach((tgUserId, idx) => {
    const x = Math.min(gridW - 1, 1 + idx * 2);
    const y = 1;

    state.players.set(tgUserId, {
      tgUserId,
      lastInputSeq: 0,
      x,
      y,
    });
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
