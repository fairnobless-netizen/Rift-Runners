import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { getDebugState } from './debug/debugFlags';
import './styles.css';

function isAndroidRuntime(): boolean {
  return /Android/i.test(window.navigator.userAgent);
}

function bootstrapAndroidViewportFix() {
  if (!isAndroidRuntime()) {
    return;
  }

  const root = document.documentElement;
  root.classList.add('is-android');

  const syncViewportHeight = (): void => {
    root.style.setProperty('--app-vh', `${window.innerHeight * 0.01}px`);
  };

  syncViewportHeight();
  window.addEventListener('resize', syncViewportHeight);
  window.addEventListener('orientationchange', syncViewportHeight);
}

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
bootstrapAndroidViewportFix();

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
