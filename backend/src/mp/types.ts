export type PlayerState = {
  tgUserId: string;
  lastInputSeq: number;
};

export type MatchState = {
  matchId: string;
  roomId: string;
  tick: number;
  players: Map<string, PlayerState>;
  inputQueue: Array<{
    tgUserId: string;
    seq: number;
    payload: any;
  }>;
  interval?: NodeJS.Timeout;
};
