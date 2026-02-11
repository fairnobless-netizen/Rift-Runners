export type MatchClientMessage =
  | { type: 'match:start' }
  | { type: 'match:input'; seq: number; payload: any };

export type MatchServerMessage =
  | { type: 'match:started'; matchId: string }
  | { type: 'match:snapshot'; snapshot: MatchSnapshot }
  | { type: 'match:error'; error: string };

export type MatchSnapshot = {
  version: 'match_v1';
  matchId: string;
  tick: number;
  serverTime: number;
  players: Array<{
    tgUserId: string;
    lastInputSeq: number;
  }>;
};
