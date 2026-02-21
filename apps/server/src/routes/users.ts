import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { NotFoundError } from '../utils/errors';

export const userRouter = Router();

userRouter.use(authenticate);

// Get user profile
userRouter.get('/:userId', async (req: Request, res: Response, next: NextFunction) => {
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
    const { displayName, bio, avatarUrl } = req.body;

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

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});
