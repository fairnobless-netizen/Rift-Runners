import type { IncomingMessage } from 'http';

import { TELEGRAM_AUTH_MAX_AGE_SEC, isProduction, requireEnv } from '../config/env';
import { getBearerToken, resolveSessionFromRequest } from './session';
import { verifyTelegramInitData } from './telegramInitDataVerify';

type WsAuthMode = 'telegram_initData' | 'session_token' | 'dev_query';

type WsAuthSuccess = {
  ok: true;
  tgUserId: string;
  mode: WsAuthMode;
};

type WsAuthFailure = {
  ok: false;
  reason:
    | 'credential_missing'
    | 'session_invalid'
    | 'telegram_invalid'
    | 'telegram_token_missing'
    | 'dev_fallback_not_allowed';
  hasCredential: boolean;
};

export type WsAuthResult = WsAuthSuccess | WsAuthFailure;

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function getSubprotocolCredential(req: IncomingMessage, prefix: 'session_token.' | 'init_data.'): string | null {
  const rawHeader = req.headers['sec-websocket-protocol'];
  const protocolHeader = Array.isArray(rawHeader) ? rawHeader.join(',') : String(rawHeader ?? '');
  const protocolValues = protocolHeader
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const encodedValue = protocolValues.find((entry) => entry.startsWith(prefix));
  if (!encodedValue) {
    return null;
  }

  const payload = encodedValue.slice(prefix.length);
  if (!payload) {
    return null;
  }

  try {
    return decodeURIComponent(payload);
  } catch {
    return payload;
  }
}

function extractSessionToken(req: IncomingMessage, url: URL): string | null {
  const bearerFromHeader = getBearerToken({ headers: { authorization: String(req.headers.authorization ?? '') } });
  const tokenFromQuery = firstNonEmpty(
    url.searchParams.get('token'),
    url.searchParams.get('sessionToken'),
    url.searchParams.get('accessToken'),
  );
  const tokenFromProtocol = getSubprotocolCredential(req, 'session_token.');

  return firstNonEmpty(bearerFromHeader, tokenFromQuery, tokenFromProtocol);
}

function extractInitData(req: IncomingMessage, url: URL): string | null {
  const headerInitData = firstNonEmpty(
    Array.isArray(req.headers['x-telegram-init-data'])
      ? req.headers['x-telegram-init-data'][0]
      : req.headers['x-telegram-init-data'],
  );
  const queryInitData = firstNonEmpty(url.searchParams.get('initData'));
  const protocolInitData = getSubprotocolCredential(req, 'init_data.');

  return firstNonEmpty(headerInitData, queryInitData, protocolInitData);
}

export async function authenticateWsConnection(req: IncomingMessage, url: URL): Promise<WsAuthResult> {
  const sessionToken = extractSessionToken(req, url);
  const initData = extractInitData(req, url);
  const hasCredential = Boolean(sessionToken || initData);

  if (sessionToken) {
    const session = await resolveSessionFromRequest({
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    if (session) {
      return {
        ok: true,
        tgUserId: session.tgUserId,
        mode: 'session_token',
      };
    }
    return {
      ok: false,
      reason: 'session_invalid',
      hasCredential,
    };
  }

  if (initData) {
    let botToken: string;
    try {
      botToken = requireEnv('TG_BOT_TOKEN');
    } catch {
      return {
        ok: false,
        reason: 'telegram_token_missing',
        hasCredential,
      };
    }

    const verifyResult = verifyTelegramInitData(initData, botToken, TELEGRAM_AUTH_MAX_AGE_SEC);
    if (verifyResult.ok) {
      return {
        ok: true,
        tgUserId: verifyResult.tgUserId,
        mode: 'telegram_initData',
      };
    }

    return {
      ok: false,
      reason: 'telegram_invalid',
      hasCredential,
    };
  }

  const isDevQueryFallbackEnabled = !isProduction() && process.env.RR_DEV_ALLOW_QUERY_TGUSERID === '1';
  if (isDevQueryFallbackEnabled) {
    const tgUserId = firstNonEmpty(url.searchParams.get('tgUserId'));
    if (tgUserId) {
      return {
        ok: true,
        tgUserId,
        mode: 'dev_query',
      };
    }

    return {
      ok: false,
      reason: 'credential_missing',
      hasCredential,
    };
  }

  if (!hasCredential) {
    return {
      ok: false,
      reason: 'credential_missing',
      hasCredential,
    };
  }

  return {
    ok: false,
    reason: 'dev_fallback_not_allowed',
    hasCredential,
  };
}

