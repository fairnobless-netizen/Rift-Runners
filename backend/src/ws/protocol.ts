export type WsClientMessage =
  | { type: 'ping' }
  | { type: 'lobby:list' }
  | { type: 'room:create' }
  | { type: 'room:join'; roomId: string }
  | { type: 'room:leave' };

export type WsServerMessage =
  | { type: 'pong' }
  | { type: 'lobby:list'; rooms: RoomSummary[] }
  | { type: 'room:joined'; room: RoomSnapshot }
  | { type: 'room:left' }
  | { type: 'room:update'; snapshot: RoomSnapshot }
  | { type: 'error'; error: string };

export type RoomSummary = {
  roomId: string;
  players: number;
};

export type RoomSnapshot = {
  version: 'room_v1';
  roomId: string;
  players: Array<{
    tgUserId: string;
    joinedAt: number;
  }>;
};
