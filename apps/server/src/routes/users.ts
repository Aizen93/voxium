import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail, requireConsent } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { validateDisplayName, validateBio, LIMITS } from '@voxium/shared';
import { broadcastProfileUpdate } from '../utils/profileBroadcast';
import { sanitizeText, sanitizeLabel } from '../utils/sanitize';
import { VALID_S3_KEY_RE, deleteFromS3 } from '../utils/s3';
import { adoptImageAssetUpload } from '../utils/uploadVerification';
import { rateLimitProfileUpdate } from '../middleware/rateLimiter';

export const userRouter = Router();

userRouter.use(authenticate, requireVerifiedEmail, requireConsent);

// Get user profile
userRouter.get('/:userId', async (req: Request<{ userId: string }>, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        bio: true,
        status: true,
        isSupporter: true, supporterTier: true,
        createdAt: true,
      },
    });

    if (!user) throw new NotFoundError('User');

    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
});

// Update own profile
// Per user: every edit fans `user:updated` out to every server room the user is in
userRouter.patch('/me/profile', rateLimitProfileUpdate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    let { avatarUrl } = req.body;
    let { displayName, bio } = req.body;

    // avatarUrl must be null (to clear) or a valid S3 key
    if (avatarUrl !== undefined && avatarUrl !== null) {
      if (typeof avatarUrl !== 'string' || !VALID_S3_KEY_RE.test(avatarUrl)) {
        throw new BadRequestError('Invalid avatar key');
      }
      // Ownership check: key must belong to this user
      if (!avatarUrl.startsWith(`avatars/${req.user!.userId}-`)) {
        throw new BadRequestError('Invalid avatar key');
      }
    }

    // Whether the request carried a display name at all: the user:updated
    // fan-out below keys on what was sent, as it always has
    const displayNameSent = displayName !== undefined;
    if (displayName !== undefined && typeof displayName !== 'string') throw new BadRequestError('displayName must be a string');

    // The stored name (and the stored avatar, for its cleanup), in one read
    const current = displayName !== undefined || avatarUrl !== undefined
      ? await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { displayName: true, avatarUrl: true },
      })
      : null;

    if (displayName !== undefined) {
      if (current != null && displayName === current.displayName) {
        // Sent unchanged: left as stored, neither judged nor rewritten. Every
        // desktop re-sends the display name with a bio save, and a name is
        // judged and stripped only when its owner changes it.
        displayName = undefined;
      } else {
        displayName = sanitizeLabel(displayName);
        const err = validateDisplayName(displayName);
        if (err) throw new BadRequestError(err);
      }
    }

    if (bio !== undefined) {
      if (typeof bio !== 'string') throw new BadRequestError('bio must be a string');
      bio = sanitizeText(bio);
      const err = validateBio(bio);
      if (err) throw new BadRequestError(err);
    }

    // The old avatar key, for its cleanup after the update
    const oldAvatarUrl: string | null = avatarUrl !== undefined ? current?.avatarUrl ?? null : null;

    // First reference of a new avatar object: the profile stores a verified
    // server-side copy (size cap, image header) under a key no upload URL was
    // issued for, never the uploaded key. The current key was adopted when it
    // was set, and is never re-read here.
    let adoptedAvatarKey: string | null = null;
    if (typeof avatarUrl === 'string' && avatarUrl !== oldAvatarUrl) {
      adoptedAvatarKey = await adoptImageAssetUpload(avatarUrl, `avatars/${req.user!.userId}-`, LIMITS.MAX_AVATAR_SIZE, 'Invalid avatar key');
      avatarUrl = adoptedAvatarKey;
    }

    let updated;
    try {
      updated = await prisma.user.update({
        where: { id: req.user!.userId },
        data: {
          ...(displayName !== undefined && { displayName }),
          ...(bio !== undefined && { bio }),
          ...(avatarUrl !== undefined && { avatarUrl }),
        },
        select: {
          id: true,
          username: true,
          displayName: true,
          email: true,
          avatarUrl: true,
          bio: true,
          status: true,
          createdAt: true,
        },
      });
    } catch (err) {
      // The profile never stored the adopted copy: nothing else will reference it
      if (adoptedAvatarKey) {
        const key = adoptedAvatarKey;
        deleteFromS3(key).catch((delErr) => console.warn(`[S3] Failed to delete unreferenced avatar copy ${key}:`, delErr instanceof Error ? delErr.message : delErr));
      }
      throw err;
    }

    // Delete old avatar from S3 after DB update confirmed
    if (avatarUrl !== undefined && oldAvatarUrl && oldAvatarUrl !== avatarUrl) {
      deleteFromS3(oldAvatarUrl).catch((err) => console.warn('[S3] Failed to delete old avatar:', err));
    }

    // Broadcast profile change to all servers the user is in
    if (displayNameSent || avatarUrl !== undefined) {
      await broadcastProfileUpdate(updated.id, { displayName: updated.displayName, avatarUrl: updated.avatarUrl });
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});
