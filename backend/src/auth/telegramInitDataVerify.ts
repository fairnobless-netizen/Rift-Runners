import crypto from 'crypto';

export type TelegramVerifyResult =
  | { ok: true; tgUserId: string; user: any; authDate?: number }
  | { ok: false; error: string };

function parseInitData(initData: string): Map<string, string> {
  const params = new URLSearchParams(initData);
  const map = new Map<string, string>();
  params.forEach((value, key) => map.set(key, value));
  return map;
}

/**
 * Telegram Mini Apps initData verification:
 * - secretKey = HMAC-SHA256(botToken, "WebAppData")? (legacy confusion) — for Mini Apps it's:
 *   secretKey = SHA256(botToken)
 * - data_check_string = sorted key=value lines excluding `hash`
 * - hash = HMAC-SHA256(data_check_string, secretKey) hex
 *
 * TODO backend: consider auth_date freshness window (e.g. 1 day)
 */
export function verifyTelegramInitData(initData: string, botToken: string): TelegramVerifyResult {
  if (!initData || !initData.trim()) {
    return { ok: false, error: 'initData is empty' };
  }

  const map = parseInitData(initData);
  const hash = map.get('hash');
  if (!hash) return { ok: false, error: 'Missing hash in initData' };

  // Build data_check_string (exclude hash)
  const pairs: string[] = [];
  for (const [k, v] of map.entries()) {
    if (k === 'hash') continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const hmacHex = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (hmacHex !== hash) {
    return { ok: false, error: 'Invalid initData signature' };
  }

  const userRaw = map.get('user');
  if (!userRaw) return { ok: false, error: 'Missing user in initData' };

  let user: any;
  try {
    user = JSON.parse(userRaw);
  } catch {
    return { ok: false, error: 'Invalid user JSON in initData' };
  }

  const tgUserId = String(user?.id ?? '');
  if (!tgUserId) return { ok: false, error: 'Missing user.id in initData' };

  const authDateStr = map.get('auth_date');
  const authDate = authDateStr ? Number(authDateStr) : undefined;

  return { ok: true, tgUserId, user, authDate };
}
