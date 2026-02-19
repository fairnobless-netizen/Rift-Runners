import type { MatchInputPayload, MatchSnapshotV1 } from '@shared/protocol';

export type WsClientMessage =
  | { type: 'ping'; id: number; t: number }
  | { type: 'lobby:list' }
  | { type: 'room:create' }
  | { type: 'room:join'; roomId: string; tgUserId?: string }
  | { type: 'room:leave' }
  | { type: 'match:start' }
  | { type: 'match:input'; seq: number; payload: MatchInputPayload };

export type WsServerMessage =
  | { type: 'pong'; id: number; t: number; serverNow: number }
  | { type: 'lobby:list'; rooms: Array<{ roomId: string; players: number }> }
  | { type: 'room:joined'; room: unknown }
  | { type: 'room:left' }
  | { type: 'match:started'; matchId: string }
  | { type: 'match:world_init'; roomCode: string; matchId: string; world: { gridW: number; gridH: number; tiles: number[]; worldHash: string } }
  | { type: 'match:bomb_placed'; roomCode: string; matchId: string; eventId: string; serverTick: number; tick: number; bomb: { id: string; x: number; y: number } }
  | { type: 'match:bomb_exploded'; roomCode: string; matchId: string; eventId: string; serverTick: number; tick: number; bombId: string; x: number; y: number; tilesDestroyed?: Array<{ x: number; y: number }> }
  | { type: 'match:snapshot'; snapshot: MatchSnapshotV1 }
  | { type: 'match:error'; error: string }
  | { type: 'error'; error: string };

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
};
