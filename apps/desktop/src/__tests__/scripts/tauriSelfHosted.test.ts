import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  isHostSource,
  parseServerUrl,
  serverSources,
  selfHostedCsp,
  parseUpdaterPubkey,
  selfHostedUpdater,
  selfHostedIdentifier,
  selfHostedConfig,
} from '../../../scripts/tauriSelfHosted.mjs';
import { releaseConfig } from '../../../scripts/tauriCsp.mjs';

// A self-hosted desktop build (`pnpm tauri:build`) merges an overlay over
// tauri.conf.json, the project's own release configuration: the policy names
// the server the frontend is compiled for (VITE_API_URL / VITE_WS_URL) and its
// object store (TAURI_ASSET_ORIGIN) instead of the project's hosts, and the
// updater is the builder's own (TAURI_UPDATER_ENDPOINTS + TAURI_UPDATER_PUBKEY)
// or there is none. These pin the overlay for each kind of build against the
// REAL tauri.conf.json, and the CLI `pnpm tauri:build` runs.

// __dirname, not import.meta.url: under the jsdom environment the latter is
// the page's http URL, not a file URL
const DESKTOP = resolve(__dirname, '../../..');
const CONF_PATH = join(DESKTOP, 'src-tauri', 'tauri.conf.json');
const CLI_PATH = join(DESKTOP, 'scripts', 'tauri-build-config.mjs');
type Conf = { identifier: string; app: { security: { csp: string } }; bundle: { createUpdaterArtifacts: unknown }; plugins: { updater: { endpoints: string[]; pubkey: string } } };
const conf = JSON.parse(readFileSync(CONF_PATH, 'utf8')) as Conf;
const BASE = conf.app.security.csp;
const OFFICIAL_FEED = conf.plugins.updater.endpoints;
const OFFICIAL_KEY = conf.plugins.updater.pubkey;

const API = 'https://chat.example.org/api/v1';
const WS = 'https://chat.example.org';
const STORAGE = 'https://storage.example.org';
const FEED = 'https://updates.example.org/voxium/{{target}}/{{arch}}/latest.json';

/** A minisign public key file as `tauri signer generate` writes it, base64 as the config takes it. */
function pubkey(seed: number, comment = 'minisign public key: 0123456789ABCDEF'): string {
  const key = Buffer.concat([Buffer.from('Ed', 'latin1'), Buffer.alloc(8, seed), Buffer.alloc(32, seed + 1)]);
  return Buffer.from(`untrusted comment: ${comment}\n${key.toString('base64')}\n`).toString('base64');
}
const KEY = pubkey(7);

function directive(csp: string, name: string): string[] {
  const found = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `) || d === name);
  if (!found) throw new Error(`no ${name} directive`);
  return found.split(/\s+/).slice(1);
}
const otherDirectives = (csp: string) => csp.split(';').map((d) => d.trim()).filter((d) => d && !/^(img|connect)-src /.test(d));
/** Every host source the project's own policy names (voxium.app and its subdomains). */
const projectHosts = [...directive(BASE, 'connect-src'), ...directive(BASE, 'img-src')].filter(isHostSource);

describe('the project policy the overlay replaces', () => {
  it('names the project hosts in connect-src and img-src only (so they are what a self-hosted build drops)', () => {
    expect(projectHosts.length).toBeGreaterThan(0);
    for (const d of otherDirectives(BASE)) expect(d.split(/\s+/).slice(1).filter(isHostSource), d).toEqual([]);
  });
});

describe('isHostSource', () => {
  it('keywords, hashes and scheme sources name no host; origins and wildcards do', () => {
    for (const s of ["'self'", "'wasm-unsafe-eval'", "'sha256-abc='", 'blob:', 'data:', 'mediastream:']) expect(isHostSource(s), s).toBe(false);
    for (const s of ['https://voxium.app', 'https://*.voxium.app', 'wss://voxium.app', '*', 'example.org']) expect(isHostSource(s), s).toBe(true);
  });
});

describe('parseServerUrl', () => {
  const HTTP = ['http:', 'https:'];

  it('accepts an absolute http(s) URL with a path, a port, an IPv4 address or an international name', () => {
    expect(parseServerUrl('VITE_API_URL', ' https://chat.example.org/api/v1 ', HTTP).host).toBe('chat.example.org');
    expect(parseServerUrl('VITE_API_URL', 'http://192.168.1.20:3001/api/v1', HTTP).host).toBe('192.168.1.20:3001');
    // the URL parser hands back the ASCII (punycode) form, the one a CSP source takes
    expect(parseServerUrl('VITE_API_URL', 'https://chät.example.org/api/v1', HTTP).hostname).toMatch(/^xn--[a-z0-9-]+\.example\.org$/);
  });

  it('refuses an unset or blank value: the app would fall back to localhost', () => {
    for (const v of [undefined, null, '', '   ']) {
      expect(() => parseServerUrl('VITE_API_URL', v, HTTP)).toThrow(/VITE_API_URL is not set .*fall back to localhost:3001/);
    }
  });

  it('refuses what the policy cannot name or the app cannot use, naming the setting', () => {
    const cases: Array<[string, RegExp]> = [
      ['chat.example.org/api/v1', /must be an absolute URL/],
      ['/api/v1', /must be an absolute URL/],
      ['ftp://chat.example.org', /must use http: or https:/],
      ['wss://chat.example.org', /must use http: or https:/],
      ['https://user:secret@chat.example.org/api/v1', /must not carry credentials/],
      ['https://chat.example.org/api/v1?x=1', /must not carry a query or a fragment/],
      ['https://chat.example.org/api/v1#top', /must not carry a query or a fragment/],
      // an empty query or fragment parses to '' but still breaks the paths the app appends
      ['https://chat.example.org/api/v1?', /must not carry a query or a fragment/],
      ['https://chat.example.org/api/v1#', /must not carry a query or a fragment/],
      ['https://chat.example.org?#', /must not carry a query or a fragment/],
      ['https://[::1]:3001/api/v1', /no IPv6 literal/],
      ['https://chat_server.example.org/api/v1', /DNS host/],
      ['https://chat.example.org:70000/api/v1', /must be an absolute URL/],
    ];
    for (const [value, message] of cases) {
      expect(() => parseServerUrl('VITE_API_URL', value, HTTP), value).toThrow(/VITE_API_URL/);
      expect(() => parseServerUrl('VITE_API_URL', value, HTTP), value).toThrow(message);
    }
  });
});

/** The message `fn` throws. */
function thrown(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('did not throw');
}

describe('no message quotes a refused value (a CI log may be public, and a value may come from a secret)', () => {
  const FRAGMENTS = ['secret', 'internal', 'hunter2', 'admin', 'token=', '70000'];

  it('the frontend URLs: the setting and the rule, nothing of the value', () => {
    for (const value of [
      'secret.internal/api',
      'ftp://secret.internal',
      'https://admin:hunter2@secret.internal/api',
      'https://secret.internal/api?token=hunter2',
      'https://[::1]:3001/secret',
      'https://secret_internal.example.org',
      'https://secret.internal:70000/api',
    ]) {
      const message = thrown(() => parseServerUrl('VITE_API_URL', value, ['http:', 'https:']));
      expect(message.startsWith('VITE_API_URL '), message).toBe(true);
      for (const fragment of FRAGMENTS) expect(message, `${value} -> ${message}`).not.toContain(fragment);
    }
  });

  it('the update feed: the entry\'s position and the rule, nothing of the value', () => {
    const official = conf.plugins.updater;
    for (const value of [
      'http://secret.internal/latest.json',
      'secret.internal/latest.json',
      'https://admin:hunter2@secret.internal/latest.json',
      `https://ok.example.org/latest.json,${OFFICIAL_FEED[0]}`,
    ]) {
      const message = thrown(() => selfHostedUpdater(value, KEY, official));
      expect(message.startsWith('TAURI_UPDATER_ENDPOINTS entry '), message).toBe(true);
      for (const fragment of [...FRAGMENTS, 'github', 'ok.example']) expect(message, `${value} -> ${message}`).not.toContain(fragment);
    }
  });
});

describe('serverSources', () => {
  it('one host: the API origin in both directives, the socket origin over https and wss', () => {
    expect(serverSources(API, WS)).toEqual({
      'connect-src': ['https://chat.example.org', 'wss://chat.example.org'],
      'img-src': ['https://chat.example.org'],
    });
  });

  it('separate API and socket hosts, a non-default port kept, a default one dropped like an origin does', () => {
    expect(serverSources('https://api.example.org:443/api/v1', 'https://ws.example.org:8443')).toEqual({
      'connect-src': ['https://api.example.org', 'https://ws.example.org:8443', 'wss://ws.example.org:8443'],
      'img-src': ['https://api.example.org'],
    });
  });

  it('a ws(s) socket URL still allows the http(s) polling transport, and plain http allows ws', () => {
    expect(serverSources(API, 'wss://ws.example.org')['connect-src']).toEqual(['https://chat.example.org', 'https://ws.example.org', 'wss://ws.example.org']);
    expect(serverSources('http://10.0.0.5:3001/api/v1', 'http://10.0.0.5:3001')['connect-src']).toEqual(['http://10.0.0.5:3001', 'ws://10.0.0.5:3001']);
  });

  it('names the setting that is wrong', () => {
    expect(() => serverSources(undefined, WS)).toThrow(/VITE_API_URL is not set/);
    expect(() => serverSources(API, undefined)).toThrow(/VITE_WS_URL is not set/);
    expect(() => serverSources(API, 'ftp://ws.example.org')).toThrow(/VITE_WS_URL must use http: or ws: or https: or wss:/);
  });
});

describe('selfHostedCsp', () => {
  it('replaces every host of img-src and connect-src, keeps their keywords and schemes, and leaves the other directives byte-identical', () => {
    const csp = selfHostedCsp(BASE, { 'connect-src': ['https://chat.example.org'], 'img-src': ['https://chat.example.org'] });
    expect(directive(csp, 'connect-src')).toEqual(["'self'", 'https://chat.example.org']);
    expect(directive(csp, 'img-src')).toEqual(["'self'", 'blob:', 'data:', 'https://chat.example.org']);
    expect(otherDirectives(csp)).toEqual(otherDirectives(BASE));
    for (const host of projectHosts) expect(csp.split(/[\s;]+/)).not.toContain(host);
  });

  it('never duplicates a source', () => {
    const csp = selfHostedCsp(BASE, { 'connect-src': ['https://a.example.org', 'https://a.example.org', "'self'"], 'img-src': [] });
    expect(directive(csp, 'connect-src')).toEqual(["'self'", 'https://a.example.org']);
  });

  it('refuses an empty base, a missing directive, and a host in any other directive (the build would keep a host not its own)', () => {
    expect(() => selfHostedCsp('', {})).toThrow('The base CSP is empty');
    expect(() => selfHostedCsp(undefined, {})).toThrow('The base CSP is empty');
    expect(() => selfHostedCsp("default-src 'self'; img-src 'self'", {})).toThrow('no connect-src directive');
    expect(() => selfHostedCsp("default-src 'self'; connect-src 'self'", {})).toThrow('no img-src directive');
    expect(() => selfHostedCsp(`${BASE}; frame-src https://voxium.app`, {})).toThrow("The base CSP's frame-src names the host https://voxium.app");
    expect(() => selfHostedCsp(BASE.replace("media-src 'self' blob:", "media-src 'self' blob: https://*.voxium.app"), {})).toThrow(/media-src names the host/);
  });
});

describe('parseUpdaterPubkey', () => {
  it('accepts the base64 of a minisign .pub file and returns its key line', () => {
    const line = parseUpdaterPubkey(` ${KEY} `);
    expect(Buffer.from(line, 'base64').subarray(0, 2).toString('latin1')).toBe('Ed');
    // the project's own key has that shape too
    expect(() => parseUpdaterPubkey(OFFICIAL_KEY)).not.toThrow();
  });

  it('refuses a path, raw key line, non-base64, a missing comment and a key of the wrong size or algorithm', () => {
    const keyLine = Buffer.from(KEY, 'base64').toString('utf8').split('\n')[1];
    const bad = [
      '~/.tauri/voxium.key.pub',
      keyLine,
      'not base64!',
      `${KEY}x`,
      Buffer.from(`no comment\n${keyLine}\n`).toString('base64'),
      Buffer.from(`untrusted comment: x\n${Buffer.alloc(41, 1).toString('base64')}\n`).toString('base64'),
      Buffer.from(`untrusted comment: x\n${Buffer.concat([Buffer.from('Xx'), Buffer.alloc(40, 1)]).toString('base64')}\n`).toString('base64'),
      Buffer.from('untrusted comment: x\n').toString('base64'),
    ];
    for (const value of bad) expect(() => parseUpdaterPubkey(value), value).toThrow(/TAURI_UPDATER_PUBKEY must be the public key `tauri signer generate` writes/);
  });
});

describe('selfHostedUpdater', () => {
  const official = conf.plugins.updater;

  it('neither setting: no updater at all, and the emptied block the app starts with (never null, never removed)', () => {
    for (const [e, k] of [[undefined, undefined], ['', ''], [' , ', '  ']] as const) {
      expect(selfHostedUpdater(e, k, official)).toEqual({ createUpdaterArtifacts: false, updater: { endpoints: [], pubkey: '' } });
    }
  });

  it('both settings: the builder\'s own feed(s) and key, update artifacts on', () => {
    expect(selfHostedUpdater(` ${FEED} , https://mirror.example.org/latest.json`, KEY, official)).toEqual({
      createUpdaterArtifacts: true,
      updater: { endpoints: [FEED, 'https://mirror.example.org/latest.json'], pubkey: KEY },
    });
  });

  it('refuses one setting without the other', () => {
    expect(() => selfHostedUpdater(FEED, '', official)).toThrow('TAURI_UPDATER_ENDPOINTS and TAURI_UPDATER_PUBKEY go together');
    expect(() => selfHostedUpdater('', KEY, official)).toThrow('TAURI_UPDATER_ENDPOINTS and TAURI_UPDATER_PUBKEY go together');
  });

  it('refuses a feed the release build would refuse at start (not https) or that carries credentials', () => {
    expect(() => selfHostedUpdater('http://updates.example.org/latest.json', KEY, official)).toThrow(/must be an https URL/);
    expect(() => selfHostedUpdater('updates.example.org/latest.json', KEY, official)).toThrow(/must be an https URL/);
    expect(() => selfHostedUpdater('https://u:p@updates.example.org/latest.json', KEY, official)).toThrow(/must not carry credentials/);
  });

  it('refuses the project\'s own feed, whatever the spelling or the path under its repository', () => {
    expect(OFFICIAL_FEED.length).toBeGreaterThan(0);
    for (const feed of OFFICIAL_FEED) {
      const url = new URL(feed);
      const [owner, repo] = url.pathname.split('/').filter(Boolean);
      for (const variant of [feed, feed.toUpperCase().replace('HTTPS://', 'https://'), `${url.origin}/${owner}/${repo}/releases/download/v2.1.1/latest.json`]) {
        expect(() => selfHostedUpdater(variant, KEY, official), variant).toThrow(/names the Voxium project's own update feed/);
      }
      // another repository on the same host is someone's own feed
      expect(selfHostedUpdater(`${url.origin}/someone/${repo}/releases/latest/download/latest.json`, KEY, official).createUpdaterArtifacts).toBe(true);
      expect(selfHostedUpdater(`${url.origin}/${owner}/${repo}-fork/releases/latest/download/latest.json`, KEY, official).createUpdaterArtifacts).toBe(true);
    }
  });

  it('refuses the project\'s own key, even re-wrapped with another comment', () => {
    expect(() => selfHostedUpdater(FEED, OFFICIAL_KEY, official)).toThrow(/is the Voxium project's own signing key/);
    const keyLine = Buffer.from(OFFICIAL_KEY, 'base64').toString('utf8').split('\n')[1];
    const rewrapped = Buffer.from(`untrusted comment: my key\n${keyLine}\n`).toString('base64');
    expect(() => selfHostedUpdater(FEED, rewrapped, official)).toThrow(/is the Voxium project's own signing key/);
  });

  it('refuses a malformed key', () => {
    expect(() => selfHostedUpdater(FEED, 'not-a-key', official)).toThrow(/TAURI_UPDATER_PUBKEY must be/);
  });
});

describe('selfHostedIdentifier (a build for another server keeps its own local state)', () => {
  // The identifier names the webview's data folder and, in lib.rs, the
  // credential-store services: one per server, the same on every rebuild
  const IDENTIFIER_RE = /^com\.voxium\.selfhosted\.[a-z][a-z0-9]*$/;
  const digestOf = (origin: string) => createHash('sha256').update(origin).digest('hex').slice(0, 16);

  it('is the same for the same origin however the URL is written: case, default port, trailing slash, path', () => {
    const id = selfHostedIdentifier(API);
    for (const url of [
      'HTTPS://Chat.Example.ORG/api/v1',
      'https://chat.example.org:443/api/v1',
      'https://chat.example.org/',
      'https://chat.example.org',
      'https://chat.example.org/somewhere/else',
      ' https://chat.example.org/api/v1 ',
    ]) {
      expect(selfHostedIdentifier(url), url).toBe(id);
    }
  });

  it('keeps a final dot as the URL parser does, like the origin the app stamps its sessions with: another origin, another identifier', () => {
    expect(new URL('https://chat.example.org./api/v1').origin).toBe('https://chat.example.org.');
    expect(selfHostedIdentifier('https://chat.example.org./api/v1')).toBe(`com.voxium.selfhosted.s${digestOf('https://chat.example.org.')}`);
    expect(selfHostedIdentifier('https://chat.example.org./api/v1')).not.toBe(selfHostedIdentifier(API));
  });

  it('differs for another origin: another host, scheme or port', () => {
    const origins = [
      'https://chat.example.org',
      'https://chat.example.net',
      'https://api.chat.example.org',
      'http://chat.example.org',
      'https://chat.example.org:8443',
      'http://10.0.0.5:3001',
      'http://localhost:3001',
    ];
    const ids = origins.map((origin) => selfHostedIdentifier(`${origin}/api/v1`));
    expect(new Set(ids).size).toBe(origins.length);
  });

  it('is `com.voxium.selfhosted.` and a label of a letter and the first 16 hex digits of the origin\'s SHA-256', () => {
    for (const [url, origin] of [
      [API, 'https://chat.example.org'],
      ['http://10.0.0.5:3001/api/v1', 'http://10.0.0.5:3001'],
      ['https://xn--bcher-kva.example/api/v1', 'https://xn--bcher-kva.example'],
      ['https://Bücher.example/api/v1', 'https://xn--bcher-kva.example'],
    ] as const) {
      const id = selfHostedIdentifier(url);
      expect(id, url).toMatch(IDENTIFIER_RE);
      expect(id, url).toBe(`com.voxium.selfhosted.s${digestOf(origin)}`);
    }
  });

  it('can never be the official identifier, not even for the official server', () => {
    expect(conf.identifier).toBe('com.voxium.app');
    for (const url of [API, 'https://voxium.app/api/v1', 'https://api.voxium.app/api/v1', 'http://localhost:3001/api/v1']) {
      const id = selfHostedIdentifier(url);
      expect(id).not.toBe(conf.identifier);
      expect(id.startsWith('com.voxium.selfhosted.')).toBe(true);
    }
  });

  it('refuses what the API URL check refuses, naming the setting', () => {
    expect(() => selfHostedIdentifier(undefined)).toThrow(/VITE_API_URL is not set/);
    expect(() => selfHostedIdentifier('wss://chat.example.org')).toThrow(/VITE_API_URL must use http: or https:/);
  });

  it('comes from the API origin alone: no input, base identifier or other setting changes it', () => {
    const expected = selfHostedIdentifier(API);
    const overlay = selfHostedConfig(conf, {
      apiUrl: API,
      wsUrl: 'https://ws.example.org',
      assetOrigin: STORAGE,
      updaterEndpoints: FEED,
      updaterPubkey: KEY,
      // not a setting: ignored
      identifier: 'com.voxium.app',
    } as Parameters<typeof selfHostedConfig>[1]);
    expect(overlay.identifier).toBe(expected);
    expect(selfHostedConfig({ ...conf, identifier: 'com.example.other' } as Conf, { apiUrl: API, wsUrl: WS }).identifier).toBe(expected);
  });
});

describe('selfHostedConfig (the overlay `pnpm tauri:build` merges)', () => {
  const build = (inputs: Parameters<typeof selfHostedConfig>[1]) => selfHostedConfig(conf, inputs);

  it('one host, no storage origin, no updater', () => {
    const overlay = build({ apiUrl: API, wsUrl: WS });
    expect(overlay).toEqual({
      identifier: selfHostedIdentifier(API),
      app: {
        security: {
          csp: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://chat.example.org wss://chat.example.org; img-src 'self' blob: data: https://chat.example.org; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; font-src 'self' data:",
        },
      },
      bundle: { createUpdaterArtifacts: false },
      plugins: { updater: { endpoints: [], pubkey: '' } },
    });
  });

  it('separate API, WebSocket and storage hosts, with the builder\'s own updater', () => {
    const overlay = build({
      apiUrl: 'https://api.example.org/api/v1',
      wsUrl: 'https://ws.example.org',
      assetOrigin: `${STORAGE}, https://cdn.example.org:9000`,
      updaterEndpoints: FEED,
      updaterPubkey: KEY,
    });
    const csp = overlay.app.security.csp;
    expect(directive(csp, 'connect-src')).toEqual(["'self'", 'https://api.example.org', 'https://ws.example.org', 'wss://ws.example.org', STORAGE, 'https://cdn.example.org:9000']);
    expect(directive(csp, 'img-src')).toEqual(["'self'", 'blob:', 'data:', 'https://api.example.org', STORAGE, 'https://cdn.example.org:9000']);
    expect(otherDirectives(csp)).toEqual(otherDirectives(BASE));
    expect(overlay.bundle).toEqual({ createUpdaterArtifacts: true });
    expect(overlay.plugins).toEqual({ updater: { endpoints: [FEED], pubkey: KEY } });
  });

  it('a build pointed at a local backend on purpose names localhost (the URLs it is compiled with), nothing else', () => {
    const csp = build({ apiUrl: 'http://localhost:3001/api/v1', wsUrl: 'http://localhost:3001' }).app.security.csp;
    expect(directive(csp, 'connect-src')).toEqual(["'self'", 'http://localhost:3001', 'ws://localhost:3001']);
    expect(directive(csp, 'img-src')).toEqual(["'self'", 'blob:', 'data:', 'http://localhost:3001']);
  });

  it('carries none of the project\'s hosts, feed or key, and replaces both updater fields of the base', () => {
    const overlay = build({ apiUrl: API, wsUrl: WS, assetOrigin: STORAGE, updaterEndpoints: FEED, updaterPubkey: KEY });
    const text = JSON.stringify(overlay);
    for (const host of projectHosts) expect(overlay.app.security.csp.split(/[\s;]+/)).not.toContain(host);
    expect(text).not.toContain('voxium.app');
    for (const feed of OFFICIAL_FEED) expect(text).not.toContain(feed);
    expect(text).not.toContain(OFFICIAL_KEY);
    // a merge patch replaces what it names: both fields, so neither of the
    // project's survives the merge
    expect(Object.keys(overlay.plugins.updater).sort()).toEqual(Object.keys(conf.plugins.updater).sort());
  });

  it('differs from the official release overlay, which keeps tauri.conf.json\'s identifier, updater and the project hosts', () => {
    const official = releaseConfig(conf, STORAGE)!;
    expect(Object.keys(official)).toEqual(['app']);
    for (const host of projectHosts) expect(official.app.security.csp).toContain(host);
    const selfHosted = build({ apiUrl: API, wsUrl: WS, assetOrigin: STORAGE });
    expect(Object.keys(selfHosted)).toEqual(['identifier', 'app', 'bundle', 'plugins']);
    expect(selfHosted.identifier).not.toBe(conf.identifier);
  });

  it('refuses malformed inputs instead of shipping a weaker or broken build', () => {
    expect(() => build({ wsUrl: WS })).toThrow(/VITE_API_URL is not set/);
    expect(() => build({ apiUrl: API })).toThrow(/VITE_WS_URL is not set/);
    expect(() => build({ apiUrl: API, wsUrl: WS, assetOrigin: 'storage.example.org' })).toThrow(/TAURI_ASSET_ORIGIN entry 1 of 1 is not an origin/);
    expect(() => build({ apiUrl: API, wsUrl: WS, updaterEndpoints: FEED })).toThrow(/go together/);
    expect(() => build({ apiUrl: API, wsUrl: WS, updaterEndpoints: OFFICIAL_FEED.join(','), updaterPubkey: KEY })).toThrow(/project's own update feed/);
    expect(() => selfHostedConfig({ app: { security: {} } }, { apiUrl: API, wsUrl: WS })).toThrow('The base CSP is empty');
  });

  it('is plain JSON: no null, no undefined, survives a round trip', () => {
    const overlay = build({ apiUrl: API, wsUrl: WS });
    expect(JSON.parse(JSON.stringify(overlay))).toEqual(overlay);
    expect(JSON.stringify(overlay)).not.toContain('null');
  });
});

describe('tauri-build-config.mjs (the CLI `pnpm tauri:build` runs)', () => {
  let envDir: string;

  // A scratch .env directory and an environment without any VITE_* / TAURI_*
  // of the machine running the tests: the CLI must never read the
  // developer's real apps/desktop/.env here
  beforeAll(() => {
    envDir = mkdtempSync(join(tmpdir(), 'voxium-tauri-build-'));
  });
  afterAll(() => {
    rmSync(envDir, { recursive: true, force: true });
  });

  const cleanEnv = (extra: Record<string, string> = {}) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !/^(VITE_|TAURI_)/i.test(k)) env[k] = v;
    }
    return { ...env, ...extra };
  };
  const writeEnvFiles = (files: Record<string, string>) => {
    for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) rmSync(join(envDir, name), { force: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(envDir, name), body);
  };
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [CLI_PATH, '--env-dir', envDir, ...args], { env: cleanEnv(env), encoding: 'utf8' });

  it('prints the overlay from the .env files Vite compiles the frontend with', () => {
    writeEnvFiles({ '.env': `VITE_API_URL=${API}\nVITE_WS_URL=${WS}\n` });
    const result = run([], { TAURI_ASSET_ORIGIN: STORAGE });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(selfHostedConfig(conf, { apiUrl: API, wsUrl: WS, assetOrigin: STORAGE }));
    expect(result.stderr).toContain('No update feed configured');
  });

  it('follows Vite\'s precedence: .env.production over .env, the environment over both', () => {
    writeEnvFiles({
      '.env': 'VITE_API_URL=https://wrong.example.org/api/v1\nVITE_WS_URL=https://wrong.example.org\n',
      '.env.production': 'VITE_API_URL=https://api.example.org/api/v1\nVITE_WS_URL=https://wrong-too.example.org\n',
    });
    const result = run([], { VITE_WS_URL: 'https://ws.example.org' });
    expect(result.status, result.stderr).toBe(0);
    const csp = (JSON.parse(result.stdout) as Conf).app.security.csp;
    expect(directive(csp, 'connect-src')).toEqual(["'self'", 'https://api.example.org', 'https://ws.example.org', 'wss://ws.example.org']);
    expect(csp).not.toContain('wrong');
  });

  it('with the builder\'s updater: prints it, and warns when the signing key `tauri build` needs is missing', () => {
    writeEnvFiles({ '.env': `VITE_API_URL=${API}\nVITE_WS_URL=${WS}\n` });
    const result = run([], { TAURI_ASSET_ORIGIN: STORAGE, TAURI_UPDATER_ENDPOINTS: FEED, TAURI_UPDATER_PUBKEY: KEY });
    expect(result.status, result.stderr).toBe(0);
    const overlay = JSON.parse(result.stdout) as Conf;
    expect(overlay.plugins.updater).toEqual({ endpoints: [FEED], pubkey: KEY });
    expect(result.stderr).toContain('TAURI_SIGNING_PRIVATE_KEY is not set here');
    const signed = run([], { TAURI_ASSET_ORIGIN: STORAGE, TAURI_UPDATER_ENDPOINTS: FEED, TAURI_UPDATER_PUBKEY: KEY, TAURI_SIGNING_PRIVATE_KEY: 'placeholder' });
    expect(signed.stderr).not.toContain('TAURI_SIGNING_PRIVATE_KEY');
  });

  it('prints the identifier of the server the app is compiled for, and no variable sets another', () => {
    writeEnvFiles({ '.env': `VITE_API_URL=${API}\nVITE_WS_URL=${WS}\nVITE_IDENTIFIER=com.voxium.app\n` });
    const result = run([], { TAURI_IDENTIFIER: 'com.voxium.app', TAURI_BUNDLE_IDENTIFIER: 'com.voxium.app', IDENTIFIER: 'com.voxium.app' });
    expect(result.status, result.stderr).toBe(0);
    expect((JSON.parse(result.stdout) as Conf).identifier).toBe(selfHostedIdentifier(API));
  });

  it('warns when no storage origin is set', () => {
    writeEnvFiles({ '.env': `VITE_API_URL=${API}\nVITE_WS_URL=${WS}\n` });
    expect(run([]).stderr).toContain('TAURI_ASSET_ORIGIN is unset');
  });

  it('fails with the reason and prints nothing when the frontend URLs are missing or an input is malformed', () => {
    writeEnvFiles({});
    const missing = run([]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('VITE_API_URL is not set');

    writeEnvFiles({ '.env': `VITE_API_URL=${API}\nVITE_WS_URL=${WS}\n` });
    const halfUpdater = run([], { TAURI_UPDATER_ENDPOINTS: FEED });
    expect(halfUpdater.status).toBe(1);
    expect(halfUpdater.stdout).toBe('');
    expect(halfUpdater.stderr).toContain('go together');
  });

  it('--out writes the file, and a failed run removes the one an earlier run left', () => {
    const out = join(envDir, 'nested', 'tauri.self-hosted.json');
    writeEnvFiles({ '.env': `VITE_API_URL=${API}\nVITE_WS_URL=${WS}\n` });
    const ok = run(['--out', out], { TAURI_ASSET_ORIGIN: STORAGE });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toBe('');
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(selfHostedConfig(conf, { apiUrl: API, wsUrl: WS, assetOrigin: STORAGE }));

    writeEnvFiles({});
    const failed = run(['--out', out]);
    expect(failed.status).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it('a refused storage origin, URL or feed leaves no part of its value in the output', () => {
    writeEnvFiles({ '.env': `VITE_API_URL=${API}\nVITE_WS_URL=${WS}\n` });
    const envs: Array<Record<string, string>> = [
      { TAURI_ASSET_ORIGIN: `${STORAGE},https://secret-bucket.internal.example.org/x` },
      { TAURI_UPDATER_ENDPOINTS: 'http://secret.internal/latest.json', TAURI_UPDATER_PUBKEY: KEY },
      { VITE_API_URL: 'https://admin:hunter2@secret.internal/api' },
    ];
    for (const env of envs) {
      const result = run([], env);
      expect(result.status, JSON.stringify(Object.keys(env))).toBe(1);
      expect(result.stdout).toBe('');
      for (const fragment of ['secret', 'internal', 'hunter2', 'admin', 'storage.example']) {
        expect(result.stderr, fragment).not.toContain(fragment);
      }
    }
  });

  it('refuses an unknown or incomplete argument', () => {
    writeEnvFiles({ '.env': `VITE_API_URL=${API}\nVITE_WS_URL=${WS}\n` });
    for (const args of [['--bogus'], ['--out']]) {
      const result = run(args);
      expect(result.status, args.join(' ')).toBe(1);
      expect(result.stderr).toContain('Unknown or incomplete argument');
    }
  });

  it('is what `pnpm tauri:build` runs, and the file it writes is the one `tauri build` reads', () => {
    const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const m = /^node scripts\/tauri-build-config\.mjs --out (\S+) && tauri build --config (\S+)$/.exec(pkg.scripts['tauri:build']);
    expect(m, pkg.scripts['tauri:build']).not.toBeNull();
    expect(m![1]).toBe(m![2]);
    // the generated file is never committed
    expect(m![1].startsWith('src-tauri/target/')).toBe(true);
  });
});
