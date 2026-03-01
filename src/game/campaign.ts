import { apiUrl } from '../utils/apiBase';

export const CAMPAIGN_STORAGE_KEY = 'rift_campaign_v1';
export const SESSION_TOKEN_KEY = 'rift_session_token';
export const MAX_STAGE = 7;
export const ZONES_PER_STAGE = 10;
export const SOLO_RESUME_WINDOW_MS = 60_000;

export interface CampaignState {
  stage: number;
  zone: number;
  score: number;
  trophies: string[];
  lastActiveAtMs?: number;
  soloGameOver?: boolean;
}

export type CampaignSyncStatus = 'synced' | 'offline';

let campaignSyncStatus: CampaignSyncStatus = 'offline';
let campaignPostTimer: number | null = null;
const CAMPAIGN_POST_DEBOUNCE_MS = 800;

export function getCampaignSyncStatus(): CampaignSyncStatus {
  return campaignSyncStatus;
}

const DEFAULT_CAMPAIGN_STATE: CampaignState = {
  stage: 1,
  zone: 1,
  score: 0,
  trophies: [],
};

export function createInitialCampaignState(): CampaignState {
  return { ...DEFAULT_CAMPAIGN_STATE };
}

function sanitizeCampaignState(value: unknown): CampaignState {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CAMPAIGN_STATE };

  const source = value as Partial<CampaignState>;
  const stage = Number.isInteger(source.stage) ? Number(source.stage) : DEFAULT_CAMPAIGN_STATE.stage;
  const zone = Number.isInteger(source.zone) ? Number(source.zone) : DEFAULT_CAMPAIGN_STATE.zone;
  const score = typeof source.score === 'number' && Number.isFinite(source.score) ? source.score : DEFAULT_CAMPAIGN_STATE.score;
  const trophies = Array.isArray(source.trophies) ? source.trophies.filter((item): item is string => typeof item === 'string') : [];
  const lastActiveAtMs = typeof source.lastActiveAtMs === 'number' && Number.isFinite(source.lastActiveAtMs)
    ? Math.max(0, Math.floor(source.lastActiveAtMs))
    : undefined;
  const soloGameOver = typeof source.soloGameOver === 'boolean' ? source.soloGameOver : undefined;

  return {
    stage: Math.min(MAX_STAGE, Math.max(1, Math.floor(stage))),
    zone: Math.min(ZONES_PER_STAGE, Math.max(1, Math.floor(zone))),
    score: Math.max(0, Math.floor(score)),
    trophies,
    ...(lastActiveAtMs !== undefined ? { lastActiveAtMs } : {}),
    ...(soloGameOver !== undefined ? { soloGameOver } : {}),
  };
}

export function shouldResumeCampaign(state: CampaignState, nowMs: number = Date.now()): boolean {
  if (typeof state.lastActiveAtMs !== 'number' || !Number.isFinite(state.lastActiveAtMs)) return false;
  if (state.soloGameOver === true) return false;
  return nowMs - state.lastActiveAtMs <= SOLO_RESUME_WINDOW_MS;
}

function getSessionToken(): string | null {
  try {
    const t = window.localStorage.getItem(SESSION_TOKEN_KEY);
    return t && t.trim() ? t : null;
  } catch {
    return null;
  }
}

async function postCampaignToBackend(state: CampaignState): Promise<void> {
  const token = getSessionToken();
  if (!token) {
    campaignSyncStatus = 'offline';
    return;
  }

  try {
    await fetch(apiUrl('/api/campaign/progress'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(state),
    });
    campaignSyncStatus = 'synced';
  } catch {
    campaignSyncStatus = 'offline';
    // ignore (offline / backend down)
  }
}

export async function fetchCampaignFromBackend(): Promise<{ ok: boolean; hasProgress: boolean; campaignState: CampaignState } | null> {
  const token = getSessionToken();
  if (!token) {
    campaignSyncStatus = 'offline';
    return null;
  }

  try {
    const res = await fetch(apiUrl('/api/campaign/progress'), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();

    if (!json?.ok) {
      campaignSyncStatus = 'offline';
      return null;
    }

    const campaignState = sanitizeCampaignState(json.campaignState);
    campaignSyncStatus = 'synced';
    return { ok: true, hasProgress: Boolean(json.hasProgress), campaignState };
  } catch {
    campaignSyncStatus = 'offline';
    return null;
  }
}

export function saveCampaignState(state: CampaignState): void {
  const lastActiveAtMs = typeof state.lastActiveAtMs === 'number' && Number.isFinite(state.lastActiveAtMs)
    ? state.lastActiveAtMs
    : Date.now();
  const payload = sanitizeCampaignState({
    ...state,
    lastActiveAtMs,
    soloGameOver: state.soloGameOver === true,
  });

  try {
    window.localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore write failures (private mode, quota).
  }

  // backend sync (debounced)
  if (campaignPostTimer) {
    window.clearTimeout(campaignPostTimer);
  }

  campaignPostTimer = window.setTimeout(() => {
    void postCampaignToBackend(payload);
    campaignPostTimer = null;
  }, CAMPAIGN_POST_DEBOUNCE_MS);
}

export function loadCampaignState(): CampaignState | null {
  try {
    // TODO backend: persist campaign via API instead of localStorage
    // TODO backend: replace loadCampaignState with API call GET /campaign/progress
    const raw = window.localStorage.getItem(CAMPAIGN_STORAGE_KEY);
    if (!raw) return null;
    const state = sanitizeCampaignState(JSON.parse(raw));
    if (!shouldResumeCampaign(state, Date.now())) return null;
    return state;
  } catch {
    return null;
  }
}

export function computeNextCampaignState(current: CampaignState, bossDefeated: boolean, enteredExit: boolean): CampaignState {
  if (!enteredExit) return { ...current };

  if (current.zone === 9) {
    return {
      ...current,
      zone: 10,
    };
  }

  if (current.zone === 10 && bossDefeated) {
    return {
      ...current,
      stage: Math.min(MAX_STAGE, current.stage + 1),
      zone: 1,
    };
  }

  if (current.zone < 9) {
    return {
      ...current,
      zone: current.zone + 1,
    };
  }

  return { ...current };
}

export function campaignStateToLevelIndex(state: CampaignState): number {
  const stageIndex = Math.max(0, Math.min(MAX_STAGE - 1, state.stage - 1));
  const zoneIndex = Math.max(0, Math.min(ZONES_PER_STAGE - 1, state.zone - 1));
  return stageIndex * ZONES_PER_STAGE + zoneIndex;
}

export function levelIndexToCampaignState(levelIndex: number, score: number, trophies: string[]): CampaignState {
  const safeLevelIndex = Math.max(0, Math.floor(levelIndex));
  const stage = Math.min(MAX_STAGE, Math.floor(safeLevelIndex / ZONES_PER_STAGE) + 1);
  const zone = (safeLevelIndex % ZONES_PER_STAGE) + 1;

  return {
    stage,
    zone,
    score: Math.max(0, Math.floor(score)),
    trophies: [...trophies],
  };
}

export function resetCampaignState(): CampaignState {
  const initial: CampaignState = createInitialCampaignState();

  try {
    window.localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(initial));
  } catch {
    // ignore
  }

  // push reset to backend (best-effort)
  void postCampaignToBackend(initial);

  return initial;
}
