import { WebSocket } from 'ws';
import type { RawData, Server as WebSocketServer } from 'ws';

import type { MatchClientMessage, MatchServerMessage } from '../mp/protocol';
import { startMatch } from '../mp/match';
import { createMatch, endMatch, getMatch, getMatchByRoom } from '../mp/matchManager';

// ✅ add DB cleanup
import { closeRoomTx, getRoomByCode, leaveRoomV2 } from '../db/repos';

type ClientCtx = {
  socket: WebSocket;
  tgUserId: string;
  roomId: string | null; // (roomCode)
  matchId: string | null;
  lastSeenMs: number; // ✅ for idle timeout
};

type RoomState = {
  roomId: string;
  players: Map<string, WebSocket>;
  matchId: string | null;
};

type RoomJoinMessage = {
  type: 'room:join';
  roomId: string;
  tgUserId?: string;
};

type PingMessage = { type: 'ping'; id: number; t: number };

type ClientMessage = MatchClientMessage | RoomJoinMessage | PingMessage;

type ServerMessage =
  | MatchServerMessage
  | { type: 'connected' }
  | { type: 'pong'; id: number; t: number; serverNow: number };

const rooms = new Map<string, RoomState>();
const clients = new Set<ClientCtx>();

setInterval(() => {
  const now = Date.now();
  for (const c of clients) {
    if (now - c.lastSeenMs > 60_000) {
      try {
        c.socket.terminate();
      } catch {}
    }
  }
}, 10_000);

function send(socket: WebSocket, msg: ServerMessage) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(msg));
}

function getRoom(roomId: string): RoomState | null {
  return rooms.get(roomId) ?? null;
}

function getOrCreateRoom(roomId: string): RoomState {
  const existing = rooms.get(roomId);
  if (existing) {
    return existing;
  }

  const room: RoomState = {
    roomId,
    players: new Map<string, WebSocket>(),
    matchId: null,
  };
  rooms.set(roomId, room);
  return room;
}

function broadcastToRoom(roomId: string, msg: MatchServerMessage) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  for (const socket of room.players.values()) {
    send(socket, msg);
  }
}

function attachClientToRoom(ctx: ClientCtx, roomId: string) {
  if (ctx.roomId) {
    const prevRoomCode = ctx.roomId;
    const tgUserId = ctx.tgUserId;

    detachClientFromRoom(ctx);

    if (prevRoomCode) {
      void detachClientFromRoomDb(prevRoomCode, tgUserId);
    }
  }

  const room = getOrCreateRoom(roomId);

  for (const [tgUserId, socket] of room.players.entries()) {
    if (socket === ctx.socket && tgUserId !== ctx.tgUserId) {
      room.players.delete(tgUserId);
      break;
    }
  }

  room.players.set(ctx.tgUserId, ctx.socket);

  const roomMatch = getMatchByRoom(roomId);
  room.matchId = roomMatch?.matchId ?? null;

  ctx.roomId = roomId;
  ctx.matchId = room.matchId;
}

async function detachClientFromRoomDb(roomCode: string, tgUserId: string) {
  try {
    const room = await getRoomByCode(roomCode);
    if (!room) return;

    // If owner leaves -> close room & kick everyone (DB + clients will get match loop stopped)
    if (String(room.ownerTgUserId) === String(tgUserId)) {
      await closeRoomTx(String(tgUserId), roomCode);
      return;
    }

    // Normal member leaves; deletes room if remaining==0
    await leaveRoomV2({ tgUserId: String(tgUserId), roomCode });
  } catch {
    // swallow: release-safe (avoid crashing ws handler)
  }
}

function detachClientFromRoom(ctx: ClientCtx) {
  if (!ctx.roomId) {
    return;
  }

  const room = rooms.get(ctx.roomId);
  if (room) {
    room.players.delete(ctx.tgUserId);

    if (room.players.size === 0) {
      if (room.matchId) {
        endMatch(room.matchId);
      }
      rooms.delete(room.roomId);
    }
  }

  ctx.roomId = null;
  ctx.matchId = null;
}

function parseMessage(raw: RawData): ClientMessage | null {
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed as ClientMessage;
  } catch {
    return null;
  }
}

function handleMessage(ctx: ClientCtx, msg: ClientMessage) {
  switch (msg.type) {
    case 'ping': {
      const id = Number((msg as any).id);
      const t = Number((msg as any).t);

      if (!Number.isFinite(id) || !Number.isFinite(t)) {
        return;
      }

      return send(ctx.socket, { type: 'pong', id, t, serverNow: Date.now() });
    }

    case 'room:join': {
      if (!msg.roomId || typeof msg.roomId !== 'string') {
        return send(ctx.socket, { type: 'match:error', error: 'invalid_room_id' });
      }

      if (msg.tgUserId && typeof msg.tgUserId === 'string') {
        ctx.tgUserId = msg.tgUserId;
      }

      attachClientToRoom(ctx, msg.roomId);
      return;
    }

    case 'match:start': {
      if (!ctx.roomId) {
        return send(ctx.socket, { type: 'match:error', error: 'not_in_room' });
      }

      const room = getRoom(ctx.roomId);
      if (!room) {
        return send(ctx.socket, { type: 'match:error', error: 'room_not_found' });
      }

      const players = Array.from(room.players.keys());
      if (players.length < 2) {
        return send(ctx.socket, { type: 'match:error', error: 'not_enough_ws_players' });
      }

      const match = createMatch(room.roomId, players);
      room.matchId = match.matchId;

      for (const client of clients) {
        if (client.roomId === room.roomId) {
          client.matchId = match.matchId;
          send(client.socket, {
            type: 'match:started',
            matchId: match.matchId,
          });
        }
      }

      startMatch(match, (snapshot) => {
        broadcastToRoom(room.roomId, {
          type: 'match:snapshot',
          snapshot,
        });
      });

      return;
    }

    case 'match:input': {
      const matchId = ctx.matchId;
      if (!matchId) return;

      const match = getMatch(matchId);
      if (!match) return;

      const seq = Number((msg as any).seq);
      if (!Number.isSafeInteger(seq) || seq <= 0) return;

      const payload = (msg as any).payload;
      if (!payload || typeof payload !== 'object') return;

      // Minimal validation for v1
      if (payload.kind === 'move') {
        const dir = payload.dir;
        if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') return;

        match.inputQueue.push({
          tgUserId: ctx.tgUserId,
          seq,
          payload,
        });
      }

      return;
    }

    default:
      return;
  }
}

export function registerWsHandlers(wss: WebSocketServer) {
  wss.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const roomId = url.searchParams.get('roomId');
    const tgUserId = url.searchParams.get('tgUserId') ?? `guest_${Math.random().toString(36).slice(2, 10)}`;

    const ctx: ClientCtx = {
      socket,
      tgUserId,
      roomId: null,
      matchId: null,
      lastSeenMs: Date.now(),
    };
    clients.add(ctx);

    if (roomId) {
      attachClientToRoom(ctx, roomId);
    }

    send(socket, { type: 'connected' });

    socket.on('message', (raw) => {
      const msg = parseMessage(raw);
      if (!msg) {
        send(socket, { type: 'match:error', error: 'invalid_message' });
        return;
      }
      ctx.lastSeenMs = Date.now();
      handleMessage(ctx, msg);
    });

    socket.on('close', () => {
      const roomCode = ctx.roomId;
      const tgUserId = ctx.tgUserId;

      detachClientFromRoom(ctx);
      clients.delete(ctx);

      if (roomCode) {
        void detachClientFromRoomDb(roomCode, tgUserId);
      }
    });
  });
}
