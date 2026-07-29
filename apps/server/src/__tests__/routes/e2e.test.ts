import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { generateKeyPairSync, sign as cryptoSign, randomBytes } from 'node:crypto';
import { e2eDeviceCanonical, e2eKeyCanonical, E2E_LIMITS, buildE2EEnvelope, buildMegolmEnvelope } from '@voxium/shared';

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
    rateLimitE2EShares: passthrough,
  };
});

vi.mock('../../utils/prisma', () => ({
  prisma: {
    e2EDevice: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    e2EOneTimeKey: {
      count: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    e2EDeviceRegistry: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    e2EKeyShare: {
      count: vi.fn(),
      findMany: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    conversation: { findUnique: vi.fn(), findMany: vi.fn() },
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
function makeTestDevice(userId: string, deviceId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // raw 32-byte key = last 32 bytes of the SPKI DER
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const ed25519Key = unpadded(spki.subarray(spki.length - 32).toString('base64'));
  const curve25519Key = unpadded(randomBytes(32).toString('base64'));
  const signRaw = (message: string) =>
    unpadded(cryptoSign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64'));
  const oneTimeKey = (keyId: string) => {
    const key = unpadded(randomBytes(32).toString('base64'));
    return { keyId, key, signature: signRaw(e2eKeyCanonical(userId, deviceId, curve25519Key, keyId, key)) };
  };
  return {
    deviceId,
    curve25519Key,
    ed25519Key,
    // v2 canonical binds the deviceId — a signature for one device slot can
    // never be replayed into another.
    deviceSignature: signRaw(e2eDeviceCanonical(userId, deviceId, curve25519Key, ed25519Key)),
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
const DEVICE_A = 'device-aaaa1111';
const DEVICE_B = 'device-bbbb2222';

function validRegistration(device: ReturnType<typeof makeTestDevice>) {
  return {
    deviceId: device.deviceId,
    curve25519Key: device.curve25519Key,
    ed25519Key: device.ed25519Key,
    deviceSignature: device.deviceSignature,
    oneTimeKeys: [device.oneTimeKey('AAAAAQ'), device.oneTimeKey('AAAAAg')],
    fallbackKey: device.oneTimeKey('AAAAAw'),
  };
}

/** Raw rows as GET /devices returns them (Date objects, prisma-shaped). */
function deviceRow(deviceId: string, over: Record<string, unknown> = {}) {
  return {
    id: `row-${deviceId}`,
    deviceId,
    curve25519Key: `curve-${deviceId}`,
    ed25519Key: `ed-${deviceId}`,
    deviceSignature: `sig-${deviceId}`,
    createdAt: new Date('2026-07-20T00:00:00Z'),
    updatedAt: new Date('2026-07-21T00:00:00Z'),
    fallbackKeyId: 'fbid',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(prisma));
  vi.mocked(prisma.e2EDeviceRegistry.upsert).mockResolvedValue({ userId: 'user-1', version: 3 } as any);
  vi.mocked(prisma.e2EDeviceRegistry.findUnique).mockResolvedValue({ version: 7 } as any);
});

// ─── PUT /devices ────────────────────────────────────────────────────────────

describe('E2E routes — PUT /devices', () => {
  it('registers a device and bumps the device-list version', async () => {
    const device = makeTestDevice('user-1', DEVICE_A);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.e2EDevice.count).mockResolvedValue(0);
    vi.mocked(prisma.e2EDevice.upsert).mockResolvedValue({ id: 'dev-1', updatedAt: new Date('2026-07-11') } as any);

    const res = await request(createApp()).put('/api/v1/e2e/devices').send(validRegistration(device));

    expect(res.status).toBe(201);
    expect(res.body.data.registered).toBe(true);
    expect(res.body.data.deviceId).toBe(DEVICE_A);
    expect(res.body.data.oneTimeKeyCount).toBe(2);
    expect(res.body.data.listVersion).toBe(3);
    // upsert is keyed by the composite, never by userId alone
    expect(prisma.e2EDevice.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_deviceId: { userId: 'user-1', deviceId: DEVICE_A } } })
    );
    // replacing a device wipes the previous account's one-time keys
    expect(prisma.e2EOneTimeKey.deleteMany).toHaveBeenCalledWith({ where: { deviceId: 'dev-1' } });
    expect(prisma.e2EOneTimeKey.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ deviceId: 'dev-1' })]) })
    );
    // the bump runs inside the same transaction as the write
    expect(prisma.e2EDeviceRegistry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' }, update: { version: { increment: 1 } } })
    );
  });

  it('registers a SECOND device alongside the first', async () => {
    const second = makeTestDevice('user-1', DEVICE_B);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.e2EDevice.count).mockResolvedValue(1);
    vi.mocked(prisma.e2EDevice.upsert).mockResolvedValue({ id: 'dev-2', updatedAt: new Date('2026-07-12') } as any);

    const res = await request(createApp()).put('/api/v1/e2e/devices').send(validRegistration(second));

    expect(res.status).toBe(201);
    expect(res.body.data.deviceId).toBe(DEVICE_B);
    // only this device's key pool is cleared
    expect(prisma.e2EOneTimeKey.deleteMany).toHaveBeenCalledWith({ where: { deviceId: 'dev-2' } });
  });

  it('rejects a NEW device once the per-user device limit is reached', async () => {
    const device = makeTestDevice('user-1', DEVICE_B);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.e2EDevice.count).mockResolvedValue(E2E_LIMITS.MAX_DEVICES);

    const res = await request(createApp()).put('/api/v1/e2e/devices').send(validRegistration(device));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/device limit/i);
    expect(prisma.e2EDevice.upsert).not.toHaveBeenCalled();
    expect(prisma.e2EDeviceRegistry.upsert).not.toHaveBeenCalled();
  });

  it('re-registering an EXISTING device is allowed at the limit', async () => {
    const device = makeTestDevice('user-1', DEVICE_A);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({ id: 'dev-1' } as any);
    vi.mocked(prisma.e2EDevice.count).mockResolvedValue(E2E_LIMITS.MAX_DEVICES);
    vi.mocked(prisma.e2EDevice.upsert).mockResolvedValue({ id: 'dev-1', updatedAt: new Date() } as any);

    const res = await request(createApp()).put('/api/v1/e2e/devices').send(validRegistration(device));

    expect(res.status).toBe(201);
    expect(prisma.e2EDevice.count).not.toHaveBeenCalled();
  });

  it('rejects a missing or malformed deviceId', async () => {
    const device = makeTestDevice('user-1', DEVICE_A);
    const app = createApp();

    const noId = { ...validRegistration(device) } as any;
    delete noId.deviceId;
    expect((await request(app).put('/api/v1/e2e/devices').send(noId)).status).toBe(400);

    for (const bad of ['short', 'has spaces here', 'x'.repeat(33), 'bad/chars+here']) {
      const res = await request(app).put('/api/v1/e2e/devices').send({ ...validRegistration(device), deviceId: bad });
      expect(res.status).toBe(400);
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a device signature that does not verify', async () => {
    const device = makeTestDevice('user-1', DEVICE_A);
    const body = validRegistration(device);
    body.deviceSignature = device.signRaw('some other payload');

    const res = await request(createApp()).put('/api/v1/e2e/devices').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a v1-style signature that omits the deviceId (no downgrade)', async () => {
    const device = makeTestDevice('user-1', DEVICE_A);
    const body = validRegistration(device);
    // the old (v1) canonical: domain|device|userId|curve|ed
    body.deviceSignature = device.signRaw(
      `voxium-e2e-v1|device|user-1|${device.curve25519Key}|${device.ed25519Key}`
    );

    const res = await request(createApp()).put('/api/v1/e2e/devices').send(body);
    expect(res.status).toBe(400);
  });

  it('rejects a signature bound to a DIFFERENT device slot (replay across devices)', async () => {
    const device = makeTestDevice('user-1', DEVICE_A);
    const body = validRegistration(device);
    // valid signature — but over device B's canonical, uploaded as device A
    body.deviceSignature = device.signRaw(
      e2eDeviceCanonical('user-1', DEVICE_B, device.curve25519Key, device.ed25519Key)
    );

    const res = await request(createApp()).put('/api/v1/e2e/devices').send(body);
    expect(res.status).toBe(400);
  });

  it('rejects a signature made by a different identity (key splicing)', async () => {
    const device = makeTestDevice('user-1', DEVICE_A);
    const impostor = makeTestDevice('user-1', DEVICE_A);
    const body = validRegistration(device);
    body.deviceSignature = impostor.signRaw(
      e2eDeviceCanonical('user-1', DEVICE_A, device.curve25519Key, device.ed25519Key)
    );

    const res = await request(createApp()).put('/api/v1/e2e/devices').send(body);
    expect(res.status).toBe(400);
  });

  it('rejects a one-time key whose binding signature fails', async () => {
    const device = makeTestDevice('user-1', DEVICE_A);
    const body = validRegistration(device);
    body.oneTimeKeys[0] = { ...body.oneTimeKeys[0], key: unpadded(randomBytes(32).toString('base64')) };

    const res = await request(createApp()).put('/api/v1/e2e/devices').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/oneTimeKey/);
  });

  it('rejects malformed keys, missing fallback, oversized batches and duplicate key ids', async () => {
    const device = makeTestDevice('user-1', DEVICE_A);
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

describe('E2E routes — device lists', () => {
  it('lists own devices with the current list version', async () => {
    vi.mocked(prisma.e2EDevice.findMany).mockResolvedValue([deviceRow(DEVICE_A), deviceRow(DEVICE_B)] as any);

    const res = await request(createApp()).get('/api/v1/e2e/devices/me');

    expect(res.status).toBe(200);
    expect(res.body.data.registered).toBe(true);
    expect(res.body.data.listVersion).toBe(7);
    expect(res.body.data.devices).toEqual([
      {
        deviceId: DEVICE_A,
        curve25519Key: `curve-${DEVICE_A}`,
        ed25519Key: `ed-${DEVICE_A}`,
        deviceSignature: `sig-${DEVICE_A}`,
        createdAt: '2026-07-20T00:00:00.000Z',
      },
      expect.objectContaining({ deviceId: DEVICE_B }),
    ]);
    // list responses never leak private key material or fallback secrets
    expect(JSON.stringify(res.body.data.devices)).not.toContain('fbid');
  });

  it('reports unregistered state for a user with no devices', async () => {
    vi.mocked(prisma.e2EDevice.findMany).mockResolvedValue([] as any);
    const res = await request(createApp()).get('/api/v1/e2e/devices/me');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ registered: false, devices: [], listVersion: 7 });
  });

  it('reports this device key stock when ?deviceId is given', async () => {
    vi.mocked(prisma.e2EDevice.findMany).mockResolvedValue([deviceRow(DEVICE_A)] as any);
    vi.mocked(prisma.e2EOneTimeKey.count).mockResolvedValue(17);

    const res = await request(createApp()).get(`/api/v1/e2e/devices/me?deviceId=${DEVICE_A}`);

    expect(res.body.data.registered).toBe(true);
    expect(res.body.data.deviceId).toBe(DEVICE_A);
    expect(res.body.data.oneTimeKeyCount).toBe(17);
    expect(res.body.data.hasFallbackKey).toBe(true);
    expect(prisma.e2EOneTimeKey.count).toHaveBeenCalledWith({ where: { deviceId: `row-${DEVICE_A}` } });
  });

  it('reports registered=false when ?deviceId is not one of the account devices', async () => {
    vi.mocked(prisma.e2EDevice.findMany).mockResolvedValue([deviceRow(DEVICE_A)] as any);
    const res = await request(createApp()).get(`/api/v1/e2e/devices/me?deviceId=${DEVICE_B}`);
    expect(res.body.data.registered).toBe(false);
    expect(res.body.data.devices).toHaveLength(1);
    expect(prisma.e2EOneTimeKey.count).not.toHaveBeenCalled();
  });

  it('rejects a malformed ?deviceId', async () => {
    const res = await request(createApp()).get('/api/v1/e2e/devices/me?deviceId=nope');
    expect(res.status).toBe(400);
    expect(prisma.e2EDevice.findMany).not.toHaveBeenCalled();
  });

  it("denies another user's device list without a shared conversation", async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(null);
    const res = await request(createApp()).get('/api/v1/e2e/devices/user-2');
    expect(res.status).toBe(403);
    expect(prisma.e2EDevice.findMany).not.toHaveBeenCalled();
  });

  it("returns a peer's device list when a conversation exists", async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(mockConversation as any);
    vi.mocked(prisma.e2EDevice.findMany).mockResolvedValue([deviceRow(DEVICE_A)] as any);
    vi.mocked(prisma.e2EDeviceRegistry.findUnique).mockResolvedValue({ version: 4 } as any);

    const res = await request(createApp()).get('/api/v1/e2e/devices/user-2');

    expect(res.status).toBe(200);
    expect(res.body.data.listVersion).toBe(4);
    expect(res.body.data.devices).toHaveLength(1);
    expect(res.body.data.devices[0].deviceSignature).toBe(`sig-${DEVICE_A}`);
    // conversation lookup used the sorted composite key
    expect(prisma.conversation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user1Id_user2Id: { user1Id: 'user-1', user2Id: 'user-2' } } })
    );
  });

  it('returns an empty list (version 0) for peers without devices', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(mockConversation as any);
    vi.mocked(prisma.e2EDevice.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.e2EDeviceRegistry.findUnique).mockResolvedValue(null as any);

    const res = await request(createApp()).get('/api/v1/e2e/devices/user-2');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ devices: [], listVersion: 0 });
  });

  it('allows fetching your own list through the public route without a conversation', async () => {
    vi.mocked(prisma.e2EDevice.findMany).mockResolvedValue([deviceRow(DEVICE_A)] as any);
    const res = await request(createApp()).get('/api/v1/e2e/devices/user-1');
    expect(res.status).toBe(200);
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
  });
});

// ─── DELETE /devices/me/:deviceId ───────────────────────────────────────────

describe('E2E routes — device revocation', () => {
  it('revokes a device, drops its pending shares and bumps the list version', async () => {
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({ id: 'row-a' } as any);
    vi.mocked(prisma.e2EDeviceRegistry.upsert).mockResolvedValue({ version: 9 } as any);

    const res = await request(createApp()).delete(`/api/v1/e2e/devices/me/${DEVICE_A}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ revoked: true, deviceId: DEVICE_A, listVersion: 9 });
    expect(prisma.e2EDevice.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_deviceId: { userId: 'user-1', deviceId: DEVICE_A } } })
    );
    // one-time keys cascade with the row; undeliverable shares are cleaned up
    expect(prisma.e2EDevice.delete).toHaveBeenCalledWith({ where: { id: 'row-a' } });
    expect(prisma.e2EKeyShare.deleteMany).toHaveBeenCalledWith({
      where: { recipientUserId: 'user-1', recipientDeviceId: DEVICE_A },
    });
    expect(prisma.e2EDeviceRegistry.upsert).toHaveBeenCalled();
  });

  it('404s for a device the caller does not own, touching nothing', async () => {
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue(null);
    const res = await request(createApp()).delete(`/api/v1/e2e/devices/me/${DEVICE_B}`);
    expect(res.status).toBe(404);
    expect(prisma.e2EDevice.delete).not.toHaveBeenCalled();
    expect(prisma.e2EKeyShare.deleteMany).not.toHaveBeenCalled();
    expect(prisma.e2EDeviceRegistry.upsert).not.toHaveBeenCalled();
  });

  it('rejects a malformed deviceId', async () => {
    const res = await request(createApp()).delete('/api/v1/e2e/devices/me/nope');
    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ─── POST /devices/me/keys ───────────────────────────────────────────────────

describe('E2E routes — key replenishment', () => {
  it('requires a deviceId', async () => {
    const res = await request(createApp()).post('/api/v1/e2e/devices/me/keys').send({ oneTimeKeys: [] });
    expect(res.status).toBe(400);
    expect(prisma.e2EDevice.findUnique).not.toHaveBeenCalled();
  });

  it('requires a registered device', async () => {
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue(null);
    const res = await request(createApp())
      .post('/api/v1/e2e/devices/me/keys')
      .send({ deviceId: DEVICE_A, oneTimeKeys: [] });
    expect(res.status).toBe(403);
  });

  it('uploads new one-time keys after verifying their v2 signatures', async () => {
    const device = makeTestDevice('user-1', DEVICE_A);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({
      id: 'dev-1', curve25519Key: device.curve25519Key, ed25519Key: device.ed25519Key,
    } as any);
    vi.mocked(prisma.e2EOneTimeKey.count).mockResolvedValueOnce(10).mockResolvedValueOnce(12);

    const res = await request(createApp())
      .post('/api/v1/e2e/devices/me/keys')
      .send({ deviceId: DEVICE_A, oneTimeKeys: [device.oneTimeKey('N1'), device.oneTimeKey('N2')] });

    expect(res.status).toBe(200);
    expect(res.body.data.oneTimeKeyCount).toBe(12);
    expect(prisma.e2EOneTimeKey.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
  });

  it("rejects one-time keys signed for a different device slot", async () => {
    const device = makeTestDevice('user-1', DEVICE_A);
    const otherSlot = makeTestDevice('user-1', DEVICE_B);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({
      id: 'dev-1', curve25519Key: device.curve25519Key, ed25519Key: device.ed25519Key,
    } as any);

    const res = await request(createApp())
      .post('/api/v1/e2e/devices/me/keys')
      .send({ deviceId: DEVICE_A, oneTimeKeys: [otherSlot.oneTimeKey('N1')] });

    expect(res.status).toBe(400);
    expect(prisma.e2EOneTimeKey.createMany).not.toHaveBeenCalled();
  });

  it('rejects uploads that would exceed the storage cap', async () => {
    const device = makeTestDevice('user-1', DEVICE_A);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({
      id: 'dev-1', curve25519Key: device.curve25519Key, ed25519Key: device.ed25519Key,
    } as any);
    vi.mocked(prisma.e2EOneTimeKey.count).mockResolvedValue(E2E_LIMITS.MAX_STORED_OTKS);

    const res = await request(createApp())
      .post('/api/v1/e2e/devices/me/keys')
      .send({ deviceId: DEVICE_A, oneTimeKeys: [device.oneTimeKey('N1')] });
    expect(res.status).toBe(409);
    expect(prisma.e2EOneTimeKey.createMany).not.toHaveBeenCalled();
  });

  it('rotates the fallback key', async () => {
    const device = makeTestDevice('user-1', DEVICE_A);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({
      id: 'dev-1', curve25519Key: device.curve25519Key, ed25519Key: device.ed25519Key,
    } as any);
    vi.mocked(prisma.e2EOneTimeKey.count).mockResolvedValue(5);
    const fallback = device.oneTimeKey('FB2');

    const res = await request(createApp())
      .post('/api/v1/e2e/devices/me/keys')
      .send({ deviceId: DEVICE_A, fallbackKey: fallback });
    expect(res.status).toBe(200);
    expect(prisma.e2EDevice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { fallbackKeyId: fallback.keyId, fallbackKey: fallback.key, fallbackKeySignature: fallback.signature },
      })
    );
  });

  it('rejects an empty upload', async () => {
    const device = makeTestDevice('user-1', DEVICE_A);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({
      id: 'dev-1', curve25519Key: device.curve25519Key, ed25519Key: device.ed25519Key,
    } as any);
    const res = await request(createApp()).post('/api/v1/e2e/devices/me/keys').send({ deviceId: DEVICE_A });
    expect(res.status).toBe(400);
  });
});

// ─── POST /bundles/:userId/:deviceId ────────────────────────────────────────

describe('E2E routes — per-device bundle claim', () => {
  const peerDevice = {
    id: 'dev-2',
    curve25519Key: 'curve-2',
    ed25519Key: 'ed-2',
    deviceSignature: 'devsig-2',
    fallbackKeyId: 'fbid',
    fallbackKey: 'fbkey',
    fallbackKeySignature: 'fbsig',
  };

  it('requires a shared conversation', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(null);
    const res = await request(createApp()).post(`/api/v1/e2e/bundles/user-2/${DEVICE_A}`);
    expect(res.status).toBe(403);
    expect(prisma.e2EDevice.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a malformed target deviceId', async () => {
    const res = await request(createApp()).post('/api/v1/e2e/bundles/user-2/nope');
    expect(res.status).toBe(400);
  });

  it('404s when the target device does not exist', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(mockConversation as any);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue(null);
    const res = await request(createApp()).post(`/api/v1/e2e/bundles/user-2/${DEVICE_A}`);
    expect(res.status).toBe(404);
  });

  it('pops a one-time key atomically from that device pool', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(mockConversation as any);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue(peerDevice as any);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ key_id: 'K1', public_key: 'PK1', signature: 'S1' }]);

    const res = await request(createApp()).post(`/api/v1/e2e/bundles/user-2/${DEVICE_B}`);

    expect(res.status).toBe(200);
    expect(res.body.data.deviceId).toBe(DEVICE_B);
    expect(res.body.data.preKey).toEqual({ keyId: 'K1', key: 'PK1', signature: 'S1', type: 'otk' });
    expect(res.body.data.deviceSignature).toBe('devsig-2');
    expect(prisma.e2EDevice.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_deviceId: { userId: 'user-2', deviceId: DEVICE_B } } })
    );
    const sql = (vi.mocked(prisma.$queryRaw).mock.calls[0][0] as unknown as string[]).join('?');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('falls back to the fallback key when one-time keys are exhausted', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(mockConversation as any);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue(peerDevice as any);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);

    const res = await request(createApp()).post(`/api/v1/e2e/bundles/user-2/${DEVICE_B}`);
    expect(res.status).toBe(200);
    expect(res.body.data.preKey).toEqual({ keyId: 'fbid', key: 'fbkey', signature: 'fbsig', type: 'fallback' });
  });

  it('409s when neither one-time nor fallback keys exist', async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(mockConversation as any);
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({
      ...peerDevice, fallbackKeyId: null, fallbackKey: null, fallbackKeySignature: null,
    } as any);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);

    const res = await request(createApp()).post(`/api/v1/e2e/bundles/user-2/${DEVICE_B}`);
    expect(res.status).toBe(409);
  });

  it('lets a device claim a bundle for ANOTHER device of the same account (self-fanout)', async () => {
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue(peerDevice as any);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ key_id: 'K1', public_key: 'PK1', signature: 'S1' }]);

    const res = await request(createApp()).post(
      `/api/v1/e2e/bundles/user-1/${DEVICE_B}?fromDeviceId=${DEVICE_A}`
    );

    expect(res.status).toBe(200);
    // self-claims skip the conversation gate entirely
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a self-claim for the calling device itself', async () => {
    const res = await request(createApp()).post(
      `/api/v1/e2e/bundles/user-1/${DEVICE_A}?fromDeviceId=${DEVICE_A}`
    );
    expect(res.status).toBe(400);
    expect(prisma.e2EDevice.findUnique).not.toHaveBeenCalled();
  });

  it('requires fromDeviceId on a self-claim', async () => {
    const res = await request(createApp()).post(`/api/v1/e2e/bundles/user-1/${DEVICE_B}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fromDeviceId/i);
  });
});

// ─── POST /keyshares ────────────────────────────────────────────────────────

const shareBody = buildE2EEnvelope(0, 'c2Vzc2lvbktleUNpcGhlcnRleHQ');

function share(over: Record<string, unknown> = {}) {
  return {
    recipientUserId: 'user-2',
    recipientDeviceId: DEVICE_B,
    conversationId: 'conv-1',
    sessionId: 'c2Vzc2lvbklk',
    body: shareBody,
    ...over,
  };
}

describe('E2E routes — POST /keyshares', () => {
  beforeEach(() => {
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({ id: 'dev-1' } as any);
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([
      { id: 'conv-1', user1Id: 'user-1', user2Id: 'user-2' },
    ] as any);
    // Recipient-device existence check: by default every requested pair exists
    vi.mocked(prisma.e2EDevice.findMany).mockImplementation(((args: any) =>
      Promise.resolve(
        (args?.where?.OR ?? []).map((o: any) => ({ userId: o.userId, deviceId: o.deviceId }))
      )) as any);
    vi.mocked(prisma.e2EKeyShare.count).mockResolvedValue(0);
  });

  it('stores a batch of shares with truthful sender attribution', async () => {
    const res = await request(createApp())
      .post('/api/v1/e2e/keyshares')
      .send({ deviceId: DEVICE_A, shares: [share(), share({ recipientDeviceId: 'device-cccc3333' })] });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ stored: 2, evicted: 0 });
    expect(prisma.e2EKeyShare.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          recipientUserId: 'user-2',
          recipientDeviceId: DEVICE_B,
          senderUserId: 'user-1',
          senderDeviceId: DEVICE_A,
          conversationId: 'conv-1',
          sessionId: 'c2Vzc2lvbklk',
          body: shareBody,
        }),
        expect.objectContaining({ recipientDeviceId: 'device-cccc3333' }),
      ],
    });
  });

  it('rejects an unknown sender device (no forged attribution)', async () => {
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue(null);
    const res = await request(createApp())
      .post('/api/v1/e2e/keyshares')
      .send({ deviceId: DEVICE_A, shares: [share()] });
    expect(res.status).toBe(403);
    expect(prisma.e2EKeyShare.createMany).not.toHaveBeenCalled();
  });

  it('rejects recipients the sender shares no conversation with', async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([{ user1Id: 'user-1', user2Id: 'user-2' }] as any);
    const res = await request(createApp())
      .post('/api/v1/e2e/keyshares')
      .send({ deviceId: DEVICE_A, shares: [share(), share({ recipientUserId: 'user-9' })] });
    expect(res.status).toBe(403);
    expect(prisma.e2EKeyShare.createMany).not.toHaveBeenCalled();
  });

  it('allows shares addressed to your own other devices in a conversation you are in', async () => {
    const res = await request(createApp())
      .post('/api/v1/e2e/keyshares')
      .send({ deviceId: DEVICE_A, shares: [share({ recipientUserId: 'user-1' })] });
    expect(res.status).toBe(201);
  });

  it('rejects a share for a conversation the sender is not part of', async () => {
    // The gate is per-conversation: a DM peer must not be able to plant a
    // session record labelled with someone else's conversation.
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([
      { id: 'conv-other', user1Id: 'user-8', user2Id: 'user-9' },
    ] as any);
    const res = await request(createApp())
      .post('/api/v1/e2e/keyshares')
      .send({ deviceId: DEVICE_A, shares: [share({ conversationId: 'conv-other' })] });
    expect(res.status).toBe(403);
    expect(prisma.e2EKeyShare.createMany).not.toHaveBeenCalled();
  });

  it('rejects shares addressed to a device that does not exist (storage bomb)', async () => {
    // Fabricated device ids would never be claimable and never expire.
    vi.mocked(prisma.e2EDevice.findMany).mockResolvedValue([] as any);
    const res = await request(createApp())
      .post('/api/v1/e2e/keyshares')
      .send({ deviceId: DEVICE_A, shares: [share({ recipientDeviceId: 'device-ffff9999' })] });
    expect(res.status).toBe(400);
    expect(prisma.e2EKeyShare.createMany).not.toHaveBeenCalled();
  });

  it('enforces the batch cap and rejects empty batches', async () => {
    const app = createApp();
    expect((await request(app).post('/api/v1/e2e/keyshares').send({ deviceId: DEVICE_A, shares: [] })).status).toBe(400);
    expect((await request(app).post('/api/v1/e2e/keyshares').send({ deviceId: DEVICE_A })).status).toBe(400);

    const tooMany = Array.from({ length: E2E_LIMITS.KEYSHARE_BATCH_MAX + 1 }, () => share());
    const res = await request(app).post('/api/v1/e2e/keyshares').send({ deviceId: DEVICE_A, shares: tooMany });
    expect(res.status).toBe(400);
    expect(prisma.e2EKeyShare.createMany).not.toHaveBeenCalled();
  });

  it('validates every field of every share', async () => {
    const app = createApp();
    const bad = [
      share({ recipientDeviceId: 'nope' }),
      share({ recipientUserId: '' }),
      share({ conversationId: '' }),
      share({ sessionId: 'not a session id!' }),
      share({ body: 'not an envelope' }),
      // megolm bodies are not key shares — the transport is pairwise Olm
      share({ body: buildMegolmEnvelope('c2Vzc2lvbklk', 'QWJjZA') }),
      share({ body: 123 }),
    ];
    for (const s of bad) {
      const res = await request(app).post('/api/v1/e2e/keyshares').send({ deviceId: DEVICE_A, shares: [s] });
      expect(res.status).toBe(400);
    }
    expect(prisma.e2EKeyShare.createMany).not.toHaveBeenCalled();
  });

  it('requires a valid sender deviceId', async () => {
    const res = await request(createApp()).post('/api/v1/e2e/keyshares').send({ deviceId: 'x', shares: [share()] });
    expect(res.status).toBe(400);
  });

  it('evicts the oldest pending shares when a recipient inbox is full', async () => {
    vi.mocked(prisma.e2EKeyShare.count).mockResolvedValue(E2E_LIMITS.KEYSHARE_STORE_CAP_PER_SENDER);
    vi.mocked(prisma.e2EKeyShare.findMany).mockResolvedValue([{ id: 'old-1' }, { id: 'old-2' }] as any);

    const res = await request(createApp())
      .post('/api/v1/e2e/keyshares')
      .send({ deviceId: DEVICE_A, shares: [share(), share()] });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ stored: 2, evicted: 2 });
    expect(prisma.e2EKeyShare.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'asc' }, take: 2 })
    );
    expect(prisma.e2EKeyShare.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['old-1', 'old-2'] } } });
    expect(prisma.e2EKeyShare.createMany).toHaveBeenCalled();
  });

  it('scopes the inbox cap and eviction to the SENDER (no cross-sender flushing)', async () => {
    // Otherwise anyone sharing a DM with the victim could flood their inbox and
    // evict the session keys a legitimate peer had queued for them.
    vi.mocked(prisma.e2EKeyShare.count).mockResolvedValue(E2E_LIMITS.KEYSHARE_STORE_CAP_PER_SENDER);
    vi.mocked(prisma.e2EKeyShare.findMany).mockResolvedValue([{ id: 'own-old-1' }] as any);

    const res = await request(createApp())
      .post('/api/v1/e2e/keyshares')
      .send({ deviceId: DEVICE_A, shares: [share()] });

    expect(res.status).toBe(201);
    const scope = { recipientUserId: 'user-2', recipientDeviceId: DEVICE_B, senderUserId: 'user-1' };
    expect(prisma.e2EKeyShare.count).toHaveBeenCalledWith({ where: scope });
    expect(prisma.e2EKeyShare.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: scope }));
  });

  it('does not evict while the inbox has room', async () => {
    vi.mocked(prisma.e2EKeyShare.count).mockResolvedValue(E2E_LIMITS.KEYSHARE_STORE_CAP_PER_SENDER - 5);
    const res = await request(createApp())
      .post('/api/v1/e2e/keyshares')
      .send({ deviceId: DEVICE_A, shares: [share()] });
    expect(res.status).toBe(201);
    expect(res.body.data.evicted).toBe(0);
    expect(prisma.e2EKeyShare.deleteMany).not.toHaveBeenCalled();
  });
});

// ─── GET /keyshares ─────────────────────────────────────────────────────────

describe('E2E routes — GET /keyshares', () => {
  it('claims pending shares atomically and deletes them', async () => {
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({ id: 'dev-1' } as any);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      {
        id: 'ks-1',
        sender_user_id: 'user-2',
        sender_device_id: DEVICE_B,
        conversation_id: 'conv-1',
        session_id: 'c2Vzc2lvbklk',
        body: shareBody,
        created_at: new Date('2026-07-25T10:00:00Z'),
      },
    ]);

    const res = await request(createApp()).get(`/api/v1/e2e/keyshares?deviceId=${DEVICE_A}`);

    expect(res.status).toBe(200);
    expect(res.body.data.shares).toEqual([
      {
        id: 'ks-1',
        senderUserId: 'user-2',
        senderDeviceId: DEVICE_B,
        conversationId: 'conv-1',
        sessionId: 'c2Vzc2lvbklk',
        body: shareBody,
        createdAt: '2026-07-25T10:00:00.000Z',
      },
    ]);

    const call = vi.mocked(prisma.$queryRaw).mock.calls[0];
    const sql = (call[0] as unknown as string[]).join('?');
    // claim-and-delete in ONE statement: no window where two pollers both read it
    expect(sql).toContain('DELETE FROM e2e_key_shares');
    expect(sql).toContain('RETURNING');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    // scoped to the caller's own inbox and bounded
    expect(call.slice(1)).toEqual(['user-1', DEVICE_A, E2E_LIMITS.KEYSHARE_CLAIM_MAX]);
  });

  it('returns an empty list when the inbox is empty', async () => {
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue({ id: 'dev-1' } as any);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
    const res = await request(createApp()).get(`/api/v1/e2e/keyshares?deviceId=${DEVICE_A}`);
    expect(res.status).toBe(200);
    expect(res.body.data.shares).toEqual([]);
  });

  it('refuses to drain an inbox for a device the caller does not own', async () => {
    vi.mocked(prisma.e2EDevice.findUnique).mockResolvedValue(null);
    const res = await request(createApp()).get(`/api/v1/e2e/keyshares?deviceId=${DEVICE_B}`);
    expect(res.status).toBe(403);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects a malformed deviceId', async () => {
    const res = await request(createApp()).get('/api/v1/e2e/keyshares?deviceId=nope');
    expect(res.status).toBe(400);
    expect(prisma.e2EDevice.findUnique).not.toHaveBeenCalled();
  });
});
