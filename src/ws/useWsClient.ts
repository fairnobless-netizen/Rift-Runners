import { useEffect, useRef, useState } from 'react';
import { diagnosticsStore } from '../debug/diagnosticsStore';
import { WsClient } from './wsClient';
import type {
  WsClientMessage,
  WsInboundTraceEntry,
  WsOutboundTraceEntry,
  WsServerMessage,
  WsTraceContext,
} from './wsTypes';

export type NetSimPresetId = 'good-wifi' | '4g-ok' | 'bad-4g' | 'train';


type BombEventNetStats = {
  serverTick: number;
  lastEventTick: number;
  eventsBuffered: number;
  eventsDroppedDup: number;
  eventsDroppedOutOfOrder: number;
};

type NetSimPreset = {
  id: NetSimPresetId;
  label: string;
  latencyMs: number;
  jitterMs: number;
  dropRate: number;
};

const NET_SIM_PRESETS: NetSimPreset[] = [
  { id: 'good-wifi', label: 'Good WiFi', latencyMs: 20, jitterMs: 8, dropRate: 0.005 },
  { id: '4g-ok', label: '4G OK', latencyMs: 70, jitterMs: 22, dropRate: 0.02 },
  { id: 'bad-4g', label: 'Bad 4G', latencyMs: 140, jitterMs: 70, dropRate: 0.08 },
  { id: 'train', label: 'Train', latencyMs: 220, jitterMs: 120, dropRate: 0.16 },
];

const DEFAULT_BACKEND_HOST = 'rift-runners-backend.onrender.com';

function normalizeWsUrl(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  try {
    const normalized = new URL(trimmed);
    if (normalized.protocol !== 'ws:' && normalized.protocol !== 'wss:') return null;
    if (normalized.pathname === '/' || normalized.pathname === '') {
      normalized.pathname = '/ws';
    }
    return normalized.toString();
  } catch {
    return null;
  }
}

function inferDevBackendWsUrl(): string | null {
  if (!import.meta.env.DEV) return null;

  try {
    const current = new URL(window.location.href);
    const guessed = new URL(current.href);
    guessed.protocol = current.protocol === 'https:' ? 'wss:' : 'ws:';
    guessed.pathname = '/ws';
    guessed.search = '';
    guessed.hash = '';

    const hostLooksLikeVite = current.port === '5173' || current.port === '5174' || current.hostname === 'localhost' || current.hostname === '127.0.0.1';
    if (hostLooksLikeVite) {
      guessed.host = `${current.hostname}:4101`;
    }

    return guessed.toString();
  } catch {
    return null;
  }
}

function resolveWsUrl(): string {
  const configuredWsUrl = normalizeWsUrl(import.meta.env.VITE_WS_URL?.trim() ?? '');
  if (configuredWsUrl) return configuredWsUrl;

  const inferredDevWsUrl = inferDevBackendWsUrl();
  if (inferredDevWsUrl) return inferredDevWsUrl;

  return `wss://${DEFAULT_BACKEND_HOST}/ws`;
}

export type NetSimConfig = {
  presetId: NetSimPresetId;
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
  const defaultPreset = NET_SIM_PRESETS[0];
  const params = new URLSearchParams(search);
  const latencyMs = clamp(parseNumber(params, 'net_latency') ?? defaultPreset.latencyMs, 0, 500);
  const jitterMs = clamp(parseNumber(params, 'net_jitter') ?? defaultPreset.jitterMs, 0, 300);
  const dropRate = clamp(parseNumber(params, 'net_drop') ?? defaultPreset.dropRate, 0, 0.5);
  const hasParams = params.has('net_latency') || params.has('net_jitter') || params.has('net_drop');

  return {
    presetId: defaultPreset.id,
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
  const [netSimConfig, setNetSimConfig] = useState<NetSimConfig>(() => resolveNetSimConfig(window.location.search));
  const netSimConfigRef = useRef<NetSimConfig>(netSimConfig);
  useEffect(() => {
    netSimConfigRef.current = netSimConfig;
  }, [netSimConfig]);

  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<WsServerMessage[]>([]);
  const [inboundTrace, setInboundTrace] = useState<WsInboundTraceEntry[]>([]);
  const [outboundTrace, setOutboundTrace] = useState<WsOutboundTraceEntry[]>([]);
  const [urlUsed, setUrlUsed] = useState<string>('');
  const [lastError, setLastError] = useState<string | null>(null);

  // M14.7 RTT (EMA + jitter EMA)
  const pingSeqRef = useRef(0);
  const pingSentAtRef = useRef(new Map<number, number>()); // id -> perfNow at actual send time
  const rttEmaRef = useRef<number | null>(null);
  const rttJitterEmaRef = useRef<number>(0);

  const [rttMs, setRttMs] = useState<number | null>(null);
  const [rttJitterMs, setRttJitterMs] = useState<number>(0);
  const bombEventSeenRef = useRef<Map<string, number>>(new Map());
  const lastEventTickRef = useRef<number>(-1);
  const currentMatchIdRef = useRef<string | null>(null);
  const [bombEventNetStats, setBombEventNetStats] = useState<BombEventNetStats>({
    serverTick: -1,
    lastEventTick: -1,
    eventsBuffered: 0,
    eventsDroppedDup: 0,
    eventsDroppedOutOfOrder: 0,
  });

  useEffect(() => {
    if (!token) return;

    const wsUrl = resolveWsUrl();

    setUrlUsed(wsUrl);
    setLastError(null);
    diagnosticsStore.setWsState({ wsUrlUsed: wsUrl, status: 'CONNECTING', lastError: null });
    const diagnosticsEnabled = diagnosticsStore.isEnabled();
    diagnosticsStore.log('WS', 'INFO', 'connect:starting', { wsUrlUsed: wsUrl });

    const client = new WsClient({
      url: wsUrl,
      token,
      onOpen: () => {
        setConnected(true);
        setLastError(null);
        const now = new Date().toISOString();
        diagnosticsStore.setWsState({ status: 'OPEN', lastError: null, lastOpenAt: now });
        diagnosticsStore.log('WS', 'INFO', 'connect:open');
      },
      onClose: (event) => {
        setConnected(false);
        if (event.code === 4401) {
          const authError = `Session expired (WS close ${event.code}${event.reason ? `: ${event.reason}` : ''})`;
          setLastError(authError);
          diagnosticsStore.setWsState({ status: 'ERROR', lastError: authError });
          diagnosticsStore.log('WS', 'ERROR', 'connect:close_auth_failed', {
            code: event.code,
            reason: event.reason || null,
          });
        }

        const now = new Date().toISOString();
        diagnosticsStore.setWsState({
          status: 'CLOSED',
          lastCloseAt: now,
          lastCloseCode: event.code,
          lastCloseReason: event.reason || null,
        });
        diagnosticsStore.log('WS', 'WARN', 'connect:close', { code: event.code, reason: event.reason || null });
      },
      onError: () => {
        setLastError('WebSocket error');
        diagnosticsStore.setWsState({ status: 'ERROR', lastError: 'WebSocket error' });
        diagnosticsStore.log('WS', 'ERROR', 'connect:error', { error: 'WebSocket error' });
      },
      onMessage: (msg) => {
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

        if (msg.type === 'match:error') {
          setLastError(msg.error);
          diagnosticsStore.setWsState({ status: 'ERROR', lastError: msg.error });
          diagnosticsStore.log('WS', 'ERROR', 'recv:match:error', { error: msg.error });
        }

        diagnosticsStore.setWsState({ lastMessageAt: new Date().toISOString() });
        if (diagnosticsEnabled) {
          diagnosticsStore.log('WS', 'INFO', `recv:${msg.type}`, {
            type: msg.type,
            preview: JSON.stringify(msg).slice(0, 1000),
          });
        }

        let messageMatchId: string | null = null;
        if (msg.type === 'match:world_init' && typeof msg.matchId === 'string') {
          messageMatchId = msg.matchId;
        } else if (msg.type === 'match:started' && typeof msg.matchId === 'string') {
          messageMatchId = msg.matchId;
        } else if (msg.type === 'match:snapshot' && typeof msg.snapshot?.matchId === 'string') {
          messageMatchId = msg.snapshot.matchId;
        }

        if (messageMatchId && currentMatchIdRef.current !== messageMatchId) {
          const oldMatchId = currentMatchIdRef.current;
          currentMatchIdRef.current = messageMatchId;
          bombEventSeenRef.current.clear();
          lastEventTickRef.current = -1;
          setBombEventNetStats((prev) => ({
            ...prev,
            lastEventTick: -1,
            serverTick: -1,
          }));
          diagnosticsStore.log('WS', 'INFO', 'ws:bomb_event_state_reset_on_new_match', {
            oldMatchId,
            newMatchId: messageMatchId,
            reason: msg.type,
          });
        }

        if (msg.type === 'match:snapshot') {
          const snapshotTick = Number.isFinite(msg.snapshot?.tick) ? msg.snapshot.tick : -1;
          if (snapshotTick >= 0) {
            lastEventTickRef.current = Math.max(lastEventTickRef.current, snapshotTick);
            setBombEventNetStats((prev) => ({
              ...prev,
              serverTick: Math.max(prev.serverTick, snapshotTick),
              lastEventTick: lastEventTickRef.current,
            }));
          }
        }

        if (msg.type === 'match:bomb_spawned' || msg.type === 'match:bomb_exploded') {
          const eventId = typeof msg.eventId === 'string' ? msg.eventId : '';
          const serverTick = Number.isFinite(msg.serverTick) ? msg.serverTick : -1;

          if (eventId) {
            if (bombEventSeenRef.current.has(eventId)) {
              setBombEventNetStats((prev) => ({ ...prev, eventsDroppedDup: prev.eventsDroppedDup + 1, serverTick: Math.max(prev.serverTick, serverTick) }));
              return;
            }

            bombEventSeenRef.current.set(eventId, Date.now());
            if (bombEventSeenRef.current.size > 2048) {
              const oldest = bombEventSeenRef.current.keys().next().value;
              if (typeof oldest === 'string') bombEventSeenRef.current.delete(oldest);
            }
          }

          if (serverTick >= 0 && serverTick < lastEventTickRef.current) {
            setBombEventNetStats((prev) => ({ ...prev, eventsDroppedOutOfOrder: prev.eventsDroppedOutOfOrder + 1, serverTick: Math.max(prev.serverTick, serverTick) }));
            return;
          }

          if (serverTick >= 0) {
            lastEventTickRef.current = Math.max(lastEventTickRef.current, serverTick);
          }

          setBombEventNetStats((prev) => ({
            ...prev,
            serverTick: Math.max(prev.serverTick, serverTick),
            lastEventTick: lastEventTickRef.current,
          }));
        }

        const recvAt = Date.now();
        setInboundTrace((prev) => [...prev.slice(-80), { at: recvAt, message_type: msg.type, message: msg }]);

        const config = netSimConfigRef.current;
        const shouldSimulateSnapshot = import.meta.env.DEV && msg.type === 'match:snapshot' && config.enabled;
        if (shouldSimulateSnapshot && shouldDrop(config)) return;

        const delayMs = shouldSimulateSnapshot ? getNetDelayMs(config) : 0;
        window.setTimeout(() => {
          setMessages((prev) => [...prev.slice(-50), msg]);
        }, delayMs);
      },
    });

    clientRef.current = client;
    client.connect();

    // Ping loop (1s).
    const pingTimer = window.setInterval(() => {
      const c = clientRef.current;
      if (!c) return;

      const id = ++pingSeqRef.current;
      pingSentAtRef.current.set(id, performance.now());
      const msg: WsClientMessage = { type: 'ping', id, t: Date.now() };
      c.send(msg);
    }, 1000);

    return () => {
      window.clearInterval(pingTimer);
      pingSentAtRef.current.clear();
      bombEventSeenRef.current.clear();
      lastEventTickRef.current = -1;
      currentMatchIdRef.current = null;
      setBombEventNetStats({ serverTick: -1, lastEventTick: -1, eventsBuffered: 0, eventsDroppedDup: 0, eventsDroppedOutOfOrder: 0 });

      client.disconnect();
      clientRef.current = null;
      setConnected(false);
      setUrlUsed('');
      diagnosticsStore.setWsState({ status: 'CLOSED' });
    };
  }, [token]);

  return {
    connected,
    messages,
    inboundTrace,
    outboundTrace,
    urlUsed,
    lastError,
    netSimConfig,
    netSimPresets: NET_SIM_PRESETS,
    rttMs,
    rttJitterMs,
    bombEventNetStats,
    setNetSimEnabled: (enabled: boolean) => {
      if (!import.meta.env.DEV) return;
      setNetSimConfig((prev) => ({ ...prev, enabled }));
    },
    setNetSimPreset: (presetId: NetSimPresetId) => {
      if (!import.meta.env.DEV) return;

      const preset = NET_SIM_PRESETS.find((candidate) => candidate.id === presetId);
      if (!preset) return;

      setNetSimConfig((prev) => ({
        ...prev,
        presetId: preset.id,
        latencyMs: preset.latencyMs,
        jitterMs: preset.jitterMs,
        dropRate: preset.dropRate,
      }));
    },
    send: (msg: WsClientMessage, debugContext?: WsTraceContext) => {
      const sentAt = Date.now();
      setOutboundTrace((prev) => [...prev.slice(-80), { at: sentAt, message_type: msg.type, message: msg, traceContext: debugContext }]);
      if (diagnosticsStore.isEnabled()) {
        diagnosticsStore.log('WS', 'INFO', `send:${msg.type}`, {
          type: msg.type,
          preview: JSON.stringify(msg).slice(0, 1000),
        });
      }
      const config = netSimConfigRef.current;
      const shouldSimulateInput = import.meta.env.DEV && msg.type === 'match:input' && config.enabled;
      if (shouldSimulateInput && shouldDrop(config)) return;

      const delayMs = shouldSimulateInput ? getNetDelayMs(config) : 0;
      window.setTimeout(() => {
        clientRef.current?.send(msg);
      }, delayMs);
    },
  };
}
