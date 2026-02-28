import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

let permissionGranted = false;

/**
 * Check and request notification permission on app startup.
 * Should be called once from MainLayout on mount.
 */
export async function initNotifications(): Promise<void> {
  try {
    permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const permission = await requestPermission();
      permissionGranted = permission === 'granted';
    }
  } catch {
    // Plugin not available (e.g. running in browser dev mode) — fall back to Web API
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  }
}

/**
 * Send a native desktop notification. Falls back to Web Notification API
 * if the Tauri plugin is unavailable (browser dev mode).
 */
export function notify(title: string, body: string): void {
  try {
    if (permissionGranted) {
      sendNotification({ title, body });
      return;
    }
  } catch {
    // Plugin unavailable — fall through to Web API fallback
  }

  // Web API fallback (browser dev mode)
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, silent: true });
  }
}
