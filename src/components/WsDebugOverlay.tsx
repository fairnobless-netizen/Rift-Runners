import { useEffect, useMemo, useRef, useState } from 'react';
import type { NetSimConfig, NetSimPresetId } from '../ws/useWsClient';

type PredictionStats = {
  correctionCount: number;
  softCorrectionCount: number;
  droppedInputCount: number;
  pendingCount: number;
  lastAckSeq: number;
  drift: number;
  biasX: number;
  biasY: number;
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

type TelemetrySnapshotSummary = {
  avgDrift: number;
  maxDrift: number;
  hardCorrectionCount: number;
  softCorrectionCount: number;
  avgPendingInputs: number;
  avgDelayTicks: number;
  avgTargetBufferPairs: number;
  underrunRate: number;
  sampleCount: number;
};

export function WsDebugOverlay({
  connected,
  messages,
  identity,
  netSim,
  onLobby,
  netSimPresets,
  onToggleNetSim,
  onSelectNetSimPreset,
  predictionStats,
  tickDebugStats,
  rttMs,
  rttJitterMs,
  onCreateRoom,
  onStartMatch,
  onMove,
}: {
  connected: boolean;
  messages: any[];
  identity: {
    id?: string;
    clientId?: number;
    displayName?: string;
  };
  netSim: NetSimConfig;
  netSimPresets: { id: NetSimPresetId; label: string }[];
  onToggleNetSim: (enabled: boolean) => void;
  onSelectNetSimPreset: (presetId: NetSimPresetId) => void;
  onLobby: () => void;
  predictionStats: PredictionStats | null;
  tickDebugStats: TickDebugStats | null;
  rttMs: number | null;
  rttJitterMs: number;
  onCreateRoom: () => void;
  onStartMatch: () => void;
  onMove: (dir: 'up' | 'down' | 'left' | 'right') => void;
}) {
  const lastSnapshot = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.type === 'match:snapshot') return m.snapshot;
    }
    return null;
  }, [messages]);

  const [isTelemetryRecording, setIsTelemetryRecording] = useState(false);
  const [telemetrySummary, setTelemetrySummary] = useState<TelemetrySnapshotSummary | null>(null);
  const telemetrySamplesRef = useRef<
    {
      drift: number;
      hardCorrectionCount: number;
      softCorrectionCount: number;
      pendingInputs: number;
      delayTicks: number;
      targetBufferPairs: number;
      underrunRate: number;
    }[]
  >([]);
  const telemetryTimeoutRef = useRef<number | null>(null);

  const latestStatsRef = useRef<{ predictionStats: PredictionStats | null; tickDebugStats: TickDebugStats | null }>({
    predictionStats,
    tickDebugStats,
  });

  useEffect(() => {
    latestStatsRef.current = { predictionStats, tickDebugStats };
  }, [predictionStats, tickDebugStats]);

  useEffect(() => {
    if (!isTelemetryRecording) return;

    const sampleIntervalId = window.setInterval(() => {
      const latest = latestStatsRef.current;
      if (!latest.predictionStats || !latest.tickDebugStats) return;
      telemetrySamplesRef.current.push({
        drift: latest.predictionStats.drift,
        hardCorrectionCount: latest.predictionStats.correctionCount,
        softCorrectionCount: latest.predictionStats.softCorrectionCount,
        pendingInputs: latest.predictionStats.pendingCount,
        delayTicks: latest.tickDebugStats.delayTicks,
        targetBufferPairs: latest.tickDebugStats.targetBufferPairs,
        underrunRate: latest.tickDebugStats.underrunRate,
      });
    }, 100);

    return () => {
      window.clearInterval(sampleIntervalId);
    };
  }, [isTelemetryRecording]);

  useEffect(() => {
    return () => {
      if (telemetryTimeoutRef.current !== null) {
        window.clearTimeout(telemetryTimeoutRef.current);
      }
    };
  }, []);

  const finishTelemetryRecording = () => {
    telemetryTimeoutRef.current = null;
    const samples = telemetrySamplesRef.current;
    if (samples.length === 0) {
      setTelemetrySummary(null);
      setIsTelemetryRecording(false);
      return;
    }

    const sum = samples.reduce(
      (acc, sample) => {
        acc.drift += sample.drift;
        acc.hardCorrectionCount += sample.hardCorrectionCount;
        acc.softCorrectionCount += sample.softCorrectionCount;
        acc.pendingInputs += sample.pendingInputs;
        acc.delayTicks += sample.delayTicks;
        acc.targetBufferPairs += sample.targetBufferPairs;
        acc.underrunRate += sample.underrunRate;
        return acc;
      },
      {
        drift: 0,
        hardCorrectionCount: 0,
        softCorrectionCount: 0,
        pendingInputs: 0,
        delayTicks: 0,
        targetBufferPairs: 0,
        underrunRate: 0,
      },
    );

    const summary: TelemetrySnapshotSummary = {
      avgDrift: sum.drift / samples.length,
      maxDrift: samples.reduce((max, sample) => Math.max(max, sample.drift), Number.NEGATIVE_INFINITY),
      hardCorrectionCount: sum.hardCorrectionCount,
      softCorrectionCount: sum.softCorrectionCount,
      avgPendingInputs: sum.pendingInputs / samples.length,
      avgDelayTicks: sum.delayTicks / samples.length,
      avgTargetBufferPairs: sum.targetBufferPairs / samples.length,
      underrunRate: sum.underrunRate / samples.length,
      sampleCount: samples.length,
    };

    console.group('[WsDebugOverlay] 10s Telemetry Snapshot');
    console.table(summary);
    console.groupEnd();

    setTelemetrySummary(summary);
    setIsTelemetryRecording(false);
  };

  const startTelemetryRecording = () => {
    telemetrySamplesRef.current = [];
    setTelemetrySummary(null);
    setIsTelemetryRecording(true);
    if (telemetryTimeoutRef.current !== null) {
      window.clearTimeout(telemetryTimeoutRef.current);
    }
    telemetryTimeoutRef.current = window.setTimeout(() => {
      finishTelemetryRecording();
    }, 10_000);
  };
  return (
    <div
      style={{
        position: 'fixed',
        right: 10,
        bottom: 10,
        width: 360,
        background: 'rgba(0,0,0,0.82)',
        color: '#0f0',
        fontSize: 12,
        padding: 10,
        zIndex: 9999,
        borderRadius: 10,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div>WS: {connected ? 'CONNECTED' : 'OFFLINE'}</div>
        <div>{lastSnapshot ? `tick: ${lastSnapshot.tick}` : 'no snapshot'}</div>
      </div>

      <div style={{ marginTop: 8 }}>
        Client: {identity.clientId ?? identity.id ?? '—'} | Name: {identity.displayName ?? '—'}
      </div>

      <div style={{ marginTop: 4 }}>
        NetSim: {netSim.enabled ? 'ON' : 'OFF'} | latency={netSim.latencyMs}ms, jitter={netSim.jitterMs}ms, drop={netSim.dropRate}
      </div>

      {import.meta.env.DEV && (
        <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={netSim.enabled}
              onChange={(ev) => onToggleNetSim(ev.currentTarget.checked)}
            />
            NetSim
          </label>
          <select value={netSim.presetId} onChange={(ev) => onSelectNetSimPreset(ev.currentTarget.value as NetSimPresetId)}>
            {netSimPresets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
          <button onClick={startTelemetryRecording} disabled={isTelemetryRecording || !predictionStats || !tickDebugStats}>
            {isTelemetryRecording ? 'Recording…' : 'Record 10s Telemetry'}
          </button>
        </div>
      )}

      <div style={{ marginTop: 4 }}>
        snapshotTick: {tickDebugStats?.snapshotTick ?? '—'} | simulationTick: {tickDebugStats?.simulationTick ?? '—'}
      </div>

      <div style={{ marginTop: 4 }}>
        renderTick: {tickDebugStats?.renderTick ?? '—'} | delayTicks(auto): {tickDebugStats?.delayTicks ?? '—'} | baseDelay: {tickDebugStats?.baseDelayTicks ?? '—'} (target {tickDebugStats?.baseDelayTargetTicks ?? '—'}) | range {tickDebugStats?.minDelayTicks ?? '—'}-{tickDebugStats?.maxDelayTicks ?? '—'}
      </div>

      <div style={{ marginTop: 4 }}>
        targetBuffer: {tickDebugStats?.targetBufferPairs ?? '—'} (target {tickDebugStats?.targetBufferTargetPairs ?? '—'}) | reserve: {String(tickDebugStats?.bufferHasReserve ?? false)}
      </div>

      <div style={{ marginTop: 4 }}>
        adaptiveEvery: {tickDebugStats?.adaptiveEveryTicks ?? '—'} (target {tickDebugStats?.adaptiveEveryTargetTicks ?? '—'})
      </div>

      <div style={{ marginTop: 4 }}>
        limits: delay≤{tickDebugStats?.tuning.baseDelayMax ?? '—'}, buf {tickDebugStats?.tuning.targetBufferMin ?? '—'}..{tickDebugStats?.tuning.targetBufferMax ?? '—'}, cadence {tickDebugStats?.tuning.cadenceMin ?? '—'}..{tickDebugStats?.tuning.cadenceMax ?? '—'}
      </div>

      <div style={{ marginTop: 4 }}>
        RTT: {(tickDebugStats?.rttMs ?? rttMs)?.toFixed(0) ?? '—'} ms | Jitter: {(tickDebugStats?.rttJitterMs ?? rttJitterMs).toFixed(0)} ms
      </div>

      <div style={{ marginTop: 4 }}>
        bufferSize: {tickDebugStats?.bufferSize ?? 0} | underrunRate: {((tickDebugStats?.underrunRate ?? 0) * 100).toFixed(1)}% | underruns: {tickDebugStats?.underrunCount ?? 0} | lateRate(EMA): {((tickDebugStats?.lateSnapshotEma ?? 0) * 100).toFixed(1)}% | lateCount: {tickDebugStats?.lateSnapshotCount ?? 0}
      </div>

      <div style={{ marginTop: 4 }}>
        extrapCount: {tickDebugStats?.extrapCount ?? 0} | stallCount: {tickDebugStats?.stallCount ?? 0} | extrapTicks: {tickDebugStats?.extrapolatingTicks ?? 0} | stalled: {String(tickDebugStats?.stalled ?? false)}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={onLobby}>Lobby</button>
        <button onClick={onCreateRoom}>Create Room</button>
        <button onClick={onStartMatch}>Start Match</button>
      </div>

      <div style={{ marginTop: 8 }}>
        {predictionStats
          ? `Prediction: pending=${predictionStats.pendingCount}, hardSnaps=${predictionStats.correctionCount}, softCorrections=${predictionStats.softCorrectionCount}, drift=${predictionStats.drift.toFixed(3)}, bias=(${predictionStats.biasX.toFixed(3)}, ${predictionStats.biasY.toFixed(3)}), dropped=${predictionStats.droppedInputCount}, lastAckSeq=${predictionStats.lastAckSeq}`
          : 'Prediction: —'}
      </div>

      {import.meta.env.DEV && telemetrySummary && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(0,255,0,0.25)' }}>
          <div style={{ marginBottom: 4 }}>10s Telemetry Summary ({telemetrySummary.sampleCount} samples)</div>
          <div>avg drift: {telemetrySummary.avgDrift.toFixed(3)}</div>
          <div>max drift: {telemetrySummary.maxDrift.toFixed(3)}</div>
          <div>hardCorrectionCount: {telemetrySummary.hardCorrectionCount}</div>
          <div>softCorrectionCount: {telemetrySummary.softCorrectionCount}</div>
          <div>avg pendingInputs: {telemetrySummary.avgPendingInputs.toFixed(2)}</div>
          <div>avg delayTicks: {telemetrySummary.avgDelayTicks.toFixed(2)}</div>
          <div>avg targetBufferPairs: {telemetrySummary.avgTargetBufferPairs.toFixed(2)}</div>
          <div>underrunRate: {(telemetrySummary.underrunRate * 100).toFixed(2)}%</div>
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <div style={{ marginBottom: 6 }}>Move:</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, width: 180 }}>
          <div />
          <button onClick={() => onMove('up')}>↑</button>
          <div />
          <button onClick={() => onMove('left')}>←</button>
          <button onClick={() => onMove('down')}>↓</button>
          <button onClick={() => onMove('right')}>→</button>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <div style={{ marginBottom: 6 }}>Snapshot preview:</div>
        <MiniGrid snapshot={lastSnapshot} />
      </div>

      <div style={{ marginTop: 8 }}>
        <div style={{ marginBottom: 6 }}>Last messages:</div>
        <pre style={{ maxHeight: 120, overflow: 'auto', margin: 0 }}>
          {JSON.stringify(messages.slice(-3), null, 2)}
        </pre>
      </div>
    </div>
  );
}

function MiniGrid({ snapshot }: { snapshot: any }) {
  if (!snapshot?.world) return <div style={{ opacity: 0.6 }}>No match snapshot yet.</div>;

  const gridW = snapshot.world.gridW ?? 15;
  const gridH = snapshot.world.gridH ?? 15;
  const cell = 10;

  const players = Array.isArray(snapshot.players) ? snapshot.players : [];

  return (
    <div
      style={{
        position: 'relative',
        width: gridW * cell,
        height: gridH * cell,
        border: '1px solid rgba(0,255,0,0.35)',
        backgroundSize: `${cell}px ${cell}px`,
        backgroundImage:
          'linear-gradient(to right, rgba(0,255,0,0.12) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,255,0,0.12) 1px, transparent 1px)',
      }}
    >
      {players.map((p: any) => (
        <div
          key={String(p.tgUserId)}
          title={String(p.tgUserId)}
          style={{
            position: 'absolute',
            left: (p.x ?? 0) * cell + 1,
            top: (p.y ?? 0) * cell + 1,
            width: cell - 2,
            height: cell - 2,
            background: 'rgba(0,255,0,0.65)',
            borderRadius: 3,
          }}
        />
      ))}
    </div>
  );
}
