import type { JSX } from 'react';

type ConnectionStatus = 'connected' | 'reconnecting' | 'offline';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: 'WS: connected',
  reconnecting: 'WS: reconnecting',
  offline: 'WS: offline',
};

export function ConnectionStatusBadge({ status }: { status: ConnectionStatus }): JSX.Element {
  return (
    <div className={`connection-status-badge connection-status-badge--${status}`} role="status" aria-live="polite">
      {STATUS_LABEL[status]}
    </div>
  );
}
