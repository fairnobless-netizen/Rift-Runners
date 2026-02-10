import { Router } from 'express';
import crypto from 'crypto';
import { TELEGRAM_AUTH_MAX_AGE_SEC, isProduction, requireEnv } from '../config/env';
import { verifyTelegramInitData } from '../auth/telegramInitDataVerify';
import { memoryDb } from '../db/memoryDb';

export const authRouter = Router();

authRouter.post('/auth/telegram', (req, res) => {
  const initData: string = String(req.body?.initData ?? '');

  // DEV fallback: allow empty initData when running locally without Telegram
  const isDev = !isProduction();

  if (isDev && !initData) {
    // DEV fallback allowed ONLY outside production
    const tgUserId = 'dev_demo';
    const now = Date.now();

    if (!memoryDb.users.has(tgUserId)) {
      memoryDb.users.set(tgUserId, {
        tgUserId,
        displayName: 'Dev Demo',
        createdAt: now,
        updatedAt: now,
      });
      memoryDb.wallets.set(tgUserId, { tgUserId, stars: 0, crystals: 0 });
    }

    const token = crypto.randomBytes(24).toString('hex');
    memoryDb.sessions.set(token, { token, tgUserId, createdAt: now });

    return res.status(200).json({ ok: true, token, user: memoryDb.users.get(tgUserId) });
  }

  let botToken: string;
  try {
    botToken = requireEnv('TG_BOT_TOKEN');
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? 'Missing TG_BOT_TOKEN' });
  }

  const vr = verifyTelegramInitData(initData, botToken, TELEGRAM_AUTH_MAX_AGE_SEC);
  if (!vr.ok) {
    return res.status(401).json({
      ok: false,
      error: vr.error,
      message: vr.message,
    });
  }

  const now = Date.now();
  const displayName =
    String(vr.user?.first_name ?? '') +
    (vr.user?.last_name ? ` ${vr.user.last_name}` : '');

  const existing = memoryDb.users.get(vr.tgUserId);
  if (!existing) {
    memoryDb.users.set(vr.tgUserId, {
      tgUserId: vr.tgUserId,
      displayName: displayName.trim() || `TG ${vr.tgUserId}`,
      createdAt: now,
      updatedAt: now,
    });
    memoryDb.wallets.set(vr.tgUserId, { tgUserId: vr.tgUserId, stars: 0, crystals: 0 });
  } else {
    memoryDb.users.set(vr.tgUserId, { ...existing, displayName: displayName.trim() || existing.displayName, updatedAt: now });
  }

  const token = crypto.randomBytes(24).toString('hex');
  memoryDb.sessions.set(token, { token, tgUserId: vr.tgUserId, createdAt: now });

  // TODO backend-relevant: replace memory session tokens with JWT + refresh flow
  return res.status(200).json({ ok: true, token, user: memoryDb.users.get(vr.tgUserId) });
});
