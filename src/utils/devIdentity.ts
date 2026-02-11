const DEV_FALLBACK_KEY = 'rift_dev_client_id';

export type DevIdentity = {
  clientId?: number;
  displayNameOverride?: string;
  localFallbackTgUserId: string;
};

function parseClientId(raw: string | null): number | undefined {
  if (!raw) return undefined;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function createRandomDevId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `dev:${crypto.randomUUID()}`;
  }

  const randomPart = Math.random().toString(36).slice(2, 10);
  return `dev:${randomPart}`;
}

function getStableFallbackDevId(clientId?: number): string {
  if (clientId) {
    return `dev:${clientId}`;
  }

  const existing = localStorage.getItem(DEV_FALLBACK_KEY);
  if (existing) return existing;

  const next = createRandomDevId();
  localStorage.setItem(DEV_FALLBACK_KEY, next);
  return next;
}

export function resolveDevIdentity(search: string): DevIdentity {
  const params = new URLSearchParams(search);
  const clientId = parseClientId(params.get('client'));

  const rawName = params.get('name');
  const name = rawName ? rawName.trim() : '';
  const displayNameOverride = name || (clientId ? `Client ${clientId}` : undefined);

  return {
    clientId,
    displayNameOverride,
    localFallbackTgUserId: getStableFallbackDevId(clientId),
  };
}
