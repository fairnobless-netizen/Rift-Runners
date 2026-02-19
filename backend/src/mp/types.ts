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

export type BombState = {
  id: string;
  x: number;
  y: number;
  ownerId: string;
  placedTick: number;
  explodeTick: number;
};

export type MatchState = {
  matchId: string;
  roomId: string;
  tick: number;

  world: {
    gridW: number;
    gridH: number;
    tiles: number[];
    worldHash: string;
  };

  players: Map<string, PlayerState>;
  bombs: Map<string, BombState>;

  inputQueue: Array<{
    tgUserId: string;
    seq: number;
    payload: MatchInputPayload;
  }>;

  interval?: NodeJS.Timeout;
};
