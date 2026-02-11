import type { MatchInputPayload } from './protocol';

export type PlayerState = {
  tgUserId: string;
  displayName: string;
  colorId: number; // 0..3
  skinId: string;  // 'default' for now
  lastInputSeq: number;
  x: number;
  y: number;
};

export type MatchState = {
  matchId: string;
  roomId: string;
  tick: number;

  world: {
    gridW: number;
    gridH: number;
  };

  players: Map<string, PlayerState>;

  inputQueue: Array<{
    tgUserId: string;
    seq: number;
    payload: MatchInputPayload;
  }>;

  interval?: NodeJS.Timeout;
};
