export type DiagnosticsLevel = 'INFO' | 'WARN' | 'ERROR';
export type DiagnosticsCategory = 'WS' | 'ROOM' | 'AUTH' | 'UI' | 'NET';

export type DiagnosticsEvent = {
  ts: string;
  level: DiagnosticsLevel;
  cat: DiagnosticsCategory;
  msg: string;
  data?: unknown;
};

type WsDiagnosticsState = {
  wsUrlUsed: string | null;
  status: 'CONNECTING' | 'OPEN' | 'CLOSED' | 'ERROR';
  lastError: string | null;
  lastOpenAt: string | null;
  lastCloseAt: string | null;
  lastCloseCode: number | null;
  lastCloseReason: string | null;
  lastMessageAt: string | null;
  retryCount: number | null;
};

type RoomDiagnosticsState = {
  roomCode: string | null;
  members: number;
  isHost: boolean;
  canStart: boolean;
  phase: string | null;
};

type AuthDiagnosticsState = {
  telegramPresent: boolean;
  startParamPresent: boolean;
  userIdMasked: string | null;
  nickname: string | null;
  reasonIfNotTelegram: string | null;
};

export type DiagnosticsSnapshot = {
  ws: WsDiagnosticsState;
  room: RoomDiagnosticsState;
  auth: AuthDiagnosticsState;
  events: DiagnosticsEvent[];
};

const MAX_EVENTS = 200;

const state: DiagnosticsSnapshot = {
  ws: {
    wsUrlUsed: null,
    status: 'CONNECTING',
    lastError: null,
    lastOpenAt: null,
    lastCloseAt: null,
    lastCloseCode: null,
    lastCloseReason: null,
    lastMessageAt: null,
    retryCount: null,
  },
  room: {
    roomCode: null,
    members: 0,
    isHost: false,
    canStart: false,
    phase: null,
  },
  auth: {
    telegramPresent: false,
    startParamPresent: false,
    userIdMasked: null,
    nickname: null,
    reasonIfNotTelegram: null,
  },
  events: [],
};

const listeners = new Set<() => void>();


function resolveDiagnosticsEnabled(): boolean {
  if (import.meta.env.DEV) {
    return true;
  }

  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const search = new URLSearchParams(window.location.search);
    if (search.get('diag') === '1') {
      return true;
    }
  } catch {}

  try {
    return window.localStorage.getItem('rr_diag') === '1';
  } catch {
    return false;
  }
}

const DIAGNOSTICS_ENABLED = resolveDiagnosticsEnabled();


function notify(): void {
  listeners.forEach((listener) => listener());
}

function sanitizeData(data: unknown): unknown {
  if (typeof data === 'string') {
    return data.length > 1200 ? `${data.slice(0, 1200)}…` : data;
  }
  if (Array.isArray(data)) {
    return data.slice(0, 20).map((entry) => sanitizeData(entry));
  }
  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, value] of Object.entries(rec)) {
      if (count >= 25) {
        out.__truncated = true;
        break;
      }
      if (/token|authorization|header|initdata/i.test(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = sanitizeData(value);
      }
      count += 1;
    }
    return out;
  }
  return data;
}

export const diagnosticsStore = {
  isEnabled(): boolean {
    return DIAGNOSTICS_ENABLED;
  },

  log(cat: DiagnosticsCategory, level: DiagnosticsLevel, msg: string, data?: unknown): void {
    if (!DIAGNOSTICS_ENABLED) {
      return;
    }

    state.events = [
      ...state.events,
      {
        ts: new Date().toISOString(),
        level,
        cat,
        msg,
        data: data === undefined ? undefined : sanitizeData(data),
      },
    ].slice(-MAX_EVENTS);
    notify();
  },

  setWsState(partial: Partial<WsDiagnosticsState>): void {
    state.ws = { ...state.ws, ...partial };
    notify();
  },

  setRoomState(partial: Partial<RoomDiagnosticsState>): void {
    state.room = { ...state.room, ...partial };
    notify();
  },

  setAuthState(partial: Partial<AuthDiagnosticsState>): void {
    state.auth = { ...state.auth, ...partial };
    notify();
  },

  clearEvents(): void {
    state.events = [];
    notify();
  },

  getSnapshot(): DiagnosticsSnapshot {
    return {
      ws: { ...state.ws },
      room: { ...state.room },
      auth: { ...state.auth },
      events: state.events.map((event) => ({ ...event })),
    };
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
