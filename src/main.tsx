import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { getDebugState } from './debug/debugFlags';
import './styles.css';

function bootstrapDebugFlags() {
  const debugState = getDebugState(window.location.search);
  if (!debugState.enabled) return;

  window.__RR_DEBUG__ = true;

  try {
    window.localStorage.setItem('rr_debug', '1');
  } catch {
    // ignore storage write errors in restricted webviews
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
