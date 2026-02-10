export const CAMPAIGN_STORAGE_KEY = 'rift_campaign_v1';
export const SESSION_TOKEN_KEY = 'rift_session_token';
export const MAX_STAGE = 7;
export const ZONES_PER_STAGE = 10;

export interface CampaignState {
  stage: number;
  zone: number;
  score: number;
  trophies: string[];
}

const DEFAULT_CAMPAIGN_STATE: CampaignState = {
  stage: 1,
  zone: 1,
  score: 0,
  trophies: [],
};

function sanitizeCampaignState(value: unknown): CampaignState {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CAMPAIGN_STATE };

  const source = value as Partial<CampaignState>;
  const stage = Number.isInteger(source.stage) ? Number(source.stage) : DEFAULT_CAMPAIGN_STATE.stage;
  const zone = Number.isInteger(source.zone) ? Number(source.zone) : DEFAULT_CAMPAIGN_STATE.zone;
  const score = typeof source.score === 'number' && Number.isFinite(source.score) ? source.score : DEFAULT_CAMPAIGN_STATE.score;
  const trophies = Array.isArray(source.trophies) ? source.trophies.filter((item): item is string => typeof item === 'string') : [];

  return {
    stage: Math.min(MAX_STAGE, Math.max(1, Math.floor(stage))),
    zone: Math.min(ZONES_PER_STAGE, Math.max(1, Math.floor(zone))),
    score: Math.max(0, Math.floor(score)),
    trophies,
  };
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
  if (!token) return;

  try {
    await fetch('/api/campaign/progress', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(state),
    });
  } catch {
    // ignore (offline / backend down)
  }
}

export async function fetchCampaignFromBackend(): Promise<{ ok: boolean; hasProgress: boolean; campaignState: CampaignState } | null> {
  const token = getSessionToken();
  if (!token) return null;

  try {
    const res = await fetch('/api/campaign/progress', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();

    if (!json?.ok) return null;

    const campaignState = sanitizeCampaignState(json.campaignState);
    return { ok: true, hasProgress: Boolean(json.hasProgress), campaignState };
  } catch {
    return null;
  }
}

export function saveCampaignState(state: CampaignState): void {
  const payload = sanitizeCampaignState(state);

  try {
    window.localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore write failures (private mode, quota).
  }

  // backend truth (best-effort)
  // TODO backend: if backend becomes authoritative DB, keep this as primary write path
  void postCampaignToBackend(payload);
}

export function loadCampaignState(): CampaignState {
  try {
    // TODO backend: persist campaign via API instead of localStorage
    // TODO backend: replace loadCampaignState with API call GET /campaign/progress
    const raw = window.localStorage.getItem(CAMPAIGN_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CAMPAIGN_STATE };
    return sanitizeCampaignState(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CAMPAIGN_STATE };
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
