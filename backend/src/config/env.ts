export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function getOptionalEnv(name: string): string | undefined {
  return process.env[name];
}

export const TELEGRAM_AUTH_MAX_AGE_SEC = 24 * 60 * 60; // 24 hours

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * DB
 * - required in production
 * - allowed to be missing in dev only if you still run memory mode (we will remove memory mode in N1)
 */
export function requireDatabaseUrl(): string {
  return requireEnv('DATABASE_URL');
}

/**
 * Session TTL in seconds (default 30 days).
 * We store expiresAt in DB and reject expired sessions.
 */
export function getSessionTtlSeconds(): number {
  const raw = Number(process.env.SESSION_TTL_SECONDS ?? 30 * 24 * 60 * 60);
  if (!Number.isFinite(raw) || raw <= 60) return 30 * 24 * 60 * 60;
  return Math.floor(raw);
}
