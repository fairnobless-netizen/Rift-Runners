import type { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { resolveWsUser } from './wsAuth';
import type { WsClientMessage, WsServerMessage } from './protocol';
import { listRooms, createRoom, joinRoom, leaveRoom, snapshotRoom } from './rooms';
import type { ClientCtx } from './types';

export function attachWsServer(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (socket: WebSocket, req: IncomingMessage) => {
    const auth = await resolveWsUser(req);
    if (!auth) {
      socket.close(1008, 'unauthorized');
      return;
    }

    const ctx: ClientCtx = {
      socket,
      tgUserId: auth.tgUserId,
    };

    socket.on('message', (raw) => {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(String(raw)) as WsClientMessage;
      } catch {
        send(socket, { type: 'error', error: 'invalid_json' });
        return;
      }

      handleMessage(ctx, msg);
    });

    socket.on('close', () => {
      if (ctx.roomId) {
        leaveRoom(ctx.roomId, ctx.tgUserId);
      }
    });
  });

  return wss;
}

function send(ws: WebSocket, msg: WsServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function handleMessage(ctx: ClientCtx, msg: WsClientMessage): void {
  switch (msg.type) {
    case 'ping':
      send(ctx.socket, { type: 'pong' });
      return;

    case 'lobby:list':
      send(ctx.socket, { type: 'lobby:list', rooms: listRooms() });
      return;

    case 'room:create': {
      if (ctx.roomId) {
        leaveRoom(ctx.roomId, ctx.tgUserId);
      }

      const room = createRoom(ctx.tgUserId);
      ctx.roomId = room.roomId;

      send(ctx.socket, {
        type: 'room:joined',
        room: snapshotRoom(room),
      });
      return;
    }

    case 'room:join': {
      if (ctx.roomId) {
        leaveRoom(ctx.roomId, ctx.tgUserId);
      }

      const room = joinRoom(msg.roomId, ctx.tgUserId);
      if (!room) {
        send(ctx.socket, { type: 'error', error: 'room_not_found' });
        return;
      }

      ctx.roomId = room.roomId;
      send(ctx.socket, {
        type: 'room:joined',
        room: snapshotRoom(room),
      });
      return;
    }

    case 'room:leave':
      if (ctx.roomId) {
        leaveRoom(ctx.roomId, ctx.tgUserId);
        ctx.roomId = undefined;
      }
      send(ctx.socket, { type: 'room:left' });
      return;

    default:
      send(ctx.socket, { type: 'error', error: 'unknown_message' });
  }
}
