export type ProtocolVersion = 'match_v1';

export type MoveDir = 'up' | 'down' | 'left' | 'right';

export type MatchInputPayload =
  | { kind: 'move'; dir: MoveDir }
  | { kind: 'bomb_place'; x: number; y: number };

export type MatchClientMessage =
  | { type: 'match:start' }
  | { type: 'match:input'; seq: number; payload: MatchInputPayload }
  | { type: 'match:bomb_place'; payload: { x: number; y: number } }
  | { type: 'room:restart_propose' }
  | { type: 'room:restart_vote'; vote: 'yes' | 'no' };

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

export type MatchBombSpawned = {
  type: 'match:bomb_spawned';
  roomCode: string;
  matchId: string;
  eventId: string;
  serverTick: number;
  tick: number;
  bomb: BombSnapshot;
};

export type MatchBombExploded = {
  type: 'match:bomb_exploded';
  roomCode: string;
  matchId: string;
  eventId: string;
  serverTick: number;
  tick: number;
  bombId: string;
  x: number;
  y: number;
  impacts: Array<{ x: number; y: number }>;
};

export type MatchTilesDestroyed = {
  type: 'match:tiles_destroyed';
  roomCode: string;
  matchId: string;
  eventId: string;
  serverTick: number;
  tick: number;
  tiles: Array<{ x: number; y: number }>;
};

export type MatchPlayerDamaged = {
  type: 'match:player_damaged';
  roomCode: string;
  matchId: string;
  eventId: string;
  serverTick: number;
  tick: number;
  tgUserId: string;
  lives: number;
};

export type MatchPlayerEliminated = {
  type: 'match:player_eliminated';
  roomCode: string;
  matchId: string;
  eventId: string;
  serverTick: number;
  tick: number;
  tgUserId: string;
};

export type MatchPlayerRespawned = {
  type: 'match:player_respawned';
  roomCode: string;
  matchId: string;
  eventId: string;
  serverTick: number;
  tick: number;
  tgUserId: string;
  x: number;
  y: number;
  invulnUntilTick: number;
};

export type MatchEnd = {
  type: 'match:end';
  roomCode: string;
  matchId: string;
  serverTick: number;
  tick: number;
  winnerTgUserId: string | null;
  reason: 'elimination' | 'draw';
};

export type RoomRestartProposed = {
  type: 'room:restart_proposed';
  roomCode: string;
  byTgUserId: string;
  expiresAt: number;
};

export type RoomRestartVoteState = {
  type: 'room:restart_vote_state';
  roomCode: string;
  yesCount: number;
  total: number;
};

export type RoomRestartAccepted = {
  type: 'room:restart_accepted';
  roomCode: string;
};

export type RoomRestartCancelled = {
  type: 'room:restart_cancelled';
  roomCode: string;
  reason: 'no_vote' | 'timeout';
};

export type MatchBombPlacedEvent = MatchBombSpawned;
export type MatchBombExplodedEvent = MatchBombExploded;

export type MatchSnapshot = {
  version: ProtocolVersion;
  roomCode: string;
  matchId: string;
  tick: number;
  serverTime: number;
  serverTimeMs: number;
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
    lives?: number;
    eliminated?: boolean;
  }>;
};

export type MatchSnapshotV1 = MatchSnapshot;

export type MatchServerMessage =
  | { type: 'match:started'; roomCode: string; matchId: string }
  | MatchWorldInit
  | MatchBombSpawned
  | MatchBombExploded
  | MatchTilesDestroyed
  | MatchPlayerDamaged
  | MatchPlayerRespawned
  | MatchPlayerEliminated
  | MatchEnd
  | RoomRestartProposed
  | RoomRestartVoteState
  | RoomRestartAccepted
  | RoomRestartCancelled
  | { type: 'match:snapshot'; snapshot: MatchSnapshot }
  | { type: 'match:error'; error: string };
