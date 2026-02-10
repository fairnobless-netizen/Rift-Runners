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
