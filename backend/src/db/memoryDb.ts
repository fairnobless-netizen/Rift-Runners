export type UserRecord = {
  tgUserId: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
};

export type WalletRecord = {
  tgUserId: string;
  stars: number;
  crystals: number;
};

export type CampaignProgressRecord = {
  tgUserId: string;
  stage: number;
  zone: number;
  score: number;
  trophies: string[];
  updatedAt: number;
};

export type SessionRecord = {
  token: string;
  tgUserId: string;
  createdAt: number;
};

const users = new Map<string, UserRecord>();
const wallets = new Map<string, WalletRecord>();
const sessions = new Map<string, SessionRecord>();
const campaignProgress = new Map<string, CampaignProgressRecord>();

export const memoryDb = {
  users,
  wallets,
  sessions,
  campaignProgress,
};

// TODO M5c+: replace memoryDb with Postgres + ORM repositories
// TODO M5e+: replace campaignProgress Map with DB table keyed by tgUserId
