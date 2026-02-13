import { useEffect, useMemo, useRef, useState } from 'react';
import type { NetSimConfig, NetSimPresetId } from '../ws/useWsClient';
import { triggerDebugDrift } from '../game/LocalPredictionController';

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

  // M16.2.1
  predictionError?: number;
  predictionErrorEma?: number;
  historySize?: number;
  missingHistoryCount?: number;
  reconcileReason?: 'none' | 'soft' | 'hard';
};

function formatPredictionLine(localInputSeq: number, ps: PredictionStats): string {
  return `Prediction: inputSeq=${localInputSeq}, ack(lastInputSeq)=${ps.lastAckSeq}, unacked=${ps.pendingCount}, predErr=${(ps.predictionError ?? 0).toFixed(3)}, predErrEma=${(ps.predictionErrorEma ?? 0).toFixed(3)}, hardT=(${(ps.predHardEnter ?? 0).toFixed(2)}/${(ps.predHardExit ?? 0).toFixed(2)}), hist=${ps.historySize ?? 0}, missHist=${ps.missingHistoryCount ?? 0}, reason=${ps.reconcileReason ?? 'none'}, hardSnaps=${ps.correctionCount}, softCorrections=${ps.softCorrectionCount}, drift=${ps.drift.toFixed(3)}, bias=(${ps.biasX.toFixed(3)}, ${ps.biasY.toFixed(3)}), dropped=${ps.droppedInputCount}`;
}

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

type TelemetrySample = {
  drift: number;
  hardCorrectionCount: number;
  softCorrectionCount: number;
  pendingInputs: number;
  delayTicks: number;
  targetBufferPairs: number;
  underrunRate: number;
};

type TelemetryExportSnapshot = {
  createdAt: string;
  presetName: string;
  netSimConfig: {
    latencyMs: number;
    jitterMs: number;
    drop: number;
  };
  wsStatus: {
    connected: boolean;
  };
  captureWindow: {
    sampleCount: number;
    durationMs: number;
    cadenceMs: number;
  };
  summary: TelemetrySnapshotSummary;
  samples?: TelemetrySample[];
};

type TelemetryRun = TelemetryExportSnapshot;

const TELEMETRY_DURATION_MS = 10_000;
const TELEMETRY_CADENCE_MS = 100;

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
  localInputSeq,
  getLocalPlayerPosition,
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
  localInputSeq: number;
  getLocalPlayerPosition?: () => { x: number; y: number } | null;
}) {
  const debugUiFlag = String(import.meta.env.VITE_DEBUG_UI ?? '').trim().toLowerCase();
  const showDebugUi = debugUiFlag === '1' || debugUiFlag === 'true' || import.meta.env.DEV;

  const lastSnapshot = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.type === 'match:snapshot') return m.snapshot;
    }
    return null;
  }, [messages]);

  const [isTelemetryRecording, setIsTelemetryRecording] = useState(false);
  const [telemetrySummary, setTelemetrySummary] = useState<TelemetrySnapshotSummary | null>(null);
  const [telemetryExportSnapshot, setTelemetryExportSnapshot] = useState<TelemetryExportSnapshot | null>(null);
  const [telemetryRuns, setTelemetryRuns] = useState<TelemetryRun[]>([]);
  const [probeSummary, setProbeSummary] = useState<{
    moved: number;
    blocked: number;
    pass: boolean;
  } | null>(null);
  const telemetrySamplesRef = useRef<TelemetrySample[]>([]);
  const telemetryTimeoutRef = useRef<number | null>(null);

  // --- M16.2.1 probe ---
  const latestPredictionStatsRef = useRef<PredictionStats | null>(null);
  const latestLocalInputSeqRef = useRef<number>(0);

  useEffect(() => {
    latestPredictionStatsRef.current = predictionStats ?? null;
  }, [predictionStats]);

  useEffect(() => {
    latestLocalInputSeqRef.current = localInputSeq;
  }, [localInputSeq]);

  const downloadJson = (data: unknown, filename: string) => {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runProbe = () => {
    setProbeSummary(null);

    const steps = 20;
    const intervalMs = 80;
    const dirs: Array<'up' | 'down' | 'left' | 'right'> = [
      // Phase A: try to force collisions (hammer a direction)
      ...Array(6).fill('right'),
      ...Array(6).fill('left'),
      ...Array(6).fill('down'),
      // Phase B: small zig-zag (ensures mixed moved/blocked near obstacles)
      'right', 'right', 'down', 'left', 'left', 'down',
    ];

    const getLocalPlayerPos = () => {
      const players = Array.isArray(lastSnapshot?.players) ? lastSnapshot.players : [];
      const localId = identity.clientId ?? identity.id;
      if (localId === undefined || localId === null) return null;
      const me = players.find((player: any) => String(player?.tgUserId) === String(localId));
      if (!me || typeof me.x !== 'number' || typeof me.y !== 'number') return null;
      return { x: me.x, y: me.y };
    };

    const samples: any[] = [];
    let i = 0;

    const timer = window.setInterval(() => {
      const dir = dirs[i % dirs.length];
      const before = getLocalPlayerPosition?.() ?? getLocalPlayerPos();
      onMove(dir);

      // sample after move has been queued (next tick)
      window.setTimeout(() => {
        const ps = latestPredictionStatsRef.current;
        const after = getLocalPlayerPosition?.() ?? getLocalPlayerPos();

        const moved =
          before && after ? before.x !== after.x || before.y !== after.y : false;

        const blocked = Boolean(before && after && !moved);

        samples.push({
          t: Date.now(),
          step: i + 1,
          dir,
          from: before,
          to: after,
          moved,
          blocked,
          inputSeq: latestLocalInputSeqRef.current,
          ack: ps?.lastAckSeq ?? null,
          unacked: ps?.pendingCount ?? null,
          predErr: ps?.predictionError ?? null,
          predErrEma: ps?.predictionErrorEma ?? null,
          reason: ps?.reconcileReason ?? null,
          predHardEnter: ps?.predHardEnter ?? null,
          predHardExit: ps?.predHardExit ?? null,
          hist: ps?.historySize ?? null,
          missHist: ps?.missingHistoryCount ?? null,
          drift: ps?.drift ?? null,
        });
      }, 0);

      i += 1;
      if (i >= steps) {
        window.clearInterval(timer);

        // finalize after a short delay to catch last render
        window.setTimeout(() => {
          const movedCount = samples.filter((s) => s.moved).length;
          const blockedCount = samples.filter((s) => s.blocked).length;
          const pass = movedCount >= 3 && blockedCount >= 3;

          setProbeSummary({
            moved: movedCount,
            blocked: blockedCount,
            pass,
          });

          const payload = {
            createdAt: new Date().toISOString(),
            steps,
            intervalMs,
            samples,
          };

          (window as any).__probeLastResult = payload;

          downloadJson(payload, `m16_2_1_probe_${Date.now()}.json`);
        }, 150);
      }
    }, intervalMs);
  };

  const sanitizePreset = (preset: string) => preset.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_]/g, '');

  const formatExportTimestamp = (createdAt: string) =>
    createdAt.replace(/:/g, '-').replace('T', '_').replace(/\.\d+Z$/, '').replace('Z', '');

  const triggerJsonDownload = (data: unknown, filename: string) => {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const downloadTelemetryRun = (run: TelemetryRun) => {
    const filename = `rift_telemetry_${sanitizePreset(run.presetName)}_${formatExportTimestamp(run.createdAt)}.json`;
    triggerJsonDownload(run, filename);
  };

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
    }, TELEMETRY_CADENCE_MS);

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
      setTelemetryExportSnapshot(null);
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

    const presetName = netSimPresets.find((preset) => preset.id === netSim.presetId)?.label ?? netSim.presetId;
    const nextRun: TelemetryRun = {
      createdAt: new Date().toISOString(),
      presetName,
      netSimConfig: {
        latencyMs: netSim.latencyMs,
        jitterMs: netSim.jitterMs,
        drop: netSim.dropRate,
      },
      wsStatus: {
        connected,
      },
      captureWindow: {
        sampleCount: summary.sampleCount,
        durationMs: TELEMETRY_DURATION_MS,
        cadenceMs: TELEMETRY_CADENCE_MS,
      },
      summary,
      samples,
    };

    setTelemetryExportSnapshot(nextRun);
    if (import.meta.env.DEV) {
      setTelemetryRuns((prev) => [...prev, nextRun].slice(-20));
    }

    setTelemetrySummary(summary);
    setIsTelemetryRecording(false);
  };

  const startTelemetryRecording = () => {
    telemetrySamplesRef.current = [];
    setTelemetrySummary(null);
    setTelemetryExportSnapshot(null);
    setIsTelemetryRecording(true);
    if (telemetryTimeoutRef.current !== null) {
      window.clearTimeout(telemetryTimeoutRef.current);
    }
    telemetryTimeoutRef.current = window.setTimeout(() => {
      finishTelemetryRecording();
    }, TELEMETRY_DURATION_MS);
  };

  const handleDownloadTelemetryJson = () => {
    if (!telemetryExportSnapshot) return;

    downloadTelemetryRun(telemetryExportSnapshot);
  };

  const handleDownloadAllTelemetryRunsJson = () => {
    if (telemetryRuns.length === 0) return;
    const filename = `rift_telemetry_all_${formatExportTimestamp(new Date().toISOString())}.json`;
    triggerJsonDownload(telemetryRuns, filename);
  };

  const formatRunTime = (iso: string) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleTimeString('en-GB', { hour12: false });
  };

  return (
    <>
      <div
        style={{
          position: 'fixed',
          right: 10,
          bottom: 10,
          zIndex: 10000,
          pointerEvents: 'none',
        }}
      >
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', pointerEvents: 'auto' }}>
          <button data-testid="probe-btn" onClick={runProbe}>Probe 20 moves</button>
        </div>

        {probeSummary && (
          <div
            data-testid="probe-summary"
            style={{
              marginTop: 8,
              padding: 6,
              fontSize: 12,
              borderRadius: 6,
              background: probeSummary.pass ? '#0b3d1a' : '#3d0b0b',
              color: probeSummary.pass ? '#5cff8d' : '#ff6b6b',
              pointerEvents: 'auto',
            }}
          >
            Probe result: moved={probeSummary.moved}, blocked={probeSummary.blocked} — {probeSummary.pass ? 'PASS' : 'FAIL'}
          </div>
        )}
      </div>

      {showDebugUi && (
        <div
          style={{
            position: 'fixed',
            right: 10,
            bottom: 64,
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
          <button onClick={handleDownloadTelemetryJson} disabled={!telemetryExportSnapshot || isTelemetryRecording}>
            Download JSON
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

      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button onClick={onLobby}>Lobby</button>
        <button onClick={onCreateRoom}>Create Room</button>
        <button onClick={onStartMatch}>Start Match</button>
        {import.meta.env.DEV && <button onClick={() => triggerDebugDrift(10)}>Force Drift (10 ticks)</button>}
      </div>

      <div style={{ marginTop: 8 }}>
        {predictionStats ? formatPredictionLine(localInputSeq, predictionStats) : 'Prediction: —'}
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

          <div style={{ marginTop: 8, marginBottom: 4 }}>Telemetry Runs ({telemetryRuns.length}/20)</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <button onClick={handleDownloadAllTelemetryRunsJson} disabled={telemetryRuns.length === 0 || isTelemetryRecording}>
              Download All JSON
            </button>
            <button onClick={() => setTelemetryRuns([])} disabled={telemetryRuns.length === 0 || isTelemetryRecording}>
              Clear
            </button>
          </div>

          {telemetryRuns.length === 0 ? (
            <div style={{ opacity: 0.75 }}>No telemetry runs recorded yet.</div>
          ) : (
            <div style={{ maxHeight: 180, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>time</th>
                    <th style={{ textAlign: 'left' }}>preset</th>
                    <th style={{ textAlign: 'right' }}>avgDrift</th>
                    <th style={{ textAlign: 'right' }}>maxDrift</th>
                    <th style={{ textAlign: 'right' }}>hard</th>
                    <th style={{ textAlign: 'right' }}>soft</th>
                    <th style={{ textAlign: 'right' }}>avgDelay</th>
                    <th style={{ textAlign: 'right' }}>avgBuf</th>
                    <th style={{ textAlign: 'right' }}>underrunRate</th>
                    <th style={{ textAlign: 'left' }}>action</th>
                  </tr>
                </thead>
                <tbody>
                  {[...telemetryRuns].reverse().map((run) => (
                    <tr key={`${run.createdAt}-${run.presetName}`}>
                      <td>{formatRunTime(run.createdAt)}</td>
                      <td>{run.presetName}</td>
                      <td style={{ textAlign: 'right' }}>{run.summary.avgDrift.toFixed(3)}</td>
                      <td style={{ textAlign: 'right' }}>{run.summary.maxDrift.toFixed(3)}</td>
                      <td style={{ textAlign: 'right' }}>{run.summary.hardCorrectionCount}</td>
                      <td style={{ textAlign: 'right' }}>{run.summary.softCorrectionCount}</td>
                      <td style={{ textAlign: 'right' }}>{run.summary.avgDelayTicks.toFixed(2)}</td>
                      <td style={{ textAlign: 'right' }}>{run.summary.avgTargetBufferPairs.toFixed(2)}</td>
                      <td style={{ textAlign: 'right' }}>{(run.summary.underrunRate * 100).toFixed(2)}%</td>
                      <td>
                        <button onClick={() => downloadTelemetryRun(run)} disabled={isTelemetryRecording}>
                          Download
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
      )}
    </>
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
