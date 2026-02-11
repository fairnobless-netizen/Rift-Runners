import type { WsServerMessage } from '../ws/wsTypes';

type WsDebugOverlayProps = {
  connected: boolean;
  messages: WsServerMessage[];
  onLobby: () => void;
  onCreateRoom: () => void;
  onStartMatch: () => void;
};

export function WsDebugOverlay({
  connected,
  messages,
  onLobby,
  onCreateRoom,
  onStartMatch,
}: WsDebugOverlayProps) {
  return (
    <div
      style={{
        position: 'fixed',
        right: 10,
        bottom: 10,
        width: 320,
        maxHeight: 300,
        overflow: 'auto',
        background: 'rgba(0,0,0,0.8)',
        color: '#0f0',
        fontSize: 12,
        padding: 8,
        zIndex: 9999,
      }}
    >
      <div>WS: {connected ? 'CONNECTED' : 'OFFLINE'}</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button type="button" onClick={onLobby}>Lobby</button>
        <button type="button" onClick={onCreateRoom}>Create Room</button>
        <button type="button" onClick={onStartMatch}>Start Match</button>
      </div>
      <pre>{JSON.stringify(messages.slice(-5), null, 2)}</pre>
    </div>
  );
}
