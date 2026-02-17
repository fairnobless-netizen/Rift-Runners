import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

function bootstrapDebugFlags() {
  const params = new URLSearchParams(window.location.search);

  const queryDebug =
    params.has('rr_debug') ||
    params.has('wsdebug') ||
    params.has('debug');

  let startParamDebug = false;

  try {
    const tg = (window as any).Telegram?.WebApp;
    const startParam = tg?.initDataUnsafe?.start_param;

    if (typeof startParam === 'string' && startParam.toLowerCase().includes('debug')) {
      startParamDebug = true;
    }
  } catch (e) {
    // ignore safely
  }

  if (queryDebug || startParamDebug) {
    localStorage.setItem('rr_debug', '1');
  }
}

if ((window as any).Telegram?.WebApp) {
  (window as any).Telegram.WebApp.ready();
}

bootstrapDebugFlags();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // fail silently in production
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
