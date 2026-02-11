import crypto from 'crypto';
import type { RoomSnapshot, RoomSummary } from './protocol';

type Player = {
  tgUserId: string;
  joinedAt: number;
};

type Room = {
  roomId: string;
  players: Map<string, Player>;
};

const rooms = new Map<string, Room>();

function newRoomId(): string {
  return `room_${crypto.randomBytes(6).toString('hex')}`;
}

export function listRooms(): RoomSummary[] {
  return Array.from(rooms.values()).map((room) => ({
    roomId: room.roomId,
    players: room.players.size,
  }));
}

export function createRoom(ownerUserId: string): Room {
  const roomId = newRoomId();
  const room: Room = {
    roomId,
    players: new Map(),
  };

  room.players.set(ownerUserId, {
    tgUserId: ownerUserId,
    joinedAt: Date.now(),
  });

  rooms.set(roomId, room);
  return room;
}

export function joinRoom(roomId: string, tgUserId: string): Room | null {
  const room = rooms.get(roomId);
  if (!room) return null;

  room.players.set(tgUserId, {
    tgUserId,
    joinedAt: Date.now(),
  });

  return room;
}

export function leaveRoom(roomId: string, tgUserId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;

  room.players.delete(tgUserId);

  if (room.players.size === 0) {
    rooms.delete(roomId);
  }
}

export function snapshotRoom(room: Room): RoomSnapshot {
  return {
    version: 'room_v1',
    roomId: room.roomId,
    players: Array.from(room.players.values()),
  };
}
