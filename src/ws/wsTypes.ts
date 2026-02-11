export type WsClientMessage =
  | { type: 'ping'; id: number; t: number } // t = Date.now() on client (debug)
  | { type: 'lobby:list' }
  | { type: 'room:create' }
  | { type: 'room:join'; roomId: string }
  | { type: 'room:leave' }
  | { type: 'match:start' }
  | { type: 'match:input'; seq: number; payload: { kind: 'move'; dir: 'up' | 'down' | 'left' | 'right' } };

export type WsServerMessage =
  | { type: 'pong'; id: number; t: number; serverNow: number } // echo id/t + server time
  | { type: 'lobby:list'; rooms: Array<{ roomId: string; players: number }> }
  | { type: 'room:joined'; room: unknown }
  | { type: 'room:left' }
  | { type: 'match:started'; matchId: string }
  | { type: 'match:snapshot'; snapshot: MatchSnapshotV1 }
  | { type: 'error'; error: string };

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
