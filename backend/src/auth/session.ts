import { memoryDb } from '../db/memoryDb';

type RequestWithHeaders = {
  headers?: {
    authorization?: string;
  };
};

function getBearerToken(req: RequestWithHeaders): string | null {
  const header = String(req.headers?.authorization ?? '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export async function resolveSessionFromRequest(req: RequestWithHeaders): Promise<{ tgUserId: string } | null> {
  const token = getBearerToken(req);
  if (!token) return null;

  const session = memoryDb.sessions.get(token);
  if (!session) return null;

  return { tgUserId: session.tgUserId };
}
