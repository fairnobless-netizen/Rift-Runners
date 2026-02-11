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

export type WalletLedgerType = 'reward' | 'purchase' | 'refund' | 'adjustment';
export type WalletCurrency = 'stars' | 'crystals';

export type WalletLedgerEntryRecord = {
  id: string;
  tgUserId: string;
  type: WalletLedgerType;
  currency: WalletCurrency;
  amount: number;
  meta: Record<string, unknown>;
  createdAt: number;
};

export type PurchaseIntentRecord = {
  id: string;
  tgUserId: string;
  sku: string;
  provider: 'telegram_stars';
  createdAt: number;
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
const purchaseIntents = new Map<string, PurchaseIntentRecord>();
const walletLedger: WalletLedgerEntryRecord[] = [];

export const memoryDb = {
  users,
  wallets,
  sessions,
  campaignProgress,
  purchaseIntents,
  walletLedger,
};

// TODO M5c+: replace memoryDb with Postgres + ORM repositories
// TODO M5e+: replace campaignProgress Map with DB table keyed by tgUserId
