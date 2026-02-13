import { Router } from 'express';
import { resolveSessionFromRequest } from '../auth/session';
import {
  closeRoomTx,
  createRoomTx,
  getRoomByCode,
  joinRoomTx,
  leaveRoomTx,
  listMyRooms,
  listRoomMembers,
  setRoomMemberReadyTx,
  startRoomTx,
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
        phase: room.phase,
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


roomsRouter.post('/leave', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  try {
    const result = await leaveRoomTx(session.tgUserId);
    return res.status(200).json({ ok: true, ...result });
  } catch (error: any) {
    if (error?.code === 'ROOM_NOT_FOUND') return res.status(404).json({ ok: false, error: 'room_not_found' });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

roomsRouter.post('/close', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const roomCode = String((req as any).body?.roomCode ?? '').trim().toUpperCase();
  if (!roomCode) return res.status(400).json({ ok: false, error: 'room_code_required' });

  try {
    await closeRoomTx(session.tgUserId, roomCode);
    return res.status(200).json({ ok: true, roomCode });
  } catch (error: any) {
    if (error?.code === 'ROOM_NOT_FOUND') return res.status(404).json({ ok: false, error: 'room_not_found' });
    if (error?.code === 'FORBIDDEN') return res.status(403).json({ ok: false, error: 'forbidden' });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});


roomsRouter.post('/ready', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const roomCode = String((req as any).body?.roomCode ?? '').trim().toUpperCase();
  if (!roomCode) return res.status(400).json({ ok: false, error: 'room_code_required' });

  const readyRaw = (req as any).body?.ready;
  if (typeof readyRaw !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'ready_invalid' });
  }

  const ready = readyRaw;

  try {
    const result = await setRoomMemberReadyTx({ tgUserId: session.tgUserId, roomCode, ready });
    return res.status(200).json({ ok: true, room: result.room, members: result.members });
  } catch (error: any) {
    if (error?.code === 'ROOM_NOT_FOUND') return res.status(404).json({ ok: false, error: 'room_not_found' });
    if (error?.code === 'FORBIDDEN') return res.status(403).json({ ok: false, error: 'forbidden' });
    if (error?.code === 'ROOM_STARTED') return res.status(409).json({ ok: false, error: 'room_started' });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

roomsRouter.post('/start', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const roomCode = String((req as any).body?.roomCode ?? '').trim().toUpperCase();
  if (!roomCode) return res.status(400).json({ ok: false, error: 'room_code_required' });

  try {
    const result = await startRoomTx({ ownerTgUserId: session.tgUserId, roomCode });
    return res.status(200).json({ ok: true, room: result.room, members: result.members });
  } catch (error: any) {
    if (error?.code === 'ROOM_NOT_FOUND') return res.status(404).json({ ok: false, error: 'room_not_found' });
    if (error?.code === 'FORBIDDEN') return res.status(403).json({ ok: false, error: 'forbidden' });
    if (error?.code === 'ROOM_STARTED') return res.status(409).json({ ok: false, error: 'room_started' });
    if (error?.code === 'NOT_ENOUGH_PLAYERS') return res.status(409).json({ ok: false, error: 'not_enough_players' });
    if (error?.code === 'NOT_ALL_READY') return res.status(409).json({ ok: false, error: 'not_all_ready' });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

roomsRouter.get('/me', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const rooms = await listMyRooms(session.tgUserId);
  return res.status(200).json({ ok: true, rooms });
});

roomsRouter.get('/code/:code', async (req, res) => {
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
      phase: room.phase,
      startedAt: room.startedAt,
      startedByTgUserId: room.startedByTgUserId,
      createdAt: room.createdAt,
    },
    members,
  });
});
