import type { WebSocket } from 'ws';

export type ClientCtx = {
  socket: WebSocket;
  tgUserId: string;
  roomId?: string;
};
