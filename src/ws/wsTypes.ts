export type WsClientMessage =
  | { type: 'ping' }
  | { type: 'lobby:list' }
  | { type: 'room:create' }
  | { type: 'room:join'; roomId: string }
  | { type: 'room:leave' }
  | { type: 'match:start' }
  | { type: 'match:input'; seq: number; payload: { kind: 'move'; dir: 'up' | 'down' | 'left' | 'right' } };

export type WsServerMessage =
  | { type: 'pong' }
  | { type: 'lobby:list'; rooms: Array<{ roomId: string; players: number }> }
  | { type: 'room:joined'; room: unknown }
  | { type: 'room:left' }
  | { type: 'match:started'; matchId: string }
  | { type: 'match:snapshot'; snapshot: unknown }
  | { type: 'error'; error: string };
