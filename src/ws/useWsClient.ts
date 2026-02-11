import { useEffect, useRef, useState } from 'react';
import { WsClient } from './wsClient';
import type { MatchSnapshotV1, WsClientMessage, WsServerMessage } from './wsTypes';

type UseWsClientOptions = {
  onSnapshot?: (snapshot: MatchSnapshotV1) => void;
};

export function useWsClient(token?: string, opts: UseWsClientOptions = {}) {
  const clientRef = useRef<WsClient | null>(null);
  const onSnapshotRef = useRef(opts.onSnapshot);
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<WsServerMessage[]>([]);

  useEffect(() => {
    onSnapshotRef.current = opts.onSnapshot;
  }, [opts.onSnapshot]);

  useEffect(() => {
    if (!token) return;

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const client = new WsClient({
      url: `${protocol}://${location.host}/ws`,
      token,
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onMessage: (msg) => {
        if (msg.type === 'match:snapshot') {
          onSnapshotRef.current?.(msg.snapshot);
        }
        setMessages((prev) => [...prev.slice(-50), msg]);
      },
    });

    clientRef.current = client;
    client.connect();

    return () => {
      client.disconnect();
      clientRef.current = null;
      setConnected(false);
    };
  }, [token]);

  return {
    connected,
    messages,
    send: (msg: WsClientMessage) => clientRef.current?.send(msg),
  };
}
