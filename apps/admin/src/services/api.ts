import axios, { type InternalAxiosRequestConfig } from 'axios';
import { getAccessToken } from './tokenStorage';
import {
  API_BASE, AccountChangedError, SessionLostError, bearerOf, currentSessionEpoch, isTabSignedIn, mayCarry,
  refreshAccessToken, reloadOntoStoredSession,
} from './session';

declare module 'axios' {
  interface AxiosRequestConfig {
    /**
     * A request that must neither carry the stored bearer nor ever renew or
     * retry on a 401 (sign-in and the two-factor step: a 401 there is the
     * route's own answer).
     */
    skipAuth?: boolean;
    /**
     * The session restore's own request: it renews on a 401 although the tab
     * is not signed in yet (the restore compares the answer with the stored
     * session before it uses it).
     */
    sessionRestore?: boolean;
    /** @internal the session epoch the request was first sent in */
    _sessionEpoch?: number;
    /** @internal the request is the one retry after a 401 */
    _retry?: boolean;
  }
}

export const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
});

// Attach the stored access token, or the token the 401 path chose for the one
// retry. A tab that is not signed in sends only the restore's own request
// (its session ended: a view still mounted until the page goes must not send
// whatever another tab stored since). A token of another account than the one
// this tab is signed in as (another tab signed in as someone else, this tab
// not reloaded yet) is never sent: the request is rejected unsent and the page
// reloads onto the stored session. A request keeps the session epoch it was
// first sent in, so its 401 is never retried in a later session of this tab
// (below).
api.interceptors.request.use((config) => {
  if (config.skipAuth) return config;
  if (!isTabSignedIn() && !config.sessionRestore) throw new SessionLostError('This tab is not signed in');
  config._sessionEpoch ??= currentSessionEpoch();
  const token = config._retry ? bearerOf(config.headers.Authorization) : getAccessToken();
  if (token === null) return config;
  if (!mayCarry(token)) {
    reloadOntoStoredSession();
    throw new AccountChangedError();
  }
  config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// A 401 renews the access token (one shared request, services/session.ts)
// and retries that request ONCE, only while the session the request was sent
// in is still this tab's and the tab is signed in (or the request is the
// restore's own). A request that carried no bearer goes the same way: with
// nothing stored (another tab signed out under a page that still shows the
// dashboard) the renewal finds no refresh token and ends the session here,
// instead of every later request answering 401. Only a refused refresh ends
// the session; a transport failure of the refresh fails this request and
// keeps the tokens.
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest: InternalAxiosRequestConfig | undefined = error?.config;

    if (error?.response?.status !== 401 || !originalRequest || originalRequest._retry || originalRequest.skipAuth) {
      return Promise.reject(error);
    }
    // Sent in a session that has ended since (a sign-out, a sign-in, a
    // refusal), or answered while the tab is signed out (a request still out
    // from a view that unmounted): its 401 is its caller's. Nothing renews,
    // retries, navigates or changes the storage for it.
    if (originalRequest._sessionEpoch !== currentSessionEpoch()) return Promise.reject(error);
    if (!isTabSignedIn() && !originalRequest.sessionRestore) return Promise.reject(error);
    originalRequest._retry = true;

    // Another request (or another tab) stored a token since this one was sent:
    // use it. The request interceptor checks its account before the retry.
    const sentToken = bearerOf(originalRequest.headers?.Authorization);
    const current = getAccessToken();
    const token = current !== null && current !== sentToken ? current : await refreshAccessToken();

    originalRequest.headers.Authorization = `Bearer ${token}`;
    return api(originalRequest);
  }
);
