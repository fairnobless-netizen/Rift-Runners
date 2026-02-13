export type MoveDir = 'up' | 'down' | 'left' | 'right';

export type MatchInputPayload =
  | { kind: 'move'; dir: MoveDir };

export type MatchClientMessage =
  | { type: 'match:start' }
  | { type: 'match:input'; seq: number; payload: MatchInputPayload };

export type MatchSnapshotV1 = {
  version: 'match_v1';
  matchId: string;
  tick: number;
  serverTime: number;
  world: { gridW: number; gridH: number };
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

export type MatchServerMessage =
  | { type: 'match:started'; matchId: string }
  | { type: 'match:snapshot'; snapshot: MatchSnapshotV1 }
  | { type: 'match:error'; error: string };

export type WsClientMessage =
  | { type: 'ping'; id: number; t: number }
  | { type: 'lobby:list' }
  | { type: 'room:create' }
  | { type: 'room:join'; roomId: string }
  | { type: 'room:leave' }
  | MatchClientMessage;

export type WsServerMessage =
  | { type: 'pong'; id: number; t: number; serverNow: number }
  | { type: 'lobby:list'; rooms: Array<{ roomId: string; players: number }> }
  | { type: 'room:joined'; room: unknown }
  | { type: 'room:left' }
  | MatchServerMessage
  | { type: 'error'; error: string };
