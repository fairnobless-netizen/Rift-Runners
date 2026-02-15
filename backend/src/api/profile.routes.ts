import { Router } from 'express';
import { resolveSessionFromRequest } from '../auth/session';
import {
  computeNameChangeRemaining,
  getUserAndWallet,
  getUserSettings,
  getReferralStats,
  redeemReferral,
  updateDisplayNameWithLimit,
  upsertUserSettings,
} from '../db/repos';

export const profileRouter = Router();

profileRouter.get('/profile/me', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const uw = await getUserAndWallet(s.tgUserId);
  if (!uw) return res.status(404).json({ ok: false, error: 'User not found' });

  return res.status(200).json({ ok: true, user: uw.user, wallet: uw.wallet });
});

profileRouter.get('/settings/me', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const settings = await getUserSettings(s.tgUserId);
  return res.status(200).json({ ok: true, settings });
});

profileRouter.post('/settings/me', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const musicEnabled = Boolean(req.body?.musicEnabled);
  const sfxEnabled = Boolean(req.body?.sfxEnabled);

  const settings = await upsertUserSettings({
    tgUserId: s.tgUserId,
    musicEnabled,
    sfxEnabled,
  });

  return res.status(200).json({ ok: true, settings });
});

profileRouter.get('/profile/account', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const uw = await getUserAndWallet(s.tgUserId);
  if (!uw) return res.status(404).json({ ok: false, error: 'User not found' });

  const tgBotUsername = String(process.env.TG_BOT_USERNAME ?? '').trim();
  const referralLink = tgBotUsername
    ? `https://t.me/${tgBotUsername}?startapp=ref_${encodeURIComponent(s.tgUserId)}`
    : `https://t.me/share/url?url=${encodeURIComponent(s.tgUserId)}`;

  const nameChangeRemaining = await computeNameChangeRemaining(s.tgUserId);

  return res.status(200).json({
    ok: true,
    account: {
      id: s.tgUserId,
      displayName: uw.user.displayName,
      referralLink,
      nameChangeRemaining,
    },
  });
});

profileRouter.post('/profile/name', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const raw = String(req.body?.displayName ?? '');
  const displayName = raw.trim();

  if (displayName.length < 1 || displayName.length > 32) {
    return res.status(400).json({ ok: false, error: 'invalid_display_name' });
  }

  const result = await updateDisplayNameWithLimit({
    tgUserId: s.tgUserId,
    displayName,
  });

  if (!result.ok) {
    return res.status(429).json({ ok: false, error: 'limit_reached', remaining: 0 });
  }

  return res.status(200).json({ ok: true, displayName, remaining: result.remaining });
});


profileRouter.get('/profile/referral', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const tgBotUsername = String(process.env.TG_BOT_USERNAME ?? '').trim();
  const link = tgBotUsername
    ? `https://t.me/${tgBotUsername}?startapp=ref_${encodeURIComponent(s.tgUserId)}`
    : `https://t.me/share/url?url=${encodeURIComponent(s.tgUserId)}`;

  const stats = await getReferralStats(s.tgUserId);
  return res.status(200).json({ link, plasmaEarned: stats.plasmaEarned, invitedCount: stats.invitedCount });
});

profileRouter.post('/profile/referral/redeem', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const code = String(req.body?.code ?? '').trim();
  if (!code) return res.status(400).json({ ok: false, error: 'code_required' });

  try {
    const awarded = await redeemReferral({ inviteeTgUserId: s.tgUserId, code });
    return res.status(200).json({ ok: true, awarded });
  } catch (error: any) {
    if (error?.code === 'INVALID_CODE') return res.status(404).json({ ok: false, error: 'invalid_code' });
    if (error?.code === 'SELF_REDEEM') return res.status(400).json({ ok: false, error: 'self_redeem_not_allowed' });
    if (error?.code === 'ALREADY_REDEEMED') return res.status(409).json({ ok: false, error: 'already_redeemed' });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});
