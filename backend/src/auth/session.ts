import crypto from 'crypto';
import type { Request } from 'express';
import { pgQuery } from '../db/pg';

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function getBearerToken(req: Request): string | null {
  const h = String((req.headers as any)?.authorization ?? '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export async function resolveSessionFromRequest(req: Request): Promise<{ tgUserId: string } | null> {
  const token = getBearerToken(req);
  if (!token) return null;

  const tokenHash = sha256Hex(token);
  const now = Date.now();

  const { rows } = await pgQuery<{ tg_user_id: string; expires_at: number }>(
    `SELECT tg_user_id, expires_at FROM sessions WHERE token_hash = $1 LIMIT 1`,
    [tokenHash],
  );

  const s = rows[0];
  if (!s) return null;
  if (Number(s.expires_at) <= now) return null;

  return { tgUserId: String(s.tg_user_id) };
}
