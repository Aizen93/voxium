import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '@voxium/shared';
import { redactUrl } from '../../utils/redactUrl';
import { forwardedClientAddress } from '../../utils/trustProxy';

// docs/reverse-proxy.md tells a self-hoster what the proxy in front of the
// server must do, and ends with a complete nginx configuration. These hold
// the example to the code it serves: the body limits of the parsers, the
// Socket.IO heartbeat, the server's keep-alive, the HSTS header the server
// sends itself, the forwarded-address rule, and the paths whose URL is a
// credential (the ones utils/redactUrl.ts redacts and the web client's
// pages with a token in their path). The example was also checked with
// `nginx -t` (nginx 1.27, a self-signed certificate) when it was written.

const ROOT = path.resolve(__dirname, '../../../../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const guide = read('docs/reverse-proxy.md');

/** The worked example: the nginx block under "A complete nginx example". */
const example = (() => {
  const at = guide.indexOf('## A complete nginx example');
  const start = guide.indexOf('```nginx\n', at);
  if (at === -1 || start === -1) return '';
  return guide.slice(start + '```nginx\n'.length, guide.indexOf('\n```', start + 1));
})();
/** The example without its comments. */
const directives = example.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');

/** The body of the location whose header line is exactly `header`. */
function location(header: string): string {
  const at = directives.indexOf(`    location ${header} {\n`);
  if (at === -1) return '';
  return directives.slice(at, directives.indexOf('\n    }\n', at));
}

/** The regular expression of a `location ~* <re> {` line, as JavaScript would run it (case-insensitive). */
function locationRegex(prefixOfRe: string): RegExp {
  const escaped = prefixOfRe.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const m = new RegExp(`^ {4}location ~\\* (\\^${escaped}\\S*) \\{$`, 'm').exec(directives);
  expect(m, `location ~* ^${prefixOfRe}…`).not.toBeNull();
  return new RegExp(m![1], 'i');
}

/** nginx compares locations with the URI's repeated slashes merged (merge_slashes on, the default). */
const nginxUri = (url: string) => url.split('?')[0].replace(/\/{2,}/g, '/');

const bytes = (size: string) => {
  const m = /^(\d+)([km])?$/i.exec(size);
  expect(m, size).not.toBeNull();
  return Number(m![1]) * ({ k: 1024, m: 1024 * 1024 } as Record<string, number>)[(m![2] ?? '').toLowerCase()] || Number(m![1]);
};

describe('docs/reverse-proxy.md', () => {
  it('is tracked under docs/ and has its worked nginx example', () => {
    expect(example).toContain('server_name chat.example.com;');
    expect(example).toContain('upstream voxium_server');
  });

  it('allows the largest request body a route reads: the webhook execute route, and a Socket.IO polling request', () => {
    const limit = /^ {4}client_max_body_size (\S+);$/m.exec(directives)?.[1];
    expect(limit).toBeDefined();
    expect(bytes(limit!)).toBeGreaterThanOrEqual(LIMITS.WEBHOOK_BODY_MAX_BYTES);
    expect(bytes(limit!)).toBeGreaterThanOrEqual(1e6); // Socket.IO's maxHttpBufferSize default
    expect(read('apps/server/src/app.ts')).toContain("express.json({ limit: '100kb' })");
    expect(guide).toContain('at most 100 KB');
  });

  it('keeps a connection open past the Socket.IO heartbeat, and passes the WebSocket upgrade', () => {
    const socket = read('apps/server/src/websocket/socketServer.ts');
    const interval = Number(/pingInterval: (\d+),/.exec(socket)?.[1]);
    const timeout = Number(/pingTimeout: (\d+),/.exec(socket)?.[1]);
    expect(interval).toBeGreaterThan(0);
    const read_ = Number(/^ {4}proxy_read_timeout (\d+)s;$/m.exec(directives)?.[1]);
    expect(read_ * 1000).toBeGreaterThan(interval + timeout);
    expect(guide).toContain(`pings every ${interval / 1000} seconds and gives up after ${timeout / 1000} more`);
    expect(directives).toMatch(/^ {4}proxy_http_version 1\.1;$/m);
    expect(directives).toMatch(/^ {4}proxy_set_header Upgrade {11}\$http_upgrade;$/m);
    expect(directives).toMatch(/^ {4}proxy_set_header Connection {8}\$connection_upgrade;$/m);
    expect(location('/socket.io/')).toContain('proxy_pass http://voxium_server;');
  });

  it('states the server\'s keep-alive the proxy must stay under', () => {
    const keepAlive = Number(/server\.keepAliveTimeout = (\d+);/.exec(read('apps/server/src/index.ts'))?.[1]);
    expect(guide).toContain(`closes an idle connection after ${keepAlive / 1000} seconds`);
  });

  it('appends to X-Forwarded-For, and the hop table follows the rule trustProxy.ts applies', () => {
    expect(directives).toMatch(/^ {4}proxy_set_header X-Forwarded-For {3}\$proxy_add_x_forwarded_for;$/m);
    // nginx alone, hops 1: the entry nginx appended, whatever the client wrote before it
    expect(forwardedClientAddress('198.51.100.7, 203.0.113.9', 1)).toBe('203.0.113.9');
    // a load balancer then nginx, hops 2: the entry the load balancer appended
    expect(forwardedClientAddress('198.51.100.7, 203.0.113.9, 192.0.2.4', 2)).toBe('203.0.113.9');
    // too high: the entry the client wrote itself
    expect(forwardedClientAddress('198.51.100.7, 203.0.113.9', 2)).toBe('198.51.100.7');
    expect(guide).toMatch(/\| One proxy \(nginx\) in front of the server \| `1` \(the default\) \|/);
    expect(guide).toMatch(/\| A load balancer or CDN in front of nginx, both appending to `X-Forwarded-For` \| `2` \|/);
  });

  it('sends the HSTS header the server sends on its own responses, once per response', () => {
    const app = read('apps/server/src/app.ts');
    expect(app).toContain('? { maxAge: 31536000, includeSubDomains: true }');
    expect(directives).toMatch(/^ {4}add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;$/m);
    expect(directives).toMatch(/^ {4}proxy_hide_header Strict-Transport-Security;$/m);
    // a location with an add_header of its own would drop the server-level ones
    expect(directives.split('\n').filter((l) => /^ {8}add_header /.test(l))).toEqual([]);
  });

  describe('the paths whose URL is a credential stay out of both logs', () => {
    it('logs neither the query string nor the Referer anywhere', () => {
      const format = /log_format voxium ([\s\S]*?);\n/.exec(directives)?.[1] ?? '';
      expect(format).toContain('$uri');
      expect(format).not.toMatch(/\$request\b(?!_)/);
      expect(format).not.toContain('$http_referer');
      expect(format).not.toContain('$args');
      expect(directives).toMatch(/^ {4}access_log \S+ voxium;$/m);
      expect(directives).toMatch(/^ {4}add_header Referrer-Policy "no-referrer" always;$/m);
    });

    it('the API location matches every URL redactUrl redacts, case and doubled slashes included', () => {
      const api = locationRegex('/api/v1/');
      const credentialUrls = [
        '/api/v1/webhooks/wh1/secret-token',
        '/API/V1/Webhooks/wh1/secret-token',
        '/api/v1//webhooks/wh1/secret-token',
        '/api/v1/webhooks//secret-token',
        '/api/v1/invites/INVITECODE',
        '/api/v1/Invites/INVITECODE/join',
      ];
      for (const url of credentialUrls) {
        expect(redactUrl(url), url).not.toBe(url); // the server treats it as a credential
        expect(api.test(nginxUri(url)), url).toBe(true);
      }
      // the management routes carry no credential and stay logged
      expect(api.test('/api/v1/servers/s1/webhooks')).toBe(false);
      expect(redactUrl('/api/v1/servers/s1/webhooks')).toBe('/api/v1/servers/s1/webhooks');
    });

    it('the web client location matches every page of the app whose path carries a token or a code', () => {
      const routes = [...read('apps/desktop/src/App.tsx').matchAll(/path="(\/[a-z-]+)\/:(?:token|code)"/g)].map((m) => m[1]);
      expect(routes.sort()).toEqual(['/invite', '/mail-block', '/reset-password', '/verify-email']);
      const pages = locationRegex('/(');
      for (const route of routes) {
        expect(pages.test(`${route}/abc`), route).toBe(true);
        expect(pages.test(`${route.toUpperCase()}/abc`), route).toBe(true);
        expect(guide, route).toContain(`\`${route}/`);
      }
      expect(pages.test('/login')).toBe(false);
    });

    it('each of those locations turns the access log off and the error log down to critical', () => {
      const blocks = [...directives.matchAll(/^ {4}location ~\* \S+ \{\n([\s\S]*?)\n {4}\}$/gm)].map((m) => m[1]);
      expect(blocks).toHaveLength(2);
      for (const block of blocks) {
        expect(block).toMatch(/^ {8}access_log off;$/m);
        expect(block).toMatch(/^ {8}error_log \S+ crit;$/m);
      }
    });

    it('the regex locations stand before nothing that could take their paths (nginx gives a regex precedence over a plain prefix)', () => {
      // no `^~` prefix, which would win over the regex locations
      expect(directives).not.toMatch(/location \^~/);
      expect(location('/api/')).toContain('proxy_pass http://voxium_server;');
    });
  });

  it('serves the web client with the fallback to index.html, and passes no path to the server', () => {
    expect(location('/')).toMatch(/try_files \$uri \/index\.html;/);
    expect(location('= /index.html')).toContain('expires -1;');
    for (const pass of directives.matchAll(/proxy_pass (\S+);/g)) expect(pass[1]).toBe('http://voxium_server');
  });

  it('says the media and STUN ports go around the proxy', () => {
    expect(guide).toMatch(/Voice media, UDP and TCP `MEDIASOUP_MIN_PORT`\.\.`MEDIASOUP_MAX_PORT` \| \*\*no\*\*/);
    expect(guide).toMatch(/STUN for direct calls, 3478\/udp \| \*\*no\*\*/);
  });

  it('uses example names only', () => {
    const hosts = [...guide.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi)].map((m) => m[0].toLowerCase());
    const allowed = /(?:^|\.)example\.com$|^(?:nginx\.conf|voxium\.conf|index\.html|reverse-proxy\.md|chat\.example\.com\.(?:crt|key)|tauri\.localhost|ipc\.localhost|trustproxy\.ts|redacturl\.ts|socketserver\.ts|index\.ts|setup-dev-bucket\.ts|docker-compose\.production\.yml|env\.production|env\.example|voxium\.error\.log|voxium\.access\.log|socket\.io)$/;
    expect(hosts.filter((h) => !allowed.test(h))).toEqual([]);
  });
});

describe('what points at the guide', () => {
  it.each(['README.md', 'docker-compose.production.yml', 'apps/server/.env.example', '.env.production.example', 'apps/server/src/app.ts'])('%s names docs/reverse-proxy.md', (rel) => {
    expect(read(rel)).toContain('docs/reverse-proxy.md');
  });
});
