import { useEffect, useMemo, useRef, useState } from 'react';
import type { NetSimConfig, NetSimPresetId } from '../ws/useWsClient';
import type { WsDebugMetrics } from '../ws/wsTypes';
import { triggerDebugDrift } from '../game/LocalPredictionController';
import { isDebugEnabled } from '../debug/debugFlags';

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
  ackLastInputSeq?: number;
  localMode?: string;
  localRenderDriftTiles?: number;
  localSnapCount?: number;
};

function formatPredictionLine(localInputSeq: number, ps: PredictionStats): string {
  const ackLastInputSeq = ps.ackLastInputSeq ?? ps.lastAckSeq;
  const unacked = Math.max(0, localInputSeq - ackLastInputSeq);
  return `Prediction: mode=${ps.localMode ?? 'predicted'}, inputSeq=${localInputSeq}, ack(lastInputSeq)=${ackLastInputSeq}, unacked=${unacked}, predErr=${(ps.predictionError ?? 0).toFixed(3)}, predErrEma=${(ps.predictionErrorEma ?? 0).toFixed(3)}, hardT=(${(ps.predHardEnter ?? 0).toFixed(2)}/${(ps.predHardExit ?? 0).toFixed(2)}), hist=${ps.historySize ?? 0}, missHist=${ps.missingHistoryCount ?? 0}, reason=${ps.reconcileReason ?? 'none'}, hardSnaps=${ps.correctionCount}, softCorrections=${ps.softCorrectionCount}, drift=${ps.drift.toFixed(3)}, renderDrift=${(ps.localRenderDriftTiles ?? 0).toFixed(3)}, localSnaps=${ps.localSnapCount ?? 0}, bias=(${ps.biasX.toFixed(3)}, ${ps.biasY.toFixed(3)}), dropped=${ps.droppedInputCount}`;
}


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
  ackLastInputSeq,
  getLocalPlayerPosition,
  inspectorEnabled,
  onToggleInspector,
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
  tickDebugStats: WsDebugMetrics | null;
  rttMs: number | null;
  rttJitterMs: number;
  onCreateRoom: () => void;
  onStartMatch: () => void;
  onMove: (dir: 'up' | 'down' | 'left' | 'right') => void;
  localInputSeq: number;
  ackLastInputSeq: number;
  getLocalPlayerPosition?: () => { x: number; y: number } | null;
  inspectorEnabled: boolean;
  onToggleInspector: () => void;
}) {
  const debugUiFlag = String(import.meta.env.VITE_DEBUG_UI ?? '').trim().toLowerCase();
  const probeModeFlag = String(import.meta.env.VITE_PROBE_MODE ?? '').trim().toLowerCase();
  const [isExplicitDebugEnabled, setIsExplicitDebugEnabled] = useState(false);
  const showDebugUi = debugUiFlag === '1' || debugUiFlag === 'true' || import.meta.env.DEV || isExplicitDebugEnabled;
  const isProbeRoute = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('probe') === '1' || window.location.pathname === '/__probe';
  }, []);
  const showProbeUi = probeModeFlag === 'true' && isProbeRoute;


  useEffect(() => {
    if (typeof window === 'undefined') return;
    setIsExplicitDebugEnabled(isDebugEnabled(window.location.search));
  }, []);

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

  // --- M16.26b tray state (persisted) ---
  const TRAY_STORAGE_KEY = 'ws-debug-overlay-collapsed';

  const [trayCollapsed, setTrayCollapsed] = useState<boolean>(() => {
    // SSR-safe default: collapsed
    return true;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(TRAY_STORAGE_KEY);
      if (raw === null) return;
      setTrayCollapsed(raw === '1' || raw === 'true');
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(TRAY_STORAGE_KEY, trayCollapsed ? '1' : '0');
    } catch {
      // ignore
    }
  }, [trayCollapsed]);

  const [moveCollapsed, setMoveCollapsed] = useState(true);
  const [snapshotCollapsed, setSnapshotCollapsed] = useState(true);

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
          ack: ackLastInputSeq,
          unacked: Math.max(0, latestLocalInputSeqRef.current - ackLastInputSeq),
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

  const latestStatsRef = useRef<{ predictionStats: PredictionStats | null; tickDebugStats: WsDebugMetrics | null }>({
    predictionStats: predictionStats ? { ...predictionStats, ackLastInputSeq } : null,
    tickDebugStats,
  });

  useEffect(() => {
    latestStatsRef.current = {
      predictionStats: predictionStats ? { ...predictionStats, ackLastInputSeq } : null,
      tickDebugStats,
    };
  }, [predictionStats, tickDebugStats, ackLastInputSeq]);

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
    <div
      // IMPORTANT: out-of-flow overlay root, anchored to nearest positioned parent (.page)
      style={{
        position: 'fixed',
        inset: 0,
        // GDX: keep probe/debug controls above any modal overlays for E2E clickability.
        zIndex: 2147483647,
        pointerEvents: 'none', // root does not steal input
      }}
    >
      {/* Bottom-left tray chip (debug-only controls) */}
      {showDebugUi && (
        <div
          style={{
            position: 'fixed',
            left: 10,
            bottom: 10,
            // GDX: ensure tray itself sits above overlay stacking contexts.
            zIndex: 2147483647,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
              padding: '8px 10px',
              borderRadius: 999,
              background: 'rgba(0,0,0,0.78)',
              border: '1px solid rgba(255,255,255,0.12)',
              pointerEvents: 'auto', // interactive children enabled
            }}
          >
            {showProbeUi ? (
              <button data-testid="probe-btn" onClick={runProbe}>
                Probe 20 moves
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => setTrayCollapsed((v) => !v)}
              aria-label={trayCollapsed ? 'Expand WS debug panel' : 'Collapse WS debug panel'}
              title={trayCollapsed ? 'Expand WS debug panel' : 'Collapse WS debug panel'}
            >
              {trayCollapsed ? 'WS ▸' : 'WS ▾'}
            </button>
            <button
              type="button"
              onClick={onToggleInspector}
              aria-label={inspectorEnabled ? 'Hide multiplayer inspector' : 'Show multiplayer inspector'}
              title={inspectorEnabled ? 'Hide multiplayer inspector' : 'Show multiplayer inspector'}
            >
              {inspectorEnabled ? 'MP ▾' : 'MP ▸'}
            </button>
          </div>

          {showProbeUi && probeSummary && (
            <div
              data-testid="probe-summary"
              style={{
                marginTop: 8,
                padding: 6,
                fontSize: 12,
                borderRadius: 8,
                background: probeSummary.pass ? '#0b3d1a' : '#3d0b0b',
                color: probeSummary.pass ? '#5cff8d' : '#ff6b6b',
                pointerEvents: 'auto',
                maxWidth: 420,
              }}
            >
              Probe result: moved={probeSummary.moved}, blocked={probeSummary.blocked} —{' '}
              {probeSummary.pass ? 'PASS' : 'FAIL'}
            </div>
          )}
        </div>
      )}

      {/* Top-right expanded panel (ONLY when debug UI enabled + tray expanded) */}
      {showDebugUi && !trayCollapsed && (
        <div
          style={{
            position: 'absolute',
            right: 10,
            top: 10,
            width: 340,
            background: 'rgba(0,0,0,0.82)',
            color: '#0f0',
            fontSize: 12,
            padding: 10,
            zIndex: 9999,
            borderRadius: 10,
            pointerEvents: 'auto', // interactive
            maxHeight: '88vh',
            overflow: 'auto',
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
            NetSim: {netSim.enabled ? 'ON' : 'OFF'} | latency={netSim.latencyMs}ms, jitter={netSim.jitterMs}ms,
            drop={netSim.dropRate}
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
              <select
                value={netSim.presetId}
                onChange={(ev) => onSelectNetSimPreset(ev.currentTarget.value as NetSimPresetId)}
              >
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
            serverTick: {tickDebugStats?.serverTick ?? '—'} | snapshotTick: {tickDebugStats?.snapshotTick ?? '—'} | appliedSnapshotTick: {tickDebugStats?.lastAppliedSnapshotTick ?? '—'} | lastEventTick: {tickDebugStats?.lastEventTick ?? '—'} | simulationTick: {tickDebugStats?.simulationTick ?? '—'}
          </div>

          <div style={{ marginTop: 4 }}>
            renderTick: {tickDebugStats?.renderTick ?? '—'} | delayTicks(auto): {tickDebugStats?.delayTicks ?? '—'} | baseDelay:{' '}
            {tickDebugStats?.baseDelayTicks ?? '—'} (target {tickDebugStats?.baseDelayTargetTicks ?? '—'}) | range{' '}
            {tickDebugStats?.minDelayTicks ?? '—'}-{tickDebugStats?.maxDelayTicks ?? '—'}
          </div>

          <div style={{ marginTop: 4 }}>
            targetBuffer: {tickDebugStats?.targetBufferPairs ?? '—'} (target {tickDebugStats?.targetBufferTargetPairs ?? '—'}) | reserve:{' '}
            {String(tickDebugStats?.bufferHasReserve ?? false)}
          </div>

          <div style={{ marginTop: 4 }}>
            adaptiveEvery: {tickDebugStats?.adaptiveEveryTicks ?? '—'} (target {tickDebugStats?.adaptiveEveryTargetTicks ?? '—'})
          </div>

          <div style={{ marginTop: 4 }}>
            limits: delay≤{tickDebugStats?.tuning.baseDelayMax ?? '—'}, buf {tickDebugStats?.tuning.targetBufferMin ?? '—'}..{tickDebugStats?.tuning.targetBufferMax ?? '—'},
            cadence {tickDebugStats?.tuning.cadenceMin ?? '—'}..{tickDebugStats?.tuning.cadenceMax ?? '—'}
          </div>

          <div style={{ marginTop: 4 }}>
            RTT: {(tickDebugStats?.rttMs ?? rttMs)?.toFixed(0) ?? '—'} ms | Jitter: {(tickDebugStats?.rttJitterMs ?? rttJitterMs).toFixed(0)} ms
          </div>

          <div style={{ marginTop: 4 }}>
            bufferSize: {tickDebugStats?.bufferSize ?? 0} | underrunRate: {((tickDebugStats?.underrunRate ?? 0) * 100).toFixed(1)}% | underruns: {tickDebugStats?.underrunCount ?? 0} | lateRate(EMA):{' '}
            {((tickDebugStats?.lateSnapshotEma ?? 0) * 100).toFixed(1)}% | lateCount: {tickDebugStats?.lateSnapshotCount ?? 0}
          </div>

          <div style={{ marginTop: 4 }}>
            droppedWrongRoom: {tickDebugStats?.droppedWrongRoom ?? 0} | invalidPosDrops: {tickDebugStats?.invalidPosDrops ?? 0} | lastSnapshotRoom: {tickDebugStats?.lastSnapshotRoom ?? '—'}
          </div>
          <div>
            eventsBuffered: {tickDebugStats?.eventsBuffered ?? 0} | eventsDroppedDup: {tickDebugStats?.eventsDroppedDup ?? 0} | eventsDroppedOutOfOrder: {tickDebugStats?.eventsDroppedOutOfOrder ?? 0}
          </div>
          <div>
            worldReady: {tickDebugStats?.worldReady ? 'yes' : 'no'} | worldHashServer: {tickDebugStats?.worldHashServer ?? '—'} | worldHashClient: {tickDebugStats?.worldHashClient ?? '—'}
          </div>
          <div>
            needsNetResync: {String(tickDebugStats?.needsNetResync ?? false)} | netResyncReason: {tickDebugStats?.netResyncReason ?? '—'}
          </div>
          <div>
            bombGated: {String(tickDebugStats?.bombInputGated ?? false)} | bombGateReason: {tickDebugStats?.bombGateReason ?? '—'}
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
            {predictionStats
              ? formatPredictionLine(localInputSeq, { ...predictionStats, ackLastInputSeq })
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

          <div style={{ marginTop: 8 }}>
            <button onClick={() => setMoveCollapsed((v) => !v)} style={{ marginBottom: 6 }}>
              {moveCollapsed ? 'Move ▸' : 'Move ▾'}
            </button>
            {!moveCollapsed && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, width: 140 }}>
                <div />
                <button onClick={() => onMove('up')}>↑</button>
                <div />
                <button onClick={() => onMove('left')}>←</button>
                <button onClick={() => onMove('down')}>↓</button>
                <button onClick={() => onMove('right')}>→</button>
              </div>
            )}
          </div>

          <div style={{ marginTop: 8 }}>
            <button onClick={() => setSnapshotCollapsed((v) => !v)} style={{ marginBottom: 6 }}>
              {snapshotCollapsed ? 'Snapshot preview ▸' : 'Snapshot preview ▾'}
            </button>
            {!snapshotCollapsed && <MiniGrid snapshot={lastSnapshot} compact />}
          </div>

          <div style={{ marginTop: 8 }}>
            <div style={{ marginBottom: 6 }}>Last messages:</div>
            <pre style={{ maxHeight: 240, overflow: 'auto', margin: 0 }}>
              {JSON.stringify(messages.slice(-20), null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function MiniGrid({ snapshot, compact = false }: { snapshot: any; compact?: boolean }) {
  if (!snapshot?.world) return <div style={{ opacity: 0.6 }}>No match snapshot yet.</div>;

  const gridW = snapshot.world.gridW ?? 15;
  const gridH = snapshot.world.gridH ?? 15;
  const cell = compact ? 2 : 10;

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
