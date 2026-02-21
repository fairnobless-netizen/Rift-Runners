export type RoomLifecycleMeta = {
  roomId: string;
  createdAtMs: number;
  started: boolean;
  startedAtMs: number | null;
  lastSeenMs: number;
  activeConnectionIds: Set<string>;
};

type SweepConfig = {
  nowMs: number;
  staleConnectionMs: number;
  inactiveRoomMs: number;
};

type SweepResult = {
  staleConnectionIds: string[];
  removableRoomIds: string[];
};

export class RoomRegistry {
  private readonly rooms = new Map<string, RoomLifecycleMeta>();
  private readonly connections = new Map<string, { roomId: string; lastSeenMs: number }>();

  ensureRoom(roomId: string, nowMs = Date.now()): RoomLifecycleMeta {
    const existing = this.rooms.get(roomId);
    if (existing) {
      existing.lastSeenMs = nowMs;
      return existing;
    }

    const created: RoomLifecycleMeta = {
      roomId,
      createdAtMs: nowMs,
      started: false,
      startedAtMs: null,
      lastSeenMs: nowMs,
      activeConnectionIds: new Set(),
    };

    this.rooms.set(roomId, created);
    return created;
  }

  getRoom(roomId: string): RoomLifecycleMeta | null {
    return this.rooms.get(roomId) ?? null;
  }

  touchConnection(roomId: string, connectionId: string, nowMs = Date.now()): void {
    const room = this.ensureRoom(roomId, nowMs);
    room.activeConnectionIds.add(connectionId);
    room.lastSeenMs = nowMs;
    this.connections.set(connectionId, { roomId, lastSeenMs: nowMs });
  }

  heartbeat(connectionId: string, nowMs = Date.now()): void {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    connection.lastSeenMs = nowMs;

    const room = this.rooms.get(connection.roomId);
    if (!room) {
      return;
    }

    room.lastSeenMs = nowMs;
  }

  detachConnection(connectionId: string, nowMs = Date.now()): string | null {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return null;
    }

    this.connections.delete(connectionId);

    const room = this.rooms.get(connection.roomId);
    if (!room) {
      return connection.roomId;
    }

    room.activeConnectionIds.delete(connectionId);
    room.lastSeenMs = nowMs;

    if (room.activeConnectionIds.size === 0) {
      this.rooms.delete(connection.roomId);
    }

    return connection.roomId;
  }


  removeRoom(roomId: string): string[] {
    const room = this.rooms.get(roomId);
    if (!room) {
      return [];
    }

    const connectionIds = Array.from(room.activeConnectionIds);
    this.rooms.delete(roomId);

    for (const connectionId of connectionIds) {
      this.connections.delete(connectionId);
    }

    return connectionIds;
  }
  markStarted(roomId: string, nowMs = Date.now()): void {
    const room = this.ensureRoom(roomId, nowMs);
    room.started = true;
    room.startedAtMs = nowMs;
    room.lastSeenMs = nowMs;
  }

  markLobby(roomId: string, nowMs = Date.now()): void {
    const room = this.ensureRoom(roomId, nowMs);
    room.started = false;
    room.startedAtMs = null;
    room.lastSeenMs = nowMs;
  }

  sweep(config: SweepConfig): SweepResult {
    const staleConnectionIds: string[] = [];
    const removableRoomIds: string[] = [];

    for (const [connectionId, connection] of this.connections.entries()) {
      if (config.nowMs - connection.lastSeenMs > config.staleConnectionMs) {
        staleConnectionIds.push(connectionId);
      }
    }

    for (const room of this.rooms.values()) {
      const idleForMs = config.nowMs - room.lastSeenMs;
      if (room.activeConnectionIds.size === 0 || idleForMs > config.inactiveRoomMs) {
        removableRoomIds.push(room.roomId);
      }
    }

    return { staleConnectionIds, removableRoomIds };
  }
}
