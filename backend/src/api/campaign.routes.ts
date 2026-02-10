import { Router } from 'express';
import { memoryDb } from '../db/memoryDb';

export const campaignRouter = Router();

function getBearerToken(req: any): string | null {
  const h = String(req.headers?.authorization ?? '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function requireSession(req: any): { tgUserId: string } | null {
  const token = getBearerToken(req);
  if (!token) return null;
  const session = memoryDb.sessions.get(token);
  if (!session) return null;
  return { tgUserId: session.tgUserId };
}

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

campaignRouter.get('/campaign/progress', (req, res) => {
  const s = requireSession(req);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const existing = memoryDb.campaignProgress.get(s.tgUserId);
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
  });
});

campaignRouter.post('/campaign/progress', (req, res) => {
  const s = requireSession(req);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const clean = sanitizeCampaignState(req.body ?? {});
  const now = Date.now();

  memoryDb.campaignProgress.set(s.tgUserId, {
    tgUserId: s.tgUserId,
    ...clean,
    updatedAt: now,
  });

  // TODO M5e+: persist to DB per tgUserId
  return res.status(200).json({ ok: true, saved: true, updatedAt: now });
});
