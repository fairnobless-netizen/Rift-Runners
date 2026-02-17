import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { diagnosticsStore, type DiagnosticsCategory, type DiagnosticsSnapshot } from './diagnosticsStore';

type CategoryFilter = 'ALL' | DiagnosticsCategory;

const CATEGORIES: CategoryFilter[] = ['ALL', 'WS', 'ROOM', 'AUTH', 'UI', 'NET'];

export function DiagnosticsOverlay({ enabled }: { enabled: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState<CategoryFilter>('ALL');
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot>(() => diagnosticsStore.getSnapshot());

  useEffect(() => {
    if (!enabled) return;
    setSnapshot(diagnosticsStore.getSnapshot());
    return diagnosticsStore.subscribe(() => setSnapshot(diagnosticsStore.getSnapshot()));
  }, [enabled]);

  const events = useMemo(
    () => snapshot.events.filter((event) => filter === 'ALL' || event.cat === filter),
    [filter, snapshot.events],
  );

  if (!enabled) return null;

  const onCopy = (): void => {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  const overlay = (
    <div className="rr-diag-overlay-root">
      <button type="button" className="rr-diag-pill" onClick={() => setExpanded((v) => !v)}>
        {expanded ? 'DBG ×' : 'DBG'}
      </button>

      {expanded ? (
        <section className="rr-diag-panel" aria-label="Diagnostics panel">
          <div className="rr-diag-head">
            <strong>Diagnostics</strong>
            <div className="rr-diag-actions">
              <button type="button" onClick={onCopy}>{copied ? 'Copied' : 'Copy JSON'}</button>
              <button type="button" onClick={() => diagnosticsStore.clearEvents()}>Clear</button>
            </div>
          </div>

          <div className="rr-diag-kv">
            <span>WS</span><code>{snapshot.ws.status === 'OPEN' ? 'ONLINE' : 'OFFLINE'}</code>
            <span>URL</span><code>{snapshot.ws.wsUrlUsed ?? '—'}</code>
            <span>Close</span><code>{snapshot.ws.lastCloseCode ?? '—'} · {snapshot.ws.lastCloseReason ?? '—'}</code>
            <span>Last error</span><code>{snapshot.ws.lastError ?? '—'}</code>
            <span>Room</span><code>{snapshot.room.roomCode ?? '—'} · members={snapshot.room.members} · phase={snapshot.room.phase ?? '—'}</code>
            <span>Auth</span><code>{snapshot.auth.telegramPresent ? 'telegram' : snapshot.auth.reasonIfNotTelegram ?? 'unknown'} · {snapshot.auth.userIdMasked ?? '—'} · {snapshot.auth.nickname ?? '—'}</code>
          </div>

          <div className="rr-diag-filters">
            {CATEGORIES.map((cat) => (
              <button key={cat} type="button" className={filter === cat ? 'active' : ''} onClick={() => setFilter(cat)}>{cat}</button>
            ))}
          </div>

          <div className="rr-diag-log">
            {events.length === 0 ? <div className="rr-diag-empty">No events</div> : events.slice(-200).reverse().map((event, index) => (
              <div key={`${event.ts}-${index}`} className={`rr-diag-row rr-diag-row--${event.level.toLowerCase()}`}>
                <span>{event.ts.split('T')[1]?.replace('Z', '') ?? event.ts}</span>
                <strong>{event.level}</strong>
                <em>{event.cat}</em>
                <span>{event.msg}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );

  return createPortal(overlay, document.body);
}
