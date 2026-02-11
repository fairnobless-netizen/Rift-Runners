import type { IncomingMessage } from 'http';
import { resolveSessionFromRequest } from '../auth/session';

export async function resolveWsUser(req: IncomingMessage): Promise<{ tgUserId: string } | null> {
  return resolveSessionFromRequest({ headers: req.headers });
}
