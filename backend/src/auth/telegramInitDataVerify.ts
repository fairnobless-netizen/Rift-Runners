import crypto from 'crypto';

export type TelegramVerifyResult =
  | {
      ok: true;
      tgUserId: string;
      user: any;
      authDate: number;
    }
  | {
      ok: false;
      error:
        | 'initData_empty'
        | 'hash_missing'
        | 'signature_invalid'
        | 'user_missing'
        | 'user_invalid'
        | 'auth_date_missing'
        | 'auth_date_invalid'
        | 'auth_date_expired';
      message: string;
    };

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
 * TODO backend: consider nonce/idempotency cache in addition to auth_date freshness
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSec: number
): TelegramVerifyResult {
  if (!initData || !initData.trim()) {
    return { ok: false, error: 'initData_empty', message: 'initData is empty' };
  }

  const map = parseInitData(initData);
  const hash = map.get('hash');
  if (!hash) {
    return { ok: false, error: 'hash_missing', message: 'Missing hash in initData' };
  }

  // auth_date
  const authDateRaw = map.get('auth_date');
  if (!authDateRaw) {
    return { ok: false, error: 'auth_date_missing', message: 'Missing auth_date' };
  }

  const authDate = Number(authDateRaw);
  if (!Number.isFinite(authDate)) {
    return { ok: false, error: 'auth_date_invalid', message: 'Invalid auth_date' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - authDate > maxAgeSec) {
    return {
      ok: false,
      error: 'auth_date_expired',
      message: 'initData has expired',
    };
  }

  // Build data_check_string
  const pairs: string[] = [];
  for (const [k, v] of map.entries()) {
    if (k === 'hash') continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const hmacHex = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (hmacHex !== hash) {
    return {
      ok: false,
      error: 'signature_invalid',
      message: 'Invalid initData signature',
    };
  }

  const userRaw = map.get('user');
  if (!userRaw) {
    return { ok: false, error: 'user_missing', message: 'Missing user payload' };
  }

  let user: any;
  try {
    user = JSON.parse(userRaw);
  } catch {
    return { ok: false, error: 'user_invalid', message: 'Invalid user JSON' };
  }

  const tgUserId = String(user?.id ?? '');
  if (!tgUserId) {
    return { ok: false, error: 'user_invalid', message: 'Missing user.id' };
  }

  return { ok: true, tgUserId, user, authDate };
}
