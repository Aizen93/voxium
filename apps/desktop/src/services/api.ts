import axios, { type InternalAxiosRequestConfig } from 'axios';
import { connectSocket } from './socket';
import { getAccessToken } from './tokenStorage';
import { API_BASE, isAccessTokenFresh, refreshAccessToken, SessionLostError } from './session';

// The REST base; defined with the session module (which cannot import this
// file) and re-exported for the callers that always took it from here
export { API_BASE };

export const api = axios.create({
  baseURL: API_BASE,
  // Note: withCredentials is intentionally NOT set. Auth uses Bearer tokens
  // via the Authorization header (not cookies). Setting withCredentials: true
  // triggers strict CORS (origin must be exact, not "*") which breaks on
  // Linux webkit2gtk where the Tauri custom protocol origin may not be echoed
  // correctly by the server.
});

// Attach the auth token to every request. A token known to be expired (the
// window was minimized longer than the access token lives) is renewed FIRST:
// the request then succeeds on its first trip instead of a 401 and a retry,
// and the renewal failing leaves the request to the 401 path below.
api.interceptors.request.use(async (config) => {
  let token = getAccessToken();
  if (token && !isAccessTokenFresh(token)) {
    try {
      token = await refreshAccessToken();
    } catch (err) {
      if (err instanceof SessionLostError) throw err;
      // Transient: send with what we have, the server decides
    }
  }
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/**
 * A 401 answers an access token the server no longer takes: renew it once
 * (one shared refresh, however many requests hit the 401 together) and retry
 * the request with the new one. A refused renewal has already ended the
 * session (services/session.ts); a transient renewal failure fails this
 * request only, the tokens stay for the next one.
 */
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config as (InternalAxiosRequestConfig & { _retry?: boolean }) | undefined;

    if (error.response?.status === 401 && originalRequest && !originalRequest._retry) {
      originalRequest._retry = true;
      let accessToken: string;
      try {
        accessToken = await refreshAccessToken();
      } catch (refreshErr) {
        return Promise.reject(refreshErr);
      }
      // The socket re-handshakes with the renewed token (or is revived if its
      // manager had given up while the token was expired)
      connectSocket(accessToken);
      originalRequest.headers.Authorization = `Bearer ${accessToken}`;
      return api(originalRequest);
    }

    return Promise.reject(error);
  }
);
