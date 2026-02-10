const SESSION_TOKEN_KEY = 'rift_session_token';

export type Wallet = { stars: number; crystals: number };

function getToken(): string | null {
  try {
    const t = localStorage.getItem(SESSION_TOKEN_KEY);
    return t && t.trim() ? t : null;
  } catch {
    return null;
  }
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

    return {
      stars: Number(json.wallet?.stars ?? 0),
      crystals: Number(json.wallet?.crystals ?? 0),
    };
  } catch {
    return null;
  }
}

// TEMP helper for MVP wiring
export async function grantWallet(delta: Partial<Wallet>): Promise<Wallet | null> {
  const token = getToken();
  if (!token) return null;

  try {
    const res = await fetch('/api/wallet/grant', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(delta),
    });
    const json = await res.json();
    if (!json?.ok) return null;

    return {
      stars: Number(json.wallet?.stars ?? 0),
      crystals: Number(json.wallet?.crystals ?? 0),
    };
  } catch {
    return null;
  }
}
