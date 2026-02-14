import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

if (import.meta.env.PROD) {
  void import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
