import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { invoke } from '@tauri-apps/api/core';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';
const TAURI_AVAILABLE = '__TAURI_INTERNALS__' in window;

/** Must match the server's VALID_S3_KEY_RE: (avatars|server-icons)/[word-dash]+.webp */
const VALID_AVATAR_KEY_RE = /^(avatars|server-icons)\/[\w-]+\.webp$/;

const MAX_BLOB_CACHE_SIZE = 100;

let tauriPermissionGranted = false;

// Blob URL cache for Web Notification API avatar icons (browser mode).
// Capped at MAX_BLOB_CACHE_SIZE entries; oldest evicted first.
const avatarBlobCache = new Map<string, string>();

// In-flight fetch deduplication — prevents parallel fetches for the same key.
const avatarFetchInFlight = new Map<string, Promise<string | null>>();

/**
 * Check and request notification permission on app startup.
 * Should be called once from MainLayout on mount.
 */
export async function initNotifications(): Promise<void> {
  if (TAURI_AVAILABLE) {
    try {
      tauriPermissionGranted = await isPermissionGranted();
      if (!tauriPermissionGranted) {
        const permission = await requestPermission();
        tauriPermissionGranted = permission === 'granted';
      }
      return;
    } catch {
      // Plugin failed even in Tauri context — fall through to Web API
    }
  }

  // Browser mode — use Web Notification API
  if ('Notification' in window && Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {
      // Permission request failed — notifications will be unavailable
    }
  }
}

/**
 * Fetch an avatar image and return a blob: URL for the Web Notification API.
 * Uses ?inline to proxy through the server (avoids S3 302 redirect CORS issues).
 * Deduplicates concurrent fetches and caps cache size.
 */
async function resolveAvatarBlobUrl(avatarKey: string): Promise<string | null> {
  const cached = avatarBlobCache.get(avatarKey);
  if (cached) return cached;

  // Deduplicate: if a fetch for this key is already in flight, reuse it
  const inFlight = avatarFetchInFlight.get(avatarKey);
  if (inFlight) return inFlight;

  const promise = (async (): Promise<string | null> => {
    try {
      const response = await fetch(`${API_BASE}/uploads/${avatarKey}?inline`);
      if (!response.ok) return null;
      const blob = await response.blob();
      if (blob.size === 0 || blob.size > 1_048_576) return null;
      const blobUrl = URL.createObjectURL(blob);

      // Evict oldest entry if cache is full
      if (avatarBlobCache.size >= MAX_BLOB_CACHE_SIZE) {
        const oldest = avatarBlobCache.keys().next().value;
        if (oldest !== undefined) {
          const oldUrl = avatarBlobCache.get(oldest);
          if (oldUrl) URL.revokeObjectURL(oldUrl);
          avatarBlobCache.delete(oldest);
        }
      }

      avatarBlobCache.set(avatarKey, blobUrl);
      return blobUrl;
    } catch {
      return null;
    }
  })();

  avatarFetchInFlight.set(avatarKey, promise);
  try {
    return await promise;
  } finally {
    avatarFetchInFlight.delete(avatarKey);
  }
}

/**
 * Send a native desktop notification with optional avatar.
 *
 * Resolution order:
 * 1. Custom Tauri command (Windows: circular avatar in toast app logo position)
 * 2. Tauri notification plugin fallback (macOS/Linux, text-only)
 * 3. Web Notification API (browser mode, pre-fetched blob URL icon)
 */
export async function notify(
  title: string,
  body: string,
  avatarKey?: string | null,
): Promise<void> {
  // Validate avatar key format before using it in any URL construction
  const safeAvatarKey = avatarKey && VALID_AVATAR_KEY_RE.test(avatarKey) ? avatarKey : null;

  if (TAURI_AVAILABLE) {
    // 1. Try native Tauri command with avatar support (Windows)
    try {
      await invoke('notify_with_avatar', {
        title,
        body,
        apiBase: safeAvatarKey ? API_BASE : null,
        avatarKey: safeAvatarKey,
      });
      return;
    } catch {
      // Command not available or not implemented on this platform — fall through
    }

    // 2. Tauri notification plugin (no avatar, but native notifications)
    try {
      if (tauriPermissionGranted) {
        sendNotification({ title, body });
        return;
      }
    } catch {
      // Plugin unavailable — fall through to Web API
    }
  }

  // 3. Web Notification API (browser mode)
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const webOptions: NotificationOptions = { body, silent: true };
      if (safeAvatarKey) {
        const blobUrl = await resolveAvatarBlobUrl(safeAvatarKey);
        if (blobUrl) {
          webOptions.icon = blobUrl;
        }
      }
      new Notification(title, webOptions);
    } catch {
      // Web Notification API failed — non-critical, silently ignore
    }
  }
}
