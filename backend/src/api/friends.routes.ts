import { Router } from 'express';
import { resolveSessionFromRequest } from '../auth/session';
import {
  listFriends,
  listIncomingRequests,
  listOutgoingRequests,
  requestFriend,
  respondFriendRequest,
} from '../db/repos';

export const friendsRouter = Router();

friendsRouter.get('/', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const [friends, incoming, outgoing] = await Promise.all([
    listFriends(session.tgUserId),
    listIncomingRequests(session.tgUserId),
    listOutgoingRequests(session.tgUserId),
  ]);

  return res.status(200).json({ ok: true, friends, incoming, outgoing });
});

friendsRouter.post('/request', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const toTgUserId = String((req as any).body?.toTgUserId ?? '').trim();
  if (!toTgUserId || toTgUserId === session.tgUserId) {
    return res.status(400).json({ ok: false, error: 'invalid_target' });
  }

  try {
    await requestFriend(session.tgUserId, toTgUserId);
    return res.status(200).json({ ok: true });
  } catch (error: any) {
    if (error?.code === 'INVALID_TARGET') return res.status(400).json({ ok: false, error: 'invalid_target' });
    if (error?.code === 'ALREADY_FRIENDS') return res.status(409).json({ ok: false, error: 'already_friends' });
    if (error?.code === 'ALREADY_REQUESTED') return res.status(409).json({ ok: false, error: 'already_requested' });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

friendsRouter.post('/respond', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const fromTgUserId = String((req as any).body?.fromTgUserId ?? '').trim();
  const actionRaw = String((req as any).body?.action ?? '').trim().toLowerCase();
  const action = actionRaw === 'accept' || actionRaw === 'decline' ? actionRaw : null;

  if (!fromTgUserId || !action) {
    return res.status(400).json({ ok: false, error: 'invalid_payload' });
  }

  try {
    await respondFriendRequest(session.tgUserId, fromTgUserId, action);
    return res.status(200).json({ ok: true });
  } catch (error: any) {
    if (error?.code === 'REQUEST_NOT_FOUND') return res.status(404).json({ ok: false, error: 'request_not_found' });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});
