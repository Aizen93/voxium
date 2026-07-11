import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { generateKeyPairSync, sign as cryptoSign, randomBytes } from 'node:crypto';
import { e2eDeviceCanonical, e2eKeyCanonical, E2E_LIMITS } from '@voxium/shared';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 0, emailVerified: true };
    next();
  },
  requireVerifiedEmail: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    rateLimitE2EDevice: passthrough,
    rateLimitE2EKeys: passthrough,
    rateLimitE2EBundle: passthrough,
    rateLimitE2EStatus: passthrough,
  };
});

vi.mock('../../utils/prisma', () => ({
  prisma: {
    e2EDevice: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    e2EOneTimeKey: {
      count: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    conversation: { findUnique: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

import { prisma } from '../../utils/prisma';
import { e2eRouter } from '../../routes/e2e';
import { errorHandler } from '../../middleware/errorHandler';

// ─── Real Ed25519 signing (exercises the actual verification path) ──────────

function unpadded(b64: string): string {
  return b64.replace(/=+$/, '');
}

/** A device with a real signing key — payloads pass verifyEd25519Signature. */
function makeTestDevice(userId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // raw 32-byte key = last 32 bytes of the SPKI DER
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const ed25519Key = unpadded(spki.subarray(spki.length - 32).toString('base64'));
  const curve25519Key = unpadded(randomBytes(32).toString('base64'));
  const signRaw = (message: string) =>
    unpadded(cryptoSign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64'));
  const oneTimeKey = (keyId: string) => {
    const key = unpadded(randomBytes(32).toString('base64'));
    return { keyId, key, signature: signRaw(e2eKeyCanonical(userId, curve25519Key, keyId, key)) };
  };
  return {
    curve25519Key,
    ed25519Key,
    deviceSignature: signRaw(e2eDeviceCanonical(userId, curve25519Key, ed25519Key)),
    signRaw,
    oneTimeKey,
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/e2e', e2eRouter);
  app.use(errorHandler);
  return app;
}

const mockConversation = { id: 'conv-1' };

function validRegistration(device: ReturnType<typeof makeTestDevice>) {
  return {
    curve25519Key: device.curve25519Key,
    ed25519Key: device.ed25519Key,
    deviceSignature: device.deviceSignature,
    oneTimeKeys: [device.oneTimeKey('AAAAAQ'), device.oneTimeKey('AAAAAg')],
    fallbackKey: device.oneTimeKey('AAAAAw'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(prisma));
});

// ─── PUT /devices ────────────────────────────────────────────────────────────

describe('E2E routes — PUT /devices', () => {
  it('registers a device with valid signatures', async () => {
    const device = makeTestDevice('user-1');
    vi.mocked(prisma.e2EDevice.upsert).mockResolvedValue({ id: 'dev-1', updatedAt: new Date('2026-07-11') } as any);

    const res = await request(createApp()).put('/api/v1/e2e/devices').send(validRegistration(device));

    expect(res.status).toBe(201);
    expect(res.body.data.registered).toBe(true);
    expect(res.body.data.oneTimeKeyCount).toBe(2);
    // replacing a device wipes the previous account's one-time keys
    expect(prisma.e2EOneTimeKey.deleteMany).toHaveBeenCalledWith({ where: { deviceId: 'dev-1' } });
    expect(prisma.e2EOneTimeKey.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ deviceId: 'dev-1' })]) })
    );
  });

  it('rejects a device signature that does not verify', async () => {
    const device = makeTestDevice('user-1');
    const body = validRegistration(device);
    body.deviceSignature = device.signRaw('some other payload');

    const res = await request(createApp()).put('/api/v1/e2e/devices').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a signature made by a different identity (key splicing)', async () => {
    const device = makeTestDevice('user-1');
    const impostor = makeTestDevice('user-1');
    const body = validRegistration(device);
    // signature over the right canonical but by the wrong key
    body.deviceSignature = impostor.signRaw(e2eDeviceCanonical('user-1', device.curve25519Key, device.ed25519Key));

    const res = await request(createApp()).put('/api/v1/e2e/devices').send(body);
    expect(res.status).toBe(400);
  });

  it('rejects a one-time key whose binding signature fails', async () => {
    const device = makeTestDevice('user-1');
    const body = validRegistration(device);
    body.oneTimeKeys[0] = { ...body.oneTimeKeys[0], key: unpadded(randomBytes(32).toString('base64')) };

    const res = await request(createApp()).put('/api/v1/e2e/devices').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/oneTimeKey/);
  });

  it('rejects malformed keys, missing fallback, oversized batches and duplicate key ids', async () => {
    const device = makeTestDevice('user-1');
    const app = createApp();

    const badKey = await request(app).put('/api/v1/e2e/devices').send({ ...validRegistration(device), curve25519Key: 'not-base64!!' });
    expect(badKey.status).toBe(400);

    const noFallback = { ...validRegistration(device) } as any;
    delete noFallback.fallbackKey;
    expect((await request(app).put('/api/v1/e2e/devices').send(noFallback)).status).toBe(400);

    const tooMany = {
      ...validRegistration(device),
      oneTimeKeys: Array.from({ length: E2E_LIMITS.OTK_UPLOAD_MAX + 1 }, (_, i) => device.oneTimeKey(`K${i}`)),
    };
    expect((await request(app).put('/api/v1/e2e/devices').send(tooMany)).status).toBe(400);

    const dup = device.oneTimeKey('DUP');
    const duplicated = { ...validRegistration(device), oneTimeKeys: [dup, dup] };
    expect((await request(app).put('/api/v1/e2e/devices').send(duplicated)).status).toBe(400);
  });
});

// ─── GET /devices/me & /devices/:userId ─────────────────────────────────────

describe('E2E routes — device status', () => {
  it('reports unregistered state', async () => {
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue(null);
    const res = await request(createApp()).get('/api/v1/e2e/devices/me');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ registered: false });
  });

  it('reports own key stock', async () => {
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({
      id: 'dev-1', curve25519Key: 'c', ed25519Key: 'e', fallbackKeyId: 'fk', updatedAt: new Date(),
    } as any);
    vi.mocked(prisma.e2EOneTimeKey.count).mockResolvedValue(17);
    const res = await request(createApp()).get('/api/v1/e2e/devices/me');
    expect(res.body.data.oneTimeKeyCount).toBe(17);
    expect(res.body.data.hasFallbackKey).toBe(true);
  });

  it("denies another user's device info without a shared conversation", async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(null);
    const res = await request(createApp()).get('/api/v1/e2e/devices/user-2');
    expect(res.status).toBe(403);
    expect(prisma.e2EDevice.findUnique).not.toHaveBeenCalled();
  });

  it("returns a peer's device info when a conversation exists", async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(mockConversation as any);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({
      curve25519Key: 'curve', ed25519Key: 'ed', deviceSignature: 'sig', updatedAt: new Date(),
    } as any);
    const res = await request(createApp()).get('/api/v1/e2e/devices/user-2');
    expect(res.status).toBe(200);
    expect(res.body.data.hasDevice).toBe(true);
    expect(res.body.data.curve25519Key).toBe('curve');
    // conversation lookup used the sorted composite key
    expect(prisma.conversation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user1Id_user2Id: { user1Id: 'user-1', user2Id: 'user-2' } } })
    );
  });

  it('reports hasDevice=false for peers without a device', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(mockConversation as any);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue(null);
    const res = await request(createApp()).get('/api/v1/e2e/devices/user-2');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ hasDevice: false });
  });
});

// ─── POST /devices/me/keys ───────────────────────────────────────────────────

describe('E2E routes — key replenishment', () => {
  it('requires a registered device', async () => {
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue(null);
    const res = await request(createApp()).post('/api/v1/e2e/devices/me/keys').send({ oneTimeKeys: [] });
    expect(res.status).toBe(403);
  });

  it('uploads new one-time keys after verifying their signatures', async () => {
    const device = makeTestDevice('user-1');
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({
      id: 'dev-1', curve25519Key: device.curve25519Key, ed25519Key: device.ed25519Key,
    } as any);
    vi.mocked(prisma.e2EOneTimeKey.count).mockResolvedValueOnce(10).mockResolvedValueOnce(12);

    const res = await request(createApp())
      .post('/api/v1/e2e/devices/me/keys')
      .send({ oneTimeKeys: [device.oneTimeKey('N1'), device.oneTimeKey('N2')] });

    expect(res.status).toBe(200);
    expect(res.body.data.oneTimeKeyCount).toBe(12);
    expect(prisma.e2EOneTimeKey.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
  });

  it('rejects uploads that would exceed the storage cap', async () => {
    const device = makeTestDevice('user-1');
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({
      id: 'dev-1', curve25519Key: device.curve25519Key, ed25519Key: device.ed25519Key,
    } as any);
    vi.mocked(prisma.e2EOneTimeKey.count).mockResolvedValue(E2E_LIMITS.MAX_STORED_OTKS);

    const res = await request(createApp())
      .post('/api/v1/e2e/devices/me/keys')
      .send({ oneTimeKeys: [device.oneTimeKey('N1')] });
    expect(res.status).toBe(409);
    expect(prisma.e2EOneTimeKey.createMany).not.toHaveBeenCalled();
  });

  it('rotates the fallback key', async () => {
    const device = makeTestDevice('user-1');
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({
      id: 'dev-1', curve25519Key: device.curve25519Key, ed25519Key: device.ed25519Key,
    } as any);
    vi.mocked(prisma.e2EOneTimeKey.count).mockResolvedValue(5);
    const fallback = device.oneTimeKey('FB2');

    const res = await request(createApp()).post('/api/v1/e2e/devices/me/keys').send({ fallbackKey: fallback });
    expect(res.status).toBe(200);
    expect(prisma.e2EDevice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { fallbackKeyId: fallback.keyId, fallbackKey: fallback.key, fallbackKeySignature: fallback.signature },
      })
    );
  });

  it('rejects an empty upload', async () => {
    const device = makeTestDevice('user-1');
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({
      id: 'dev-1', curve25519Key: device.curve25519Key, ed25519Key: device.ed25519Key,
    } as any);
    const res = await request(createApp()).post('/api/v1/e2e/devices/me/keys').send({});
    expect(res.status).toBe(400);
  });
});

// ─── POST /bundles/:userId ───────────────────────────────────────────────────

describe('E2E routes — bundle claim', () => {
  const deviceRow = {
    id: 'dev-2',
    curve25519Key: 'curve-2',
    ed25519Key: 'ed-2',
    deviceSignature: 'devsig-2',
    fallbackKeyId: 'fbid',
    fallbackKey: 'fbkey',
    fallbackKeySignature: 'fbsig',
  };

  it('refuses claiming a bundle for yourself', async () => {
    const res = await request(createApp()).post('/api/v1/e2e/bundles/user-1');
    expect(res.status).toBe(400);
  });

  it('requires a shared conversation', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(null);
    const res = await request(createApp()).post('/api/v1/e2e/bundles/user-2');
    expect(res.status).toBe(403);
  });

  it('404s when the target has no device', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(mockConversation as any);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue(null);
    const res = await request(createApp()).post('/api/v1/e2e/bundles/user-2');
    expect(res.status).toBe(404);
  });

  it('pops a one-time key atomically and returns it', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(mockConversation as any);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue(deviceRow as any);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ key_id: 'K1', public_key: 'PK1', signature: 'S1' }]);

    const res = await request(createApp()).post('/api/v1/e2e/bundles/user-2');
    expect(res.status).toBe(200);
    expect(res.body.data.preKey).toEqual({ keyId: 'K1', key: 'PK1', signature: 'S1', type: 'otk' });
    expect(res.body.data.curve25519Key).toBe('curve-2');
    expect(res.body.data.deviceSignature).toBe('devsig-2');
  });

  it('falls back to the fallback key when one-time keys are exhausted', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(mockConversation as any);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue(deviceRow as any);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);

    const res = await request(createApp()).post('/api/v1/e2e/bundles/user-2');
    expect(res.status).toBe(200);
    expect(res.body.data.preKey).toEqual({ keyId: 'fbid', key: 'fbkey', signature: 'fbsig', type: 'fallback' });
  });

  it('409s when neither one-time nor fallback keys exist', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(mockConversation as any);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({
      ...deviceRow, fallbackKeyId: null, fallbackKey: null, fallbackKeySignature: null,
    } as any);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);

    const res = await request(createApp()).post('/api/v1/e2e/bundles/user-2');
    expect(res.status).toBe(409);
  });
});
