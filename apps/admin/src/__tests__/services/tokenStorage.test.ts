import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAccessToken, getRefreshToken, setTokens, clearTokens, isRemembered,
  getTrustedDeviceToken, setTrustedDeviceToken, ADMIN_STORAGE_KEYS,
} from '../../services/tokenStorage';

// The names the web client keeps ITS session under.
const CLIENT_ACCESS = 'voxium_access_token';
const CLIENT_REFRESH = 'voxium_refresh_token';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('admin tokenStorage key names', () => {
  it('writes only under names of its own, in localStorage when remembered', () => {
    setTokens('a', 'r', true);
    expect(localStorage.getItem('voxium_admin_access_token')).toBe('a');
    expect(localStorage.getItem('voxium_admin_refresh_token')).toBe('r');
    expect(localStorage.length).toBe(2);
    expect(sessionStorage.length).toBe(0);
  });

  it('writes only under names of its own, in sessionStorage when not remembered', () => {
    setTokens('a', 'r', false);
    expect(sessionStorage.getItem('voxium_admin_access_token')).toBe('a');
    expect(sessionStorage.getItem('voxium_admin_refresh_token')).toBe('r');
    expect(sessionStorage.length).toBe(2);
    expect(localStorage.length).toBe(0);
  });

  it("never reads a session kept under the client's names", () => {
    localStorage.setItem(CLIENT_ACCESS, 'client-a');
    localStorage.setItem(CLIENT_REFRESH, 'client-r');
    sessionStorage.setItem(CLIENT_ACCESS, 'client-a2');
    sessionStorage.setItem(CLIENT_REFRESH, 'client-r2');
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(isRemembered()).toBe(false);
  });

  it("leaves the client's session untouched on sign-in, renewal and clear", () => {
    localStorage.setItem(CLIENT_ACCESS, 'client-a');
    localStorage.setItem(CLIENT_REFRESH, 'client-r');
    sessionStorage.setItem(CLIENT_ACCESS, 'client-a2');
    sessionStorage.setItem(CLIENT_REFRESH, 'client-r2');

    setTokens('a', 'r', true);
    setTokens('a2', 'r2'); // a renewal keeps the choice
    setTokens('a3', 'r3', false);
    clearTokens();

    expect(localStorage.getItem(CLIENT_ACCESS)).toBe('client-a');
    expect(localStorage.getItem(CLIENT_REFRESH)).toBe('client-r');
    expect(sessionStorage.getItem(CLIENT_ACCESS)).toBe('client-a2');
    expect(sessionStorage.getItem(CLIENT_REFRESH)).toBe('client-r2');
  });

  it('a clear removes the admin session from both storages and nothing else', () => {
    setTokens('a', 'r', true);
    sessionStorage.setItem('voxium_admin_access_token', 'x');
    localStorage.setItem('unrelated', 'keep');
    clearTokens();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('keep');
  });

  it('keeps the trusted-device token under its own name, across a clear', () => {
    expect(getTrustedDeviceToken()).toBeUndefined();
    setTrustedDeviceToken('t');
    expect(localStorage.getItem('voxium_admin_trusted_device')).toBe('t');
    expect(getTrustedDeviceToken()).toBe('t');
    clearTokens();
    expect(getTrustedDeviceToken()).toBe('t');
  });

  it('lists every key it uses', () => {
    expect([...ADMIN_STORAGE_KEYS].sort()).toEqual([
      'voxium_admin_access_token', 'voxium_admin_refresh_token', 'voxium_admin_trusted_device',
    ]);
  });
});
