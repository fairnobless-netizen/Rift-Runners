import { useEffect, useRef, useState } from 'react';
import { WsClient } from './wsClient';
import type { WsClientMessage, WsServerMessage } from './wsTypes';

type NetSimConfig = {
  enabled: boolean;
  latencyMs: number;
  jitterMs: number;
  dropRate: number;
};

function parseNumber(search: URLSearchParams, key: string): number | undefined {
  const raw = search.get(key);
  if (raw === null || raw.trim() === '') return undefined;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveNetSimConfig(search: string): NetSimConfig {
  const params = new URLSearchParams(search);
  const latencyMs = clamp(parseNumber(params, 'net_latency') ?? 0, 0, 500);
  const jitterMs = clamp(parseNumber(params, 'net_jitter') ?? 0, 0, 300);
  const dropRate = clamp(parseNumber(params, 'net_drop') ?? 0, 0, 0.5);
  const hasParams = params.has('net_latency') || params.has('net_jitter') || params.has('net_drop');

  return {
    enabled: import.meta.env.DEV && hasParams,
    latencyMs,
    jitterMs,
    dropRate,
  };
}

function getNetDelayMs(config: NetSimConfig): number {
  if (!config.enabled) return 0;
  if (config.jitterMs <= 0) return config.latencyMs;

  const jitterOffset = (Math.random() * 2 - 1) * config.jitterMs;
  return Math.max(0, config.latencyMs + jitterOffset);
}

function shouldDrop(config: NetSimConfig): boolean {
  if (!config.enabled) return false;
  if (config.dropRate <= 0) return false;
  return Math.random() < config.dropRate;
}

export function useWsClient(token?: string) {
  const clientRef = useRef<WsClient | null>(null);
  const netSimConfigRef = useRef<NetSimConfig>(resolveNetSimConfig(window.location.search));
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<WsServerMessage[]>([]);

  // M14.7 RTT (EMA + jitter EMA)
  const pingSeqRef = useRef(0);
  const pingSentAtRef = useRef(new Map<number, number>()); // id -> perfNow at actual send time
  const rttEmaRef = useRef<number | null>(null);
  const rttJitterEmaRef = useRef<number>(0);

  const [rttMs, setRttMs] = useState<number | null>(null);
  const [rttJitterMs, setRttJitterMs] = useState<number>(0);

  useEffect(() => {
    if (!token) return;

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const client = new WsClient({
      url: `${protocol}://${location.host}/ws`,
      token,
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onMessage: (msg) => {
        const config = netSimConfigRef.current;
        if (shouldDrop(config)) return;

        const delayMs = getNetDelayMs(config);
        window.setTimeout(() => {
          // Handle pong without polluting messages
          if (msg.type === 'pong') {
            const sentPerf = pingSentAtRef.current.get(msg.id);
            if (typeof sentPerf === 'number') {
              pingSentAtRef.current.delete(msg.id);

              const now = performance.now();
              const sample = Math.max(0, now - sentPerf);

              const prev = rttEmaRef.current;
              const alpha = 0.15;
              const next = prev == null ? sample : prev + alpha * (sample - prev);
              rttEmaRef.current = next;

              const jitterSample = prev == null ? 0 : Math.abs(sample - prev);
              const jAlpha = 0.2;
              rttJitterEmaRef.current = rttJitterEmaRef.current + jAlpha * (jitterSample - rttJitterEmaRef.current);

              setRttMs(next);
              setRttJitterMs(rttJitterEmaRef.current);
            }
            return;
          }

          setMessages((prev) => [...prev.slice(-50), msg]);
        }, delayMs);
      },
    });

    clientRef.current = client;
    client.connect();

    // Ping loop (1s). We apply net-sim delay to ping send too, so RTT reflects simulated link.
    const pingTimer = window.setInterval(() => {
      const c = clientRef.current;
      if (!c) return;

      const config = netSimConfigRef.current;
      if (shouldDrop(config)) return;

      const delayMs = getNetDelayMs(config);
      const id = ++pingSeqRef.current;

      window.setTimeout(() => {
        // stamp at actual send time (after netSim delay)
        pingSentAtRef.current.set(id, performance.now());
        const msg: WsClientMessage = { type: 'ping', id, t: Date.now() };
        c.send(msg);
      }, delayMs);
    }, 1000);

    return () => {
      window.clearInterval(pingTimer);
      pingSentAtRef.current.clear();

      client.disconnect();
      clientRef.current = null;
      setConnected(false);
    };
  }, [token]);

  return {
    connected,
    messages,
    netSimConfig: netSimConfigRef.current,
    rttMs,
    rttJitterMs,
    send: (msg: WsClientMessage) => {
      const config = netSimConfigRef.current;
      if (shouldDrop(config)) return;

      const delayMs = getNetDelayMs(config);
      window.setTimeout(() => {
        clientRef.current?.send(msg);
      }, delayMs);
    },
  };
}
