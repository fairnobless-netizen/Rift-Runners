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

  const clampInset = (value: number): number => Math.min(80, Math.max(0, value));

  const syncSafeInsets = (): void => {
    const vv = window.visualViewport;
    if (!vv) {
      root.style.setProperty('--safe-left', '0px');
      root.style.setProperty('--safe-right', '0px');
      return;
    }

    const safeLeft = clampInset(vv.offsetLeft);
    const safeRight = clampInset(window.innerWidth - (vv.offsetLeft + vv.width));

    root.style.setProperty('--safe-left', `${safeLeft}px`);
    root.style.setProperty('--safe-right', `${safeRight}px`);
  };

  const syncViewportHeight = (): void => {
    root.style.setProperty('--app-vh', `${window.innerHeight * 0.01}px`);
    syncSafeInsets();
  };

  syncViewportHeight();
  window.addEventListener('resize', syncViewportHeight);
  window.addEventListener('orientationchange', syncViewportHeight);
  window.visualViewport?.addEventListener('resize', syncViewportHeight);
  window.visualViewport?.addEventListener('scroll', syncViewportHeight);
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
