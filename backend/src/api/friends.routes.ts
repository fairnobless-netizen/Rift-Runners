import { Router } from 'express';
import { resolveSessionFromRequest } from '../auth/session';
import {
  cancelFriendRequest,
  createFriendRequestByUsername,
  listConfirmedFriendsV2,
  listIncomingRequestsV2,
  listOutgoingRequestsV2,
  requestFriend,
  respondFriendRequest,
  searchUsers,
} from '../db/repos';

export const friendsRouter = Router();

friendsRouter.get('/', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const [confirmedRaw, incomingRaw, outgoingRaw] = await Promise.all([
    listConfirmedFriendsV2(session.tgUserId),
    listIncomingRequestsV2(session.tgUserId),
    listOutgoingRequestsV2(session.tgUserId),
  ]);

  return res.status(200).json({
    ok: true,
    friends: confirmedRaw.map((u) => ({
      tgUserId: u.userId,
      displayName: u.displayName,
    })),
    incoming: incomingRaw.map((r) => ({
      requestId: r.requestId,
      fromTgUserId: r.user.userId,
      displayName: r.user.displayName,
      createdAt: r.createdAt,
    })),
    outgoing: outgoingRaw.map((r) => ({
      requestId: r.requestId,
      toTgUserId: r.user.userId,
      displayName: r.user.displayName,
      createdAt: r.createdAt,
      status: 'PENDING',
    })),
  });
});

friendsRouter.get('/search', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const q = String(req.query?.q ?? '').trim();
  if (!q) return res.status(400).json({ ok: false, error: 'q_required' });

  const users = await searchUsers(q);
  return res.status(200).json({ ok: true, users });
});

friendsRouter.post('/request', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const username = String((req as any).body?.username ?? '').trim();
  const toTgUserId = String((req as any).body?.toTgUserId ?? '').trim();

  try {
    if (username) {
      await createFriendRequestByUsername(session.tgUserId, username);
    } else if (toTgUserId) {
      await requestFriend(session.tgUserId, toTgUserId);
    } else {
      return res.status(400).json({ ok: false, error: 'invalid_payload' });
    }

    return res.status(200).json({ ok: true });
  } catch (error: any) {
    if (error?.code === 'INVALID_USERNAME') return res.status(400).json({ ok: false, error: 'invalid_username' });
    if (error?.code === 'USER_NOT_FOUND') return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (error?.code === 'INVALID_TARGET') return res.status(400).json({ ok: false, error: 'invalid_target' });
    if (error?.code === 'ALREADY_FRIENDS') return res.status(409).json({ ok: false, error: 'already_friends' });
    if (error?.code === 'ALREADY_REQUESTED') return res.status(409).json({ ok: false, error: 'already_requested' });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

friendsRouter.post('/respond', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const requestId = String((req as any).body?.requestId ?? '').trim();
  const fromTgUserId = String((req as any).body?.fromTgUserId ?? '').trim();
  const actionRaw = String((req as any).body?.action ?? '').trim().toLowerCase();
  const action = actionRaw === 'accept' || actionRaw === 'decline' ? actionRaw : null;

  if (!action) {
    return res.status(400).json({ ok: false, error: 'invalid_payload' });
  }

  const fromId = requestId ? String(requestId.split(':')[0] ?? '') : fromTgUserId;
  if (!fromId) {
    return res.status(400).json({ ok: false, error: 'invalid_payload' });
  }

  try {
    await respondFriendRequest(session.tgUserId, fromId, action);
    return res.status(200).json({ ok: true });
  } catch (error: any) {
    if (error?.code === 'REQUEST_NOT_FOUND') return res.status(404).json({ ok: false, error: 'request_not_found' });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

friendsRouter.post('/cancel', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const requestId = String((req as any).body?.requestId ?? '').trim();
  if (!requestId) return res.status(400).json({ ok: false, error: 'invalid_payload' });

  try {
    await cancelFriendRequest(session.tgUserId, requestId);
    return res.status(200).json({ ok: true });
  } catch (error: any) {
    if (error?.code === 'FORBIDDEN') return res.status(403).json({ ok: false, error: 'forbidden' });
    if (error?.code === 'REQUEST_NOT_FOUND') return res.status(404).json({ ok: false, error: 'request_not_found' });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});
