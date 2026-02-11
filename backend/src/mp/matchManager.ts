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

  const state: MatchState = {
    matchId,
    roomId,
    tick: 0,
    players: new Map<string, PlayerState>(),
    inputQueue: [],
  };

  for (const tgUserId of players) {
    state.players.set(tgUserId, {
      tgUserId,
      lastInputSeq: 0,
    });
  }

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
