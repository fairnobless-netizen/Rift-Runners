export type ProtocolVersion = 'match_v1';

export type MoveDir = 'up' | 'down' | 'left' | 'right';

export type MatchInputPayload =
  | { kind: 'move'; dir: MoveDir }
  | { kind: 'place_bomb' };

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
    bombs?: Array<{ id: string; x: number; y: number; ownerId: string; explodeTick: number }>;
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

export type MatchBombPlacedEvent = {
  type: 'match:bomb_placed';
  eventId: string;
  roomCode: string;
  matchId: string;
  tick: number;
  bomb: { id: string; x: number; y: number; ownerId: string; explodeTick: number };
};

export type MatchBombExplodedEvent = {
  type: 'match:bomb_exploded';
  eventId: string;
  roomCode: string;
  matchId: string;
  tick: number;
  bombId: string;
  destroyed: Array<{ x: number; y: number }>;
  affected: Array<{ x: number; y: number }>;
};

export type MatchSnapshotV1 = MatchSnapshot;

export type MatchServerMessage =
  | { type: 'match:started'; roomCode: string; matchId: string }
  | MatchWorldInit
  | { type: 'match:snapshot'; snapshot: MatchSnapshot }
  | MatchBombPlacedEvent
  | MatchBombExplodedEvent
  | { type: 'match:error'; error: string };
