import { Router } from 'express';
import { TELEGRAM_AUTH_MAX_AGE_SEC, getSessionTtlSeconds, isProduction, requireEnv } from '../config/env';
import { verifyTelegramInitData } from '../auth/telegramInitDataVerify';
import { randomToken, sha256Hex } from '../auth/session';
import { ensureGameUserId, ensureReferralCode, ensureWallet, createSession, upsertUser } from '../db/repos';
import { resolveResumeEligibility } from '../services/resumeEligibilityService';
import { getActiveSession } from '../services/resumeService';

export const authRouter = Router();

authRouter.post('/auth/telegram', async (req, res) => {
  const initData: string = String(req.body?.initData ?? '');

  // DEV fallback: allow empty initData when running locally without Telegram
  const isDev = !isProduction();

  const now = Date.now();
  const ttlMs = getSessionTtlSeconds() * 1000;
  const expiresAt = now + ttlMs;

  if (isDev && !initData) {
    const tgUserId = 'dev_demo';

    const user = await upsertUser({
      tgUserId,
      tgUsername: 'dev_demo',
      displayName: 'Dev Demo',
    });
    await ensureWallet(tgUserId);
    const gameUserId = await ensureGameUserId(tgUserId);
    await ensureReferralCode(tgUserId);

    const token = randomToken(24);
    const tokenHash = sha256Hex(token);
    await createSession({ tokenHash, tgUserId, expiresAt });

    const resume = await resolveResumeEligibility(tgUserId, getActiveSession(tgUserId));
    return res.status(200).json({ ok: true, token, user: { ...user, gameUserId: user.gameUserId ?? gameUserId }, resume });
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

  const displayName =
    String(vr.user?.first_name ?? '') +
    (vr.user?.last_name ? ` ${vr.user.last_name}` : '');

  const user = await upsertUser({
    tgUserId: vr.tgUserId,
    tgUsername: vr.user?.username ? String(vr.user.username) : null,
    displayName: displayName.trim() || `TG ${vr.tgUserId}`,
  });
  await ensureWallet(vr.tgUserId);
  const gameUserId = await ensureGameUserId(vr.tgUserId);
  await ensureReferralCode(vr.tgUserId);

  const token = randomToken(24);
  const tokenHash = sha256Hex(token);
  await createSession({ tokenHash, tgUserId: vr.tgUserId, expiresAt });

  // GDX backend-relevant: later replace with JWT+refresh; for now token+hash+TTL in DB
  const resume = await resolveResumeEligibility(vr.tgUserId, getActiveSession(vr.tgUserId));
  return res.status(200).json({ ok: true, token, user: { ...user, gameUserId: user.gameUserId ?? gameUserId }, resume });
});
