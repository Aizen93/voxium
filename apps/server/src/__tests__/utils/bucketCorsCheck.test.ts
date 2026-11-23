import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CORSRule } from '@aws-sdk/client-s3';

/**
 * The boot check of the store's CORS answer, against a fake store: a local
 * HTTP server that answers the browser's preflight (OPTIONS on a presigned PUT
 * address) and the bucket's CORS configuration (GET/PUT ?cors). The SDK, the
 * presigner and fetch are the real ones; only the store is fake.
 *
 * The store ends every connection after its answer (`Connection: close`).
 * Reusing a connection would make a case depend on timing: fetch keeps an idle
 * connection for the next request, and when the store (this very process) drops
 * it first (a case that destroys its sockets, a keep-alive window that lapses on
 * a busy machine) the next request fails with `TypeError: fetch failed`
 * (ECONNRESET) instead of reaching the store. One connection per request leaves
 * nothing to go stale, and the requests on the wire are the same.
 */

const BUCKET = 'acme-private-assets';
const WEB = 'https://chat.example.org';
const TAURI = 'tauri://localhost';
const ORIGINS = [WEB, 'https://tauri.localhost', TAURI, 'http://tauri.localhost'];

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface StoreState {
  /** null: no CORS configuration (GET ?cors answers NoSuchCORSConfiguration). */
  rules: CORSRule[] | null;
  /** GET ?cors answers a success with no rule at all. */
  zeroRules: boolean;
  getCorsStatus: number | null;
  putCorsStatus: number | null;
  /** Called for every preflight; the default models a store applying the FIRST rule that names the origin. */
  preflight: (origin: string, state: StoreState, req: http.IncomingMessage) => { status: number; headers?: Record<string, string> };
  /** OPTIONS is never answered. */
  hang: boolean;
  /** After a PutBucketCors, OPTIONS drops the connection. */
  breakAfterPut: boolean;
  putDone: boolean;
}

const xmlEscape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function rulesToXml(rules: CORSRule[]): string {
  const tag = (name: string, values?: string[]) => (values ?? []).map((v) => `<${name}>${xmlEscape(v)}</${name}>`).join('');
  return '<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
    + rules.map((r) => `<CORSRule>${r.ID ? `<ID>${xmlEscape(r.ID)}</ID>` : ''}${tag('AllowedOrigin', r.AllowedOrigins)}${tag('AllowedMethod', r.AllowedMethods)}${tag('AllowedHeader', r.AllowedHeaders)}${tag('ExposeHeader', r.ExposeHeaders)}${r.MaxAgeSeconds === undefined ? '' : `<MaxAgeSeconds>${r.MaxAgeSeconds}</MaxAgeSeconds>`}</CORSRule>`).join('')
    + '</CORSConfiguration>';
}

function xmlToRules(xml: string): CORSRule[] {
  const all = (block: string, name: string) => [...block.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))].map((m) => m[1]);
  return [...xml.matchAll(/<CORSRule>([\s\S]*?)<\/CORSRule>/g)].map((m) => {
    const block = m[1];
    const rule: CORSRule = { AllowedOrigins: all(block, 'AllowedOrigin'), AllowedMethods: all(block, 'AllowedMethod') };
    const id = all(block, 'ID')[0];
    if (id) rule.ID = id;
    const headers = all(block, 'AllowedHeader');
    if (headers.length > 0) rule.AllowedHeaders = headers;
    const exposed = all(block, 'ExposeHeader');
    if (exposed.length > 0) rule.ExposeHeaders = exposed;
    const age = all(block, 'MaxAgeSeconds')[0];
    if (age !== undefined) rule.MaxAgeSeconds = Number(age);
    return rule;
  });
}

/** A store that applies the first rule naming the origin; that rule must allow PUT and content-type. */
const firstMatchPreflight: StoreState['preflight'] = (origin, state, req) => {
  const wantedMethod = String(req.headers['access-control-request-method'] ?? '').toUpperCase();
  const wantedHeaders = String(req.headers['access-control-request-headers'] ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const rule = (state.rules ?? []).find((r) => (r.AllowedOrigins ?? []).some((o) => o === origin || o === '*'));
  if (!rule) return { status: 403 };
  const methodOk = (rule.AllowedMethods ?? []).map((m) => m.toUpperCase()).includes(wantedMethod);
  const headersOk = wantedHeaders.every((h) => (rule.AllowedHeaders ?? []).some((a) => a === '*' || a.toLowerCase() === h));
  if (!methodOk || !headersOk) return { status: 403 };
  return {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': (rule.AllowedMethods ?? []).join(', '),
      'Access-Control-Allow-Headers': wantedHeaders.join(', '),
    },
  };
};

const openStores: http.Server[] = [];
const openSockets = new Set<import('node:net').Socket>();

async function startStore(patch: Partial<StoreState> = {}) {
  const state: StoreState = {
    rules: null, zeroRules: false, getCorsStatus: null, putCorsStatus: null,
    preflight: firstMatchPreflight, hang: false, breakAfterPut: false, putDone: false, ...patch,
  };
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    res.setHeader('connection', 'close');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const isCors = (req.url ?? '').includes('?cors') || (req.url ?? '').includes('&cors') || /[?&]cors(=|&|$)/.test(req.url ?? '');
      const error = (status: number, code: string) => {
        res.writeHead(status, { 'content-type': 'application/xml' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>The thing does not exist for ${BUCKET}</Message></Error>`);
      };
      if (req.method === 'OPTIONS') {
        if (state.hang) return;
        if (state.breakAfterPut && state.putDone) { req.socket.destroy(); return; }
        const origin = String(req.headers.origin ?? '');
        const answer = state.preflight(origin, state, req);
        res.writeHead(answer.status, answer.headers ?? {});
        res.end();
        return;
      }
      if (req.method === 'GET' && isCors) {
        if (state.getCorsStatus) return error(state.getCorsStatus, 'AccessDenied');
        if (state.rules === null && !state.zeroRules) return error(404, 'NoSuchCORSConfiguration');
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(rulesToXml(state.zeroRules ? [] : state.rules ?? []));
        return;
      }
      if (req.method === 'PUT' && isCors) {
        if (state.putCorsStatus) return error(state.putCorsStatus, 'AccessDenied');
        state.rules = xmlToRules(body);
        state.zeroRules = false;
        state.putDone = true;
        res.writeHead(200);
        res.end();
        return;
      }
      error(400, 'InvalidRequest');
    });
  });
  server.on('connection', (socket) => { openSockets.add(socket); socket.on('close', () => openSockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  openStores.push(server);
  const { port } = server.address() as AddressInfo;
  return { state, seen, port };
}

const preflights = (seen: Seen[]) => seen.filter((s) => s.method === 'OPTIONS');
const corsCalls = (seen: Seen[]) => seen.filter((s) => s.method !== 'OPTIONS');

describe('bucket CORS check — against a fake store', () => {
  // A test that reaches any host but the local fake must fail, not send a real request
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const host = new URL(url).hostname;
      if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('a test tried to reach a host other than the local fake store');
      return realFetch(input, init);
    }) as typeof fetch;
  });
  afterAll(() => { globalThis.fetch = realFetch; });

  const saved: Record<string, string | undefined> = {};
  const envKeys = ['S3_ASSETS_ENDPOINT', 'S3_ASSETS_REGION', 'S3_ASSETS_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_CORS_APPLY', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE'];
  let logs: { level: string; text: string }[];
  let sensitive: string[];

  const line = (level: 'log' | 'warn' | 'error') => logs.filter((l) => l.level === level).map((l) => l.text);

  async function setUp(port: number | null, patch: Record<string, string> = {}) {
    process.env.S3_ASSETS_ENDPOINT = `http://127.0.0.1:${port ?? 9}`;
    process.env.S3_ASSETS_REGION = 'us-east-1';
    process.env.S3_ASSETS_BUCKET = BUCKET;
    process.env.S3_ACCESS_KEY = 'test-access-key-id-q93z';
    process.env.S3_SECRET_KEY = 'test-secret-access-key-q93z';
    process.env.AWS_CONFIG_FILE = '/nonexistent/voxium-test/aws-config';
    process.env.AWS_SHARED_CREDENTIALS_FILE = '/nonexistent/voxium-test/aws-credentials';
    delete process.env.S3_CORS_APPLY;
    Object.assign(process.env, patch);
    sensitive = [BUCKET, '127.0.0.1', `:${port}`, 'cors-check', 'X-Amz', 'Signature', 'test-access-key-id-q93z', 'test-secret-access-key-q93z'];
    return import('../../utils/s3');
  }

  beforeEach(() => {
    vi.resetModules();
    for (const key of envKeys) saved[key] = process.env[key];
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push({ level, text: args.map(String).join(' ') }); });
    }
  });

  afterEach(async () => {
    // Nothing the check says may carry the bucket, the endpoint, the probe key,
    // a presigned address or a credential into a log line
    for (const { text } of logs) for (const s of sensitive) expect(text).not.toContain(s);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
    for (const socket of openSockets) socket.destroy();
    await Promise.all(openStores.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  describe('default mode: only preflights, never the bucket\'s rules', () => {
    it('all origins accepted: ONE info line, one preflight per origin to the probe key, nothing else', async () => {
      const store = await startStore({ rules: [{ ID: 'ops', AllowedOrigins: ORIGINS, AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'] }] });
      const { ensureBucketCors } = await setUp(store.port);

      await ensureBucketCors(ORIGINS);

      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('log');
      expect(logs[0].text).toContain('accepts browser uploads from all 4 CORS_ORIGIN origin(s)');
      expect(corsCalls(store.seen)).toEqual([]);
      const sent = preflights(store.seen);
      expect(sent.map((s) => s.headers.origin)).toEqual([...ORIGINS].sort());
      for (const s of sent) {
        expect(s.url.startsWith(`/${BUCKET}/cors-check/probe?`)).toBe(true);
        expect(s.url).toContain('X-Amz-Signature=');
        expect(s.headers['access-control-request-method']).toBe('PUT');
        expect(s.headers['access-control-request-headers']).toBe('content-type');
        expect(s.headers.authorization).toBeUndefined();
        expect(s.body).toBe('');
      }
    });

    it('a refusal: ONE warning naming the refused origins only, saying uploads from them fail with a network error; no rule is read or written', async () => {
      const store = await startStore({ rules: [{ AllowedOrigins: [WEB], AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'] }] });
      const { ensureBucketCors } = await setUp(store.port);

      await ensureBucketCors(ORIGINS);

      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('warn');
      const text = logs[0].text;
      expect(text).toContain('refuses browser uploads from http://tauri.localhost, https://tauri.localhost, tauri://localhost');
      expect(text).not.toContain(`from ${WEB}`);
      expect(text).toContain('network error');
      expect(text).toContain('S3_CORS_APPLY=true');
      expect(corsCalls(store.seen)).toEqual([]);
    });

    it('reads and writes nothing even with S3_CORS_APPLY=false written out', async () => {
      const store = await startStore();
      const { ensureBucketCors } = await setUp(store.port, { S3_CORS_APPLY: 'false' });

      await ensureBucketCors([WEB]);

      expect(corsCalls(store.seen)).toEqual([]);
      expect(store.state.rules).toBeNull();
    });

    it('an unsupported S3_CORS_APPLY value warns once and checks only', async () => {
      const store = await startStore();
      const { ensureBucketCors } = await setUp(store.port, { S3_CORS_APPLY: 'yes' });

      await ensureBucketCors([WEB]);
      await ensureBucketCors([WEB]);

      expect(line('warn').filter((l) => l.includes('Ignoring unsupported S3_CORS_APPLY'))).toHaveLength(1);
      expect(corsCalls(store.seen)).toEqual([]);
    });

    it('wildcard and non-origin entries are not asked about and the line counts them', async () => {
      const store = await startStore({ rules: [{ AllowedOrigins: [WEB, TAURI], AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'] }] });
      const { ensureBucketCors } = await setUp(store.port);

      await ensureBucketCors([WEB, 'https://*.example.org', 'http://localhost:*', 'https://chat.example.org/', TAURI, '']);

      expect(preflights(store.seen).map((s) => s.headers.origin)).toEqual([WEB, TAURI]);
      expect(logs).toHaveLength(1);
      expect(logs[0].text).toContain('all 2 CORS_ORIGIN origin(s)');
      expect(logs[0].text).toContain('3 CORS_ORIGIN entries left out');
      expect(logs[0].text).not.toContain('*');
    });

    it('only wildcards and non-origins: one line, no request at all', async () => {
      const store = await startStore();
      const { ensureBucketCors } = await setUp(store.port);

      await ensureBucketCors(['https://*.example.org', '*']);

      expect(store.seen).toEqual([]);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('warn');
      expect(logs[0].text).toContain('names no origin to check');
      expect(logs[0].text).toContain('2 CORS_ORIGIN entries left out');
    });

    it('a store that is not there: ONE warning with the error code, no host or port', async () => {
      const store = await startStore();
      const { port } = store;
      await new Promise<void>((r) => { for (const s of openSockets) s.destroy(); openStores[0].close(() => r()); });
      const { ensureBucketCors } = await setUp(port);

      await ensureBucketCors(ORIGINS);

      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('warn');
      expect(logs[0].text).toContain('the check could not run');
      expect(logs[0].text).toContain('ECONNREFUSED');
      expect(logs[0].text).toContain('server runs either way');
    });

    it('never throws, whatever the environment is missing', async () => {
      const { ensureBucketCors } = await setUp(null);
      // No bucket: the presign throws locally, before any request leaves
      delete process.env.S3_ASSETS_BUCKET;
      await expect(ensureBucketCors(ORIGINS)).resolves.toBeUndefined();
      expect(logs).toHaveLength(1);
      expect(logs[0].text).toContain('the check could not run');
    });
  });

  describe('the judgement of the store\'s answer', () => {
    const rule = (over: Partial<CORSRule>): CORSRule => ({ AllowedOrigins: [WEB], AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'], ...over });
    const answerOf = (status: number, headers: Record<string, string>) => ({ preflight: () => ({ status, headers }) });

    async function refused(patch: Partial<StoreState>): Promise<string[]> {
      const store = await startStore(patch);
      const { reconcileBucketCors } = await setUp(store.port);
      const outcome = await reconcileBucketCors({ origins: [WEB], apply: false });
      if (outcome.status === 'accepted') return [];
      if (outcome.status !== 'refused') throw new Error(`unexpected ${outcome.status}`);
      return outcome.refused;
    }

    it('a non-2xx answer refuses', async () => {
      expect(await refused({ rules: [], preflight: () => ({ status: 403, headers: { 'Access-Control-Allow-Origin': WEB, 'Access-Control-Allow-Methods': 'PUT', 'Access-Control-Allow-Headers': 'content-type' } }) })).toEqual([WEB]);
    });

    it('a method spelled in lower case refuses, as a browser refuses it', async () => {
      expect(await refused(answerOf(200, { 'Access-Control-Allow-Origin': WEB, 'Access-Control-Allow-Methods': 'put', 'Access-Control-Allow-Headers': 'content-type' }))).toEqual([WEB]);
    });

    it.each([403, 404])('a %i answer is a refusal, not a check that could not run', async (status) => {
      expect(await refused({ rules: [], preflight: () => ({ status }) })).toEqual([WEB]);
    });

    it.each([301, 308, 500, 503])('a %i answer means the check could not run, in default mode and in apply mode (nothing is written)', async (status) => {
      for (const apply of [false, true]) {
        const store = await startStore({ rules: [], preflight: () => ({ status }) });
        const { reconcileBucketCors } = await setUp(store.port);
        const outcome = await reconcileBucketCors({ origins: [WEB], apply });
        expect(outcome).toMatchObject({ status: 'unavailable', error: `HTTP ${status}` });
        // Only the first preflight went out: nothing is known about the other origins either
        expect(preflights(store.seen)).toHaveLength(1);
        expect(corsCalls(store.seen)).toEqual([]);
        vi.resetModules();
      }
    });

    it('the log line of a 503 says the check could not run, with the status and no address', async () => {
      const store = await startStore({ preflight: () => ({ status: 503 }) });
      const { ensureBucketCors } = await setUp(store.port);
      await ensureBucketCors(ORIGINS);
      expect(logs).toHaveLength(1);
      expect(logs[0].text).toContain('the check could not run (HTTP 503)');
    });

    it('a preflight answer whose body cannot be discarded is warned about, and the verdict stands', async () => {
      const store = await startStore();
      const { reconcileBucketCors } = await setUp(store.port);
      const body = new ReadableStream({ cancel() { return Promise.reject(Object.assign(new Error('boom store-host.internal'), { name: 'CancelError' })); } });
      const fetchImpl = async (_input: string, init: RequestInit) => {
        const origin = (init.headers as Record<string, string>).Origin;
        return new Response(body, { status: 200, headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'PUT', 'access-control-allow-headers': 'content-type' } });
      };

      const outcome = await reconcileBucketCors({ origins: [WEB], apply: false, fetchImpl });

      expect(outcome.status).toBe('accepted');
      expect(line('warn')).toEqual(['[S3] Bucket CORS: a preflight answer could not be discarded (CancelError)']);
    });

    it('a wrong or a missing allow-origin refuses', async () => {
      expect(await refused(answerOf(200, { 'Access-Control-Allow-Origin': 'https://other.example.org', 'Access-Control-Allow-Methods': 'PUT', 'Access-Control-Allow-Headers': 'content-type' }))).toEqual([WEB]);
      expect(await refused(answerOf(200, { 'Access-Control-Allow-Methods': 'PUT', 'Access-Control-Allow-Headers': 'content-type' }))).toEqual([WEB]);
    });

    it('methods without PUT refuse', async () => {
      expect(await refused(answerOf(200, { 'Access-Control-Allow-Origin': WEB, 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'content-type' }))).toEqual([WEB]);
    });

    it('headers without content-type refuse', async () => {
      expect(await refused(answerOf(200, { 'Access-Control-Allow-Origin': WEB, 'Access-Control-Allow-Methods': 'PUT', 'Access-Control-Allow-Headers': 'x-amz-meta-a, content-*' }))).toEqual([WEB]);
    });

    it('the * forms and any header case or spacing accept, and GET is not needed', async () => {
      expect(await refused(answerOf(200, { 'access-control-allow-origin': '*', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' }))).toEqual([]);
      expect(await refused(answerOf(204, { 'ACCESS-CONTROL-ALLOW-ORIGIN': WEB, 'Access-Control-Allow-Methods': ' get ,  PUT ', 'Access-Control-Allow-Headers': 'X-Other ,  Content-TYPE ' }))).toEqual([]);
      expect(await refused({ rules: [rule({})] })).toEqual([]);
    });

    it('a redirect is not followed, and the check could not run', async () => {
      const store = await startStore({ preflight: () => ({ status: 307, headers: { Location: 'http://127.0.0.1:9/elsewhere' } }) });
      const { reconcileBucketCors } = await setUp(store.port);
      expect(await reconcileBucketCors({ origins: [WEB], apply: false })).toMatchObject({ status: 'unavailable', error: 'HTTP 307' });
      expect(store.seen).toHaveLength(1);
    });
  });

  describe('a store that does not answer', () => {
    it('gives up after the time limit and reports the check could not run', async () => {
      const store = await startStore({ hang: true });
      const { reconcileBucketCors } = await setUp(store.port);

      const started = Date.now();
      const outcome = await reconcileBucketCors({ origins: ORIGINS, apply: false, timeoutMs: 150 });

      expect(Date.now() - started).toBeLessThan(2000);
      expect(outcome).toMatchObject({ status: 'unavailable', error: expect.stringContaining('TimeoutError') });
      // The check stops at the first failure: one preflight, not four
      expect(preflights(store.seen)).toHaveLength(1);
    });
  });

  describe('with S3_CORS_APPLY=true', () => {
    const upload = (origins: string[]): CORSRule => ({ ID: 'voxium-uploads', AllowedOrigins: [...origins].sort(), AllowedMethods: ['GET', 'PUT'], AllowedHeaders: ['content-type'], MaxAgeSeconds: 3600 });
    const operator: CORSRule[] = [
      { ID: 'site', AllowedOrigins: ['https://www.example.org'], AllowedMethods: ['GET', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 60 },
      { AllowedOrigins: ['https://other.example.org'], AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'] },
    ];

    it('everything accepted: no rule is read or written', async () => {
      const store = await startStore({ rules: [{ AllowedOrigins: ORIGINS, AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'] }] });
      const { ensureBucketCors } = await setUp(store.port, { S3_CORS_APPLY: 'true' });

      await ensureBucketCors(ORIGINS);

      expect(corsCalls(store.seen)).toEqual([]);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('log');
    });

    it('no configuration (NoSuchCORSConfiguration): writes the upload rule alone, asks again, and ONE line says it now works', async () => {
      const store = await startStore({ rules: null });
      const { ensureBucketCors } = await setUp(store.port, { S3_CORS_APPLY: 'true' });

      await ensureBucketCors(ORIGINS);

      expect(corsCalls(store.seen).map((s) => s.method)).toEqual(['GET', 'PUT']);
      expect(store.state.rules).toEqual([upload(ORIGINS)]);
      // 4 preflights before the write, 4 after
      expect(preflights(store.seen)).toHaveLength(8);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('log');
      expect(logs[0].text).toContain('added the upload rule');
      expect(logs[0].text).toContain('now accepts browser uploads from all 4 CORS_ORIGIN origin(s)');
      // The write sends a CRC32 of its real body, as the operation requires
      const put = store.seen.find((s) => s.method === 'PUT')!;
      expect(put.headers['x-amz-checksum-crc32']).toBeTruthy();
    });

    it('a non-empty list: every rule is written back in order and the upload rule goes last', async () => {
      const store = await startStore({ rules: operator });
      const { ensureBucketCors } = await setUp(store.port, { S3_CORS_APPLY: 'true' });

      await ensureBucketCors(ORIGINS);

      expect(store.state.rules).toEqual([...operator, upload(ORIGINS)]);
      expect(logs).toHaveLength(1);
      expect(logs[0].text).toContain("the bucket's 2 other rule(s) written back unchanged");
    });

    it('its own earlier rule is replaced at the position it has, the others stay where they are', async () => {
      const old: CORSRule = { ID: 'voxium-uploads', AllowedOrigins: ['https://gone.example.org'], AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'] };
      const store = await startStore({ rules: [operator[0], old, operator[1]] });
      const { ensureBucketCors } = await setUp(store.port, { S3_CORS_APPLY: 'true' });

      await ensureBucketCors(ORIGINS);

      expect(store.state.rules).toEqual([operator[0], upload(ORIGINS), operator[1]]);
      expect(logs[0].text).toContain('replaced the upload rule');
    });

    it('a success with no rule is not read as "no rules": nothing is written and the line says so', async () => {
      const store = await startStore({ zeroRules: true });
      const { ensureBucketCors } = await setUp(store.port, { S3_CORS_APPLY: 'true' });

      await ensureBucketCors(ORIGINS);

      expect(corsCalls(store.seen).map((s) => s.method)).toEqual(['GET']);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('warn');
      expect(logs[0].text).toContain('could not be interpreted');
    });

    it('rules that cannot be read: nothing is written, the line names the error code', async () => {
      const store = await startStore({ getCorsStatus: 403 });
      const { ensureBucketCors } = await setUp(store.port, { S3_CORS_APPLY: 'true' });

      await ensureBucketCors(ORIGINS);

      expect(corsCalls(store.seen).map((s) => s.method)).toEqual(['GET']);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('warn');
      expect(logs[0].text).toContain('AccessDenied');
      expect(logs[0].text).toContain('HTTP 403');
    });

    it('a refused write: ONE error line, never a throw', async () => {
      const store = await startStore({ rules: operator, putCorsStatus: 403 });
      const { ensureBucketCors } = await setUp(store.port, { S3_CORS_APPLY: 'true' });

      await expect(ensureBucketCors(ORIGINS)).resolves.toBeUndefined();

      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('error');
      expect(logs[0].text).toContain('could not be written (AccessDenied');
      expect(store.state.rules).toEqual(operator);
    });

    it('written, yet an earlier rule that names the origin is answered first: the line names the origins still refused', async () => {
      // A store taking the first rule that names the origin: this rule allows GET only
      const shadow: CORSRule = { ID: 'site', AllowedOrigins: [WEB], AllowedMethods: ['GET'], AllowedHeaders: ['*'] };
      const store = await startStore({ rules: [shadow] });
      const { ensureBucketCors } = await setUp(store.port, { S3_CORS_APPLY: 'true' });

      await ensureBucketCors(ORIGINS);

      expect(store.state.rules).toEqual([shadow, upload(ORIGINS)]);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('warn');
      expect(logs[0].text).toContain(`still refuses browser uploads from ${WEB}`);
      expect(logs[0].text).not.toContain('https://tauri.localhost');
    });

    it('written, but the check afterwards cannot run: the line says so', async () => {
      const store = await startStore({ rules: null, breakAfterPut: true });
      const { ensureBucketCors } = await setUp(store.port, { S3_CORS_APPLY: 'true' });

      await ensureBucketCors(ORIGINS);

      expect(store.state.putDone).toBe(true);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('warn');
      expect(logs[0].text).toContain('the check afterwards could not run');
    });

    it('a store that cannot be reached is never written to', async () => {
      const store = await startStore({ hang: true });
      const { reconcileBucketCors } = await setUp(store.port, { S3_CORS_APPLY: 'true' });

      const outcome = await reconcileBucketCors({ origins: ORIGINS, apply: true, timeoutMs: 100 });

      expect(outcome.status).toBe('unavailable');
      expect(corsCalls(store.seen)).toEqual([]);
    });
  });
});
