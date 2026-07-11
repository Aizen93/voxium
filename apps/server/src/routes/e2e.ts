import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import {
  rateLimitE2EDevice,
  rateLimitE2EKeys,
  rateLimitE2EBundle,
  rateLimitE2EStatus,
} from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import {
  E2E_KEY_B64_RE,
  E2E_KEY_ID_B64_RE,
  E2E_SIGNATURE_B64_RE,
  E2E_LIMITS,
  e2eDeviceCanonical,
  e2eKeyCanonical,
  type E2EPreKey,
} from '@voxium/shared';
import { verifyEd25519Signature } from '../utils/e2eVerify';

// Key distribution for E2E DMs (docs/e2e-dm-spec.md §4–§5). The server is an
// untrusted directory: it stores public keys and hands out one-shot bundles.
// Signatures are verified here as upload hygiene, but clients re-verify
// everything before establishing a session — server compromise must never be
// able to silently swap keys without the peer's safety number changing.

export const e2eRouter = Router();

e2eRouter.use(authenticate, requireVerifiedEmail);

interface RawPreKey {
  keyId?: unknown;
  key?: unknown;
  signature?: unknown;
}

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

/** Verify a pre-key's binding signature against the device identity. */
function verifyPreKeySignature(
  k: E2EPreKey,
  userId: string,
  curve25519Key: string,
  ed25519Key: string,
  label: string
): void {
  if (!verifyEd25519Signature(ed25519Key, e2eKeyCanonical(userId, curve25519Key, k.keyId, k.key), k.signature)) {
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

// ─── Register / replace own device ───────────────────────────────────────────

e2eRouter.put('/devices', rateLimitE2EDevice, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { curve25519Key, ed25519Key, deviceSignature, oneTimeKeys, fallbackKey } = req.body ?? {};

    if (typeof curve25519Key !== 'string' || !E2E_KEY_B64_RE.test(curve25519Key)) {
      throw new BadRequestError('Invalid curve25519Key');
    }
    if (typeof ed25519Key !== 'string' || !E2E_KEY_B64_RE.test(ed25519Key)) {
      throw new BadRequestError('Invalid ed25519Key');
    }
    if (typeof deviceSignature !== 'string' || !E2E_SIGNATURE_B64_RE.test(deviceSignature)) {
      throw new BadRequestError('Invalid deviceSignature');
    }
    if (!verifyEd25519Signature(ed25519Key, e2eDeviceCanonical(userId, curve25519Key, ed25519Key), deviceSignature)) {
      throw new BadRequestError('Device signature verification failed');
    }

    if (!Array.isArray(oneTimeKeys) || oneTimeKeys.length === 0 || oneTimeKeys.length > E2E_LIMITS.OTK_UPLOAD_MAX) {
      throw new BadRequestError(`oneTimeKeys must contain 1–${E2E_LIMITS.OTK_UPLOAD_MAX} keys`);
    }
    for (const k of oneTimeKeys) {
      validatePreKeyShape(k, 'oneTimeKey');
      verifyPreKeySignature(k, userId, curve25519Key, ed25519Key, 'oneTimeKey');
    }
    const keyIds = new Set(oneTimeKeys.map((k: E2EPreKey) => k.keyId));
    if (keyIds.size !== oneTimeKeys.length) throw new BadRequestError('Duplicate oneTimeKey keyIds');

    validatePreKeyShape(fallbackKey, 'fallbackKey');
    verifyPreKeySignature(fallbackKey, userId, curve25519Key, ed25519Key, 'fallbackKey');

    // Replacing a device invalidates all previously published one-time keys —
    // they belong to the old Olm account and can never establish a session.
    const device = await prisma.$transaction(async (tx) => {
      const upserted = await tx.e2EDevice.upsert({
        where: { userId },
        create: {
          userId,
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
      return upserted;
    });

    res.status(201).json({
      success: true,
      data: { registered: true, oneTimeKeyCount: oneTimeKeys.length, updatedAt: device.updatedAt.toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Own device status (registered BEFORE /devices/:userId — route order) ────

e2eRouter.get('/devices/me', rateLimitE2EStatus, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const device = await prisma.e2EDevice.findUnique({
      where: { userId },
      select: { id: true, curve25519Key: true, ed25519Key: true, fallbackKeyId: true, updatedAt: true },
    });
    if (!device) {
      res.json({ success: true, data: { registered: false } });
      return;
    }
    const oneTimeKeyCount = await prisma.e2EOneTimeKey.count({ where: { deviceId: device.id } });
    res.json({
      success: true,
      data: {
        registered: true,
        curve25519Key: device.curve25519Key,
        ed25519Key: device.ed25519Key,
        oneTimeKeyCount,
        hasFallbackKey: device.fallbackKeyId !== null,
        updatedAt: device.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Public device info (identity pinning / "can this user do E2E?") ─────────

e2eRouter.get('/devices/:userId', rateLimitE2EStatus, async (req: Request<{ userId: string }>, res: Response, next: NextFunction) => {
  try {
    const requesterId = req.user!.userId;
    const targetUserId = req.params.userId;
    if (targetUserId !== requesterId) {
      await assertSharesConversation(requesterId, targetUserId);
    }

    const device = await prisma.e2EDevice.findUnique({
      where: { userId: targetUserId },
      select: { curve25519Key: true, ed25519Key: true, deviceSignature: true, updatedAt: true },
    });
    if (!device) {
      res.json({ success: true, data: { hasDevice: false } });
      return;
    }
    res.json({
      success: true,
      data: {
        hasDevice: true,
        userId: targetUserId,
        curve25519Key: device.curve25519Key,
        ed25519Key: device.ed25519Key,
        deviceSignature: device.deviceSignature,
        updatedAt: device.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Replenish one-time keys / rotate fallback key ───────────────────────────

e2eRouter.post('/devices/me/keys', rateLimitE2EKeys, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { oneTimeKeys, fallbackKey } = req.body ?? {};

    const device = await prisma.e2EDevice.findUnique({
      where: { userId },
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
        verifyPreKeySignature(k, userId, device.curve25519Key, device.ed25519Key, 'oneTimeKey');
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
      verifyPreKeySignature(fallbackKey, userId, device.curve25519Key, device.ed25519Key, 'fallbackKey');
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

// ─── Claim a key bundle (consumes one OTK — hence POST) ──────────────────────

e2eRouter.post('/bundles/:userId', rateLimitE2EBundle, async (req: Request<{ userId: string }>, res: Response, next: NextFunction) => {
  try {
    const requesterId = req.user!.userId;
    const targetUserId = req.params.userId;
    if (targetUserId === requesterId) throw new BadRequestError('Cannot claim a bundle for yourself');
    await assertSharesConversation(requesterId, targetUserId);

    const device = await prisma.e2EDevice.findUnique({
      where: { userId: targetUserId },
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
      throw new ConflictError('No keys available for this user');
    }

    res.json({
      success: true,
      data: {
        userId: targetUserId,
        curve25519Key: device.curve25519Key,
        ed25519Key: device.ed25519Key,
        deviceSignature: device.deviceSignature,
        preKey,
      },
    });
  } catch (err) {
    next(err);
  }
});
