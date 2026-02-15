// src/utils/apiBase.ts
// API base for deployments where frontend and backend are on different origins.
// If VITE_API_BASE_URL is not set, we fallback to same-origin requests.

const RAW_BASE = (import.meta as any)?.env?.VITE_API_BASE_URL ?? '';

export const API_BASE =
  typeof RAW_BASE === 'string' && RAW_BASE.trim().length > 0
    ? (RAW_BASE.trim().endsWith('/') ? RAW_BASE.trim().slice(0, -1) : RAW_BASE.trim())
    : '';

export function apiUrl(path: string): string {
  // keep legacy behavior for local/dev where backend may be proxied/same-origin
  if (!API_BASE) return path;

  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${normalized}`;
}
