type DebugState = {
  fromQuery: boolean;
  fromTgWebAppStartParam: boolean;
  fromTelegramStartParam: boolean;
  fromStorage: boolean;
  fromMemory: boolean;
  enabled: boolean;
};

declare global {
  interface Window {
    __RR_DEBUG__?: boolean;
  }
}

function hasDebugToken(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase().includes('debug');
}

export function getDebugState(search: string = window.location.search): DebugState {
  const params = new URLSearchParams(search);
  const queryFlags: Array<'rr_debug' | 'wsdebug' | 'debug'> = ['rr_debug', 'wsdebug', 'debug'];
  const fromQuery = queryFlags.some((key) => params.get(key) === '1' || params.has(key));
  const fromTgWebAppStartParam = hasDebugToken(params.get('tgWebAppStartParam'));

  let fromTelegramStartParam = false;
  try {
    const tg = (window as any).Telegram?.WebApp;
    fromTelegramStartParam = hasDebugToken(tg?.initDataUnsafe?.start_param);
  } catch {
    fromTelegramStartParam = false;
  }

  let fromStorage = false;
  try {
    fromStorage = window.localStorage.getItem('rr_debug') === '1';
  } catch {
    fromStorage = false;
  }

  const fromMemory = window.__RR_DEBUG__ === true;
  const enabled = fromQuery || fromTgWebAppStartParam || fromTelegramStartParam || fromStorage || fromMemory;

  if (enabled) {
    window.__RR_DEBUG__ = true;
  }

  return {
    fromQuery,
    fromTgWebAppStartParam,
    fromTelegramStartParam,
    fromStorage,
    fromMemory,
    enabled,
  };
}

export function isDebugEnabled(search: string = window.location.search): boolean {
  return getDebugState(search).enabled;
}
