// src/utils/apiBase.ts
function normalize(base?: string | null): string {
  const v = (base ?? '').trim();
  if (!v) return '';
  return v.endsWith('/') ? v.slice(0, -1) : v;
}

function readMetaApiBase(): string {
  try {
    const el = document.querySelector('meta[name="rr-api-base"]') as HTMLMetaElement | null;
    return normalize(el?.content);
  } catch {
    return '';
  }
}

// 1) build-time env (Vite)
const envBase = normalize((import.meta as any)?.env?.VITE_API_BASE_URL);

// 2) runtime meta fallback (also filled by Vite via %VITE_...% in index.html)
const metaBase = typeof document !== 'undefined' ? readMetaApiBase() : '';

export const API_BASE = envBase || metaBase;

export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return API_BASE ? `${API_BASE}${p}` : p;
}
