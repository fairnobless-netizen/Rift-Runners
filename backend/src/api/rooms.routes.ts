import { Router } from 'express';
import { resolveSessionFromRequest } from '../auth/session';
import {
  closeRoomTx,
  createRoomPublic,
  createRoomTx,
  getRoomByCode,
  joinRoomTx,
  joinRoomWithPassword,
  leaveRoomTx,
  leaveRoomV2,
  listMyRooms,
  listMyRoomsV2,
  listPublicRooms,
  listRoomMembers,
  resumeRoomTx,
  setRoomMemberReadyTx,
  startRoomTx,
} from '../db/repos';

export const roomsRouter = Router();

roomsRouter.post('/', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const capacity = Number((req as any).body?.capacity);
  const name = String((req as any).body?.name ?? '').trim();
  const password = String((req as any).body?.password ?? '');
  if (![2, 3, 4].includes(capacity)) return res.status(400).json({ ok: false, error: 'capacity_invalid' });
  if (!name) return res.status(400).json({ ok: false, error: 'name_required' });

  try {
    const room = await createRoomPublic({ tgUserId: session.tgUserId, name, capacity: capacity as 2 | 3 | 4, password: password || undefined });
    return res.status(200).json({ room });
  } catch {
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

roomsRouter.get('/public', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const query = String(req.query?.query ?? '').trim();
  const rooms = await listPublicRooms(query);
  return res.status(200).json({ rooms });
});

roomsRouter.post('/:code/join', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const roomCode = String((req as any).params?.code ?? '').trim().toUpperCase();
  if (!roomCode) return res.status(400).json({ ok: false, error: 'room_code_required' });

  try {
    const room = await joinRoomWithPassword({ tgUserId: session.tgUserId, roomCode, password: String((req as any).body?.password ?? '') || undefined });
    return res.status(200).json({ room });
  } catch (error: any) {
    if (error?.code === 'ROOM_NOT_FOUND') return res.status(404).json({ ok: false, error: 'room_not_found' });
    if (error?.code === 'ROOM_FULL') return res.status(409).json({ ok: false, error: 'room_full' });
    if (error?.code === 'ROOM_STARTED') return res.status(409).json({ ok: false, error: 'room_started' });
    if (error?.code === 'WRONG_PASSWORD') return res.status(403).json({ ok: false, error: 'wrong_password' });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

roomsRouter.post('/:code/leave', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const roomCode = String((req as any).params?.code ?? '').trim().toUpperCase();
  if (!roomCode) return res.status(400).json({ ok: false, error: 'room_code_required' });

  try {
    await leaveRoomV2({ tgUserId: session.tgUserId, roomCode });
    return res.status(200).json({ ok: true });
  } catch (error: any) {
    if (error?.code === 'ROOM_NOT_FOUND') return res.status(404).json({ ok: false, error: 'room_not_found' });
    if (error?.code === 'NOT_A_MEMBER') return res.status(403).json({ ok: false, error: 'forbidden' });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

roomsRouter.get('/me', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const rooms = await listMyRoomsV2(session.tgUserId);
  return res.status(200).json({ ok: true, rooms });
});

// Legacy compatibility endpoints
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
        phase: room.phase ?? 'LOBBY',
      },
      members: joined.members.map((member) => ({
        ...member,
        ready: member.ready ?? false,
      })),
    });
  } catch (error: any) {
    if (error?.code === 'ROOM_NOT_FOUND') return res.status(404).json({ ok: false, error: 'room_not_found' });
    if (error?.code === 'ROOM_FULL') return res.status(409).json({ ok: false, error: 'room_full' });
    if (error?.code === 'ROOM_CLOSED') return res.status(409).json({ ok: false, error: 'room_closed' });
    if (error?.code === 'ROOM_STARTED') return res.status(409).json({ ok: false, error: 'room_started' });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});


roomsRouter.post('/resume', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const roomCode = String((req as any).body?.roomCode ?? '').trim().toUpperCase();
  if (!roomCode) return res.status(400).json({ ok: false, error: 'room_code_required' });

  try {
    const result = await resumeRoomTx({ tgUserId: session.tgUserId, roomCode });
    return res.status(200).json({
      ok: true,
      room: {
        roomCode: result.room.roomCode,
        ownerTgUserId: result.room.ownerTgUserId,
        capacity: result.room.capacity,
        status: result.room.status,
        phase: result.room.phase ?? 'LOBBY',
        createdAt: result.room.createdAt,
      },
      members: result.members.map((member) => ({ ...member, ready: member.ready ?? false })),
    });
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

  try {
    const result = await setRoomMemberReadyTx({ tgUserId: session.tgUserId, roomCode, ready: readyRaw });
    return res.status(200).json({ ok: true, room: { roomCode: result.room.roomCode, ownerTgUserId: result.room.ownerTgUserId, capacity: result.room.capacity, status: result.room.status, phase: result.room.phase ?? 'LOBBY', createdAt: result.room.createdAt }, members: result.members.map((member) => ({ ...member, ready: member.ready ?? false })) });
  } catch (error: any) {
    if (error?.code === 'ROOM_NOT_FOUND') return res.status(404).json({ ok: false, error: 'room_not_found' });
    if (error?.code === 'FORBIDDEN') return res.status(403).json({ ok: false, error: 'forbidden' });
    if (error?.code === 'NOT_A_MEMBER') return res.status(403).json({ ok: false, error: 'forbidden' });
    if (error?.code === 'ROOM_STARTED') return res.status(409).json({ ok: false, error: 'room_started' });
    if (error?.code === 'ROOM_CLOSED') return res.status(409).json({ ok: false, error: 'room_closed' });
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
    return res.status(200).json({ ok: true, room: { roomCode: result.room.roomCode, ownerTgUserId: result.room.ownerTgUserId, capacity: result.room.capacity, status: result.room.status, phase: result.room.phase ?? 'LOBBY', createdAt: result.room.createdAt }, members: result.members.map((member) => ({ ...member, ready: member.ready ?? false })) });
  } catch (error: any) {
    if (error?.code === 'ROOM_NOT_FOUND') return res.status(404).json({ ok: false, error: 'room_not_found' });
    if (error?.code === 'FORBIDDEN') return res.status(403).json({ ok: false, error: 'forbidden' });
    if (error?.code === 'ROOM_STARTED') return res.status(409).json({ ok: false, error: 'room_started' });
    if (error?.code === 'ROOM_CLOSED') return res.status(409).json({ ok: false, error: 'room_closed' });
    if (error?.code === 'NOT_ENOUGH_PLAYERS') return res.status(409).json({ ok: false, error: 'not_enough_players' });
    if (error?.code === 'NOT_ALL_READY') return res.status(409).json({ ok: false, error: 'not_all_ready' });
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
    if (error?.code === 'ROOM_NOT_JOINED') return res.status(200).json({ ok: true, roomCode: '' });
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

roomsRouter.get('/legacy/me', async (req, res) => {
  const session = await resolveSessionFromRequest(req as any);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const rooms = await listMyRooms(session.tgUserId);
  return res.status(200).json({ ok: true, rooms: rooms.map((room) => ({ ...room, phase: room.phase ?? 'LOBBY' })) });
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
    room: { roomCode: room.roomCode, ownerTgUserId: room.ownerTgUserId, capacity: room.capacity, status: room.status, phase: room.phase ?? 'LOBBY', createdAt: room.createdAt },
    members: members.map((member) => ({ ...member, ready: member.ready ?? false })),
  });
});
