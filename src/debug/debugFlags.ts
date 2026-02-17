export function isDebugEnabled(search: string = window.location.search): boolean {
  try {
    const params = new URLSearchParams(search);
    const tgWebAppStartParam = params.get('tgWebAppStartParam')?.toLowerCase() ?? '';
    const fromQuery =
      params.has('rr_debug') ||
      params.get('rr_debug') === '1' ||
      params.has('wsdebug') ||
      params.get('wsdebug') === '1' ||
      params.has('debug') ||
      params.get('debug') === '1' ||
      tgWebAppStartParam.includes('debug') ||
      tgWebAppStartParam === 'wsdebug/rr_debug/debug';
    const fromStorage = window.localStorage.getItem('rr_debug') === '1';

    let fromInitDataStartParam = false;
    try {
      const tg = (window as any).Telegram?.WebApp;
      const startParam = tg?.initDataUnsafe?.start_param;
      fromInitDataStartParam = typeof startParam === 'string' && startParam.toLowerCase().includes('debug');
    } catch {
      // ignore safely
    }

    return fromStorage || fromQuery || fromInitDataStartParam;
  } catch {
    return false;
  }
}
