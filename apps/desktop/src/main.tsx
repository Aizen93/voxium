import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles/globals.css';

// ─── Global error handlers ──────────────────────────────────────────────────
// Catch unhandled promise rejections (e.g., forgotten .catch())
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Voxium] Unhandled promise rejection:', event.reason);
  event.preventDefault(); // Prevent default browser error logging
});

// Catch uncaught synchronous errors that escape React error boundaries
window.addEventListener('error', (event) => {
  console.error('[Voxium] Uncaught error:', event.error || event.message);
});

// ─── Remove splash screen after React mounts ────────────────────────────────
function removeSplash() {
  const splash = document.getElementById('splash');
  if (splash) {
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 300); // wait for fade-out transition
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App onReady={removeSplash} />
    </BrowserRouter>
  </React.StrictMode>
);
