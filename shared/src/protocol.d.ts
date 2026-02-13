export type ProtocolVersion = 'match_v1';

export type MoveDir = 'up' | 'down' | 'left' | 'right';

export type MatchInputPayload =
  | { kind: 'move'; dir: MoveDir };

export type MatchClientMessage =
  | { type: 'match:start' }
  | { type: 'match:input'; seq: number; payload: MatchInputPayload };

export type MatchSnapshot = {
  version: ProtocolVersion;
  matchId: string;
  tick: number;
  serverTime: number;
  world: {
    gridW: number;
    gridH: number;
  };
  players: Array<{
    tgUserId: string;
    displayName: string;
    colorId: number;
    skinId: string;
    lastInputSeq: number;
    x: number;
    y: number;
  }>;
};

export type MatchSnapshotV1 = MatchSnapshot;

export type MatchServerMessage =
  | { type: 'match:started'; matchId: string }
  | { type: 'match:snapshot'; snapshot: MatchSnapshot }
  | { type: 'match:error'; error: string };
