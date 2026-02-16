import { Router } from 'express';
import { resolveSessionFromRequest } from '../auth/session';
import { claimReferral } from '../db/repos';

export const referralsRouter = Router();

referralsRouter.post('/referrals/claim', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const refCode = String(req.body?.refCode ?? '').trim();
  if (!refCode) return res.status(400).json({ ok: false, error: 'ref_code_required' });

  try {
    const result = await claimReferral({ inviteeTgUserId: session.tgUserId, refCode });
    return res.status(200).json({ ok: true, claimed: result.claimed });
  } catch (error: any) {
    if (error?.code === 'INVALID_CODE') return res.status(404).json({ ok: false, error: 'invalid_code' });
    if (error?.code === 'SELF_REFERRAL') return res.status(400).json({ ok: false, error: 'self_referral_not_allowed' });
    if (error?.code === 'USER_NOT_FOUND') return res.status(404).json({ ok: false, error: 'user_not_found' });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});
