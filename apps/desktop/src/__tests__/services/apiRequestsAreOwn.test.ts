import { describe, it, expect, afterEach, vi } from 'vitest';
import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';

// The REAL axios instance of services/api.ts, with only its transport
// replaced: axios merges its own defaults (a status check, a response
// transform) into every config before the adapter runs, and what reaches the
// transport is what the client sends.
vi.mock('../../services/socket', () => ({ connectSocket: vi.fn() }));
vi.mock('../../services/tokenStorage', () => ({
  getAccessToken: vi.fn(() => null),
  getRefreshToken: vi.fn(() => null),
  isTokenOfAnotherAccount: vi.fn(() => false),
  reloadAfterSessionChange: vi.fn(),
}));
vi.mock('../../services/session', () => ({
  API_BASE: 'http://api.test/api/v1',
  isAccessTokenFresh: vi.fn(() => true),
  shouldRenewBeforeSending: vi.fn(() => false),
  refreshAccessToken: vi.fn(),
  currentSessionEpoch: vi.fn(() => 0),
  SessionLostError: class SessionLostError extends Error {},
}));

const originalAdapter = axios.defaults.adapter;

afterEach(() => {
  axios.defaults.adapter = originalAdapter;
  vi.resetModules();
});

describe('api — every request goes out as its own request', () => {
  it('two identical GETs issued in the same tick each reach the transport, and each caller gets its own response', async () => {
    const sent: InternalAxiosRequestConfig[] = [];
    const transport: AxiosAdapter = (config) => {
      sent.push(config);
      return Promise.resolve({ data: { n: sent.length }, status: 200, statusText: 'OK', headers: {}, config });
    };
    // The transport under whatever adapter the instance installs: set before
    // the module builds its instance, so an adapter that joins requests
    // would sit in front of this one and be seen
    axios.defaults.adapter = transport;
    vi.resetModules();
    const { api } = await import('../../services/api');

    const [first, second] = await Promise.all([api.get('/servers'), api.get('/servers')]);

    expect(sent).toHaveLength(2);
    expect(first).not.toBe(second);
    expect(first.data).toEqual({ n: 1 });
    expect(second.data).toEqual({ n: 2 });
    expect(first.config).not.toBe(second.config);
  });
});
