import { useMemo } from 'react';
import type { NetSimConfig, NetSimPresetId, WsDebugEvent } from '../ws/useWsClient';

type PredictionStats = {
  correctionCount: number;
  softCorrectionCount: number;
  droppedInputCount: number;
  pendingCount: number;
  lastAckSeq: number;
  drift: number;
  biasX: number;
  biasY: number;
  predHardEnter?: number;
  predHardExit?: number;
  predictionError?: number;
  predictionErrorEma?: number;
  historySize?: number;
  missingHistoryCount?: number;
  reconcileReason?: 'none' | 'soft' | 'hard';
};

type TickDebugStats = {
  snapshotTick: number;
  simulationTick: number;
  renderTick: number;
  baseDelayTicks: number;
  baseDelayTargetTicks: number;
  baseDelayStepCooldownMs: number;
  baseDelayStepCooldownTicks: number;
  delayTicks: number;
  minDelayTicks: number;
  maxDelayTicks: number;
  bufferSize: number;
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
};

type WsDebugOverlayProps = {
  connected: boolean;
  messages: any[];
  debugEvents: WsDebugEvent[];
  identity: {
    id?: string;
    clientId?: number;
    displayName?: string;
  };
  netSim: NetSimConfig;
  onLobby: () => void;
  netSimPresets: { id: NetSimPresetId; label: string }[];
  onToggleNetSim: (enabled: boolean) => void;
  onSelectNetSimPreset: (presetId: NetSimPresetId) => void;
  predictionStats: PredictionStats | null;
  tickDebugStats: TickDebugStats | null;
  rttMs: number | null;
  rttJitterMs: number;
  onCreateRoom: () => void;
  onStartMatch: () => void;
  onMove: (dir: 'up' | 'down' | 'left' | 'right') => void;
  localInputSeq: number;
  getLocalPlayerPosition?: () => { x: number; y: number } | null;
};

function formatEventLine(event: WsDebugEvent): string {
  const arrow = event.direction === 'out' ? '→' : '←';
  if (event.type === 'match:snapshot') {
    return `${arrow} ${event.type} (players:${event.playersCount ?? 0})`;
  }
  if (event.type === 'match:error') {
    return `${arrow} ${event.type}${event.error ? ` (${event.error})` : ''}`;
  }
  return `${arrow} ${event.type}`;
}

export function WsDebugOverlay(props: WsDebugOverlayProps) {
  const showDebugWs = import.meta.env.DEV || String(import.meta.env.VITE_DEBUG_WS ?? '').toLowerCase() === 'true';

  const latestSnapshot = useMemo(() => {
    for (let i = props.messages.length - 1; i >= 0; i -= 1) {
      const message = props.messages[i];
      if (message?.type === 'match:snapshot') return message.snapshot;
    }
    return null;
  }, [props.messages]);

  const latestMatchId = useMemo(() => {
    for (let i = props.debugEvents.length - 1; i >= 0; i -= 1) {
      const event = props.debugEvents[i];
      if (event.matchId) return event.matchId;
    }
    return latestSnapshot?.matchId ?? '—';
  }, [latestSnapshot?.matchId, props.debugEvents]);

  const latestRoomId = useMemo(() => {
    for (let i = props.debugEvents.length - 1; i >= 0; i -= 1) {
      const event = props.debugEvents[i];
      if (event.roomId) return event.roomId;
    }
    return '—';
  }, [props.debugEvents]);

  if (!showDebugWs) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483647,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          position: 'fixed',
          top: 8,
          right: 8,
          width: 360,
          maxWidth: 'calc(100vw - 16px)',
          padding: 10,
          borderRadius: 8,
          background: 'rgba(8, 11, 20, 0.88)',
          color: '#d8e2ff',
          fontSize: 12,
          lineHeight: 1.35,
          border: '1px solid rgba(126, 153, 255, 0.35)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          pointerEvents: 'none',
        }}
      >
        <div>WS: {props.connected ? 'connected' : 'disconnected'}</div>
        <div>Room: {latestRoomId}</div>
        <div>Match: {latestMatchId}</div>
        <div>Players in snapshot: {latestSnapshot?.players?.length ?? 0}</div>
        <div>Local ID: {props.identity.id ?? '—'}</div>

        <div style={{ marginTop: 8, opacity: 0.9 }}>Messages:</div>
        <div style={{ maxHeight: 180, overflow: 'hidden', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          {props.debugEvents.length === 0
            ? '—'
            : props.debugEvents.slice(-15).map((event) => formatEventLine(event)).join('\n')}
        </div>
      </div>
    </div>
  );
}
