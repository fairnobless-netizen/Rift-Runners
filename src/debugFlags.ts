function parseBooleanFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export const DEBUG_UI_ENABLED = parseBooleanFlag(import.meta.env.VITE_DEBUG_UI);
