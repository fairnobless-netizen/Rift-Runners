import { useMemo } from 'react';
import type { WsInboundTraceEntry, WsOutboundTraceEntry, WsDebugMetrics } from '../ws/wsTypes';

type InspectorBinding = {
  currentRoomCode: string | null;
  expectedMatchId: string | null;
  worldReady: boolean;
  lastWorldInitAt: number | null;
  lastSnapshotAt: number | null;
  lastRecvSnapshotTick: number | null;
  lastAppliedSnapshotTick: number | null;
  bufferedSnapshotsCount: number;
  wrongRoomDrops: number;
  wrongMatchDrops: number;
  duplicateTickDrops: number;
  invalidPosDrops: number;
};

function fmtAgo(ts: number | null): string {
  if (!ts) return '—';
  const sec = Math.max(0, (Date.now() - ts) / 1000);
  return `${sec.toFixed(1)}s ago`;
}

function fmtMeta(msg: { type: string; [key: string]: unknown }): string {
  if (msg.type === 'match:snapshot') {
    const snap = (msg as any).snapshot;
    return `room=${snap?.roomCode ?? '—'} match=${snap?.matchId ?? '—'} tick=${snap?.tick ?? '—'}`;
  }
  if (msg.type === 'match:world_init') {
    return `room=${(msg as any).roomCode ?? '—'} match=${(msg as any).matchId ?? '—'}`;
  }
  return `room=${(msg as any).roomCode ?? (msg as any).roomId ?? '—'} match=${(msg as any).matchId ?? '—'} seq=${(msg as any).seq ?? '—'}`;
}

export function MultiplayerInspectorOverlay({
  connected,
  identity,
  inboundTrace,
  outboundTrace,
  tickDebugStats,
  binding,
}: {
  connected: boolean;
  identity: { tgUserId?: string; clientId?: number; displayName?: string };
  inboundTrace: WsInboundTraceEntry[];
  outboundTrace: WsOutboundTraceEntry[];
  tickDebugStats: WsDebugMetrics | null;
  binding: InspectorBinding;
}) {
  const inbound = useMemo(() => inboundTrace.slice(-20).reverse(), [inboundTrace]);
  const outbound = useMemo(() => outboundTrace.slice(-20).reverse(), [outboundTrace]);

  const snapshotsPerSec = useMemo(() => {
    const now = Date.now();
    const last10s = inboundTrace.filter((entry) => now - entry.at <= 10_000 && entry.message.type === 'match:snapshot').length;
    return (last10s / 10).toFixed(1);
  }, [inboundTrace]);

  return (
    <div
      style={{
        position: 'absolute',
        right: 380,
        top: 10,
        width: 420,
        maxHeight: '88vh',
        overflow: 'auto',
        background: 'rgba(7,10,20,0.9)',
        color: '#b8ecff',
        borderRadius: 10,
        padding: 10,
        fontSize: 12,
        pointerEvents: 'auto',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Multiplayer Inspector</div>
      <div>connected: {String(connected)}</div>
      <div>identity: tgUserId={identity.tgUserId ?? '—'} clientId={identity.clientId ?? '—'} name={identity.displayName ?? '—'}</div>
      <div>roomCode={binding.currentRoomCode ?? '—'} expectedMatchId={binding.expectedMatchId ?? '—'}</div>
      <div>worldReady={String(binding.worldReady)} lastWorldInitAt={fmtAgo(binding.lastWorldInitAt)} lastSnapshotAt={fmtAgo(binding.lastSnapshotAt)}</div>
      <div>recvTick={binding.lastRecvSnapshotTick ?? '—'} appliedTick={binding.lastAppliedSnapshotTick ?? '—'}</div>
      <div>serverTick={tickDebugStats?.serverTick ?? '—'} snapshotTick={tickDebugStats?.snapshotTick ?? '—'} snapshots/sec~{snapshotsPerSec}</div>

      <div style={{ marginTop: 8, borderTop: '1px solid rgba(184,236,255,0.2)', paddingTop: 8 }}>
        <div style={{ fontWeight: 700 }}>Counters</div>
        <div>wrongRoomDrops={binding.wrongRoomDrops} wrongMatchDrops={binding.wrongMatchDrops} duplicateTickDrops={binding.duplicateTickDrops}</div>
        <div>bufferedSnapshots={binding.bufferedSnapshotsCount} invalidPosDrops={binding.invalidPosDrops}</div>
      </div>

      <div style={{ marginTop: 8, borderTop: '1px solid rgba(184,236,255,0.2)', paddingTop: 8 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Inbound (Back→Front)</div>
        <div style={{ display: 'grid', gap: 4 }}>
          {inbound.map((entry, i) => (
            <div key={`${entry.at}-${i}`} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 6, padding: 6 }}>
              <div>{((Date.now() - entry.at) / 1000).toFixed(1)}s · {entry.message.type}</div>
              <div style={{ opacity: 0.85 }}>{fmtMeta(entry.message as any)}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 8, borderTop: '1px solid rgba(184,236,255,0.2)', paddingTop: 8 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Outbound (Front→Back)</div>
        <div style={{ display: 'grid', gap: 4 }}>
          {outbound.map((entry, i) => (
            <div key={`${entry.at}-${i}`} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 6, padding: 6 }}>
              <div>{((Date.now() - entry.at) / 1000).toFixed(1)}s · {entry.message.type}</div>
              <div style={{ opacity: 0.85 }}>{fmtMeta(entry.message as any)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
