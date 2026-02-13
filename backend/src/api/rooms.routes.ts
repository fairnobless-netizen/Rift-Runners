import { Router } from 'express';
import { resolveSessionFromRequest } from '../auth/session';
import {
  createRoomTx,
  getRoomByCode,
  joinRoomTx,
  listMyRooms,
  listRoomMembers,
} from '../db/repos';

export const roomsRouter = Router();

roomsRouter.post('/create', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const capacity = Number((req as any).body?.capacity);
  if (![2, 3, 4].includes(capacity)) {
    return res.status(400).json({ ok: false, error: 'capacity_invalid' });
  }

  try {
    const created = await createRoomTx(session.tgUserId, capacity);
    return res.status(200).json({ ok: true, roomCode: created.roomCode, capacity });
  } catch {
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

roomsRouter.post('/join', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const roomCode = String((req as any).body?.roomCode ?? '').trim().toUpperCase();
  if (!roomCode) return res.status(400).json({ ok: false, error: 'room_code_required' });

  try {
    const joined = await joinRoomTx(session.tgUserId, roomCode);
    const room = await getRoomByCode(joined.roomCode);
    if (!room) return res.status(404).json({ ok: false, error: 'room_not_found' });

    return res.status(200).json({
      ok: true,
      room: {
        roomCode: room.roomCode,
        capacity: room.capacity,
        status: room.status,
      },
      members: joined.members,
    });
  } catch (error: any) {
    if (error?.code === 'ROOM_NOT_FOUND') return res.status(404).json({ ok: false, error: 'room_not_found' });
    if (error?.code === 'ROOM_FULL') return res.status(409).json({ ok: false, error: 'room_full' });
    if (error?.code === 'ROOM_CLOSED') return res.status(409).json({ ok: false, error: 'room_closed' });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

roomsRouter.get('/me', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const rooms = await listMyRooms(session.tgUserId);
  return res.status(200).json({ ok: true, rooms });
});

roomsRouter.get('/:code', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const roomCode = String((req as any).params?.code ?? '').trim().toUpperCase();
  if (!roomCode) return res.status(400).json({ ok: false, error: 'room_code_required' });

  const room = await getRoomByCode(roomCode);
  if (!room) return res.status(404).json({ ok: false, error: 'room_not_found' });

  const members = await listRoomMembers(roomCode);
  return res.status(200).json({
    ok: true,
    room: {
      roomCode: room.roomCode,
      ownerTgUserId: room.ownerTgUserId,
      capacity: room.capacity,
      status: room.status,
      createdAt: room.createdAt,
    },
    members,
  });
});
