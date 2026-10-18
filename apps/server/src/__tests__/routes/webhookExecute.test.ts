import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import express, { type Request } from 'express';
import request from 'supertest';
import { LIMITS } from '@voxium/shared';

// POST /api/v1/webhooks/:webhookId/:token — the public execute route
// (docs/local/webhooks-plan.html, "Execute (public)").

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Every guard records itself here, so the middleware ORDER can be asserted
const order = vi.hoisted(() => [] as string[]);

const limiters = vi.hoisted(() => ({
  ip: vi.fn((_req: any, _res: any, next: any) => {
    order.push('ipLimiter');
    next();
  }),
  perWebhook: vi.fn((req: any, _res: any, next: any) => {
    order.push(`webhookLimiter:${req.params.webhookId}`);
    next();
  }),
}));
vi.mock('../../middleware/rateLimiter', () => ({
  rateLimitWebhookExecuteIp: (...a: any[]) => limiters.ip(...a),
  rateLimitWebhookExecute: (...a: any[]) => limiters.perWebhook(...a),
}));

// requireFeature stays REAL; only the flag lookup is mocked (and recorded)
const flags = vi.hoisted(() => ({ webhooks: true }));
vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: (name: string) => {
    order.push(`flag:${name}`);
    return name === 'webhooks' ? flags.webhooks : true;
  },
}));

const prismaMock = vi.hoisted(() => ({
  webhook: { findUnique: vi.fn(), updateMany: vi.fn() },
  channel: { findUnique: vi.fn() },
  message: { create: vi.fn() },
  serverMember: { findMany: vi.fn(), findUnique: vi.fn() },
}));
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const io = vi.hoisted(() => {
  const emit = vi.fn();
  return { emit, to: vi.fn(() => ({ emit })) };
});
vi.mock('../../websocket/socketServer', () => ({ getIO: () => io }));

import { webhookExecuteRouter, LAST_USED_THROTTLE_MS } from '../../routes/webhookExecute';
import { errorHandler } from '../../middleware/errorHandler';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const WEBHOOK_ID = 'wh_abc123';
const TOKEN = 'tok_Zm9vYmFyYmF6cXV4c2VjcmV0dG9rZW5fMDEyMzQ1Njc4OQ';
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const URL_OK = `/api/v1/webhooks/${WEBHOOK_ID}/${TOKEN}`;
const CREATED_AT = new Date('2026-10-18T10:00:00Z');

function webhookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WEBHOOK_ID,
    tokenHash: sha256(TOKEN),
    enabled: true,
    type: 'generic',
    secretEnc: null,
    channelId: 'ch-1',
    serverId: 'srv-1',
    name: 'Uptime Kuma',
    ...overrides,
  };
}

/** The channel row loadWebhook reads with its SECOND query, after the token matched. */
function channelRow(overrides: Record<string, unknown> = {}) {
  return { serverId: 'srv-1', type: 'text', secure: false, name: 'alerts', server: { name: 'Ops Team' }, ...overrides };
}

/** Every Prisma call the route made, by name (the mock tree is two levels deep). */
function prismaCalls(): string[] {
  const calls: string[] = [];
  for (const [model, methods] of Object.entries(prismaMock)) {
    for (const [method, fn] of Object.entries(methods)) {
      for (let i = 0; i < (fn as ReturnType<typeof vi.fn>).mock.calls.length; i++) calls.push(`${model}.${method}`);
    }
  }
  return calls;
}

/** What Prisma would return for the create: the row + the requested includes. */
function createdRow(data: Record<string, unknown>) {
  return {
    id: 'msg-1',
    content: data.content,
    encrypted: false,
    type: 'user',
    channelId: data.channelId,
    conversationId: null,
    authorId: null,
    webhookId: data.webhookId,
    webhookName: data.webhookName,
    replyToId: null,
    editedAt: null,
    createdAt: CREATED_AT,
    author: null,
    attachments: [],
  };
}

/** Mounted exactly as app.ts mounts it: BEFORE a global 100 KB JSON parser. */
function createApp(capture?: (req: Request) => void) {
  const app = express();
  if (capture) {
    app.use((req, _res, next) => {
      capture(req);
      next();
    });
  }
  app.use('/api/v1/webhooks', webhookExecuteRouter);
  app.use(express.json({ limit: '100kb' }));
  app.use(errorHandler);
  return app;
}

const app = createApp();

function post(url: string = URL_OK) {
  return request(app).post(url).set('Content-Type', 'application/json');
}

/** A raw POST with a body and NO Content-Type header (supertest always sets one). */
function rawPostWithoutContentType(url: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('no address'));
        return;
      }
      const req = http.request(
        { hostname: '127.0.0.1', port: addr.port, path: url, method: 'POST', headers: { 'Content-Length': Buffer.byteLength(body) } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode || 0, body: data });
          });
        },
      );
      req.on('error', (e) => {
        server.close();
        reject(e);
      });
      req.end(body);
    });
  });
}

/**
 * A raw JSON POST that keeps the server up until the client has written its
 * whole body. supertest closes its ephemeral server on the response, which
 * resets a connection still uploading when the route answers EARLY (as it
 * does on a wrong token); a real server stays up and drains the body.
 */
function rawJsonPost(url: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('no address'));
        return;
      }
      let response: { status: number; body: string } | undefined;
      let written = false;
      const settle = () => {
        if (!response || !written) return;
        server.close();
        resolve(response);
      };
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: addr.port,
          path: url,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            response = { status: res.statusCode || 0, body: data };
            settle();
          });
        },
      );
      req.on('finish', () => {
        written = true;
        settle();
      });
      req.on('error', (e) => {
        server.close();
        reject(e);
      });
      req.end(body);
    });
  });
}

let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  flags.webhooks = true;
  prismaMock.webhook.findUnique.mockImplementation(async () => {
    order.push('findUnique');
    return webhookRow();
  });
  prismaMock.channel.findUnique.mockImplementation(async () => {
    order.push('channelLookup');
    return channelRow();
  });
  prismaMock.webhook.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.message.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    order.push('create');
    return createdRow(args.data);
  });
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});

afterEach(() => {
  // The token is a credential: whatever a test did, it never reached a log line
  for (const spy of consoleSpies) {
    expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
  }
  vi.restoreAllMocks();
});

// ─── Kill switch ────────────────────────────────────────────────────────────

describe('POST /webhooks/:id/:token — kill switch', () => {
  it('answers 403 "Webhooks are currently disabled" before any lookup, limiter or parse', async () => {
    flags.webhooks = false;

    const res = await post().send({ content: 'hello' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Webhooks are currently disabled' });
    expect(prismaMock.webhook.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.message.create).not.toHaveBeenCalled();
    expect(limiters.ip).not.toHaveBeenCalled();
    expect(limiters.perWebhook).not.toHaveBeenCalled();
  });

  it('still answers 403 for a non-JSON body while disabled (the flag is the first guard)', async () => {
    flags.webhooks = false;

    const res = await request(app).post(URL_OK).type('form').send('content=hello');

    expect(res.status).toBe(403);
  });
});

// ─── Malformed URL (the router's param decoding throws) ─────────────────────

describe('POST /webhooks/:id/:token — malformed percent-escape in the URL', () => {
  const BAD_URL = '/api/v1/webhooks/wh_1/abc%zz';

  it('answers 400 "Malformed URL" in the house shape, after the flag check and the per-IP limiter', async () => {
    const res = await post(BAD_URL).send({ content: 'x' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Malformed URL' });
    // router-level guards ran although the route layer threw while decoding
    expect(order).toEqual(['flag:webhooks', 'ipLimiter']);
    expect(limiters.ip).toHaveBeenCalledTimes(1);
    expect(limiters.perWebhook).not.toHaveBeenCalled();
    expect(prismaCalls()).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('logs one warning with the token segment redacted, never the raw segment', async () => {
    await post(`/api/v1/webhooks/wh_1/${TOKEN}%zz`).send({ content: 'x' });

    expect(console.warn).toHaveBeenCalledWith('[HTTP] Malformed URL', {
      method: 'POST',
      path: '/api/v1/webhooks/wh_1/[redacted]',
      status: 400,
    });
    // the afterEach hook asserts the token reached no log line
  });

  it('answers the kill switch 403 to the same URL while the flag is off', async () => {
    flags.webhooks = false;

    const res = await post(BAD_URL).send({ content: 'x' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Webhooks are currently disabled' });
    expect(limiters.ip).not.toHaveBeenCalled();
  });

  it('a per-IP 429 answers the malformed URL too', async () => {
    limiters.ip.mockImplementationOnce((_req: any, res: any) => {
      res.status(429).json({ success: false, error: 'Too many requests. Please try again later.' });
    });

    const res = await post(BAD_URL).send({ content: 'x' });

    expect(res.status).toBe(429);
  });
});

// ─── Router-level guards stay scoped to the execute route ───────────────────

describe('POST /webhooks/:id/:token — router-level guard scope', () => {
  it('a non-POST request leaves the router untouched (no flag check, no per-IP charge)', async () => {
    flags.webhooks = false;

    const res = await request(app).get(URL_OK);

    expect(res.status).toBe(404);
    expect(order).toEqual([]);
    expect(limiters.ip).not.toHaveBeenCalled();
  });

  it('a POST to another path shape leaves the router untouched', async () => {
    for (const url of ['/api/v1/webhooks', `/api/v1/webhooks/${WEBHOOK_ID}`, `${URL_OK}/extra`]) {
      await post(url).send({ content: 'x' });
    }

    expect(order).toEqual([]);
    expect(limiters.ip).not.toHaveBeenCalled();
    expect(prismaCalls()).toEqual([]);
  });

  it('a trailing slash is the execute route (the route matches it, so the guards run)', async () => {
    const res = await post(`${URL_OK}/`).send({ content: 'hello' });

    expect(res.status).toBe(204);
    expect(order[0]).toBe('flag:webhooks');
    expect(limiters.ip).toHaveBeenCalledTimes(1);
  });
});

// ─── Content type ───────────────────────────────────────────────────────────

describe('POST /webhooks/:id/:token — content type', () => {
  it('answers 415 "Send application/json" to a form-encoded body, after the per-IP limiter, before any lookup', async () => {
    const res = await request(app).post(URL_OK).type('form').send('payload=%7B%7D');

    expect(res.status).toBe(415);
    expect(res.body).toEqual({ success: false, error: 'Send application/json' });
    // the per-IP limiter is router-level now, so a 415 flood is charged too
    expect(limiters.ip).toHaveBeenCalledTimes(1);
    expect(prismaMock.webhook.findUnique).not.toHaveBeenCalled();
    expect(limiters.perWebhook).not.toHaveBeenCalled();
  });

  it('answers 415 to a body with no Content-Type at all', async () => {
    const res = await rawPostWithoutContentType(URL_OK, '{"content":"hello"}');

    expect(res.status).toBe(415);
    expect(JSON.parse(res.body)).toEqual({ success: false, error: 'Send application/json' });
    expect(prismaMock.webhook.findUnique).not.toHaveBeenCalled();
  });

  it('answers 415 to text/plain', async () => {
    const res = await request(app).post(URL_OK).set('Content-Type', 'text/plain').send('{"content":"hello"}');

    expect(res.status).toBe(415);
  });

  it('accepts application/json', async () => {
    const res = await request(app).post(URL_OK).set('Content-Type', 'application/json').send('{"content":"hello"}');

    expect(res.status).toBe(204);
    expect(prismaMock.message.create).toHaveBeenCalledTimes(1);
  });

  it('accepts application/json; charset=utf-8', async () => {
    const res = await request(app).post(URL_OK).set('Content-Type', 'application/json; charset=utf-8').send('{"content":"hello"}');

    expect(res.status).toBe(204);
    expect(prismaMock.message.create).toHaveBeenCalledTimes(1);
  });
});

// ─── Token check and opacity ────────────────────────────────────────────────

describe('POST /webhooks/:id/:token — token check', () => {
  it('an unknown id and a wrong token answer byte-identical 404 bodies', async () => {
    prismaMock.webhook.findUnique.mockResolvedValueOnce(null);
    const unknownId = await post(`/api/v1/webhooks/wh_missing/${TOKEN}`).send({ content: 'x' });

    const wrongToken = await post(`/api/v1/webhooks/${WEBHOOK_ID}/not-the-token`).send({ content: 'x' });

    expect(unknownId.status).toBe(404);
    expect(wrongToken.status).toBe(404);
    expect(unknownId.text).toBe(wrongToken.text);
    expect(unknownId.body).toEqual({ success: false, error: 'Webhook not found' });
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('both failure paths consume the per-IP limiter and NOT the per-webhook limiter', async () => {
    prismaMock.webhook.findUnique.mockResolvedValueOnce(null);
    await post(`/api/v1/webhooks/wh_missing/${TOKEN}`).send({ content: 'x' });
    await post(`/api/v1/webhooks/${WEBHOOK_ID}/not-the-token`).send({ content: 'x' });

    expect(limiters.ip).toHaveBeenCalledTimes(2);
    expect(limiters.perWebhook).not.toHaveBeenCalled();
  });

  it('an unknown id makes exactly ONE prisma call (the scalar webhook lookup), never the channel read', async () => {
    prismaMock.webhook.findUnique.mockResolvedValueOnce(null);

    const res = await post(`/api/v1/webhooks/wh_missing/${TOKEN}`).send({ content: 'x' });

    expect(res.status).toBe(404);
    expect(prismaCalls()).toEqual(['webhook.findUnique']);
    expect(prismaMock.channel.findUnique).not.toHaveBeenCalled();
  });

  it('a known id with a wrong token makes exactly the same ONE prisma call', async () => {
    const res = await post(`/api/v1/webhooks/${WEBHOOK_ID}/not-the-token`).send({ content: 'x' });

    expect(res.status).toBe(404);
    expect(prismaCalls()).toEqual(['webhook.findUnique']);
    expect(prismaMock.channel.findUnique).not.toHaveBeenCalled();
  });

  it('a valid token loads the channel AFTER the match, by the row\'s channelId', async () => {
    await post().send({ content: 'x' });

    expect(order.indexOf('findUnique')).toBeLessThan(order.indexOf('channelLookup'));
    expect(prismaMock.channel.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.channel.findUnique).toHaveBeenCalledWith({
      where: { id: 'ch-1' },
      select: { serverId: true, type: true, secure: true, name: true, server: { select: { name: true } } },
    });
  });

  it('a channel gone between the two reads answers the same not-found 404, without a warning', async () => {
    const wrongToken = await post(`/api/v1/webhooks/${WEBHOOK_ID}/not-the-token`).send({ content: 'x' });
    prismaMock.channel.findUnique.mockResolvedValueOnce(null);

    const res = await post().send({ content: 'x' });

    expect(res.status).toBe(404);
    expect(res.text).toBe(wrongToken.text);
    expect(console.warn).not.toHaveBeenCalled();
    expect(prismaMock.message.create).not.toHaveBeenCalled();
    expect(limiters.perWebhook).not.toHaveBeenCalled();
  });

  it('a wrong token never reaches the body parser: a malformed JSON body answers 404, not 400', async () => {
    let captured: Request | undefined;
    const capturingApp = createApp((req) => {
      captured = req;
    });

    const res = await request(capturingApp)
      .post(`/api/v1/webhooks/${WEBHOOK_ID}/not-the-token`)
      .set('Content-Type', 'application/json')
      .send('{"content": "x",');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Webhook not found' });
    // the parser never ran: no raw bytes kept, no body
    expect(captured?.rawBody).toBeUndefined();
    expect(captured?.body).toBeUndefined();
  });

  it('a wrong token with a body above WEBHOOK_BODY_MAX_BYTES answers 404, not 413 (the parser never ran)', async () => {
    const body = JSON.stringify({ content: 'x', pad: 'p'.repeat(LIMITS.WEBHOOK_BODY_MAX_BYTES) });

    const res = await rawJsonPost(`/api/v1/webhooks/${WEBHOOK_ID}/not-the-token`, body);

    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ success: false, error: 'Webhook not found' });
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('a malformed id answers the same 404 without a database lookup', async () => {
    const wrongToken = await post(`/api/v1/webhooks/${WEBHOOK_ID}/not-the-token`).send({ content: 'x' });
    prismaMock.webhook.findUnique.mockClear();

    const malformed = await post(`/api/v1/webhooks/${'x'.repeat(65)}/${TOKEN}`).send({ content: 'x' });

    expect(malformed.status).toBe(404);
    expect(malformed.text).toBe(wrongToken.text);
    expect(prismaMock.webhook.findUnique).not.toHaveBeenCalled();
  });

  it('a stored hash of an unexpected shape is a miss, never a throw', async () => {
    for (const tokenHash of ['abc', sha256(TOKEN).toUpperCase().slice(0, 63), `${sha256(TOKEN)}00`, 'é'.repeat(64)]) {
      prismaMock.webhook.findUnique.mockResolvedValueOnce(webhookRow({ tokenHash }));
      const res = await post().send({ content: 'x' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, error: 'Webhook not found' });
    }
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('looks the webhook up by id with a scalar-only select (no relation, no secret beyond what the handler needs)', async () => {
    await post().send({ content: 'x' });

    expect(prismaMock.webhook.findUnique).toHaveBeenCalledWith({
      where: { id: WEBHOOK_ID },
      select: {
        id: true,
        tokenHash: true,
        enabled: true,
        type: true,
        secretEnc: true,
        channelId: true,
        serverId: true,
        name: true,
      },
    });
  });

  it('a disabled webhook answers 403 "Webhook is disabled" (only with the right token)', async () => {
    prismaMock.webhook.findUnique.mockResolvedValue(webhookRow({ enabled: false }));

    const res = await post().send({ content: 'x' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Webhook is disabled' });
    expect(limiters.perWebhook).not.toHaveBeenCalled();
    expect(prismaMock.message.create).not.toHaveBeenCalled();

    // a wrong token on a disabled webhook does not learn that it is disabled
    const wrong = await post(`/api/v1/webhooks/${WEBHOOK_ID}/nope`).send({ content: 'x' });
    expect(wrong.status).toBe(404);
  });

  it('a webhook bound to a secure channel answers the not-found 404 and warns', async () => {
    prismaMock.channel.findUnique.mockResolvedValueOnce(channelRow({ secure: true, name: 'vault' }));

    const res = await post().send({ content: 'x' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Webhook not found' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[Webhooks]'), expect.objectContaining({ webhookId: WEBHOOK_ID }));
    expect(prismaMock.message.create).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('a webhook bound to a voice channel answers the not-found 404', async () => {
    prismaMock.channel.findUnique.mockResolvedValueOnce(channelRow({ type: 'voice', name: 'Lounge' }));

    const res = await post().send({ content: 'x' });

    expect(res.status).toBe(404);
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('a webhook whose channel belongs to another server answers the not-found 404', async () => {
    prismaMock.channel.findUnique.mockResolvedValueOnce(channelRow({ serverId: 'srv-OTHER', name: 'x', server: { name: 'Other' } }));

    const res = await post().send({ content: 'x' });

    expect(res.status).toBe(404);
  });
});

// ─── Middleware order and limiters ──────────────────────────────────────────

describe('POST /webhooks/:id/:token — middleware order', () => {
  it('flag → per-IP limiter → lookup → channel → per-webhook limiter (keyed on the validated id) → insert', async () => {
    const res = await post().send({ content: 'hello' });

    expect(res.status).toBe(204);
    expect(order).toEqual(['flag:webhooks', 'ipLimiter', 'findUnique', 'channelLookup', `webhookLimiter:${WEBHOOK_ID}`, 'create']);
  });

  it('the body is parsed only AFTER the per-webhook limiter: a per-webhook 429 never reads the body', async () => {
    let captured: Request | undefined;
    const capturingApp = createApp((req) => {
      captured = req;
    });
    limiters.perWebhook.mockImplementationOnce((_req: any, res: any) => {
      res.status(429).json({ success: false, error: 'Too many requests. Please try again later.' });
    });

    const res = await request(capturingApp).post(URL_OK).set('Content-Type', 'application/json').send('{"content":"hello"}');

    expect(res.status).toBe(429);
    expect(captured?.rawBody).toBeUndefined();
    expect(captured?.body).toBeUndefined();
  });

  it('a per-IP 429 stops the request before the body is parsed or the database is touched', async () => {
    limiters.ip.mockImplementationOnce((_req: any, res: any) => {
      res.status(429).json({ success: false, error: 'Too many requests. Please try again later.' });
    });

    const res = await post().send({ content: 'hello' });

    expect(res.status).toBe(429);
    expect(prismaMock.webhook.findUnique).not.toHaveBeenCalled();
    expect(limiters.perWebhook).not.toHaveBeenCalled();
  });

  it('a per-webhook 429 stops the request before the insert', async () => {
    limiters.perWebhook.mockImplementationOnce((_req: any, res: any) => {
      res.status(429).json({ success: false, error: 'Too many requests. Please try again later.' });
    });

    const res = await post().send({ content: 'hello' });

    expect(res.status).toBe(429);
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });
});

// ─── Body parsing ───────────────────────────────────────────────────────────

describe('POST /webhooks/:id/:token — body parsing', () => {
  it('answers 413 in the house shape above WEBHOOK_BODY_MAX_BYTES (on a valid token, after its checks)', async () => {
    const body = JSON.stringify({ content: 'x', pad: 'p'.repeat(LIMITS.WEBHOOK_BODY_MAX_BYTES) });

    const res = await post().send(body);

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ success: false, error: 'Request body too large' });
    expect(limiters.ip).toHaveBeenCalledTimes(1);
    // the parser runs last: the token, the channel and the per-webhook budget came first
    expect(order).toEqual(['flag:webhooks', 'ipLimiter', 'findUnique', 'channelLookup', `webhookLimiter:${WEBHOOK_ID}`]);
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('answers 400 in the house shape on malformed JSON (valid token), echoing nothing', async () => {
    const res = await post().send('{"content": "SECRET_FRAGMENT",');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Malformed JSON body' });
    expect(res.text).not.toContain('SECRET_FRAGMENT');
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('accepts a 200 KB body: the route\'s own 1 MB parser runs, not the global 100 KB one', async () => {
    const body = JSON.stringify({ content: 'big delivery', pad: 'p'.repeat(200 * 1024) });

    const res = await post().send(body);

    expect(res.status).toBe(204);
    expect(prismaMock.message.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.message.create.mock.calls[0][0].data.content).toBe('big delivery');
  });

  it('keeps the raw request bytes on req.rawBody (for the GitHub signature check)', async () => {
    let captured: Request | undefined;
    const capturingApp = createApp((req) => {
      captured = req;
    });
    const raw = '{"content":  "exact bytes"}';

    const res = await request(capturingApp).post(URL_OK).set('Content-Type', 'application/json').send(raw);

    expect(res.status).toBe(204);
    expect(Buffer.isBuffer(captured?.rawBody)).toBe(true);
    expect(captured?.rawBody?.toString('utf8')).toBe(raw);
  });

  it('answers 400 with the renderer\'s error for a body with nothing to post', async () => {
    const res = await post().send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'content or embeds required' });
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('answers 400 for a top-level JSON array', async () => {
    const res = await post().send('[{"content":"x"}]');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Body must be a JSON object' });
  });

  it('answers 400 for rendered content over MESSAGE_MAX (rejected, never truncated)', async () => {
    const res = await post().send({ content: 'a'.repeat(LIMITS.MESSAGE_MAX + 1) });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: `Message must be at most ${LIMITS.MESSAGE_MAX} characters` });
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });
});

// ─── Delivery by type ───────────────────────────────────────────────────────

describe('POST /webhooks/:id/:token — webhook types', () => {
  it('a generic webhook refuses a GitHub delivery (X-GitHub-Event) with a 400 it can act on', async () => {
    const res = await post().set('X-GitHub-Event', 'push').set('X-GitHub-Delivery', 'delivery-guid-1').send({ ref: 'refs/heads/main' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'This is a generic webhook; create a GitHub webhook for GitHub deliveries' });
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('logs the GitHub delivery id at debug level only — and nothing else from the request', async () => {
    await post().set('X-GitHub-Event', 'push').set('X-GitHub-Delivery', 'delivery-guid-2').send({ secret_field: 'BODY_VALUE' });

    expect(console.debug).toHaveBeenCalledWith('[Webhooks] GitHub delivery', { webhookId: WEBHOOK_ID, delivery: 'delivery-guid-2' });
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      expect(JSON.stringify(vi.mocked(console[method]).mock.calls)).not.toContain('BODY_VALUE');
    }
  });

  it('a GitHub-type webhook answers 400 "GitHub webhooks are not supported yet" (step 3 replaces it)', async () => {
    prismaMock.webhook.findUnique.mockResolvedValueOnce(webhookRow({ type: 'github', secretEnc: 'enc:00:00:00' }));

    const res = await post().set('X-GitHub-Event', 'push').send({ ref: 'refs/heads/main' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'GitHub webhooks are not supported yet' });
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('a GitHub-type webhook answers the same 400 to a Discord-shaped body', async () => {
    prismaMock.webhook.findUnique.mockResolvedValueOnce(webhookRow({ type: 'github' }));

    const res = await post().send({ content: 'hello' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'GitHub webhooks are not supported yet' });
  });

  it('an unknown webhook type answers 400 "Unsupported webhook type"', async () => {
    prismaMock.webhook.findUnique.mockResolvedValueOnce(webhookRow({ type: 'gitlab' }));

    const res = await post().send({ content: 'hello' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Unsupported webhook type' });
  });
});

// ─── The posted message ─────────────────────────────────────────────────────

describe('POST /webhooks/:id/:token — the message', () => {
  it('inserts with no authorId, no replyTo, no type override — the webhook is the author', async () => {
    await post().send({ content: 'hello' });

    expect(prismaMock.message.create).toHaveBeenCalledWith({
      data: { content: 'hello', channelId: 'ch-1', webhookId: WEBHOOK_ID, webhookName: 'Uptime Kuma' },
      include: {
        author: {
          select: { id: true, username: true, displayName: true, avatarUrl: true, role: true, isSupporter: true, supporterTier: true },
        },
        attachments: {
          select: { id: true, s3Key: true, fileName: true, fileSize: true, mimeType: true, expired: true },
        },
      },
    });
    const data = prismaMock.message.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('authorId');
    expect(data).not.toHaveProperty('replyToId');
    expect(data).not.toHaveProperty('type');
  });

  it('broadcasts message:new to channel:{id} with the synthesised author and empty mentions', async () => {
    await post().send({ content: 'hello' });

    expect(io.to).toHaveBeenCalledWith('channel:ch-1');
    expect(io.emit).toHaveBeenCalledTimes(1);
    const [event, payload] = io.emit.mock.calls[0];
    expect(event).toBe('message:new');
    expect(payload).toMatchObject({
      id: 'msg-1',
      content: 'hello',
      channelId: 'ch-1',
      webhookId: WEBHOOK_ID,
      webhookName: 'Uptime Kuma',
      replyTo: null,
      reactions: [],
      mentions: [],
      attachments: [],
      channelName: 'alerts',
      serverName: 'Ops Team',
      serverId: 'srv-1',
    });
    expect(payload.author).toEqual({
      id: `webhook:${WEBHOOK_ID}`,
      username: 'Uptime Kuma',
      displayName: 'Uptime Kuma',
      avatarUrl: null,
      isWebhook: true,
    });
  });

  it('never carries the token or its hash on the socket', async () => {
    await post().send({ content: 'hello' });

    const wire = JSON.stringify(io.emit.mock.calls);
    expect(wire).not.toContain(TOKEN);
    expect(wire).not.toContain(sha256(TOKEN));
  });

  it('answers 204 with no body by default', async () => {
    const res = await post().send({ content: 'hello' });

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });

  it('?wait=true answers 200 with the created message', async () => {
    const res = await post(`${URL_OK}?wait=true`).send({ content: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      id: 'msg-1',
      content: 'hello',
      channelId: 'ch-1',
      webhookId: WEBHOOK_ID,
      webhookName: 'Uptime Kuma',
      reactions: [],
      mentions: [],
      createdAt: CREATED_AT.toISOString(),
      author: { id: `webhook:${WEBHOOK_ID}`, isWebhook: true, username: 'Uptime Kuma' },
    });
    expect(JSON.stringify(res.body)).not.toContain(sha256(TOKEN));
  });

  it('?wait=false (or anything but "true") still answers 204', async () => {
    const res = await post(`${URL_OK}?wait=false`).send({ content: 'hello' });

    expect(res.status).toBe(204);
  });

  it('a username override lands in webhookName and in the synthesised author', async () => {
    await post().send({ content: 'hello', username: ' <b>Grafana</b> ' });

    expect(prismaMock.message.create.mock.calls[0][0].data.webhookName).toBe('Grafana');
    const payload = io.emit.mock.calls[0][1];
    expect(payload.webhookName).toBe('Grafana');
    expect(payload.author).toMatchObject({ username: 'Grafana', displayName: 'Grafana', isWebhook: true });
  });

  it('an over-long username is truncated to WEBHOOK_NAME_MAX, never refused', async () => {
    const res = await post().send({ content: 'hello', username: 'n'.repeat(LIMITS.WEBHOOK_NAME_MAX + 16) });

    expect(res.status).toBe(204);
    expect(prismaMock.message.create.mock.calls[0][0].data.webhookName).toBe('n'.repeat(LIMITS.WEBHOOK_NAME_MAX));
  });

  it('a webhook deleted between the token check and the insert (P2003) answers 404, not 500', async () => {
    prismaMock.message.create.mockRejectedValueOnce(
      Object.assign(new Error('Foreign key constraint violated on the constraint: `messages_webhook_id_fkey`'), {
        name: 'PrismaClientKnownRequestError',
        code: 'P2003',
      }),
    );

    const res = await post().send({ content: 'hello' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Webhook not found' });
    expect(io.emit).not.toHaveBeenCalled();
    expect(prismaMock.webhook.updateMany).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('any other insert failure is still a 500', async () => {
    prismaMock.message.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));

    const res = await post().send({ content: 'hello' });

    expect(res.status).toBe(500);
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('a generic body with embeds posts the flattened markdown', async () => {
    await post().send({
      content: 'Monitor is DOWN',
      embeds: [{ title: 'api.example.com', url: 'https://status.example.com/1', fields: [{ name: 'Error', value: 'timeout' }] }],
      avatar_url: 'https://tracker.example/pixel.png',
    });

    const content = prismaMock.message.create.mock.calls[0][0].data.content;
    expect(content).toBe('Monitor is DOWN\n\n> **[api.example.com](https://status.example.com/1)**  \n> **Error**: timeout');
    expect(content).not.toContain('tracker.example');
  });

  it('a body with @[userId] posts it literally with mentions: [] and no member lookup', async () => {
    await post().send({ content: 'ping @[user-42] and @[user-43]' });

    expect(prismaMock.message.create.mock.calls[0][0].data.content).toBe('ping @[user-42] and @[user-43]');
    expect(io.emit.mock.calls[0][1].mentions).toEqual([]);
    expect(prismaMock.serverMember.findMany).not.toHaveBeenCalled();
    expect(prismaMock.serverMember.findUnique).not.toHaveBeenCalled();
  });
});

// ─── lastUsedAt ─────────────────────────────────────────────────────────────

describe('POST /webhooks/:id/:token — lastUsedAt', () => {
  it('records lastUsedAt through ONE updateMany guarded by null-or-older-than-60s', async () => {
    const before = Date.now();
    await post().send({ content: 'hello' });
    const after = Date.now();

    expect(prismaMock.webhook.updateMany).toHaveBeenCalledTimes(1);
    const { where, data } = prismaMock.webhook.updateMany.mock.calls[0][0];
    expect(where.id).toBe(WEBHOOK_ID);
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ lastUsedAt: null });
    const threshold = where.OR[1].lastUsedAt.lt as Date;
    expect(threshold).toBeInstanceOf(Date);
    expect(threshold.getTime()).toBeGreaterThanOrEqual(before - LAST_USED_THROTTLE_MS);
    expect(threshold.getTime()).toBeLessThanOrEqual(after - LAST_USED_THROTTLE_MS);
    expect(LAST_USED_THROTTLE_MS).toBe(60_000);
    expect(data.lastUsedAt).toBeInstanceOf(Date);
  });

  it('a failed lastUsedAt write is warned about and the delivery still succeeds', async () => {
    prismaMock.webhook.updateMany.mockRejectedValueOnce(new Error('connection reset'));

    const res = await post().send({ content: 'hello' });

    expect(res.status).toBe(204);
    expect(io.emit).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith('[Webhooks] Could not record lastUsedAt', { webhookId: WEBHOOK_ID, error: 'connection reset' });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('is not written for a refused delivery', async () => {
    await post().send({});

    expect(prismaMock.webhook.updateMany).not.toHaveBeenCalled();
  });
});

// ─── Logging hygiene ────────────────────────────────────────────────────────

describe('POST /webhooks/:id/:token — logging', () => {
  it('nothing logged on any path contains the token (checked after every test, exercised here on purpose)', async () => {
    prismaMock.channel.findUnique.mockResolvedValueOnce(channelRow({ secure: true, name: 'x', server: { name: 'y' } }));
    await post().send({ content: 'secure channel path' });
    await post(`/api/v1/webhooks/${WEBHOOK_ID}/${TOKEN}%zz`).send({ content: 'malformed url path' });
    await post().send(JSON.stringify({ pad: 'p'.repeat(LIMITS.WEBHOOK_BODY_MAX_BYTES) }));
    await post().send('{bad json');
    prismaMock.webhook.updateMany.mockRejectedValueOnce(new Error('db down'));
    await post().send({ content: 'ok' });
    prismaMock.message.create.mockRejectedValueOnce(new Error('insert failed'));
    const failed = await post().send({ content: 'insert fails' });

    expect(failed.status).toBe(500);
    expect(console.warn).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
    // the afterEach hook asserts the token appears in none of these calls
  });
});
