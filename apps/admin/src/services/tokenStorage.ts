// Every key the admin dashboard keeps in browser storage lives here, under a
// name of its own: the web client uses `voxium_access_token` and
// `voxium_refresh_token`, and where both apps are served from one origin a
// shared name makes each read, overwrite and clear the other's session. The old
// names are never read, moved or removed (on a shared origin they may hold the
// web client's session): an administrator signs in once more.
const ACCESS_KEY = 'voxium_admin_access_token';
const REFRESH_KEY = 'voxium_admin_refresh_token';
const TRUSTED_DEVICE_KEY = 'voxium_admin_trusted_device';

/** Every storage key the admin app uses (pinned apart from the client's by a test). */
export const ADMIN_STORAGE_KEYS: readonly string[] = [ACCESS_KEY, REFRESH_KEY, TRUSTED_DEVICE_KEY];

export function getTrustedDeviceToken(): string | undefined {
  return localStorage.getItem(TRUSTED_DEVICE_KEY) || undefined;
}

export function setTrustedDeviceToken(token: string): void {
  localStorage.setItem(TRUSTED_DEVICE_KEY, token);
}

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_KEY) ?? sessionStorage.getItem(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY) ?? sessionStorage.getItem(REFRESH_KEY);
}

/**
 * Store tokens in the appropriate storage.
 * - rememberMe=true  → localStorage (survives app restart)
 * - rememberMe=false → sessionStorage (cleared when window closes)
 * - rememberMe omitted → auto-detect from where current tokens live
 *   (used during token refresh to preserve the original choice)
 */
export function setTokens(accessToken: string, refreshToken: string, rememberMe?: boolean): void {
  const useLocal = rememberMe ?? (localStorage.getItem(ACCESS_KEY) !== null);

  if (useLocal) {
    sessionStorage.removeItem(ACCESS_KEY);
    sessionStorage.removeItem(REFRESH_KEY);
    localStorage.setItem(ACCESS_KEY, accessToken);
    localStorage.setItem(REFRESH_KEY, refreshToken);
  } else {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    sessionStorage.setItem(ACCESS_KEY, accessToken);
    sessionStorage.setItem(REFRESH_KEY, refreshToken);
  }
}

/** Returns true if tokens are stored in localStorage (i.e. "remember me" is active). */
export function isRemembered(): boolean {
  return localStorage.getItem(ACCESS_KEY) !== null;
}

export function clearTokens(): void {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  sessionStorage.removeItem(ACCESS_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
}
