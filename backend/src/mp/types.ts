import type { MatchInputPayload } from './protocol';

export type PlayerState = {
  tgUserId: string;
  displayName: string;
  colorId: number; // 0..3
  skinId: string;  // 'default' for now
  lastInputSeq: number;
  x: number;
  y: number;
  state: 'alive' | 'dead_respawning' | 'eliminated';
  respawnAtTick: number | null;
  invulnUntilTick: number;
  spawnX: number;
  spawnY: number;
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
  playerLives: Map<string, number>;
  eliminatedPlayers: Set<string>;

  bombs: Map<string, {
    id: string;
    ownerId: string;
    x: number;
    y: number;
    tickPlaced: number;
    explodeAtTick: number;
    range: number;
  }>;
  maxBombsPerPlayer: number;
  bombFuseTicks: number;
  bombRange: number;

  eventSeq: number;
  seenEventIds: string[];

  inputQueue: Array<{
    tgUserId: string;
    seq: number;
    payload: MatchInputPayload;
  }>;

  interval?: NodeJS.Timeout;
  ended: boolean;
};
