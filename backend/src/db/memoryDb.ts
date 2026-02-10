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

export type SessionRecord = {
  token: string;
  tgUserId: string;
  createdAt: number;
};

const users = new Map<string, UserRecord>();
const wallets = new Map<string, WalletRecord>();
const sessions = new Map<string, SessionRecord>();

export const memoryDb = {
  users,
  wallets,
  sessions,
};

// TODO M5c+: replace memoryDb with Postgres + ORM repositories
