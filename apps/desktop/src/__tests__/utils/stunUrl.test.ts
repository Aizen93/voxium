import { describe, it, expect, vi } from 'vitest';
import { resolveStunUrl, deriveStunUrl, isValidStunUrl, DEFAULT_STUN_PORT } from '../../utils/stunUrl';

describe('stunUrl — where DM calls send their STUN binding requests', () => {
  it('derives stun:<api-host>:3478 from VITE_WS_URL by default (coturn lives on the edge box)', () => {
    expect(resolveStunUrl({ VITE_WS_URL: 'https://voxium.app' })).toBe(`stun:voxium.app:${DEFAULT_STUN_PORT}`);
    expect(resolveStunUrl({ VITE_WS_URL: 'http://192.168.1.15:3001' })).toBe('stun:192.168.1.15:3478');
    expect(resolveStunUrl({ VITE_WS_URL: 'http://[::1]:3001' })).toBe('stun:[::1]:3478');
  });

  it('falls back to localhost when VITE_WS_URL is missing or unparseable, and says so', () => {
    const warn = vi.fn();
    expect(resolveStunUrl({}, warn)).toBe('stun:localhost:3478');
    expect(warn).not.toHaveBeenCalled();
    expect(resolveStunUrl({ VITE_WS_URL: 'not a url' }, warn)).toBe('stun:localhost:3478');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(deriveStunUrl(undefined)).toBe('stun:localhost:3478');
  });

  // A dedicated coturn node (infra plan §8.6) needs the client to be pointed
  // at it; the value is compiled in, so it is an env var, not a setting.
  it('honours a well-formed VITE_STUN_URL override, trimmed, in either scheme', () => {
    expect(resolveStunUrl({ VITE_STUN_URL: 'stun:stun.voxium.app:3478', VITE_WS_URL: 'https://voxium.app' }))
      .toBe('stun:stun.voxium.app:3478');
    expect(resolveStunUrl({ VITE_STUN_URL: '  stun:stun.voxium.app  ' })).toBe('stun:stun.voxium.app');
    expect(resolveStunUrl({ VITE_STUN_URL: 'stuns:stun.voxium.app:5349' })).toBe('stuns:stun.voxium.app:5349');
    expect(resolveStunUrl({ VITE_STUN_URL: 'STUN:stun.voxium.app:3478' })).toBe('STUN:stun.voxium.app:3478');
  });

  // An unparseable ICE server makes `new RTCPeerConnection()` throw, which
  // would take every DM call down with a typo. Log and ignore instead.
  it('ignores a malformed override (warns) and derives from VITE_WS_URL instead', () => {
    const warn = vi.fn();
    for (const bad of ['voxium.app:3478', 'stun://voxium.app', 'stun:voxium.app/path', 'stun:user@voxium.app', 'stun:', 'stun:a b']) {
      warn.mockClear();
      expect(resolveStunUrl({ VITE_STUN_URL: bad, VITE_WS_URL: 'https://voxium.app' }, warn), bad).toBe('stun:voxium.app:3478');
      expect(warn, bad).toHaveBeenCalledTimes(1);
      expect(isValidStunUrl(bad), bad).toBe(false);
    }
  });

  // Privacy-first: STUN only. TURN relays media and needs credentials; the
  // Privacy Policy promises neither. Reject rather than silently accept.
  it('refuses turn:/turns: URLs — TURN is a product decision, not a config value', () => {
    const warn = vi.fn();
    expect(resolveStunUrl({ VITE_STUN_URL: 'turn:relay.example.com:3478', VITE_WS_URL: 'https://voxium.app' }, warn))
      .toBe('stun:voxium.app:3478');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(isValidStunUrl('turns:relay.example.com')).toBe(false);
  });

  it('treats an empty override as unset', () => {
    const warn = vi.fn();
    expect(resolveStunUrl({ VITE_STUN_URL: '', VITE_WS_URL: 'https://voxium.app' }, warn)).toBe('stun:voxium.app:3478');
    expect(resolveStunUrl({ VITE_STUN_URL: '   ', VITE_WS_URL: 'https://voxium.app' }, warn)).toBe('stun:voxium.app:3478');
    expect(warn).not.toHaveBeenCalled();
  });
});
