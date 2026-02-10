export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function getOptionalEnv(name: string): string | undefined {
  return process.env[name];
}
