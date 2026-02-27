import { Router } from 'express';
import { resolveSessionFromRequest } from '../auth/session';
import {
  checkAndTouchLeaderboardSubmitLimit,
  getMyLeaderboardEntry,
  getMyTeamEntry,
  getTopTeamLeaderboard,
  grantReferralBonusForFirstCompletedMatch,
  listLeaderboardTop,
  submitLeaderboardScore,
  submitTeamLeaderboardScore,
} from '../db/repos';

export const leaderboardRouter = Router();

const ALLOWED_MODES = new Set(['solo', 'duo', 'trio', 'squad']);
const TEAM_MODE_MEMBER_COUNTS: Record<'duo' | 'trio' | 'squad', number> = { duo: 2, trio: 3, squad: 4 };

function isValidMode(mode: string): boolean {
  return ALLOWED_MODES.has(mode);
}

function isTeamMode(mode: string): mode is 'duo' | 'trio' | 'squad' {
  return mode === 'duo' || mode === 'trio' || mode === 'squad';
}

function normalizeDisplayName(value: unknown): string {
  const raw = String(value ?? '').trim();
  return raw || 'Unknown';
}

leaderboardRouter.get('/:mode', async (req, res) => {
  const mode = String(req.params.mode ?? '').trim().toLowerCase();
  if (!isValidMode(mode)) {
    return res.status(400).json({ ok: false, error: 'invalid_mode' });
  }

  const session = await resolveSessionFromRequest(req as any);

  if (mode === 'solo') {
    const top = await listLeaderboardTop(mode, 100);
    const me = session ? await getMyLeaderboardEntry(session.tgUserId, mode) : null;
    return res.status(200).json({ ok: true, mode, top, me });
  }

  const top = await getTopTeamLeaderboard(mode, 100);
  const me = null;
  return res.status(200).json({ ok: true, mode, top, me });
});

leaderboardRouter.post('/submit-team', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const mode = String((req as any).body?.mode ?? '').trim().toLowerCase();
  const scoreRaw = (req as any).body?.score;
  const score = Number(scoreRaw);
  const membersRaw = Array.isArray((req as any).body?.members) ? (req as any).body.members : [];

  if (!isTeamMode(mode)) {
    return res.status(400).json({ ok: false, error: 'invalid_mode' });
  }

  if (!Number.isInteger(score) || score < 0) {
    return res.status(400).json({ ok: false, error: 'invalid_score' });
  }

  const expectedCount = TEAM_MODE_MEMBER_COUNTS[mode];
  if (membersRaw.length !== expectedCount) {
    return res.status(400).json({ ok: false, error: 'invalid_members_count' });
  }

  const members = membersRaw.map((member: any) => ({
    tgUserId: String(member?.tgUserId ?? '').trim(),
    displayName: normalizeDisplayName(member?.displayName),
  }));

  if (members.some((member) => !member.tgUserId)) {
    return res.status(400).json({ ok: false, error: 'invalid_member' });
  }

  if (!members.some((member) => member.tgUserId === session.tgUserId)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  const memberIds = members.map((member) => member.tgUserId);
  const displayName = members.map((member) => member.displayName).join(' + ');

  const allowed = await checkAndTouchLeaderboardSubmitLimit(session.tgUserId, 30_000);
  if (!allowed) {
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  await submitTeamLeaderboardScore({ mode, memberIds, displayName, score });
  const me = await getMyTeamEntry(mode, memberIds);

  return res.status(200).json({ ok: true, mode, me });
});

leaderboardRouter.post('/submit', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const mode = String((req as any).body?.mode ?? '').trim().toLowerCase();
  const scoreRaw = (req as any).body?.score;
  const score = Number(scoreRaw);

  if (mode !== 'solo') {
    return res.status(400).json({ ok: false, error: 'invalid_mode' });
  }

  if (!Number.isInteger(score) || score < 0) {
    return res.status(400).json({ ok: false, error: 'invalid_score' });
  }

  const allowed = await checkAndTouchLeaderboardSubmitLimit(session.tgUserId, 30_000);
  if (!allowed) {
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  await submitLeaderboardScore(session.tgUserId, mode, score);
  await grantReferralBonusForFirstCompletedMatch(session.tgUserId);
  const me = await getMyLeaderboardEntry(session.tgUserId, mode);

  return res.status(200).json({ ok: true, mode, me });
});
