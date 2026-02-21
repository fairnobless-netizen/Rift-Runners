import type { MatchClientMessage, MatchServerMessage } from '@shared/protocol';

export type WsClientMessage =
  | { type: 'ping'; id: number; t: number }
  | { type: 'lobby:list' }
  | { type: 'room:create' }
  | { type: 'room:join'; roomId: string; tgUserId?: string }
  | { type: 'room:leave' }
  | MatchClientMessage;

export type WsServerMessage =
  | { type: 'pong'; id: number; t: number; serverNow: number }
  | { type: 'lobby:list'; rooms: Array<{ roomId: string; players: number }> }
  | { type: 'room:joined'; room: unknown }
  | { type: 'room:left' }
  | MatchServerMessage
  | { type: 'error'; error: string };

export type WsTraceContext = {
  roomCode?: string | null;
  matchId?: string | null;
  expectedMatchId?: string | null;
};

type WithType = {
  type: string;
};

export type WsTrafficEntryBase<TMessage extends WithType> = {
  at: number;
  message_type: TMessage['type'];
  message: TMessage;
  traceContext?: WsTraceContext;
};

export type WsInboundTraceEntry = WsTrafficEntryBase<WsServerMessage>;

export type WsOutboundTraceEntry = WsTrafficEntryBase<WsClientMessage>;

export type WsDebugMetrics = {
  snapshotTick: number;
  lastAppliedSnapshotTick: number;
  simulationTick: number;
  renderTick: number;
  serverTick: number;
  lastEventTick: number;
  baseDelayTicks: number;
  baseDelayTargetTicks: number;
  baseDelayStepCooldownMs: number;
  baseDelayStepCooldownTicks: number;
  delayTicks: number;
  minDelayTicks: number;
  maxDelayTicks: number;
  bufferSize: number;
  eventsBuffered: number;
  eventsDroppedDup: number;
  eventsDroppedOutOfOrder: number;
  underrunRate: number;
  underrunCount: number;
  lateSnapshotCount: number;
  lateSnapshotEma: number;
  stallCount: number;
  extrapCount: number;
  extrapolatingTicks: number;
  stalled: boolean;
  rttMs: number | null;
  rttJitterMs: number;
  targetBufferPairs: number;
  targetBufferTargetPairs: number;
  adaptiveEveryTicks: number;
  adaptiveEveryTargetTicks: number;
  bufferHasReserve: boolean;
  tuning: {
    baseDelayMax: number;
    targetBufferMin: number;
    targetBufferMax: number;
    cadenceMin: number;
    cadenceMax: number;
  };
  droppedWrongRoom: number;
  invalidPosDrops: number;
  lastSnapshotRoom: string | null;
  worldReady: boolean;
  worldHashServer: string | null;
  worldHashClient: string | null;
  needsNetResync: boolean;
  netResyncReason: string | null;
  bombInputGated: boolean;
  bombGateReason: string | null;
  renderDelayMs: number;
  serverTimeOffsetMs: number;
  snapshotRateHz: number;
  jitterMs: number;
  lateFrames: number;
  renderTimeMs: number;
};
