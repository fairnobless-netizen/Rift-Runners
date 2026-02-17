import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

function bootstrapDebugFlags(): void {
  try {
    const qs = new URLSearchParams(window.location.search);
    const q = qs.get('rr_debug') || qs.get('debug') || qs.get('wsdebug');
    const startParam = (window as any)?.Telegram?.WebApp?.initDataUnsafe?.start_param;
    const token = [q, startParam].filter(Boolean).join(' ').toLowerCase();

    if (qs.get('rr_debug') === '0') {
      localStorage.removeItem('rr_debug');
    } else if (
      token.includes('debug') ||
      token.includes('wsdebug') ||
      qs.get('rr_debug') === '1'
    ) {
      localStorage.setItem('rr_debug', '1');
    }
  } catch {
    // fail silently
  }
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
