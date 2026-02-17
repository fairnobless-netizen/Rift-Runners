export function isDebugEnabled(search: string = window.location.search): boolean {
  try {
    const params = new URLSearchParams(search);
    const fromQuery = params.get('rr_debug') === '1' || params.get('wsdebug') === '1' || params.get('debug') === '1';
    const fromStorage = window.localStorage.getItem('rr_debug') === '1';
    return fromStorage || fromQuery;
  } catch {
    return false;
  }
}

