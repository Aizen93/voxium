import axios, { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { connectSocket } from './socket';
import { getAccessToken, getRefreshToken } from './tokenStorage';
import { API_BASE, isAccessTokenFresh, shouldRenewBeforeSending, refreshAccessToken, SessionLostError } from './session';
import { requestGeneration, bumpRequestGeneration } from './requestGeneration';

// The REST base; defined with the session module (which cannot import this
// file) and re-exported for the callers that always took it from here
export { API_BASE };

/** What the interceptors note on a request's config (read back from an error's `config` by the session restore). */
export type SessionRequestConfig = InternalAxiosRequestConfig & {
  /** The 401 path ran once for this request. */
  _retry?: boolean;
  /** The request went out with a stale token because its renewal had just failed transiently. */
  _renewalFailed?: boolean;
};

/** The token a request carried, from its Authorization header (an AxiosHeaders on a sent request, a plain object before). */
function bearerOf(config: SessionRequestConfig): string | null {
  const headers = config.headers as { get?: (name: string) => unknown; Authorization?: unknown } | undefined;
  const value = typeof headers?.get === 'function' ? headers.get('Authorization') : headers?.Authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice('Bearer '.length) : null;
}

// ─── Identical GETs in flight share one request ──────────────────────────────
//
// The client asks for the same resource from several places at once: the
// layout's mount and the socket's connect handler both fetch the server and
// DM lists, every component with a permission gate asks for the same
// effective permissions, a reload asks for the device list four times — and
// StrictMode doubles every mount effect in dev. Each copy costs a point of
// the per-IP request budget that everyone behind the same NAT shares, and
// three colleagues navigating at once were refused ordinary reads for it.
// Coalesced at the transport: the interceptors still run per caller (the 401
// retry included — a follower is handed an error of its own, with its own
// config), and a follower gets its own copy of the data. Left alone: anything
// but a plain GET (a download, an abortable or cancellable request, a custom
// transform or status check, a request with a body), and the reads that are
// not idempotent on the server (a key-share claim consumes what it reads).
// A GET issued after a write, or after the socket delivered an event, never
// joins one issued before (services/requestGeneration.ts), and nobody joins a
// leader older than COALESCE_MAX_AGE_MS: the api has no timeout, and a request
// hung on a dead connection must not take every later identical GET with it.

export const COALESCE_MAX_AGE_MS = 5_000;

/** Reads whose answer is consumed by the reading (never shared). */
const NON_IDEMPOTENT_GETS = [/^\/?e2e\/keyshares(\/|\?|$)/];

interface InFlightGet {
  promise: Promise<AxiosResponse>;
  startedAt: number;
}

const inFlightGets = new Map<string, InFlightGet>();
const transport: AxiosAdapter = axios.getAdapter(axios.defaults.adapter);

function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** The identity of a GET for coalescing, or null when the request must go out on its own. */
export function coalescingKey(config: InternalAxiosRequestConfig, generation: number = requestGeneration()): string | null {
  if ((config.method ?? 'get').toLowerCase() !== 'get') return null;
  if (config.signal || config.cancelToken || config.data !== undefined) return null;
  if (config.responseType && config.responseType !== 'json') return null;
  if (config.validateStatus || config.transformResponse || config.onDownloadProgress || config.paramsSerializer) return null;
  if (config.params !== undefined && !isPlainObject(config.params)) return null;
  const url = config.url ?? '';
  if (NON_IDEMPOTENT_GETS.some((re) => re.test(url))) return null;
  let params = '';
  if (config.params !== undefined) {
    try {
      params = JSON.stringify(config.params);
    } catch {
      // Not serialisable (a BigInt, a cycle): not ours to coalesce
      return null;
    }
  }
  return `${generation}|${config.baseURL ?? ''}|${url}|${params}|${bearerOf(config as SessionRequestConfig) ?? ''}`;
}

/** The leader's answer, as the follower's own: its config, its own copy of the data. */
function followerResponse(leader: AxiosResponse, config: InternalAxiosRequestConfig): AxiosResponse {
  return { ...leader, config, data: cloneData(leader.data) };
}

/** The leader's failure, as the follower's own: the 401 path reads `error.config` and marks it. */
function followerError(err: unknown, config: InternalAxiosRequestConfig): unknown {
  if (!(err instanceof AxiosError)) return err;
  const response = err.response ? { ...err.response, config, data: cloneData(err.response.data) } : undefined;
  return AxiosError.from(err, err.code, config, err.request, response);
}

function cloneData(data: unknown): unknown {
  return typeof data === 'object' && data !== null ? structuredClone(data) : data;
}

const coalescingAdapter: AxiosAdapter = (config) => {
  const key = coalescingKey(config);
  if (key === null) {
    // A write: whatever a GET in flight answers is from before it
    if ((config.method ?? 'get').toLowerCase() !== 'get') bumpRequestGeneration();
    return transport(config);
  }
  const now = Date.now();
  const leader = inFlightGets.get(key);
  if (leader && now - leader.startedAt <= COALESCE_MAX_AGE_MS) {
    return leader.promise.then(
      (response) => followerResponse(response, config),
      (err: unknown) => { throw followerError(err, config); },
    );
  }
  const entry: InFlightGet = { startedAt: now, promise: null as unknown as Promise<AxiosResponse> };
  entry.promise = transport(config).finally(() => {
    if (inFlightGets.get(key) === entry) inFlightGets.delete(key);
  });
  inFlightGets.set(key, entry);
  return entry.promise;
};

/** @internal tests */
export function _resetApiForTests(): void {
  inFlightGets.clear();
}

export const api = axios.create({
  baseURL: API_BASE,
  adapter: coalescingAdapter,
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
  if (token && shouldRenewBeforeSending(token)) {
    try {
      token = await refreshAccessToken();
    } catch (err) {
      if (err instanceof SessionLostError) throw err;
      // Transient: send with what we have, the server decides — and the 401
      // path knows not to spend a second renewal on the same breath
      console.warn('[API] Could not renew the token before the request:', err instanceof Error ? err.message : err);
      (config as SessionRequestConfig)._renewalFailed = true;
    }
  }
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/**
 * A 401 answers an access token the server no longer takes. Retried ONCE:
 * with the token stored meanwhile when another request's renewal landed
 * after this one left (no second renewal); not at all when this request's
 * own pre-send renewal just failed transiently (a second attempt in the same
 * breath would only spend the refresh limiter again); otherwise after one
 * shared renewal. A refused renewal has already ended the session
 * (services/session.ts); a transient renewal failure fails this request only,
 * the tokens stay for the next one.
 *
 * Only a request that CARRIED a token, from a session that CAN renew (a
 * refresh token is stored), gets here. A sign-in or a registration carries
 * none and a 401 is its answer (wrong password, expired TOTP challenge):
 * renewing for it ended a session that did not exist — a navigation to the
 * login page, which lost the typed e-mail and the error banner.
 */
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config as SessionRequestConfig | undefined;

    if (error.response?.status === 401 && originalRequest && !originalRequest._retry) {
      originalRequest._retry = true;
      const sent = bearerOf(originalRequest);
      if (!sent || !getRefreshToken()) return Promise.reject(error);
      let accessToken: string;
      const stored = getAccessToken();
      if (stored && stored !== sent && isAccessTokenFresh(stored)) {
        accessToken = stored;
      } else if (originalRequest._renewalFailed) {
        return Promise.reject(error);
      } else {
        try {
          accessToken = await refreshAccessToken();
        } catch (refreshErr) {
          return Promise.reject(refreshErr);
        }
        // The socket re-handshakes with the renewed token (or is reopened if
        // the server had closed its manager while the token was expired)
        connectSocket(accessToken);
      }
      originalRequest.headers.Authorization = `Bearer ${accessToken}`;
      return api(originalRequest);
    }

    return Promise.reject(error);
  }
);
