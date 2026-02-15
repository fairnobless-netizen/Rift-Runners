export type FriendStatus = 'online' | 'offline';

export type FriendConfirmed = {
  id: string;
  name: string;
  status: FriendStatus;
};

export type FriendRequest = {
  id: string;
  name: string;
};

export type SearchUser = {
  id: string;
  name: string;
};

export type RoomCard = {
  code: string;
  name: string;
  players: number;
  capacity: number;
  hasPassword: boolean;
  password?: string;
};

export const friendsConfirmed: FriendConfirmed[] = [
  { id: 'f_1', name: 'Nova', status: 'online' },
  { id: 'f_2', name: 'Echo', status: 'offline' },
  { id: 'f_3', name: 'Riven', status: 'online' },
];

export const friendsIncoming: FriendRequest[] = [
  { id: 'in_1', name: 'Glitch' },
  { id: 'in_2', name: 'Pulse' },
];

export const friendsOutgoing: FriendRequest[] = [
  { id: 'out_1', name: 'Cipher' },
];

export const usersSearchPool: SearchUser[] = [
  { id: 'u_01', name: 'Astra' },
  { id: 'u_02', name: 'Blitz' },
  { id: 'u_03', name: 'Cobalt' },
  { id: 'u_04', name: 'Dusk' },
  { id: 'u_05', name: 'Ember' },
  { id: 'u_06', name: 'Flux' },
  { id: 'u_07', name: 'Halo' },
  { id: 'u_08', name: 'Ion' },
  { id: 'u_09', name: 'Jinx' },
  { id: 'u_10', name: 'Kairo' },
  { id: 'u_11', name: 'Lynx' },
];

export const roomsPublic: RoomCard[] = [
  { code: 'AB12CD', name: 'Neon Dock', players: 2, capacity: 4, hasPassword: false },
  { code: 'ZX90QP', name: 'Void Arena', players: 3, capacity: 4, hasPassword: true, password: 'rift' },
  { code: 'MN45TR', name: 'Plasma Ring', players: 1, capacity: 4, hasPassword: false },
  { code: 'LK77YU', name: 'Delta Core', players: 2, capacity: 4, hasPassword: true, password: '1234' },
];

export const referralMock = {
  link: 'https://t.me/rift_runners_bot?startapp=ref_NOVA88',
  plasmaEarned: 750,
  invitedFriends: 11,
};

const randomDelay = (): number => 300 + Math.floor(Math.random() * 200);

function delayed<T>(payload: T): Promise<T> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(payload), randomDelay());
  });
}

function code(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export async function mockSearchUsers(query: string): Promise<SearchUser[]> {
  const q = query.trim().toLowerCase();
  if (!q) return delayed([]);
  const results = usersSearchPool
    .filter((user) => user.name.toLowerCase().includes(q))
    .slice(0, 10);
  return delayed(results);
}

export async function mockCreateRoom(payload: { roomName: string; activeSlots: number; password?: string }): Promise<RoomCard> {
  const room: RoomCard = {
    code: code(),
    name: payload.roomName,
    players: Math.max(1, Math.min(payload.activeSlots, 4)),
    capacity: Math.max(2, Math.min(payload.activeSlots, 4)),
    hasPassword: Boolean(payload.password),
    password: payload.password,
  };
  return delayed(room);
}

export async function mockJoinRoom(codeValue: string, password?: string): Promise<{ ok: boolean; error?: string; room?: RoomCard }> {
  const found = roomsPublic.find((room) => room.code.toUpperCase() === codeValue.trim().toUpperCase());
  if (!found) return delayed({ ok: false, error: 'Room not found' });
  if (found.hasPassword && found.password !== password?.trim()) {
    return delayed({ ok: false, error: 'Wrong password' });
  }
  return delayed({ ok: true, room: found });
}

export async function mockListRooms(query?: string): Promise<RoomCard[]> {
  const q = query?.trim().toLowerCase() ?? '';
  const result = q ? roomsPublic.filter((room) => room.name.toLowerCase().includes(q)) : roomsPublic;
  return delayed(result);
}
