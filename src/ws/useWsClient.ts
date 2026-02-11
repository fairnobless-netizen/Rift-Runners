import { useEffect, useRef, useState } from 'react';
import { WsClient } from './wsClient';
import type { WsClientMessage, WsServerMessage } from './wsTypes';

export function useWsClient(token?: string) {
  const clientRef = useRef<WsClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<WsServerMessage[]>([]);

  useEffect(() => {
    if (!token) return;

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const client = new WsClient({
      url: `${protocol}://${location.host}/ws`,
      token,
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onMessage: (msg) => {
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
