import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import type { RawData, Server as WebSocketServer } from 'ws';

import type { MatchClientMessage, MatchServerMessage } from '../mp/protocol';
import type { MatchState } from '../mp/types';
import {
  getBombPlacementRejectReason,
  isPlayerRejoinable,
  markPlayerDisconnected,
  markPlayerReconnected,
  startMatch,
  tryPlaceBomb,
} from '../mp/match';
import { createMatch, endMatch, getMatch, getMatchByRoom } from '../mp/matchManager';
import { touchLastMpSession } from '../mp/lastSessionStore';
import { authenticateWsConnection } from '../auth/wsAuth';

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

type InputRateLimitState = {
  windowStartMs: number;
  count: number;
  dropped: number;
};

type RoomState = {
  roomId: string;
  players: Map<string, WebSocket>;
  matchId: string | null;
  restartProposers: Map<string, RestartProposerState>;
  slotByTgUserId: Map<string, number>;
};

type RestartProposerState = { cooldownUntilMs: number; ignoredCount: number };

type PendingRejoinHandshake = {
  roomCode: string;
  matchId: string;
  rejoinAttemptId: string;
  createdAtMs: number;
  timeoutId: NodeJS.Timeout;
};

type RestartVoteState = {
  active: boolean;
  yes: Set<string>;
  no: Set<string>;
  expiresAtMs: number;
  proposerTgUserId: string;
  timeoutId: NodeJS.Timeout;
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
const pendingRejoinHandshakes = new Map<string, PendingRejoinHandshake>(); // key: connectionId
const inputRateLimitByConnectionId = new Map<string, InputRateLimitState>();

const INPUT_RATE_LIMIT_PER_SECOND = 30;
const INPUT_QUEUE_MAX_LEN = 500;

const STALE_CONNECTION_MS = 60_000;
const INACTIVE_ROOM_MS = 90_000;
const SNAPSHOT_LOGGING_ENABLED = process.env.RR_LOG_SNAPSHOT_BROADCAST === '1'; // Opt-in snapshot broadcast diagnostics
const SNAPSHOT_LOG_SAMPLE_EVERY_TICKS = Math.max(1, Number.parseInt(process.env.RR_LOG_SNAPSHOT_BROADCAST_EVERY ?? '20', 10) || 20);

function shouldLogSnapshotBroadcastForTick(tick: number): boolean {
  if (!SNAPSHOT_LOGGING_ENABLED) {
    return false;
  }
  if (!Number.isFinite(tick)) {
    return true;
  }
  return tick % SNAPSHOT_LOG_SAMPLE_EVERY_TICKS === 0;
}


function roomHasRejoinablePlayer(roomId: string, nowMs = Date.now()): boolean {
  const roomMatch = getMatchByRoom(roomId);
  if (!roomMatch) {
    return false;
  }

  for (const tgUserId of roomMatch.disconnectedPlayers) {
    if (isPlayerRejoinable(roomMatch, tgUserId, nowMs)) {
      return true;
    }
  }

  return false;
}

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
    room.slotByTgUserId.clear();
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
  clearRestartVote(roomId);
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

    if (roomHasRejoinablePlayer(roomId, now)) {
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
    restartProposers: new Map<string, RestartProposerState>(),
    slotByTgUserId: new Map<string, number>(),
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

function shouldAcceptInputForRateLimit(ctx: ClientCtx): boolean {
  const nowMs = Date.now();
  const current = inputRateLimitByConnectionId.get(ctx.connectionId);
  const state: InputRateLimitState =
    current ?? {
      windowStartMs: nowMs,
      count: 0,
      dropped: 0,
    };

  if (nowMs - state.windowStartMs >= 1_000) {
    state.windowStartMs = nowMs;
    state.count = 0;
    state.dropped = 0;
  }

  if (state.count >= INPUT_RATE_LIMIT_PER_SECOND) {
    state.dropped += 1;
    inputRateLimitByConnectionId.set(ctx.connectionId, state);
    logWsEvent('ws_input_rate_limited', {
      tgUserId: ctx.tgUserId,
      roomId: ctx.roomId,
      matchId: ctx.matchId,
      windowStartMs: state.windowStartMs,
      count: state.count,
      limit: INPUT_RATE_LIMIT_PER_SECOND,
      dropped: state.dropped,
    });
    return false;
  }

  state.count += 1;
  inputRateLimitByConnectionId.set(ctx.connectionId, state);
  return true;
}

function isSocketAttachedToRoom(ctx: ClientCtx, room: RoomState): boolean {
  return room.players.get(ctx.tgUserId) === ctx.socket;
}

function getTeamScore(match: MatchState): number {
  return Array.from(match.playerScores.values()).reduce((sum, value) => sum + Math.max(0, Number(value ?? 0)), 0);
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
    score: getTeamScore(match),
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
      score: match.playerScores.get(player.tgUserId) ?? 0,
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

  const shouldLogSnapshotBroadcast = msg.type === 'match:snapshot' && shouldLogSnapshotBroadcastForTick(msg.snapshot.tick);
  const skippedByReason = shouldLogSnapshotBroadcast ? new Map<string, number>() : null;
  let clientsConsidered = 0;
  let sentCount = 0;
  let clientMatchIdMismatchCount = 0;

  const clientsBySocket = new Map<WebSocket, ClientCtx>();
  for (const client of clients) {
    clientsBySocket.set(client.socket, client);
  }

  const addSkipReason = (reason: string) => {
    if (!skippedByReason) {
      return;
    }
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
      if (shouldLogSnapshotBroadcast) {
        logWsEvent('ws_snapshot_recipient_mismatch', {
          roomId,
          roomCode: roomId,
          matchId,
          serverTick: msg.type === 'match:snapshot' ? msg.snapshot.tick : null,
          tgUserId,
          clientMatchId: client.matchId,
        });
      }
    }

    if (!isSocketAttachedToRoom(client, room)) {
      addSkipReason('socket_not_attached_to_room_players');
      continue;
    }

    send(socket, msg);
    sentCount += 1;
  }

  if (msg.type === 'match:snapshot' && shouldLogSnapshotBroadcast) {
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

    if (skippedByReason && skippedByReason.size > 0) {
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
  const vote = restartVotes.get(roomId);
  if (!vote) {
    return;
  }

  clearTimeout(vote.timeoutId);
  restartVotes.delete(roomId);
}

function getRestartProposerState(room: RoomState, tgUserId: string): RestartProposerState {
  const existing = room.restartProposers.get(tgUserId);
  if (existing) {
    return existing;
  }

  const proposerState: RestartProposerState = { cooldownUntilMs: 0, ignoredCount: 0 };
  room.restartProposers.set(tgUserId, proposerState);
  return proposerState;
}

function pruneRestartProposers(room: RoomState): void {
  const nowMs = Date.now();

  for (const [tgUserId, state] of room.restartProposers.entries()) {
    if (room.players.has(tgUserId)) {
      continue;
    }
    if (state.cooldownUntilMs > nowMs) {
      continue;
    }
    if (state.ignoredCount > 0) {
      continue;
    }
    room.restartProposers.delete(tgUserId);
  }
}

function applyRestartProposalPenalty(room: RoomState, proposerTgUserId: string, reason: 'no_vote' | 'timeout'): void {
  const proposerState = getRestartProposerState(room, proposerTgUserId);
  proposerState.cooldownUntilMs = Date.now() + 60_000;
  if (reason === 'timeout') {
    proposerState.ignoredCount += 1;
  }

  const proposerSocket = room.players.get(proposerTgUserId);
  if (proposerSocket) {
    send(proposerSocket, {
      type: 'room:restart_cooldown',
      roomCode: room.roomId,
      retryAtMs: proposerState.cooldownUntilMs,
    });
  }

  logWsEvent('ws_restart_proposer_penalty_applied', {
    roomId: room.roomId,
    proposerTgUserId,
    reason,
    cooldownUntilMs: proposerState.cooldownUntilMs,
    ignoredCount: proposerState.ignoredCount,
  });
}

function kickPlayerFromRoom(room: RoomState, tgUserId: string, reason: string): void {
  const socket = room.players.get(tgUserId);
  if (!socket) {
    return;
  }

  room.players.delete(tgUserId);

  for (const client of clients) {
    if (client.tgUserId !== tgUserId || client.roomId !== room.roomId || client.socket !== socket) {
      continue;
    }

    detachClientFromRoom(client, 'intentional_leave');
    break;
  }

  try {
    socket.terminate();
  } catch {}

  logWsEvent('ws_player_kicked', {
    roomId: room.roomId,
    tgUserId,
    reason,
  });
}

function maybeKickRestartSpammer(room: RoomState, proposerTgUserId: string): void {
  const proposerState = getRestartProposerState(room, proposerTgUserId);
  if (proposerState.ignoredCount >= 3) {
    kickPlayerFromRoom(room, proposerTgUserId, 'restart_spam');
  }
}

function cancelRestartVote(room: RoomState, reason: 'no_vote' | 'timeout'): void {
  const vote = restartVotes.get(room.roomId);
  if (!vote || !vote.active) {
    return;
  }

  clearRestartVote(room.roomId);
  applyRestartProposalPenalty(room, vote.proposerTgUserId, reason);
  broadcastToRoom(room.roomId, {
    type: 'room:restart_cancelled',
    roomCode: room.roomId,
    reason,
  });
  maybeKickRestartSpammer(room, vote.proposerTgUserId);
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


function ensureStableRoomSlot(room: RoomState, tgUserId: string): number {
  const existingSlot = room.slotByTgUserId.get(tgUserId);
  if (typeof existingSlot === 'number') {
    return existingSlot;
  }

  const usedSlots = new Set<number>(room.slotByTgUserId.values());
  const maxSlots = 4;

  for (let slotIndex = 0; slotIndex < maxSlots; slotIndex += 1) {
    if (usedSlots.has(slotIndex)) {
      continue;
    }

    room.slotByTgUserId.set(tgUserId, slotIndex);
    return slotIndex;
  }

  const overflowSlot = room.slotByTgUserId.size;
  room.slotByTgUserId.set(tgUserId, overflowSlot);
  return overflowSlot;
}

function getStableMatchPlayers(room: RoomState): string[] {
  return Array.from(room.players.keys()).sort((a, b) => {
    const slotA = room.slotByTgUserId.get(a) ?? Number.MAX_SAFE_INTEGER;
    const slotB = room.slotByTgUserId.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (slotA !== slotB) {
      return slotA - slotB;
    }
    return a.localeCompare(b);
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

  ensureStableRoomSlot(room, ctx.tgUserId);
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

function clearPendingRejoinHandshake(connectionId: string): void {
  const pending = pendingRejoinHandshakes.get(connectionId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeoutId);
  pendingRejoinHandshakes.delete(connectionId);
}

function sendRejoinSnapshotBundle(ctx: ClientCtx, roomId: string, match: MatchState, reason: 'ready' | 'timeout'): void {
  send(ctx.socket, {
    type: 'match:started',
    roomCode: roomId,
    matchId: match.matchId,
  });

  send(ctx.socket, {
    type: 'mp:rejoin_sync',
    matchId: match.matchId,
  });

  send(ctx.socket, {
    type: 'match:world_init',
    roomCode: roomId,
    matchId: match.matchId,
    world: {
      gridW: match.world.gridW,
      gridH: match.world.gridH,
      tiles: [...match.world.tiles],
      worldHash: match.world.worldHash,
    },
  });

  send(ctx.socket, {
    type: 'match:snapshot',
    snapshot: buildSnapshotFromMatch(match),
  });

  logWsEvent('ws_rejoin_sync_sent', {
    tgUserId: ctx.tgUserId,
    roomId,
    matchId: match.matchId,
    reason,
  });
}

function beginRejoinHandshake(ctx: ClientCtx, roomId: string, match: MatchState): void {
  clearPendingRejoinHandshake(ctx.connectionId);
  const rejoinAttemptId = randomUUID();
  const createdAtMs = Date.now();

  send(ctx.socket, {
    type: 'match:started',
    roomCode: roomId,
    matchId: match.matchId,
  });

  send(ctx.socket, {
    type: 'mp:rejoin_ack',
    roomCode: roomId,
    matchId: match.matchId,
    serverTime: createdAtMs,
    rejoinAttemptId,
  });

  logWsEvent('ws_rejoin_ack_sent', {
    connectionId: ctx.connectionId,
    tgUserId: ctx.tgUserId,
    roomId,
    matchId: match.matchId,
    rejoinAttemptId,
  });

  const timeoutId = setTimeout(() => {
    const pending = pendingRejoinHandshakes.get(ctx.connectionId);
    if (
      !pending
      || pending.matchId !== match.matchId
      || pending.roomCode !== roomId
      || pending.rejoinAttemptId !== rejoinAttemptId
    ) {
      return;
    }

    pendingRejoinHandshakes.delete(ctx.connectionId);

    const activeMatch = getMatch(match.matchId);
    if (!activeMatch || activeMatch.roomId !== roomId) {
      return;
    }

    sendRejoinSnapshotBundle(ctx, roomId, activeMatch, 'timeout');
    logWsEvent('ws_rejoin_ready_timeout_fallback', {
      connectionId: ctx.connectionId,
      tgUserId: ctx.tgUserId,
      roomId,
      matchId: match.matchId,
      rejoinAttemptId,
      createdAtMs,
    });
  }, 4_000);

  pendingRejoinHandshakes.set(ctx.connectionId, {
    roomCode: roomId,
    matchId: match.matchId,
    rejoinAttemptId,
    createdAtMs,
    timeoutId,
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

  beginRejoinHandshake(ctx, roomId, activeMatch);
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

  logWsEvent('ws_player_marked_disconnected', {
    roomId,
    matchId: match.matchId,
    tgUserId,
  });
}

async function startMatchInRoom(room: RoomState): Promise<void> {
  const players = getStableMatchPlayers(room);
  const match = createMatch(room.roomId, players);
  const roomPlayerIds = Array.from(room.players.keys());
  room.matchId = match.matchId;
  clearRestartVote(room.roomId);

  await setRoomPhase(room.roomId, 'STARTED');
  roomRegistry.markStarted(room.roomId);

  for (const client of clients) {
    if (client.roomId === room.roomId && isSocketAttachedToRoom(client, room)) {
      client.matchId = match.matchId;
    }
  }

  const clientDiagnostics = Array.from(clients).map((client) => {
    const attachedToRoomBySocket = isSocketAttachedToRoom(client, room);
    const roomMatch = room.players.get(client.tgUserId);
    const inRoomByClientRoomId = client.roomId === room.roomId;
    const includedByBroadcastFilter =
      inRoomByClientRoomId &&
      attachedToRoomBySocket &&
      client.matchId === match.matchId;
    return {
      connectionId: client.connectionId,
      tgUserId: client.tgUserId,
      clientRoomId: client.roomId,
      clientMatchId: client.matchId,
      inRoomByClientRoomId,
      attachedToRoomBySocket,
      hasRoomPlayerEntry: Boolean(roomMatch),
      updatedToNewMatchId: client.matchId === match.matchId,
      includedByBroadcastFilter,
    };
  });

  logWsEvent('ws_restart_start_match_diagnostics', {
    roomId: room.roomId,
    roomCode: room.roomId,
    matchId: match.matchId,
    roomPlayers: roomPlayerIds,
    clients: clientDiagnostics,
  });

  logWsEvent('ws_match_started', {
    roomId: room.roomId,
    roomCode: room.roomId,
    matchId: match.matchId,
    playersCount: players.length,
    roomPlayersCount: room.players.size,
  });

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

    if (snapshot.roomCode !== activeRoom.roomId) {
      return;
    }

    for (const event of events) {
      if (activeRoom.matchId !== event.matchId || event.roomCode !== activeRoom.roomId) {
        continue;
      }

      broadcastToRoomMatch(activeRoom.roomId, snapshot.matchId, event);

      if (event.type === 'match:end') {
        logWsEvent('ws_match_end_scores', {
          roomId: activeRoom.roomId,
          matchId: event.matchId,
          scores: Array.from(match.playerScores.entries()).map(([tgUserId, score]) => ({ tgUserId, score })),
        });

        endMatch(event.matchId);
        activeRoom.matchId = null;
        clearRestartVote(activeRoom.roomId);

        for (const client of clients) {
          if (client.roomId === activeRoom.roomId && isSocketAttachedToRoom(client, activeRoom)) {
            client.matchId = null;
          }
        }

        void setRoomPhase(activeRoom.roomId, 'FINISHED');
        logWsEvent('ws_match_finished_room_kept_alive', {
          roomId: activeRoom.roomId,
          matchId: event.matchId,
        });
        return;
      }
    }

    broadcastToRoomMatch(activeRoom.roomId, snapshot.matchId, {
      type: 'match:snapshot',
      snapshot,
    });
  });
}

function detachClientFromRoom(ctx: ClientCtx, reason: 'intentional_leave' | 'disconnect' = 'disconnect') {
  if (!ctx.roomId) {
    return;
  }

  const roomId = ctx.roomId;
  const leavingTgUserId = ctx.tgUserId;
  const room = rooms.get(roomId);
  let keepRoomForRejoin = false;

  if (reason === 'disconnect' && room?.matchId) {
    const match = getMatch(room.matchId);
    if (match && match.roomId === roomId) {
      const changed = markPlayerDisconnected(match, leavingTgUserId);
      if (changed) {
        logWsEvent('ws_player_marked_disconnected', {
          roomId,
          matchId: match.matchId,
          tgUserId: leavingTgUserId,
        });
      }
    }
  }

  if (room) {
    if (room.players.get(leavingTgUserId) === ctx.socket) {
      room.players.delete(leavingTgUserId);
      pruneRestartProposers(room);
    }

    const vote = restartVotes.get(roomId);
    if (vote) {
      if (vote.proposerTgUserId === leavingTgUserId) {
        cancelRestartVote(room, 'no_vote');
      } else {
        vote.yes.delete(leavingTgUserId);
        vote.no.delete(leavingTgUserId);
      }
      if (room.players.size === 0) {
        clearRestartVote(roomId);
      }
    }

    if (room.players.size === 0) {
      if (roomHasRejoinablePlayer(room.roomId)) {
        keepRoomForRejoin = true;
      } else {
        void finalizeAndDeleteRoom(room.roomId);
      }
    }
  }

  roomRegistry.detachConnection(ctx.connectionId);
  if (keepRoomForRejoin) {
    roomRegistry.ensureRoom(roomId);
  }

  clearPendingRejoinHandshake(ctx.connectionId);

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

      const dbRoom = await getRoomByCode(msg.roomId);
      if (!dbRoom) {
        return send(ctx.socket, { type: 'match:error', error: 'room_not_found' });
      }

      const roomPhase = String(dbRoom.phase ?? 'LOBBY');
      const activeMatch = getMatchByRoom(msg.roomId);
      const isStartedPhase = roomPhase === 'STARTED';
      const isKnownPlayerInActiveMatch = Boolean(activeMatch?.players.has(ctx.tgUserId));
      const room = getRoom(msg.roomId);
      const existingPlayerSocket = room?.players.get(ctx.tgUserId);
      const canTakeoverStartedSocket = Boolean(
        activeMatch
        && isStartedPhase
        && isKnownPlayerInActiveMatch
        && existingPlayerSocket
        && existingPlayerSocket !== ctx.socket,
      );
      const canRejoinStarted = Boolean(
        activeMatch
        && isStartedPhase
        && isKnownPlayerInActiveMatch
        && (isPlayerRejoinable(activeMatch, ctx.tgUserId) || canTakeoverStartedSocket),
      );

      if (roomPhase !== 'LOBBY' && !canRejoinStarted) {
        roomRegistry.markStarted(msg.roomId);

        const rejoinReason = roomPhase !== 'STARTED'
          ? 'room_not_in_started_phase'
          : !activeMatch
            ? 'active_match_missing'
            : !isKnownPlayerInActiveMatch
              ? 'player_not_in_match'
              : 'rejoin_grace_expired';

        logWsEvent('ws_rejoin_join_denied', {
          roomId: msg.roomId,
          tgUserId: ctx.tgUserId,
          roomPhase,
          activeMatchId: activeMatch?.matchId ?? null,
          reason: rejoinReason,
        });

        return send(ctx.socket, { type: 'match:error', error: `room_started:${rejoinReason}` });
      }

      if (canTakeoverStartedSocket && existingPlayerSocket) {
        logWsEvent('ws_rejoin_takeover', {
          roomId: msg.roomId,
          tgUserId: ctx.tgUserId,
        });

        try {
          existingPlayerSocket.terminate();
        } catch {}
      }

      attachClientToRoom(ctx, msg.roomId);
      touchLastMpSession({
        tgUserId: ctx.tgUserId,
        roomCode: msg.roomId,
        matchId: activeMatch?.matchId ?? null,
      });
      if (activeMatch && roomPhase === 'STARTED') {
        markPlayerReconnected(activeMatch, ctx.tgUserId);
        const joinedRoom = getRoom(msg.roomId);
        if (joinedRoom) {
          joinedRoom.matchId = activeMatch.matchId;
        }
        ctx.matchId = activeMatch.matchId;
      }
      sendRejoinSyncIfActiveMatch(ctx, msg.roomId);
      return;
    }


    case 'mp:rejoin_ready': {
      if (!ctx.roomId || !ctx.matchId) {
        logInboundDrop(ctx, msg, 'rejoin_ready_no_session');
        return;
      }

      const room = rooms.get(ctx.roomId);
      if (!room || !isSocketAttachedToRoom(ctx, room) || room.matchId !== ctx.matchId) {
        logInboundDrop(ctx, msg, 'rejoin_ready_room_mismatch', room);
        return;
      }

      if (msg.roomCode !== ctx.roomId) {
        logWsEvent('ws_rejoin_ready_drop_mismatch_roomCode', {
          connectionId: ctx.connectionId,
          tgUserId: ctx.tgUserId,
          roomId: ctx.roomId,
          ctxMatchId: ctx.matchId,
          gotRoomCode: msg.roomCode,
          gotMatchId: msg.matchId,
          gotAttemptId: msg.rejoinAttemptId,
        });
        return;
      }

      if (msg.matchId !== ctx.matchId) {
        logWsEvent('ws_rejoin_ready_drop_mismatch_matchId', {
          connectionId: ctx.connectionId,
          tgUserId: ctx.tgUserId,
          roomId: ctx.roomId,
          ctxMatchId: ctx.matchId,
          gotRoomCode: msg.roomCode,
          gotMatchId: msg.matchId,
          gotAttemptId: msg.rejoinAttemptId,
        });
        return;
      }

      const pending = pendingRejoinHandshakes.get(ctx.connectionId);
      if (!pending) {
        logWsEvent('ws_rejoin_ready_drop_no_pending', {
          connectionId: ctx.connectionId,
          tgUserId: ctx.tgUserId,
          roomId: ctx.roomId,
          matchId: ctx.matchId,
          gotAttemptId: msg.rejoinAttemptId,
        });
        return;
      }

      if (pending.roomCode !== ctx.roomId || pending.matchId !== ctx.matchId) {
        logInboundDrop(ctx, msg, 'rejoin_ready_pending_mismatch', room);
        return;
      }

      if (pending.rejoinAttemptId !== msg.rejoinAttemptId) {
        logWsEvent('ws_rejoin_ready_drop_mismatch_attempt', {
          connectionId: ctx.connectionId,
          tgUserId: ctx.tgUserId,
          roomId: ctx.roomId,
          matchId: ctx.matchId,
          expectedAttemptId: pending.rejoinAttemptId,
          gotAttemptId: msg.rejoinAttemptId,
        });
        return;
      }

      clearPendingRejoinHandshake(ctx.connectionId);
      const activeMatch = getMatch(ctx.matchId);
      if (!activeMatch || activeMatch.roomId !== ctx.roomId) {
        return;
      }

      logWsEvent('ws_rejoin_ready_accepted', {
        connectionId: ctx.connectionId,
        tgUserId: ctx.tgUserId,
        roomId: ctx.roomId,
        matchId: ctx.matchId,
        rejoinAttemptId: msg.rejoinAttemptId,
      });

      sendRejoinSnapshotBundle(ctx, ctx.roomId, activeMatch, 'ready');
      return;
    }

    case 'mp:snapshot_applied': {
      logWsEvent('ws_snapshot_applied_ack', {
        tgUserId: ctx.tgUserId,
        roomId: ctx.roomId,
        ctxMatchId: ctx.matchId,
        matchId: msg.matchId,
        rejoinAttemptId: msg.rejoinAttemptId ?? null,
      });
      return;
    }


    case 'room:leave': {
      const roomCode = ctx.roomId;
      const tgUserId = ctx.tgUserId;
      detachClientFromRoom(ctx, 'intentional_leave');
      if (roomCode) {
        void detachClientFromRoomDb(roomCode, tgUserId);
      }
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

      const players = getStableMatchPlayers(room);
      if (players.length < 2) {
        return send(ctx.socket, { type: 'match:error', error: 'not_enough_ws_players' });
      }

      await startMatchInRoom(room);

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
        if (dir !== null && dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') return;

        if (!shouldAcceptInputForRateLimit(ctx)) {
          return;
        }

        if (match.inputQueue.length >= INPUT_QUEUE_MAX_LEN) {
          logWsEvent('ws_input_queue_overflow', {
            roomId: ctx.roomId,
            matchId: match.matchId,
            queueLen: match.inputQueue.length,
            maxQueueLen: INPUT_QUEUE_MAX_LEN,
            tgUserId: ctx.tgUserId,
          });
          return;
        }

        match.inputQueue.push({
          tgUserId: ctx.tgUserId,
          seq,
          payload,
        });

        touchLastMpSession({
          tgUserId: ctx.tgUserId,
          roomCode: ctx.roomId,
          matchId: match.matchId,
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

      const rawClientX = msg.payload?.x;
      const rawClientY = msg.payload?.y;
      const clientX = Number.isFinite(Number(rawClientX)) ? Number(rawClientX) : null;
      const clientY = Number.isFinite(Number(rawClientY)) ? Number(rawClientY) : null;

      const player = match.players.get(ctx.tgUserId);
      const serverX = player?.x ?? null;
      const serverY = player?.y ?? null;

      const spawned =
        player == null || serverX == null || serverY == null ? null : tryPlaceBomb(match, ctx.tgUserId, serverX, serverY);
      if (!spawned) {
        const rejectReason =
          player == null
            ? 'player_missing'
            : match.eliminatedPlayers.has(ctx.tgUserId)
              ? 'player_eliminated'
              : player.state !== 'alive'
                ? 'player_not_alive'
                : getBombPlacementRejectReason(match, ctx.tgUserId, player.x, player.y) ?? 'unknown';

        logWsEvent('bomb_place_rejected', {
          roomId: room.roomId,
          matchId: match.matchId,
          tgUserId: ctx.tgUserId,
          reason: rejectReason,
          clientX,
          clientY,
          serverX,
          serverY,
          playerState: player?.state ?? null,
          eliminated: match.eliminatedPlayers.has(ctx.tgUserId),
        });
        return;
      }

      touchLastMpSession({
        tgUserId: ctx.tgUserId,
        roomCode: ctx.roomId,
        matchId: match.matchId,
      });

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

      if (restartVotes.has(room.roomId)) {
        return send(ctx.socket, { type: 'match:error', error: 'restart_vote_already_active' });
      }

      const proposerState = getRestartProposerState(room, ctx.tgUserId);
      if (Date.now() < proposerState.cooldownUntilMs) {
        send(ctx.socket, {
          type: 'room:restart_rejected',
          roomCode: room.roomId,
          reason: 'cooldown',
          retryAtMs: proposerState.cooldownUntilMs,
        });
        return send(ctx.socket, { type: 'match:error', error: 'restart_propose_cooldown' });
      }

      const dbRoom = await getRoomByCode(ctx.roomId);
      if (!dbRoom) {
        return send(ctx.socket, { type: 'match:error', error: 'room_not_found' });
      }

      const isFinishedPhase = String(dbRoom.phase ?? 'LOBBY') === 'FINISHED';
      const activeMatch = room.matchId ? getMatch(room.matchId) : null;
      const proposerEliminated =
        activeMatch?.roomId === room.roomId
        && activeMatch.players.get(ctx.tgUserId)?.state === 'eliminated';

      if (!isFinishedPhase && !proposerEliminated) {
        return send(ctx.socket, { type: 'match:error', error: 'restart_propose_not_allowed' });
      }

      const expiresAtMs = Date.now() + 10_000;
      const timeoutId = setTimeout(() => {
        const activeRoom = getRoom(room.roomId);
        const vote = restartVotes.get(room.roomId);
        if (!activeRoom || !vote || !vote.active || vote.expiresAtMs !== expiresAtMs) {
          return;
        }

        cancelRestartVote(activeRoom, 'timeout');
      }, 10_050);

      restartVotes.set(room.roomId, {
        active: true,
        yes: new Set([ctx.tgUserId]),
        no: new Set(),
        expiresAtMs,
        proposerTgUserId: ctx.tgUserId,
        timeoutId,
      });

      broadcastToRoom(room.roomId, {
        type: 'room:restart_proposed',
        roomCode: room.roomId,
        byTgUserId: ctx.tgUserId,
        expiresAt: expiresAtMs,
      });
      emitRestartVoteState(room.roomId);
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

      if (Date.now() > vote.expiresAtMs) {
        cancelRestartVote(room, 'timeout');
        return;
      }

      if (msg.vote === 'no') {
        cancelRestartVote(room, 'no_vote');
        return;
      }

      vote.yes.add(ctx.tgUserId);
      vote.no.delete(ctx.tgUserId);
      emitRestartVoteState(room.roomId);

      if (vote.yes.size < room.players.size) {
        return;
      }

      clearRestartVote(room.roomId);
      getRestartProposerState(room, vote.proposerTgUserId).ignoredCount = 0;
      broadcastToRoom(room.roomId, {
        type: 'room:restart_accepted',
        roomCode: room.roomId,
      });

      await startMatchInRoom(room);
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

    void (async () => {
      try {
        const authResult = await authenticateWsConnection(req, url);
        if (!authResult.ok) {
          logWsEvent('ws_auth_failed', {
            reason: authResult.reason,
            hasCredential: authResult.hasCredential,
          });
          socket.close(4401, 'ws_auth_failed');
          return;
        }

        const ctx: ClientCtx = {
          connectionId: randomUUID(),
          socket,
          tgUserId: authResult.tgUserId,
          roomId: null,
          matchId: null,
          lastSeenMs: Date.now(),
        };
        clients.add(ctx);

        logWsEvent('ws_auth_ok', {
          tgUserId: authResult.tgUserId,
          mode: authResult.mode,
        });

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
          inputRateLimitByConnectionId.delete(ctx.connectionId);
          clients.delete(ctx);
        });
      } catch (error) {
        logWsEvent('ws_auth_error', {
          reason: 'internal_error',
          error: error instanceof Error ? error.message : String(error),
        });
        socket.close(4500, 'ws_auth_error');
        return;
      }
    })();
  });
}
