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

function safeEqualHex(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'hex');
  const bBuf = Buffer.from(b, 'hex');
  if (aBuf.length === 0 || bBuf.length === 0 || aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function logVerifyDiagnostic(map: Map<string, string>, dataCheckStringLength: number): void {
  const keys = Array.from(map.keys()).sort();
  console.warn('[telegram-auth] initData verification failed', {
    keys,
    dataCheckStringLength,
  });
}

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSec: number
): TelegramVerifyResult {
  if (!initData || !initData.trim()) {
    return { ok: false, error: 'initData_empty', message: 'initData is empty' };
  }

  const map = parseInitData(initData);
  const providedHash = map.get('hash');
  if (!providedHash) {
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

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken, 'utf8')
    .digest();
  const hmacHex = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString, 'utf8')
    .digest('hex');

  console.log('[tg-verify] initDataLen:', initData.length, 'hashLen:', (providedHash ?? '').length, 'botTokenLen:', botToken.length);

  if (!safeEqualHex(hmacHex, providedHash)) {
    logVerifyDiagnostic(map, dataCheckString.length);
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
