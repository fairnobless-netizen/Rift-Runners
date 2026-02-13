const SESSION_TOKEN_KEY = 'rift_session_token';

export type Wallet = { stars: number; crystals: number };

export type WalletLedgerEntry = {
  id: string;
  tgUserId: string;
  type: 'reward' | 'purchase' | 'refund' | 'adjustment';
  currency: 'stars' | 'crystals';
  amount: number;
  meta: Record<string, unknown>;
  createdAt: number;
};

export type ShopCatalogItem = {
  sku: string;
  category: string;
  title: string;
  description: string;
  priceStars: number;
  active: boolean;
  purchaseEnabled: boolean;
  sortOrder: number;
};

function getToken(): string | null {
  try {
    const t = localStorage.getItem(SESSION_TOKEN_KEY);
    return t && t.trim() ? t : null;
  } catch {
    return null;
  }
}

function parseWallet(value: any): Wallet {
  return {
    stars: Number(value?.stars ?? 0),
    crystals: Number(value?.crystals ?? 0),
  };
}

export async function fetchWallet(): Promise<Wallet | null> {
  const token = getToken();
  if (!token) return null;

  try {
    const res = await fetch('/api/wallet/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    if (!json?.ok) return null;
    return parseWallet(json.wallet);
  } catch {
    return null;
  }
}

export async function fetchLedger(limit = 50): Promise<WalletLedgerEntry[]> {
  const token = getToken();
  if (!token) return [];

  try {
    const res = await fetch(`/api/wallet/ledger?limit=${encodeURIComponent(String(limit))}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    if (!json?.ok || !Array.isArray(json.entries)) return [];
    return json.entries as WalletLedgerEntry[];
  } catch {
    return [];
  }
}

export async function fetchShopCatalog(): Promise<ShopCatalogItem[]> {
  try {
    const res = await fetch('/api/shop/catalog');
    const json = await res.json();
    if (!json?.ok || !Array.isArray(json.items)) return [];
    return json.items as ShopCatalogItem[];
  } catch {
    return [];
  }
}

export async function fetchShopOwned(): Promise<string[]> {
  const token = getToken();
  if (!token) return [];

  try {
    const res = await fetch('/api/shop/owned', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    if (!json?.ok || !Array.isArray(json.ownedSkus)) return [];
    return json.ownedSkus.map((sku: unknown) => String(sku));
  } catch {
    return [];
  }
}

export async function buyShopSku(sku: string): Promise<{ wallet: Wallet; ownedSkus: string[] } | null> {
  const token = getToken();
  if (!token) return null;

  try {
    const res = await fetch('/api/shop/buy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sku }),
    });
    const json = await res.json();
    if (!json?.ok) return null;
    return {
      wallet: parseWallet(json.wallet),
      ownedSkus: Array.isArray(json.ownedSkus) ? json.ownedSkus.map((v: unknown) => String(v)) : [],
    };
  } catch {
    return null;
  }
}

export async function createPurchaseIntent(sku: string): Promise<{ intentId: string; provider: string } | null> {
  const token = getToken();
  if (!token) return null;

  try {
    const res = await fetch('/api/shop/purchase-intent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sku }),
    });
    const json = await res.json();
    if (!json?.ok) return null;
    return { intentId: String(json.intentId), provider: String(json.provider) };
  } catch {
    return null;
  }
}

export async function confirmPurchase(intentId: string): Promise<{ wallet: Wallet; ledgerEntry: WalletLedgerEntry } | null> {
  const token = getToken();
  if (!token) return null;

  try {
    const res = await fetch('/api/shop/purchase-confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        intentId,
        providerPayload: {
          stub: true,
          source: 'frontend_stub_confirm',
        },
      }),
    });
    const json = await res.json();
    if (!json?.ok) return null;

    return {
      wallet: parseWallet(json.wallet),
      ledgerEntry: json.ledgerEntry as WalletLedgerEntry,
    };
  } catch {
    return null;
  }
}
