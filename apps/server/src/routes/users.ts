import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { validateDisplayName, validateBio, WS_EVENTS } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { sanitizeText } from '../utils/sanitize';
import { VALID_S3_KEY_RE, deleteFromS3 } from '../utils/s3';

export const userRouter = Router();

userRouter.use(authenticate, requireVerifiedEmail);

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
userRouter.patch('/me/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { avatarUrl } = req.body;
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

    if (displayName !== undefined) {
      if (typeof displayName !== 'string') throw new BadRequestError('displayName must be a string');
      displayName = sanitizeText(displayName);
      const err = validateDisplayName(displayName);
      if (err) throw new BadRequestError(err);
    }

    if (bio !== undefined) {
      if (typeof bio !== 'string') throw new BadRequestError('bio must be a string');
      bio = sanitizeText(bio);
      const err = validateBio(bio);
      if (err) throw new BadRequestError(err);
    }

    // Fetch old avatar key before updating (for cleanup)
    let oldAvatarUrl: string | null = null;
    if (avatarUrl !== undefined) {
      const current = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { avatarUrl: true },
      });
      oldAvatarUrl = current?.avatarUrl ?? null;
    }

    const updated = await prisma.user.update({
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

    // Delete old avatar from S3 after DB update confirmed
    if (avatarUrl !== undefined && oldAvatarUrl && oldAvatarUrl !== avatarUrl) {
      deleteFromS3(oldAvatarUrl).catch((err) => console.warn('[S3] Failed to delete old avatar:', err));
    }

    // Broadcast profile change to all servers the user is in
    if (displayName !== undefined || avatarUrl !== undefined) {
      const memberships = await prisma.serverMember.findMany({
        where: { userId: req.user!.userId },
        select: { serverId: true },
      });
      const io = getIO();
      const payload = { userId: updated.id, displayName: updated.displayName, avatarUrl: updated.avatarUrl };
      for (const { serverId } of memberships) {
        io.to(`server:${serverId}`).emit(WS_EVENTS.USER_UPDATED, payload);
      }
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});
