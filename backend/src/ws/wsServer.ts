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

type RoomLeaveMessage = { type: 'room:leave' };

type ClientMessage = MatchClientMessage | RoomJoinMessage | RoomLeaveMessage | PingMessage;

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

function logWsEvent(evt: string, payload: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      evt,
      ...payload,
      ts: Date.now(),
    }),
  );
}

function isSocketAttachedToRoom(ctx: ClientCtx, room: RoomState): boolean {
  return room.players.get(ctx.tgUserId) === ctx.socket;
}

function broadcastToRoomMatch(roomId: string, matchId: string, msg: MatchServerMessage) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  if (room.matchId !== matchId) {
    logWsEvent('ws_drop_outbound', {
      reason: 'room_match_mismatch',
      roomId,
      roomMatchId: room.matchId,
      targetMatchId: matchId,
      msgType: msg.type,
    });
    return;
  }

  for (const client of clients) {
    if (client.roomId !== roomId || client.matchId !== matchId) {
      continue;
    }

    if (!isSocketAttachedToRoom(client, room)) {
      continue;
    }

    send(client.socket, msg);
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

  logWsEvent('ws_room_join', {
    tgUserId: ctx.tgUserId,
    roomId,
  });
}

function sendRejoinSyncIfActiveMatch(ctx: ClientCtx, roomId: string) {
  const room = getRoom(roomId);
  if (!room) {
    logWsEvent('ws_rejoin_sync_skipped_no_match', {
      tgUserId: ctx.tgUserId,
      roomId,
      reason: 'room_missing',
    });
    return;
  }

  const roomMatchId = room.matchId;
  const activeMatch = getMatchByRoom(roomId);

  if (!roomMatchId || !activeMatch) {
    logWsEvent('ws_rejoin_sync_skipped_no_match', {
      tgUserId: ctx.tgUserId,
      roomId,
      roomMatchId,
      activeMatchId: activeMatch?.matchId ?? null,
    });
    return;
  }

  if (activeMatch.matchId !== roomMatchId) {
    logWsEvent('ws_rejoin_sync_skipped_no_match', {
      tgUserId: ctx.tgUserId,
      roomId,
      reason: 'room_match_mismatch',
      roomMatchId,
      activeMatchId: activeMatch.matchId,
    });

    room.matchId = activeMatch.matchId;
    ctx.matchId = activeMatch.matchId;
    return;
  }

  send(ctx.socket, {
    type: 'match:started',
    roomCode: roomId,
    matchId: activeMatch.matchId,
  });

  send(ctx.socket, {
    type: 'match:world_init',
    roomCode: roomId,
    matchId: activeMatch.matchId,
    world: {
      gridW: activeMatch.world.gridW,
      gridH: activeMatch.world.gridH,
      tiles: [...activeMatch.world.tiles],
      worldHash: activeMatch.world.worldHash,
    },
  });

  logWsEvent('ws_rejoin_sync_sent', {
    tgUserId: ctx.tgUserId,
    roomId,
    matchId: activeMatch.matchId,
  });
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

  const roomId = ctx.roomId;
  const room = rooms.get(roomId);
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

  logWsEvent('ws_room_leave', {
    tgUserId: ctx.tgUserId,
    roomId,
  });
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

function logInboundDrop(ctx: ClientCtx, msg: ClientMessage, reason: string, room?: RoomState | null) {
  logWsEvent('ws_drop_inbound', {
    reason,
    tgUserId: ctx.tgUserId,
    roomId: ctx.roomId,
    ctxMatchId: ctx.matchId,
    roomMatchId: room?.matchId ?? null,
    msgType: msg.type,
  });
}

async function handleMessage(ctx: ClientCtx, msg: ClientMessage) {
  try {
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
      sendRejoinSyncIfActiveMatch(ctx, msg.roomId);
      return;
    }


    case 'room:leave': {
      detachClientFromRoom(ctx);
      return;
    }

    case 'match:start': {
      if (!ctx.roomId) {
        return send(ctx.socket, { type: 'match:error', error: 'not_in_room' });
      }

      logWsEvent('ws_match_start_requested', {
        tgUserId: ctx.tgUserId,
        roomId: ctx.roomId,
      });

      const dbRoom = await getRoomByCode(ctx.roomId);
      if (!dbRoom) {
        return send(ctx.socket, { type: 'match:error', error: 'room_not_found' });
      }

      if (String(dbRoom.ownerTgUserId) !== String(ctx.tgUserId)) {
        return send(ctx.socket, { type: 'match:error', error: 'not_room_owner' });
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
        if (client.roomId === room.roomId && isSocketAttachedToRoom(client, room)) {
          client.matchId = match.matchId;
        }
      }

      logWsEvent('ws_match_started', {
        roomId: room.roomId,
        matchId: match.matchId,
        playersCount: players.length,
      });

      const startedMessage = {
        type: 'match:started',
        roomCode: room.roomId,
        matchId: match.matchId,
      } as MatchServerMessage;
      broadcastToRoomMatch(room.roomId, match.matchId, startedMessage);

      broadcastToRoomMatch(room.roomId, match.matchId, {
        type: 'match:world_init',
        roomCode: room.roomId,
        matchId: match.matchId,
        world: {
          gridW: match.world.gridW,
          gridH: match.world.gridH,
          tiles: [...match.world.tiles],
          worldHash: match.world.worldHash,
        },
      });

      startMatch(match, (snapshot, events) => {
        const activeRoom = rooms.get(room.roomId);
        if (!activeRoom) {
          endMatch(match.matchId);
          return;
        }

        if (activeRoom.matchId !== snapshot.matchId) {
          return;
        }

        if (snapshot.roomCode !== activeRoom.roomId) {
          return;
        }

        broadcastToRoomMatch(activeRoom.roomId, snapshot.matchId, {
          type: 'match:snapshot',
          snapshot,
        });

        for (const evt of events.bombPlaced) {
          broadcastToRoomMatch(activeRoom.roomId, snapshot.matchId, evt);
        }

        for (const evt of events.bombExploded) {
          broadcastToRoomMatch(activeRoom.roomId, snapshot.matchId, evt);
        }
      });

      return;
    }

    case 'match:input': {
      if (!ctx.roomId) {
        logInboundDrop(ctx, msg, 'no_room');
        return;
      }

      if (!ctx.matchId) {
        logInboundDrop(ctx, msg, 'no_match');
        return;
      }

      const room = rooms.get(ctx.roomId);
      if (!room) {
        logInboundDrop(ctx, msg, 'room_missing');
        return;
      }

      if (!isSocketAttachedToRoom(ctx, room)) {
        logInboundDrop(ctx, msg, 'socket_not_attached', room);
        return;
      }

      if (room.matchId !== ctx.matchId) {
        logInboundDrop(ctx, msg, 'match_mismatch', room);
        return;
      }

      const matchId = ctx.matchId;

      const match = getMatch(matchId);
      if (!match) {
        logInboundDrop(ctx, msg, 'match_not_found', room);
        return;
      }

      if (match.roomId !== ctx.roomId) {
        logInboundDrop(ctx, msg, 'match_room_mismatch', room);
        return;
      }

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

      if (payload.kind === 'place_bomb') {
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
  } catch {
    // release-safe: avoid crashing ws handler on malformed/unexpected message paths
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
      void handleMessage(ctx, msg);
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
