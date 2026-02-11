import { Router } from 'express';
import { resolveSessionFromRequest } from '../auth/session';
import { getCampaign, saveCampaign } from '../db/repos';

export const campaignRouter = Router();

function sanitizeCampaignState(value: any) {
  const stage = Number.isFinite(value?.stage) ? Math.floor(value.stage) : 1;
  const zone = Number.isFinite(value?.zone) ? Math.floor(value.zone) : 1;
  const score = Number.isFinite(value?.score) ? Math.floor(value.score) : 0;
  const trophies = Array.isArray(value?.trophies) ? value.trophies.filter((x: any) => typeof x === 'string') : [];

  return {
    stage: Math.max(1, Math.min(7, stage)),
    zone: Math.max(1, Math.min(10, zone)),
    score: Math.max(0, score),
    trophies,
  };
}

campaignRouter.get('/campaign/progress', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const existing = await getCampaign(s.tgUserId);
  if (!existing) {
    return res.status(200).json({
      ok: true,
      hasProgress: false,
      campaignState: { stage: 1, zone: 1, score: 0, trophies: [] as string[] },
    });
  }

  return res.status(200).json({
    ok: true,
    hasProgress: true,
    campaignState: {
      stage: existing.stage,
      zone: existing.zone,
      score: existing.score,
      trophies: existing.trophies,
    },
    updatedAt: existing.updatedAt,
    schemaVersion: existing.schemaVersion,
  });
});

campaignRouter.post('/campaign/progress', async (req, res) => {
  const s = await resolveSessionFromRequest(req as any);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const clean = sanitizeCampaignState(req.body ?? {});
  const saved = await saveCampaign({
    tgUserId: s.tgUserId,
    ...clean,
    schemaVersion: 'rift_campaign_v1',
  });

  return res.status(200).json({ ok: true, saved: true, updatedAt: saved.updatedAt });
});
