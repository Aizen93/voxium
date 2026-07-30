import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import {
  rateLimitE2EDevice,
  rateLimitE2EKeys,
  rateLimitE2EBundle,
  rateLimitE2EStatus,
  rateLimitE2EShares,
  rateLimitE2EApprove,
} from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import {
  E2E_KEY_B64_RE,
  E2E_KEY_ID_B64_RE,
  E2E_SIGNATURE_B64_RE,
  E2E_DEVICE_ID_RE,
  E2E_SESSION_ID_B64_RE,
  E2E_ENGINE_OLM1,
  E2E_LIMITS,
  e2eDeviceCanonical,
  e2eDeviceCrossCanonical,
  e2eKeyCanonical,
  e2eMasterCanonical,
  parseE2EEnvelope,
  type E2EPreKey,
} from '@voxium/shared';
import { verifyEd25519Signature } from '../utils/e2eVerify';

// Key distribution for E2E DMs (docs/e2e-dm-spec.md §4–§5, §12). The server is
// an untrusted directory: it stores public keys, hands out one-shot bundles and
// relays opaque group-session key shares. Signatures are verified here as
// upload hygiene, but clients re-verify everything before establishing a
// session — server compromise must never be able to silently swap keys without
// the peer's safety number changing.
//
// Multi-device: a user has up to E2E_LIMITS.MAX_DEVICES devices, each with its
// own identity, own one-time-key pool and own inbox of pending key shares.
// Every add/revoke bumps E2EDeviceRegistry.version so peers notice membership
// changes and rotate their outbound group session.
//
// Cross-signing (spec §14): each account also publishes ONE Ed25519 master key
// (self-signed, proving possession) which signs each of its devices. Peers then
// verify one account-level safety number instead of one per device. The server
// verifies every signature it stores — hygiene only, exactly like §4.2 — and
// relays opaque master-secret handoffs between a user's OWN devices.

export const e2eRouter = Router();

e2eRouter.use(authenticate, requireVerifiedEmail);

interface RawPreKey {
  keyId?: unknown;
  key?: unknown;
  signature?: unknown;
}

/** Minimal transaction surface used by the handlers below (also satisfied by the mock in tests). */
type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Structural validation of an uploaded pre-key (shape + encodings only). */
function validatePreKeyShape(k: RawPreKey | null | undefined, label: string): asserts k is E2EPreKey {
  if (!k || typeof k !== 'object') throw new BadRequestError(`${label} is required`);
  if (typeof k.keyId !== 'string' || !E2E_KEY_ID_B64_RE.test(k.keyId)) {
    throw new BadRequestError(`${label}: invalid keyId`);
  }
  if (typeof k.key !== 'string' || !E2E_KEY_B64_RE.test(k.key)) {
    throw new BadRequestError(`${label}: invalid key`);
  }
  if (typeof k.signature !== 'string' || !E2E_SIGNATURE_B64_RE.test(k.signature)) {
    throw new BadRequestError(`${label}: invalid signature`);
  }
}

/** Client-generated device id — validated on every path that accepts one. */
function validateDeviceId(value: unknown, label = 'deviceId'): string {
  if (typeof value !== 'string' || !E2E_DEVICE_ID_RE.test(value)) {
    throw new BadRequestError(`Invalid ${label}`);
  }
  return value;
}

/** Verify a pre-key's binding signature against the device identity. */
function verifyPreKeySignature(
  k: E2EPreKey,
  userId: string,
  deviceId: string,
  curve25519Key: string,
  ed25519Key: string,
  label: string
): void {
  if (
    !verifyEd25519Signature(
      ed25519Key,
      e2eKeyCanonical(userId, deviceId, curve25519Key, k.keyId, k.key),
      k.signature
    )
  ) {
    throw new BadRequestError(`${label}: signature verification failed`);
  }
}

/** Participants may only fetch key material of users they share a DM with. */
async function assertSharesConversation(requesterId: string, targetUserId: string): Promise<void> {
  const [user1Id, user2Id] = requesterId < targetUserId ? [requesterId, targetUserId] : [targetUserId, requesterId];
  const conversation = await prisma.conversation.findUnique({
    where: { user1Id_user2Id: { user1Id, user2Id } },
    select: { id: true },
  });
  if (!conversation) {
    throw new ForbiddenError('No conversation with this user');
  }
}

/**
 * Bump the user's device-list version. MUST run inside the same transaction as
 * the add/revoke that caused it — peers key their rotation decision off this
 * number, so a bump that lands without the device change (or vice versa) would
 * either leak messages to a revoked device or silently skip a new one.
 */
async function bumpDeviceListVersion(tx: TxClient, userId: string): Promise<number> {
  const registry = await tx.e2EDeviceRegistry.upsert({
    where: { userId },
    create: { userId, version: 1 },
    update: { version: { increment: 1 } },
  });
  return registry.version;
}

async function getDeviceListVersion(userId: string): Promise<number> {
  const registry = await prisma.e2EDeviceRegistry.findUnique({
    where: { userId },
    select: { version: true },
  });
  return registry?.version ?? 0;
}

interface DeviceRow {
  deviceId: string;
  curve25519Key: string;
  ed25519Key: string;
  deviceSignature: string;
  /** Cross-signature by the account master key; null for un-approved devices. */
  masterSignature?: string | null;
  createdAt: Date;
}

function serializeDevice(d: DeviceRow) {
  return {
    deviceId: d.deviceId,
    curve25519Key: d.curve25519Key,
    ed25519Key: d.ed25519Key,
    deviceSignature: d.deviceSignature,
    // Devices registered before cross-signing carry no signature at all — they
    // must serialize as an explicit null, not vanish from the payload.
    masterSignature: d.masterSignature ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}

/** Device columns every list endpoint returns (cross-signature included). */
const DEVICE_LIST_SELECT = {
  deviceId: true,
  curve25519Key: true,
  ed25519Key: true,
  deviceSignature: true,
  masterSignature: true,
  createdAt: true,
} as const;

/** The account-level master key pair, or nulls when cross-signing is unused. */
async function getMasterKeyInfo(userId: string): Promise<{ masterKey: string | null; masterSignature: string | null }> {
  const row = await prisma.e2EMasterKey.findUnique({
    where: { userId },
    select: { publicKey: true, signature: true },
  });
  return { masterKey: row?.publicKey ?? null, masterSignature: row?.signature ?? null };
}

// ─── Register / replace one of your devices ──────────────────────────────────

e2eRouter.put('/devices', rateLimitE2EDevice, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { deviceId, curve25519Key, ed25519Key, deviceSignature, oneTimeKeys, fallbackKey } = req.body ?? {};

    validateDeviceId(deviceId);
    if (typeof curve25519Key !== 'string' || !E2E_KEY_B64_RE.test(curve25519Key)) {
      throw new BadRequestError('Invalid curve25519Key');
    }
    if (typeof ed25519Key !== 'string' || !E2E_KEY_B64_RE.test(ed25519Key)) {
      throw new BadRequestError('Invalid ed25519Key');
    }
    if (typeof deviceSignature !== 'string' || !E2E_SIGNATURE_B64_RE.test(deviceSignature)) {
      throw new BadRequestError('Invalid deviceSignature');
    }
    if (
      !verifyEd25519Signature(
        ed25519Key,
        e2eDeviceCanonical(userId, deviceId, curve25519Key, ed25519Key),
        deviceSignature
      )
    ) {
      throw new BadRequestError('Device signature verification failed');
    }

    if (!Array.isArray(oneTimeKeys) || oneTimeKeys.length === 0 || oneTimeKeys.length > E2E_LIMITS.OTK_UPLOAD_MAX) {
      throw new BadRequestError(`oneTimeKeys must contain 1–${E2E_LIMITS.OTK_UPLOAD_MAX} keys`);
    }
    for (const k of oneTimeKeys) {
      validatePreKeyShape(k, 'oneTimeKey');
      verifyPreKeySignature(k, userId, deviceId, curve25519Key, ed25519Key, 'oneTimeKey');
    }
    const keyIds = new Set(oneTimeKeys.map((k: E2EPreKey) => k.keyId));
    if (keyIds.size !== oneTimeKeys.length) throw new BadRequestError('Duplicate oneTimeKey keyIds');

    validatePreKeyShape(fallbackKey, 'fallbackKey');
    verifyPreKeySignature(fallbackKey, userId, deviceId, curve25519Key, ed25519Key, 'fallbackKey');

    // Re-registering a deviceId replaces its identity, which invalidates every
    // previously published one-time key (they belong to the old Olm account)
    // and is a device-list change as far as peers are concerned.
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.e2EDevice.findUnique({
        where: { userId_deviceId: { userId, deviceId } },
        select: { id: true },
      });
      if (!existing) {
        const deviceCount = await tx.e2EDevice.count({ where: { userId } });
        if (deviceCount >= E2E_LIMITS.MAX_DEVICES) {
          throw new ConflictError(`Device limit reached (${E2E_LIMITS.MAX_DEVICES}) — revoke a device first`);
        }
      }

      const upserted = await tx.e2EDevice.upsert({
        where: { userId_deviceId: { userId, deviceId } },
        create: {
          userId,
          deviceId,
          curve25519Key,
          ed25519Key,
          deviceSignature,
          fallbackKeyId: fallbackKey.keyId,
          fallbackKey: fallbackKey.key,
          fallbackKeySignature: fallbackKey.signature,
        },
        update: {
          curve25519Key,
          ed25519Key,
          deviceSignature,
          // Re-registering mints new identity keys, so any existing master
          // signature covers keys that no longer exist. Clients already reject
          // it (the canonical binds both public keys); drop it server-side too
          // rather than keep serving material we know is dead.
          masterSignature: null,
          fallbackKeyId: fallbackKey.keyId,
          fallbackKey: fallbackKey.key,
          fallbackKeySignature: fallbackKey.signature,
        },
      });
      await tx.e2EOneTimeKey.deleteMany({ where: { deviceId: upserted.id } });
      await tx.e2EOneTimeKey.createMany({
        data: (oneTimeKeys as E2EPreKey[]).map((k) => ({
          deviceId: upserted.id,
          keyId: k.keyId,
          publicKey: k.key,
          signature: k.signature,
        })),
      });
      const listVersion = await bumpDeviceListVersion(tx, userId);
      return { updatedAt: upserted.updatedAt, listVersion };
    });

    res.status(201).json({
      success: true,
      data: {
        registered: true,
        deviceId,
        oneTimeKeyCount: oneTimeKeys.length,
        listVersion: result.listVersion,
        updatedAt: result.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Own devices (registered BEFORE /devices/:userId — route order) ──────────

e2eRouter.get('/devices/me', rateLimitE2EStatus, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const rawDeviceId = req.query.deviceId;
    const deviceId = rawDeviceId === undefined ? null : validateDeviceId(rawDeviceId);

    const devices = await prisma.e2EDevice.findMany({
      where: { userId },
      select: {
        ...DEVICE_LIST_SELECT,
        id: true,
        fallbackKeyId: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const listVersion = await getDeviceListVersion(userId);
    const master = await getMasterKeyInfo(userId);

    const base = {
      devices: devices.map(serializeDevice),
      listVersion,
      ...master,
    };

    if (!deviceId) {
      res.json({ success: true, data: { registered: devices.length > 0, ...base } });
      return;
    }

    const self = devices.find((d) => d.deviceId === deviceId);
    if (!self) {
      res.json({ success: true, data: { registered: false, ...base } });
      return;
    }
    const oneTimeKeyCount = await prisma.e2EOneTimeKey.count({ where: { deviceId: self.id } });
    res.json({
      success: true,
      data: {
        registered: true,
        deviceId: self.deviceId,
        curve25519Key: self.curve25519Key,
        ed25519Key: self.ed25519Key,
        oneTimeKeyCount,
        hasFallbackKey: self.fallbackKeyId !== null,
        updatedAt: self.updatedAt.toISOString(),
        ...base,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Revoke one of your own devices ──────────────────────────────────────────

e2eRouter.delete(
  '/devices/me/:deviceId',
  rateLimitE2EDevice,
  async (req: Request<{ deviceId: string }>, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const deviceId = validateDeviceId(req.params.deviceId);

      const listVersion = await prisma.$transaction(async (tx) => {
        const device = await tx.e2EDevice.findUnique({
          where: { userId_deviceId: { userId, deviceId } },
          select: { id: true },
        });
        if (!device) throw new NotFoundError('E2E device');

        // Cascades the device's one-time keys; pending key shares addressed to
        // it can never be decrypted again, so they are dropped here rather than
        // left to rot in the recipient inbox.
        await tx.e2EDevice.delete({ where: { id: device.id } });
        await tx.e2EKeyShare.deleteMany({ where: { recipientUserId: userId, recipientDeviceId: deviceId } });
        // Same reasoning for a pending master-secret handoff addressed to it:
        // the Olm session it was encrypted to is gone with the device.
        await tx.e2EMasterTransfer.deleteMany({ where: { userId, recipientDeviceId: deviceId } });
        return bumpDeviceListVersion(tx, userId);
      });

      res.json({ success: true, data: { revoked: true, deviceId, listVersion } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Public device list (identity pinning / rotation triggers) ───────────────

e2eRouter.get('/devices/:userId', rateLimitE2EStatus, async (req: Request<{ userId: string }>, res: Response, next: NextFunction) => {
  try {
    const requesterId = req.user!.userId;
    const targetUserId = req.params.userId;
    if (targetUserId !== requesterId) {
      await assertSharesConversation(requesterId, targetUserId);
    }

    const devices = await prisma.e2EDevice.findMany({
      where: { userId: targetUserId },
      select: DEVICE_LIST_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    const listVersion = await getDeviceListVersion(targetUserId);
    // The account master key travels with the list: the client verifies its
    // self-signature, pins it (TOFU), then checks each device's cross-signature
    // against it — one account-level trust decision instead of one per device.
    const master = await getMasterKeyInfo(targetUserId);

    res.json({
      success: true,
      data: { devices: devices.map(serializeDevice), listVersion, ...master },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Cross-signing: publish the account master key (spec §14) ────────────────
// Upsert of the caller's own master key plus, optionally, cross-signatures for
// devices the caller just approved — one transaction, one registry bump, so a
// peer can never observe a master key without the signatures minted under it.

interface RawDeviceSignature {
  deviceId?: unknown;
  signature?: unknown;
}

function validateSignatureB64(value: unknown, label: string): string {
  if (typeof value !== 'string' || !E2E_SIGNATURE_B64_RE.test(value)) {
    throw new BadRequestError(`Invalid ${label}`);
  }
  return value;
}

e2eRouter.put('/master-key', rateLimitE2EApprove, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { masterKey, masterSignature, deviceSignatures } = req.body ?? {};

    if (typeof masterKey !== 'string' || !E2E_KEY_B64_RE.test(masterKey)) {
      throw new BadRequestError('Invalid masterKey');
    }
    validateSignatureB64(masterSignature, 'masterSignature');
    // Self-signature: proves the publisher holds the private half, so the
    // server never stores a master key nobody can sign with.
    if (!verifyEd25519Signature(masterKey, e2eMasterCanonical(userId, masterKey), masterSignature)) {
      throw new BadRequestError('Master key signature verification failed');
    }

    let pending: Array<{ deviceId: string; signature: string }> = [];
    if (deviceSignatures !== undefined) {
      if (!Array.isArray(deviceSignatures) || deviceSignatures.length > E2E_LIMITS.MAX_DEVICES) {
        throw new BadRequestError(`deviceSignatures must contain at most ${E2E_LIMITS.MAX_DEVICES} entries`);
      }
      pending = (deviceSignatures as RawDeviceSignature[]).map((entry, i) => {
        if (!entry || typeof entry !== 'object') throw new BadRequestError(`deviceSignatures[${i}]: invalid entry`);
        return {
          deviceId: validateDeviceId(entry.deviceId, `deviceSignatures[${i}].deviceId`),
          signature: validateSignatureB64(entry.signature, `deviceSignatures[${i}].signature`),
        };
      });
      const unique = new Set(pending.map((p) => p.deviceId));
      if (unique.size !== pending.length) throw new BadRequestError('Duplicate deviceSignatures entries');
    }

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.e2EMasterKey.findUnique({ where: { userId }, select: { publicKey: true } });
      const replacing = existing !== null && existing !== undefined && existing.publicKey !== masterKey;

      const saved = await tx.e2EMasterKey.upsert({
        where: { userId },
        create: { userId, publicKey: masterKey, signature: masterSignature },
        update: { publicKey: masterKey, signature: masterSignature },
      });

      // Replacing the master key is an account identity change: every stored
      // cross-signature was made by the OLD key and would fail verification on
      // every client anyway. Clear them rather than serve known-dead data.
      if (replacing) {
        await tx.e2EDevice.updateMany({ where: { userId }, data: { masterSignature: null } });
      }

      let signed = 0;
      if (pending.length > 0) {
        // Read the identities INSIDE the transaction: a device re-registered
        // concurrently must not end up with a signature over its old keys.
        const devices = await tx.e2EDevice.findMany({
          where: { userId, deviceId: { in: pending.map((p) => p.deviceId) } },
          select: { id: true, deviceId: true, curve25519Key: true, ed25519Key: true },
        });
        const byDeviceId = new Map(devices.map((d) => [d.deviceId, d]));
        for (const entry of pending) {
          const device = byDeviceId.get(entry.deviceId);
          if (!device) throw new BadRequestError(`Unknown device in deviceSignatures: ${entry.deviceId}`);
          if (
            !verifyEd25519Signature(
              masterKey,
              e2eDeviceCrossCanonical(userId, device.deviceId, device.curve25519Key, device.ed25519Key),
              entry.signature
            )
          ) {
            // One bad signature rejects the whole request — a partially applied
            // batch would publish a device as "approved" without proof.
            throw new BadRequestError(`Device cross-signature verification failed: ${entry.deviceId}`);
          }
          await tx.e2EDevice.update({ where: { id: device.id }, data: { masterSignature: entry.signature } });
          signed++;
        }
      }

      const listVersion = await bumpDeviceListVersion(tx, userId);
      return { listVersion, signed, updatedAt: saved.updatedAt };
    });

    res.json({
      success: true,
      data: {
        masterKey,
        masterSignature,
        signedDevices: result.signed,
        listVersion: result.listVersion,
        updatedAt: result.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Cross-signing: approve one of your own devices ──────────────────────────

e2eRouter.post(
  '/devices/:deviceId/signature',
  rateLimitE2EApprove,
  async (req: Request<{ deviceId: string }>, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const deviceId = validateDeviceId(req.params.deviceId);
      const signature = validateSignatureB64((req.body ?? {}).signature, 'signature');

      const listVersion = await prisma.$transaction(async (tx) => {
        // Composite lookup: you can only sign your OWN devices.
        const device = await tx.e2EDevice.findUnique({
          where: { userId_deviceId: { userId, deviceId } },
          select: { id: true, curve25519Key: true, ed25519Key: true },
        });
        if (!device) throw new NotFoundError('E2E device');

        const master = await tx.e2EMasterKey.findUnique({ where: { userId }, select: { publicKey: true } });
        if (!master) throw new ConflictError('No master key published');

        if (
          !verifyEd25519Signature(
            master.publicKey,
            e2eDeviceCrossCanonical(userId, deviceId, device.curve25519Key, device.ed25519Key),
            signature
          )
        ) {
          throw new BadRequestError('Device cross-signature verification failed');
        }

        await tx.e2EDevice.update({ where: { id: device.id }, data: { masterSignature: signature } });
        // Peers must re-fetch: a device that just became trusted changes the
        // warning state of the list even though membership did not change.
        return bumpDeviceListVersion(tx, userId);
      });

      res.json({ success: true, data: { deviceId, signed: true, listVersion } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Replenish one-time keys / rotate fallback key (per device) ──────────────

e2eRouter.post('/devices/me/keys', rateLimitE2EKeys, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { deviceId, oneTimeKeys, fallbackKey } = req.body ?? {};
    validateDeviceId(deviceId);

    const device = await prisma.e2EDevice.findUnique({
      where: { userId_deviceId: { userId, deviceId } },
      select: { id: true, curve25519Key: true, ed25519Key: true },
    });
    if (!device) throw new ForbiddenError('No E2E device registered');

    if (oneTimeKeys === undefined && fallbackKey === undefined) {
      throw new BadRequestError('Nothing to upload');
    }

    if (oneTimeKeys !== undefined) {
      if (!Array.isArray(oneTimeKeys) || oneTimeKeys.length === 0 || oneTimeKeys.length > E2E_LIMITS.OTK_UPLOAD_MAX) {
        throw new BadRequestError(`oneTimeKeys must contain 1–${E2E_LIMITS.OTK_UPLOAD_MAX} keys`);
      }
      for (const k of oneTimeKeys) {
        validatePreKeyShape(k, 'oneTimeKey');
        verifyPreKeySignature(k, userId, deviceId, device.curve25519Key, device.ed25519Key, 'oneTimeKey');
      }
      const existing = await prisma.e2EOneTimeKey.count({ where: { deviceId: device.id } });
      if (existing + oneTimeKeys.length > E2E_LIMITS.MAX_STORED_OTKS) {
        throw new ConflictError(`Key storage full (${existing}/${E2E_LIMITS.MAX_STORED_OTKS})`);
      }
      await prisma.e2EOneTimeKey.createMany({
        data: (oneTimeKeys as E2EPreKey[]).map((k) => ({
          deviceId: device.id,
          keyId: k.keyId,
          publicKey: k.key,
          signature: k.signature,
        })),
        skipDuplicates: true,
      });
    }

    if (fallbackKey !== undefined) {
      validatePreKeyShape(fallbackKey, 'fallbackKey');
      verifyPreKeySignature(fallbackKey, userId, deviceId, device.curve25519Key, device.ed25519Key, 'fallbackKey');
      await prisma.e2EDevice.update({
        where: { id: device.id },
        data: {
          fallbackKeyId: fallbackKey.keyId,
          fallbackKey: fallbackKey.key,
          fallbackKeySignature: fallbackKey.signature,
        },
      });
    }

    const oneTimeKeyCount = await prisma.e2EOneTimeKey.count({ where: { deviceId: device.id } });
    res.json({ success: true, data: { oneTimeKeyCount } });
  } catch (err) {
    next(err);
  }
});

// ─── Claim a key bundle for ONE device (consumes an OTK — hence POST) ────────

e2eRouter.post(
  '/bundles/:userId/:deviceId',
  rateLimitE2EBundle,
  async (req: Request<{ userId: string; deviceId: string }>, res: Response, next: NextFunction) => {
    try {
      const requesterId = req.user!.userId;
      const targetUserId = req.params.userId;
      const targetDeviceId = validateDeviceId(req.params.deviceId);

      if (targetUserId === requesterId) {
        // Self-fanout: a device needs Olm sessions with the account's OTHER
        // devices to share group-session keys with them. Claiming a bundle for
        // the calling device itself is always a mistake (it would burn an OTK
        // and yield a session with yourself), so the caller identifies itself.
        const fromDeviceId = validateDeviceId(req.query.fromDeviceId, 'fromDeviceId');
        if (fromDeviceId === targetDeviceId) {
          throw new BadRequestError('Cannot claim a bundle for your own current device');
        }
      } else {
        await assertSharesConversation(requesterId, targetUserId);
      }

      const device = await prisma.e2EDevice.findUnique({
        where: { userId_deviceId: { userId: targetUserId, deviceId: targetDeviceId } },
        select: {
          id: true,
          curve25519Key: true,
          ed25519Key: true,
          deviceSignature: true,
          fallbackKeyId: true,
          fallbackKey: true,
          fallbackKeySignature: true,
        },
      });
      if (!device) throw new NotFoundError('E2E device');

      // Atomically pop the oldest one-time key. SKIP LOCKED keeps concurrent
      // claims from ever receiving the same key (one-time means one-time).
      const popped = await prisma.$queryRaw<Array<{ key_id: string; public_key: string; signature: string }>>`
        DELETE FROM e2e_one_time_keys
        WHERE id = (
          SELECT id FROM e2e_one_time_keys
          WHERE device_id = ${device.id}
          ORDER BY created_at, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING key_id, public_key, signature
      `;

      let preKey: { keyId: string; key: string; signature: string; type: 'otk' | 'fallback' };
      if (popped.length > 0) {
        preKey = { keyId: popped[0].key_id, key: popped[0].public_key, signature: popped[0].signature, type: 'otk' };
      } else if (device.fallbackKeyId && device.fallbackKey && device.fallbackKeySignature) {
        // OTKs exhausted — hand out the (reusable) fallback key rather than
        // making the conversation unestablishable.
        preKey = { keyId: device.fallbackKeyId, key: device.fallbackKey, signature: device.fallbackKeySignature, type: 'fallback' };
      } else {
        throw new ConflictError('No keys available for this device');
      }

      res.json({
        success: true,
        data: {
          userId: targetUserId,
          deviceId: targetDeviceId,
          curve25519Key: device.curve25519Key,
          ed25519Key: device.ed25519Key,
          deviceSignature: device.deviceSignature,
          preKey,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Group-session key shares (spec §12) ─────────────────────────────────────
// Opaque pairwise-Olm ciphertexts routed to a specific recipient device. The
// server can drop or duplicate them (clients recover by re-requesting a
// rotation) but can never read them.

interface RawShare {
  recipientUserId?: unknown;
  recipientDeviceId?: unknown;
  conversationId?: unknown;
  sessionId?: unknown;
  body?: unknown;
}

interface ValidShare {
  recipientUserId: string;
  recipientDeviceId: string;
  conversationId: string;
  sessionId: string;
  body: string;
}

const ID_MAX = 64;

function validateShare(raw: RawShare, index: number): ValidShare {
  const at = `shares[${index}]`;
  if (!raw || typeof raw !== 'object') throw new BadRequestError(`${at}: invalid share`);
  if (typeof raw.recipientUserId !== 'string' || raw.recipientUserId.length === 0 || raw.recipientUserId.length > ID_MAX) {
    throw new BadRequestError(`${at}: invalid recipientUserId`);
  }
  const recipientDeviceId = validateDeviceId(raw.recipientDeviceId, `${at}.recipientDeviceId`);
  if (typeof raw.conversationId !== 'string' || raw.conversationId.length === 0 || raw.conversationId.length > ID_MAX) {
    throw new BadRequestError(`${at}: invalid conversationId`);
  }
  if (typeof raw.sessionId !== 'string' || !E2E_SESSION_ID_B64_RE.test(raw.sessionId)) {
    throw new BadRequestError(`${at}: invalid sessionId`);
  }
  // The body must be a well-formed pairwise-Olm envelope: never sanitized,
  // never inspected beyond its structure. It is also size-capped well below
  // ENVELOPE_MAX — a real Olm key share is ~600 bytes, and this mailbox is
  // writable by anyone who shares a conversation with the recipient.
  if (typeof raw.body !== 'string' || raw.body.length > E2E_LIMITS.KEYSHARE_BODY_MAX) {
    throw new BadRequestError(`${at}: key share body too large`);
  }
  const envelope = parseE2EEnvelope(raw.body);
  if (!envelope || envelope.e !== E2E_ENGINE_OLM1) {
    throw new BadRequestError(`${at}: invalid body envelope`);
  }
  return {
    recipientUserId: raw.recipientUserId,
    recipientDeviceId,
    conversationId: raw.conversationId,
    sessionId: raw.sessionId,
    body: raw.body as string,
  };
}

e2eRouter.post('/keyshares', rateLimitE2EShares, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const senderUserId = req.user!.userId;
    const { deviceId, shares } = req.body ?? {};
    const senderDeviceId = validateDeviceId(deviceId);

    if (!Array.isArray(shares) || shares.length === 0 || shares.length > E2E_LIMITS.KEYSHARE_BATCH_MAX) {
      throw new BadRequestError(`shares must contain 1–${E2E_LIMITS.KEYSHARE_BATCH_MAX} entries`);
    }
    const valid = (shares as RawShare[]).map(validateShare);

    // Attribution must be truthful: the sender device has to be one of ours.
    const senderDevice = await prisma.e2EDevice.findUnique({
      where: { userId_deviceId: { userId: senderUserId, deviceId: senderDeviceId } },
      select: { id: true },
    });
    if (!senderDevice) throw new ForbiddenError('Unknown sender device');

    // Gate every share on the conversation it claims to belong to: the sender
    // must be a participant, and the recipient must be the sender (their own
    // other device) or the other participant. This also stops a DM peer from
    // planting session records labelled with a conversation they are not in.
    const conversationIds = [...new Set(valid.map((s) => s.conversationId))];
    const conversations = await prisma.conversation.findMany({
      where: { id: { in: conversationIds } },
      select: { id: true, user1Id: true, user2Id: true },
    });
    const convById = new Map(conversations.map((c) => [c.id, c]));
    for (const share of valid) {
      const conv = convById.get(share.conversationId);
      if (!conv || (conv.user1Id !== senderUserId && conv.user2Id !== senderUserId)) {
        throw new ForbiddenError('Not a participant of this conversation');
      }
      const other = conv.user1Id === senderUserId ? conv.user2Id : conv.user1Id;
      if (share.recipientUserId !== senderUserId && share.recipientUserId !== other) {
        throw new ForbiddenError('Recipient is not a participant of this conversation');
      }
    }

    // Recipient devices must actually exist. Without this, anyone could fill
    // the table with rows addressed to fabricated device ids: never claimable,
    // never expiring, and (under a per-recipient cap) able to evict a victim's
    // real session keys.
    const recipientKey = (userId: string, deviceId: string) => `${userId}\u0000${deviceId}`;
    const targets = new Map<string, { recipientUserId: string; recipientDeviceId: string; incoming: number }>();
    for (const s of valid) {
      const key = recipientKey(s.recipientUserId, s.recipientDeviceId);
      const entry = targets.get(key);
      if (entry) entry.incoming++;
      else targets.set(key, { recipientUserId: s.recipientUserId, recipientDeviceId: s.recipientDeviceId, incoming: 1 });
    }

    // The inbox cap is scoped per (sender, recipient device) and evicts only
    // the SENDER'S own oldest rows: one sender must never be able to push
    // another sender's still-needed session keys out of a victim's inbox.
    // With the recipient-device existence check above, total storage is
    // bounded by (conversations x recipient devices x cap).
    const evicted = await prisma.$transaction(async (tx) => {
      // Inside the transaction: a device revoked concurrently must not leave
      // orphaned rows behind (revocation deletes that device's shares).
      const knownDevices = await tx.e2EDevice.findMany({
        where: {
          OR: [...targets.values()].map((t) => ({ userId: t.recipientUserId, deviceId: t.recipientDeviceId })),
        },
        select: { userId: true, deviceId: true },
      });
      const knownSet = new Set(knownDevices.map((d) => recipientKey(d.userId, d.deviceId)));
      for (const key of targets.keys()) {
        if (!knownSet.has(key)) throw new BadRequestError('Unknown recipient device');
      }

      // Global per-sender ceiling. The per-recipient cap alone is not a bound:
      // any account can open a DM with any user (no friendship required), so
      // "conversations" is attacker-chosen.
      const senderTotal = await tx.e2EKeyShare.count({ where: { senderUserId } });
      if (senderTotal + valid.length > E2E_LIMITS.KEYSHARE_SENDER_TOTAL_CAP) {
        throw new ConflictError('Too many undelivered key shares — retry once recipients come online');
      }

      let evictedCount = 0;
      for (const { recipientUserId, recipientDeviceId, incoming } of targets.values()) {
        const scope = { recipientUserId, recipientDeviceId, senderUserId };
        const existing = await tx.e2EKeyShare.count({ where: scope });
        const overflow = existing + incoming - E2E_LIMITS.KEYSHARE_STORE_CAP_PER_SENDER;
        if (overflow > 0) {
          const stale = await tx.e2EKeyShare.findMany({
            where: scope,
            select: { id: true },
            orderBy: { createdAt: 'asc' },
            take: overflow,
          });
          if (stale.length > 0) {
            await tx.e2EKeyShare.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
            evictedCount += stale.length;
          }
        }
      }
      await tx.e2EKeyShare.createMany({
        data: valid.map((s) => ({
          recipientUserId: s.recipientUserId,
          recipientDeviceId: s.recipientDeviceId,
          senderUserId,
          senderDeviceId,
          conversationId: s.conversationId,
          sessionId: s.sessionId,
          body: s.body,
        })),
      });
      return evictedCount;
    });

    res.status(201).json({ success: true, data: { stored: valid.length, evicted } });
  } catch (err) {
    next(err);
  }
});

e2eRouter.get('/keyshares', rateLimitE2EShares, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const deviceId = validateDeviceId(req.query.deviceId);

    // A device inbox may only be drained by the account that owns the device.
    const device = await prisma.e2EDevice.findUnique({
      where: { userId_deviceId: { userId, deviceId } },
      select: { id: true },
    });
    if (!device) throw new ForbiddenError('Unknown device');

    // Claim-and-delete in one statement: Olm pre-key bodies are one-shot, so a
    // share handed to two concurrent pollers would decrypt at most once.
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        sender_user_id: string;
        sender_device_id: string;
        conversation_id: string;
        session_id: string;
        body: string;
        created_at: Date;
      }>
    >`
      DELETE FROM e2e_key_shares
      WHERE id IN (
        SELECT id FROM e2e_key_shares
        WHERE recipient_user_id = ${userId} AND recipient_device_id = ${deviceId}
        ORDER BY created_at, id
        LIMIT ${E2E_LIMITS.KEYSHARE_CLAIM_MAX}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, sender_user_id, sender_device_id, conversation_id, session_id, body, created_at
    `;

    res.json({
      success: true,
      data: {
        shares: rows.map((r) => ({
          id: r.id,
          senderUserId: r.sender_user_id,
          senderDeviceId: r.sender_device_id,
          conversationId: r.conversation_id,
          sessionId: r.session_id,
          body: r.body,
          createdAt: new Date(r.created_at).toISOString(),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Master-secret transfers (device approval, spec §14) ─────────────────────
// SELF ONLY: the recipient user is always the caller, so there is no
// recipientUserId in the payload and no cross-user form of this route at all.
// A dedicated mailbox rather than the key-share one — those rows are
// conversation/session scoped and their eviction policy is sender-scoped.

interface RawTransfer {
  recipientDeviceId?: unknown;
  body?: unknown;
}

function validateTransfer(raw: RawTransfer, index: number): { recipientDeviceId: string; body: string } {
  const at = `transfers[${index}]`;
  if (!raw || typeof raw !== 'object') throw new BadRequestError(`${at}: invalid transfer`);
  const recipientDeviceId = validateDeviceId(raw.recipientDeviceId, `${at}.recipientDeviceId`);
  if (typeof raw.body !== 'string' || raw.body.length > E2E_LIMITS.KEYSHARE_BODY_MAX) {
    throw new BadRequestError(`${at}: transfer body too large`);
  }
  // Opaque pairwise-Olm ciphertext: never sanitized, only structurally checked.
  const envelope = parseE2EEnvelope(raw.body);
  if (!envelope || envelope.e !== E2E_ENGINE_OLM1) {
    throw new BadRequestError(`${at}: invalid body envelope`);
  }
  return { recipientDeviceId, body: raw.body };
}

e2eRouter.post('/master-transfers', rateLimitE2EShares, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { deviceId, transfers } = req.body ?? {};
    const senderDeviceId = validateDeviceId(deviceId);

    if (!Array.isArray(transfers) || transfers.length === 0 || transfers.length > E2E_LIMITS.MASTER_TRANSFER_BATCH_MAX) {
      throw new BadRequestError(`transfers must contain 1–${E2E_LIMITS.MASTER_TRANSFER_BATCH_MAX} entries`);
    }
    const valid = (transfers as RawTransfer[]).map(validateTransfer);

    // Attribution must be truthful: the sending device has to be one of ours.
    const senderDevice = await prisma.e2EDevice.findUnique({
      where: { userId_deviceId: { userId, deviceId: senderDeviceId } },
      select: { id: true },
    });
    if (!senderDevice) throw new ForbiddenError('Unknown sender device');

    const targets = new Map<string, number>();
    for (const t of valid) {
      if (t.recipientDeviceId === senderDeviceId) {
        throw new BadRequestError('Cannot transfer the master secret to the sending device');
      }
      targets.set(t.recipientDeviceId, (targets.get(t.recipientDeviceId) ?? 0) + 1);
    }

    const evicted = await prisma.$transaction(async (tx) => {
      // Recipient devices must exist AND belong to the caller — this is the
      // only ownership boundary the mailbox has, so it runs inside the
      // transaction (a device revoked concurrently leaves no orphan rows).
      const known = await tx.e2EDevice.findMany({
        where: { userId, deviceId: { in: [...targets.keys()] } },
        select: { deviceId: true },
      });
      const knownSet = new Set(known.map((d) => d.deviceId));
      for (const recipientDeviceId of targets.keys()) {
        if (!knownSet.has(recipientDeviceId)) throw new BadRequestError('Unknown recipient device');
      }

      let evictedCount = 0;
      for (const [recipientDeviceId, incoming] of targets) {
        const scope = { userId, recipientDeviceId };
        const existing = await tx.e2EMasterTransfer.count({ where: scope });
        const overflow = existing + incoming - E2E_LIMITS.MASTER_TRANSFER_STORE_CAP;
        if (overflow > 0) {
          const stale = await tx.e2EMasterTransfer.findMany({
            where: scope,
            select: { id: true },
            orderBy: { createdAt: 'asc' },
            take: overflow,
          });
          if (stale.length > 0) {
            await tx.e2EMasterTransfer.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
            evictedCount += stale.length;
          }
        }
      }

      await tx.e2EMasterTransfer.createMany({
        data: valid.map((t) => ({
          userId,
          recipientDeviceId: t.recipientDeviceId,
          senderDeviceId,
          body: t.body,
        })),
      });
      return evictedCount;
    });

    res.status(201).json({ success: true, data: { stored: valid.length, evicted } });
  } catch (err) {
    next(err);
  }
});

e2eRouter.get('/master-transfers', rateLimitE2EShares, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const deviceId = validateDeviceId(req.query.deviceId);

    // A device inbox may only be drained by the account that owns the device.
    const device = await prisma.e2EDevice.findUnique({
      where: { userId_deviceId: { userId, deviceId } },
      select: { id: true },
    });
    if (!device) throw new ForbiddenError('Unknown device');

    // Claim-and-delete in one statement — the body is an Olm pre-key message,
    // decryptable exactly once, so it must never be handed to two pollers.
    const rows = await prisma.$queryRaw<
      Array<{ id: string; sender_device_id: string; body: string; created_at: Date }>
    >`
      DELETE FROM e2e_master_transfers
      WHERE id IN (
        SELECT id FROM e2e_master_transfers
        WHERE user_id = ${userId} AND recipient_device_id = ${deviceId}
        ORDER BY created_at, id
        LIMIT ${E2E_LIMITS.MASTER_TRANSFER_STORE_CAP}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, sender_device_id, body, created_at
    `;

    res.json({
      success: true,
      data: {
        transfers: rows.map((r) => ({
          id: r.id,
          senderDeviceId: r.sender_device_id,
          body: r.body,
          createdAt: new Date(r.created_at).toISOString(),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});
