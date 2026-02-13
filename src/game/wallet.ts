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

export type LeaderboardMode = 'solo' | 'duo' | 'trio' | 'squad';

export type LeaderboardTopEntry = {
  rank: number;
  tgUserId: string;
  displayName: string;
  score: number;
};

export type LeaderboardMeEntry = {
  rank: number | null;
  score: number;
};

export type LeaderboardResponse = {
  ok: true;
  mode: LeaderboardMode;
  top: LeaderboardTopEntry[];
  me: LeaderboardMeEntry | null;
};


export type RoomMember = {
  tgUserId: string;
  displayName: string;
  joinedAt: string;
};

export type RoomState = {
  roomCode: string;
  ownerTgUserId?: string;
  capacity: number;
  status: string;
  createdAt?: string;
};

export type MyRoomEntry = {
  roomCode: string;
  capacity: number;
  status: string;
  createdAt: string;
  memberCount: number;
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

export async function fetchLeaderboard(mode: LeaderboardMode): Promise<LeaderboardResponse | null> {
  const token = getToken();

  try {
    const res = await fetch(`/api/leaderboard/${encodeURIComponent(mode)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    const json = await res.json();
    if (!json?.ok) return null;
    return {
      ok: true,
      mode: String(json.mode ?? mode) as LeaderboardMode,
      top: Array.isArray(json.top)
        ? json.top.map((entry: any) => ({
          rank: Number(entry?.rank ?? 0),
          tgUserId: String(entry?.tgUserId ?? ''),
          displayName: String(entry?.displayName ?? 'Unknown'),
          score: Number(entry?.score ?? 0),
        }))
        : [],
      me: json.me
        ? {
          rank: json.me.rank == null ? null : Number(json.me.rank),
          score: Number(json.me.score ?? 0),
        }
        : null,
    };
  } catch {
    return null;
  }
}

export async function submitLeaderboard(mode: LeaderboardMode, score: number): Promise<LeaderboardMeEntry | null> {
  const token = getToken();
  if (!token) return null;

  try {
    const res = await fetch('/api/leaderboard/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ mode, score }),
    });
    const json = await res.json();
    if (!json?.ok || !json.me) return null;
    return {
      rank: json.me.rank == null ? null : Number(json.me.rank),
      score: Number(json.me.score ?? 0),
    };
  } catch {
    return null;
  }
}


export async function createRoom(capacity: 2 | 3 | 4): Promise<{ roomCode: string; capacity: number } | null> {
  const token = getToken();
  if (!token) return null;

  try {
    const res = await fetch('/api/rooms/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ capacity }),
    });
    const json = await res.json();
    if (!json?.ok) return null;
    return {
      roomCode: String(json.roomCode ?? ''),
      capacity: Number(json.capacity ?? capacity),
    };
  } catch {
    return null;
  }
}

export async function joinRoom(roomCode: string): Promise<{ room: RoomState; members: RoomMember[]; error?: string } | null> {
  const token = getToken();
  if (!token) return null;

  try {
    const res = await fetch('/api/rooms/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ roomCode }),
    });
    const json = await res.json();
    if (!json?.ok) {
      return {
        room: { roomCode: String(roomCode).toUpperCase(), capacity: 0, status: 'UNKNOWN' },
        members: [],
        error: String(json?.error ?? 'join_failed'),
      };
    }

    return {
      room: {
        roomCode: String(json.room?.roomCode ?? ''),
        capacity: Number(json.room?.capacity ?? 0),
        status: String(json.room?.status ?? 'OPEN'),
      },
      members: Array.isArray(json.members)
        ? json.members.map((member: any) => ({
          tgUserId: String(member?.tgUserId ?? ''),
          displayName: String(member?.displayName ?? 'Unknown'),
          joinedAt: String(member?.joinedAt ?? ''),
        }))
        : [],
    };
  } catch {
    return null;
  }
}

export async function fetchMyRooms(): Promise<MyRoomEntry[]> {
  const token = getToken();
  if (!token) return [];

  try {
    const res = await fetch('/api/rooms/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    if (!json?.ok || !Array.isArray(json.rooms)) return [];

    return json.rooms.map((room: any) => ({
      roomCode: String(room?.roomCode ?? ''),
      capacity: Number(room?.capacity ?? 0),
      status: String(room?.status ?? 'OPEN'),
      createdAt: String(room?.createdAt ?? ''),
      memberCount: Number(room?.memberCount ?? 0),
    }));
  } catch {
    return [];
  }
}

export async function fetchRoom(roomCode: string): Promise<{ room: RoomState; members: RoomMember[] } | null> {
  const token = getToken();
  if (!token) return null;

  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomCode)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    if (!json?.ok || !json.room) return null;

    return {
      room: {
        roomCode: String(json.room.roomCode ?? ''),
        ownerTgUserId: String(json.room.ownerTgUserId ?? ''),
        capacity: Number(json.room.capacity ?? 0),
        status: String(json.room.status ?? 'OPEN'),
        createdAt: String(json.room.createdAt ?? ''),
      },
      members: Array.isArray(json.members)
        ? json.members.map((member: any) => ({
          tgUserId: String(member?.tgUserId ?? ''),
          displayName: String(member?.displayName ?? 'Unknown'),
          joinedAt: String(member?.joinedAt ?? ''),
        }))
        : [],
    };
  } catch {
    return null;
  }
}
