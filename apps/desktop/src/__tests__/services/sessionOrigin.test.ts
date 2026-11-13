import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OFFICIAL_SESSION_DOMAIN, originOf, isOfficialOrigin, BUILD_API_ORIGIN } from '../../services/sessionOrigin';
import { API_BASE } from '../../services/session';

// Which server a stored session belongs to: every entry is stamped with the
// origin of the API that issued it, and entries from before the stamp count
// as the official service's, in an official build only.

describe('originOf', () => {
  it('is the scheme, host and non-default port of an absolute URL', () => {
    expect(originOf('https://chat.example.org/api/v1')).toBe('https://chat.example.org');
    expect(originOf('https://chat.example.org:443/api/v1')).toBe('https://chat.example.org');
    expect(originOf('http://10.0.0.5:3001/api/v1')).toBe('http://10.0.0.5:3001');
  });

  it('is null for what is not an absolute URL with an origin', () => {
    expect(originOf('/api/v1')).toBeNull();
    expect(originOf('not a url')).toBeNull();
    expect(originOf('data:text/plain,x')).toBeNull();
  });
});

describe('isOfficialOrigin', () => {
  it('the official domain and its subdomains, over https on the default port', () => {
    expect(isOfficialOrigin('https://voxium.app')).toBe(true);
    expect(isOfficialOrigin('https://api.voxium.app')).toBe(true);
  });

  it('nothing else: another scheme or port, a look-alike, a suffix of another domain, nothing', () => {
    for (const origin of [
      'http://voxium.app',
      'https://voxium.app:8443',
      'https://evilvoxium.app',
      'https://voxium.app.example.org',
      'https://chat.example.org',
      'http://localhost:3001',
      '',
      null,
    ]) {
      expect(isOfficialOrigin(origin), String(origin)).toBe(false);
    }
  });

  it('names the domain the official release policy allows, and only it', () => {
    // __dirname: under jsdom import.meta.url is the page's URL
    const conf = JSON.parse(readFileSync(resolve(__dirname, '../../../src-tauri/tauri.conf.json'), 'utf8')) as { app: { security: { csp: string } } };
    const connect = conf.app.security.csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src '))!;
    const httpsHosts = connect.split(/\s+/).slice(1).filter((s) => s.startsWith('https://'));
    expect(httpsHosts).toEqual([`https://${OFFICIAL_SESSION_DOMAIN}`, `https://*.${OFFICIAL_SESSION_DOMAIN}`]);
  });
});

describe('BUILD_API_ORIGIN', () => {
  it('is the origin of the API base the app sends every request to', () => {
    expect(BUILD_API_ORIGIN === originOf(API_BASE)).toBe(true);
  });
});
