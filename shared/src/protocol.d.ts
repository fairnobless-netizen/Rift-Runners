export type ProtocolVersion = 'match_v1';

export type MoveDir = 'up' | 'down' | 'left' | 'right';

export type MatchInputPayload =
  | { kind: 'move'; dir: MoveDir };

export type MatchClientMessage =
  | { type: 'match:start' }
  | { type: 'match:input'; seq: number; payload: MatchInputPayload };

export type MatchWorldState = {
  gridW: number;
  gridH: number;
  tiles: number[];
  worldHash: string;
};

export type MatchWorldInit = {
  type: 'match:world_init';
  roomCode: string;
  matchId: string;
  world: MatchWorldState;
};

export type BombSnapshot = {
  id: string;
  x: number;
  y: number;
  ownerId?: string;
  tickPlaced?: number;
  explodeAtTick?: number;
};

export type MatchBombPlaced = {
  type: 'match:bomb_placed';
  roomCode: string;
  matchId: string;
  tick: number;
  serverTick: number;
  eventId: string;
  bomb: BombSnapshot;
};

export type MatchBombExploded = {
  type: 'match:bomb_exploded';
  roomCode: string;
  matchId: string;
  tick: number;
  serverTick: number;
  eventId: string;
  bombId: string;
  x: number;
  y: number;
  tilesDestroyed?: Array<{ x: number; y: number }>;
};

export type MatchBombPlacedEvent = MatchBombPlaced;
export type MatchBombExplodedEvent = MatchBombExploded;

export type MatchSnapshot = {
  version: ProtocolVersion;
  roomCode: string;
  matchId: string;
  tick: number;
  serverTime: number;
  world: {
    gridW: number;
    gridH: number;
    worldHash?: string;
    bombs?: BombSnapshot[];
  };
  players: Array<{
    tgUserId: string;
    displayName: string;
    colorId: number;
    skinId: string;
    lastInputSeq: number;
    x: number;
    y: number;
  }>;
};

export type MatchSnapshotV1 = MatchSnapshot;

export type MatchServerMessage =
  | { type: 'match:started'; roomCode: string; matchId: string }
  | MatchWorldInit
  | MatchBombPlaced
  | MatchBombExploded
  | { type: 'match:snapshot'; snapshot: MatchSnapshot }
  | { type: 'match:error'; error: string };
