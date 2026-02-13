export type {
  MoveDir,
  MatchInputPayload,
  MatchClientMessage,
  MatchServerMessage,
  MatchSnapshot,
  MatchSnapshotV1,
  ProtocolVersion,
} from '@shared/protocol';

import type { MatchInputPayload, MatchSnapshotV1 } from '@shared/protocol';

export type WsClientMessage =
  | { type: 'ping'; id: number; t: number }
  | { type: 'lobby:list' }
  | { type: 'room:create' }
  | { type: 'room:join'; roomId: string }
  | { type: 'room:leave' }
  | { type: 'match:start' }
  | { type: 'match:input'; seq: number; payload: MatchInputPayload };

export type WsServerMessage =
  | { type: 'pong'; id: number; t: number; serverNow: number }
  | { type: 'lobby:list'; rooms: Array<{ roomId: string; players: number }> }
  | { type: 'room:joined'; room: unknown }
  | { type: 'room:left' }
  | { type: 'match:started'; matchId: string }
  | { type: 'match:snapshot'; snapshot: MatchSnapshotV1 }
  | { type: 'error'; error: string };
