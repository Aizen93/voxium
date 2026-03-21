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
async function removeSplash() {
  // Remove inline HTML splash (for browser mode)
  const splash = document.getElementById('splash');
  if (splash) {
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 300);
  }

  // In Tauri: show the main window and close the splash window
  if ('__TAURI_INTERNALS__' in window) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');

      // Show main window first
      const main = getCurrentWindow();
      await main.show();
      await main.setFocus();

      // Then close the splash window
      const splashWin = await WebviewWindow.getByLabel('splash');
      if (splashWin) {
        await splashWin.close();
      }
    } catch (err) {
      console.warn('[Splash] Failed to swap windows:', err);
    }
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App onReady={removeSplash} />
    </BrowserRouter>
  </React.StrictMode>
);
