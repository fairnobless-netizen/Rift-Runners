import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import type { RawData, Server as WebSocketServer } from 'ws';

import type { MatchClientMessage, MatchServerMessage } from '../mp/protocol';
import type { MatchState } from '../mp/types';
import { markPlayerDisconnected, startMatch, tryPlaceBomb } from '../mp/match';
import { createMatch, endMatch, getMatch, getMatchByRoom } from '../mp/matchManager';

// ✅ add DB cleanup
import { closeRoomTx, getRoomByCode, leaveRoomV2, removeRoomCascade, setRoomPhase } from '../db/repos';
import { RoomRegistry } from './roomRegistry';

type ClientCtx = {
  connectionId: string;
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

type RestartVoteState = {
  active: boolean;
  yes: Set<string>;
  no: Set<string>;
  expiresAt: number;
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
const restartVotes = new Map<string, RestartVoteState>();
const roomRegistry = new RoomRegistry();

const STALE_CONNECTION_MS = 60_000;
const INACTIVE_ROOM_MS = 90_000;

async function finalizeAndDeleteRoom(roomId: string) {
  logWsEvent('ws_room_auto_cleanup_start', { roomId });
  const room = rooms.get(roomId);
  const socketsToTerminate = new Set<WebSocket>();

  if (room?.matchId) {
    endMatch(room.matchId);
  }

  if (room) {
    for (const socket of room.players.values()) {
      socketsToTerminate.add(socket);
    }
  }

  for (const client of clients) {
    if (client.roomId !== roomId) {
      continue;
    }

    client.roomId = null;
    client.matchId = null;
    socketsToTerminate.add(client.socket);
  }

  rooms.delete(roomId);
  restartVotes.delete(roomId);
  roomRegistry.removeRoom(roomId);

  try {
    await setRoomPhase(roomId, 'FINISHED');
  } catch {}

  try {
    await removeRoomCascade(roomId);
  } catch {}

  logWsEvent('ws_room_auto_cleanup_done', { roomId, socketsTerminated: socketsToTerminate.size });

  for (const socket of socketsToTerminate) {
    try {
      socket.terminate();
    } catch {}
  }
}

setInterval(() => {
  const now = Date.now();
  const sweep = roomRegistry.sweep({
    nowMs: now,
    staleConnectionMs: STALE_CONNECTION_MS,
    inactiveRoomMs: INACTIVE_ROOM_MS,
  });

  for (const connectionId of sweep.staleConnectionIds) {
    for (const c of clients) {
      if (c.connectionId !== connectionId) continue;
      try {
        c.socket.terminate();
      } catch {}
      break;
    }
  }

  for (const roomId of sweep.removableRoomIds) {
    const room = rooms.get(roomId);
    if (room && room.players.size > 0) {
      continue;
    }

    void finalizeAndDeleteRoom(roomId);
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

function buildSnapshotFromMatch(match: MatchState): Extract<MatchServerMessage, { type: 'match:snapshot' }>['snapshot'] {
  const now = Date.now();
  return {
    version: 'match_v1',
    roomCode: match.roomId,
    matchId: match.matchId,
    tick: match.tick,
    serverTime: now,
    serverTimeMs: now,
    world: {
      gridW: match.world.gridW,
      gridH: match.world.gridH,
      worldHash: match.world.worldHash,
      bombs: Array.from(match.bombs.values()).map((bomb) => ({
        id: bomb.id,
        x: bomb.x,
        y: bomb.y,
        ownerId: bomb.ownerId,
        tickPlaced: bomb.tickPlaced,
        explodeAtTick: bomb.explodeAtTick,
      })),
    },
    players: Array.from(match.players.values()).map((player) => ({
      tgUserId: player.tgUserId,
      displayName: player.displayName,
      colorId: player.colorId,
      skinId: player.skinId,
      lastInputSeq: player.lastInputSeq,
      x: player.x,
      y: player.y,
      isMoving: false,
      moveFromX: player.x,
      moveFromY: player.y,
      moveToX: player.x,
      moveToY: player.y,
      moveStartTick: match.tick,
      moveDurationTicks: 0,
      moveStartServerTimeMs: now,
      moveDurationMs: 0,
      lives: match.playerLives.get(player.tgUserId) ?? 0,
      eliminated: match.eliminatedPlayers.has(player.tgUserId),
      disconnected: match.disconnectedPlayers.has(player.tgUserId),
    })),
    enemies: Array.from(match.enemies.values()).map((enemy) => ({
      id: enemy.id,
      x: enemy.x,
      y: enemy.y,
      alive: enemy.alive,
    })),
  };
}

function sendInitialSnapshot(roomId: string, match: MatchState) {
  if (match.roomId !== roomId) {
    return;
  }

  if (getMatch(match.matchId) !== match) {
    return;
  }

  broadcastToRoomMatch(roomId, match.matchId, {
    type: 'match:snapshot',
    snapshot: buildSnapshotFromMatch(match),
  });
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

  const skippedByReason = new Map<string, number>();
  let clientsConsidered = 0;
  let sentCount = 0;
  let clientMatchIdMismatchCount = 0;

  const clientsBySocket = new Map<WebSocket, ClientCtx>();
  for (const client of clients) {
    clientsBySocket.set(client.socket, client);
  }

  const addSkipReason = (reason: string) => {
    skippedByReason.set(reason, (skippedByReason.get(reason) ?? 0) + 1);
  };

  for (const [tgUserId, socket] of room.players.entries()) {
    clientsConsidered += 1;

    if (socket.readyState !== WebSocket.OPEN) {
      addSkipReason('socket_closed');
      continue;
    }

    const client = clientsBySocket.get(socket);
    if (!client) {
      addSkipReason('missing_client_ctx');
      continue;
    }

    if (client.roomId !== roomId) {
      addSkipReason('client_not_in_room');
      continue;
    }

    if (client.matchId !== matchId) {
      clientMatchIdMismatchCount += 1;
      logWsEvent('ws_snapshot_recipient_mismatch', {
        roomId,
        roomCode: roomId,
        matchId,
        serverTick: msg.type === 'match:snapshot' ? msg.snapshot.tick : null,
        tgUserId,
        clientMatchId: client.matchId,
      });
    }

    if (!isSocketAttachedToRoom(client, room)) {
      addSkipReason('socket_not_attached_to_room_players');
      continue;
    }

    send(socket, msg);
    sentCount += 1;
  }

  if (msg.type === 'match:snapshot') {
    const skippedCount = clientsConsidered - sentCount;
    logWsEvent('ws_snapshot_broadcast', {
      roomId,
      roomCode: roomId,
      matchId,
      serverTick: msg.snapshot.tick,
      playersInRoom: room.players.size,
      clientsConsidered,
      sentCount,
      skippedCount,
      clientMatchIdMismatchCount,
    });

    if (skippedByReason.size > 0) {
      logWsEvent('ws_snapshot_broadcast_skips', {
        roomId,
        roomCode: roomId,
        matchId,
        serverTick: msg.snapshot.tick,
        reasons: Object.fromEntries(skippedByReason.entries()),
      });
    }
  }
}

function broadcastToRoom(roomId: string, msg: MatchServerMessage) {
  const room = rooms.get(roomId);
  if (!room) return;

  for (const client of clients) {
    if (client.roomId !== roomId) continue;
    if (!isSocketAttachedToRoom(client, room)) continue;
    send(client.socket, msg);
  }
}

function clearRestartVote(roomId: string): void {
  restartVotes.delete(roomId);
}

function emitRestartVoteState(roomId: string): void {
  const room = rooms.get(roomId);
  const vote = restartVotes.get(roomId);
  if (!room || !vote) return;
  broadcastToRoom(roomId, {
    type: 'room:restart_vote_state',
    roomCode: roomId,
    yesCount: vote.yes.size,
    total: room.players.size,
  });
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
  roomRegistry.ensureRoom(roomId);

  for (const [tgUserId, socket] of room.players.entries()) {
    if (socket === ctx.socket && tgUserId !== ctx.tgUserId) {
      room.players.delete(tgUserId);
      break;
    }
  }

  room.players.set(ctx.tgUserId, ctx.socket);
  roomRegistry.touchConnection(roomId, ctx.connectionId);

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

  send(ctx.socket, {
    type: 'match:snapshot',
    snapshot: buildSnapshotFromMatch(activeMatch),
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

async function handlePlayerLeftInActiveMatch(roomId: string, tgUserId: string): Promise<void> {
  const room = rooms.get(roomId);
  if (!room?.matchId) {
    return;
  }

  const match = getMatch(room.matchId);
  if (!match || match.roomId !== roomId) {
    return;
  }

  const changed = markPlayerDisconnected(match, tgUserId);
  if (!changed) {
    return;
  }

  logWsEvent('ws_player_left_match', {
    roomId,
    matchId: match.matchId,
    tgUserId,
  });
}

function detachClientFromRoom(ctx: ClientCtx, reason: 'intentional_leave' | 'disconnect' = 'disconnect') {
  if (!ctx.roomId) {
    return;
  }

  const roomId = ctx.roomId;
  const leavingTgUserId = ctx.tgUserId;
  const room = rooms.get(roomId);
  if (room) {
    room.players.delete(leavingTgUserId);

    const vote = restartVotes.get(roomId);
    if (vote) {
      vote.yes.delete(leavingTgUserId);
      vote.no.delete(leavingTgUserId);
      if (room.players.size === 0) {
        clearRestartVote(roomId);
      }
    }

    if (room.players.size === 0) {
      void finalizeAndDeleteRoom(room.roomId);
    }
  }

  roomRegistry.detachConnection(ctx.connectionId);

  ctx.roomId = null;
  ctx.matchId = null;

  logWsEvent('ws_room_leave', {
    tgUserId: leavingTgUserId,
    roomId,
    reason,
  });

  void handlePlayerLeftInActiveMatch(roomId, leavingTgUserId);
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
      const id = Number(msg.id);
      const t = Number(msg.t);

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

      const dbRoom = await getRoomByCode(msg.roomId);
      if (!dbRoom) {
        return send(ctx.socket, { type: 'match:error', error: 'room_not_found' });
      }

      if (String(dbRoom.phase ?? 'LOBBY') !== 'LOBBY') {
        roomRegistry.markStarted(msg.roomId);
        return send(ctx.socket, { type: 'match:error', error: 'room_started' });
      }

      attachClientToRoom(ctx, msg.roomId);
      sendRejoinSyncIfActiveMatch(ctx, msg.roomId);
      return;
    }


    case 'room:leave': {
      detachClientFromRoom(ctx, 'intentional_leave');
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
      clearRestartVote(room.roomId);
      await setRoomPhase(room.roomId, 'STARTED');
      roomRegistry.markStarted(room.roomId);

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

      const startedMessage: MatchServerMessage = {
        type: 'match:started',
        roomCode: room.roomId,
        matchId: match.matchId,
      };
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

      sendInitialSnapshot(room.roomId, match);

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


        for (const event of events) {
          if (activeRoom.matchId !== event.matchId || event.roomCode !== activeRoom.roomId) {
            continue;
          }

          broadcastToRoomMatch(activeRoom.roomId, snapshot.matchId, event);

          if (event.type === 'match:end') {
            void finalizeAndDeleteRoom(activeRoom.roomId);
            return;
          }
        }

        broadcastToRoomMatch(activeRoom.roomId, snapshot.matchId, {
          type: 'match:snapshot',
          snapshot,
        });
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

      const seq = Number(msg.seq);
      if (!Number.isSafeInteger(seq) || seq <= 0) return;

      const { payload } = msg;
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

    case 'match:bomb_place': {
      if (!ctx.roomId || !ctx.matchId) {
        logInboundDrop(ctx, msg, 'bomb_place_no_session');
        return;
      }

      const room = rooms.get(ctx.roomId);
      if (!room || !isSocketAttachedToRoom(ctx, room) || room.matchId !== ctx.matchId) {
        logInboundDrop(ctx, msg, 'bomb_place_room_mismatch', room);
        return;
      }

      const match = getMatch(ctx.matchId);
      if (!match || match.roomId !== ctx.roomId) {
        logInboundDrop(ctx, msg, 'bomb_place_match_mismatch', room);
        return;
      }

      const x = Number(msg.payload?.x);
      const y = Number(msg.payload?.y);
      if (!Number.isInteger(x) || !Number.isInteger(y)) {
        return;
      }

      const spawned = tryPlaceBomb(match, ctx.tgUserId, x, y);
      if (!spawned) {
        return;
      }

      broadcastToRoomMatch(room.roomId, match.matchId, spawned);
      return;
    }

    case 'room:restart_propose': {
      if (!ctx.roomId) {
        return;
      }

      const room = getRoom(ctx.roomId);
      if (!room || !isSocketAttachedToRoom(ctx, room)) {
        return;
      }

      const dbRoom = await getRoomByCode(ctx.roomId);
      if (!dbRoom || String(dbRoom.ownerTgUserId) !== String(ctx.tgUserId)) {
        return send(ctx.socket, { type: 'match:error', error: 'not_room_owner' });
      }

      if (String(dbRoom.phase ?? 'LOBBY') !== 'FINISHED') {
        return send(ctx.socket, { type: 'match:error', error: 'restart_phase_invalid' });
      }

      const expiresAt = Date.now() + 20_000;
      restartVotes.set(room.roomId, {
        active: true,
        yes: new Set([ctx.tgUserId]),
        no: new Set(),
        expiresAt,
      });

      broadcastToRoom(room.roomId, {
        type: 'room:restart_proposed',
        roomCode: room.roomId,
        byTgUserId: ctx.tgUserId,
        expiresAt,
      });
      emitRestartVoteState(room.roomId);

      setTimeout(() => {
        const vote = restartVotes.get(room.roomId);
        if (!vote || vote.expiresAt !== expiresAt || !vote.active) return;
        clearRestartVote(room.roomId);
        broadcastToRoom(room.roomId, {
          type: 'room:restart_cancelled',
          roomCode: room.roomId,
          reason: 'timeout',
        });
      }, 20_100);
      return;
    }

    case 'room:restart_vote': {
      if (!ctx.roomId) {
        return;
      }

      const room = getRoom(ctx.roomId);
      if (!room || !isSocketAttachedToRoom(ctx, room)) {
        return;
      }

      const vote = restartVotes.get(room.roomId);
      if (!vote || !vote.active) {
        return;
      }

      if (Date.now() > vote.expiresAt) {
        clearRestartVote(room.roomId);
        broadcastToRoom(room.roomId, {
          type: 'room:restart_cancelled',
          roomCode: room.roomId,
          reason: 'timeout',
        });
        return;
      }

      if (msg.vote === 'no') {
        vote.no.add(ctx.tgUserId);
        vote.yes.delete(ctx.tgUserId);
        clearRestartVote(room.roomId);
        broadcastToRoom(room.roomId, {
          type: 'room:restart_cancelled',
          roomCode: room.roomId,
          reason: 'no_vote',
        });
        return;
      }

      vote.yes.add(ctx.tgUserId);
      vote.no.delete(ctx.tgUserId);
      emitRestartVoteState(room.roomId);

      if (vote.yes.size < room.players.size) {
        return;
      }

      clearRestartVote(room.roomId);
      broadcastToRoom(room.roomId, {
        type: 'room:restart_accepted',
        roomCode: room.roomId,
      });

      await setRoomPhase(room.roomId, 'STARTED');
      roomRegistry.markStarted(room.roomId);

      const players = Array.from(room.players.keys());
      const match = createMatch(room.roomId, players);
      room.matchId = match.matchId;

      for (const client of clients) {
        if (client.roomId === room.roomId && isSocketAttachedToRoom(client, room)) {
          client.matchId = match.matchId;
        }
      }

      broadcastToRoomMatch(room.roomId, match.matchId, {
        type: 'match:started',
        roomCode: room.roomId,
        matchId: match.matchId,
      });

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

      sendInitialSnapshot(room.roomId, match);

      startMatch(match, (snapshot, events) => {
        const activeRoom = rooms.get(room.roomId);
        if (!activeRoom) {
          endMatch(match.matchId);
          return;
        }

        if (activeRoom.matchId !== snapshot.matchId) {
          return;
        }

        for (const event of events) {
          broadcastToRoomMatch(activeRoom.roomId, snapshot.matchId, event);
          if (event.type === 'match:end') {
            void finalizeAndDeleteRoom(activeRoom.roomId);
            return;
          }
        }

        broadcastToRoomMatch(activeRoom.roomId, snapshot.matchId, {
          type: 'match:snapshot',
          snapshot,
        });
      });

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
    const tgUserId = url.searchParams.get('tgUserId') ?? `guest_${Math.random().toString(36).slice(2, 10)}`;

    const ctx: ClientCtx = {
      connectionId: randomUUID(),
      socket,
      tgUserId,
      roomId: null,
      matchId: null,
      lastSeenMs: Date.now(),
    };
    clients.add(ctx);


    send(socket, { type: 'connected' });

    socket.on('message', (raw) => {
      const msg = parseMessage(raw);
      if (!msg) {
        send(socket, { type: 'match:error', error: 'invalid_message' });
        return;
      }
      ctx.lastSeenMs = Date.now();
      roomRegistry.heartbeat(ctx.connectionId, ctx.lastSeenMs);
      void handleMessage(ctx, msg);
    });

    socket.on('close', () => {
      const roomCode = ctx.roomId;
      const tgUserId = ctx.tgUserId;

      logWsEvent('ws_player_disconnect', { tgUserId, roomId: roomCode });
      detachClientFromRoom(ctx, 'disconnect');
      clients.delete(ctx);

      if (roomCode) {
        void detachClientFromRoomDb(roomCode, tgUserId);
      }
    });
  });
}
