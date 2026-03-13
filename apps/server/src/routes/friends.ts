import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import { rateLimitFriendRequest } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { getIO } from '../websocket/socketServer';
import type { Friendship as FriendshipType, FriendUser } from '@voxium/shared';

export const friendRouter = Router();

friendRouter.use(authenticate, requireVerifiedEmail);

const userSelect = {
  select: { id: true, username: true, displayName: true, avatarUrl: true, status: true },
};

/** Map a DB friendship + the other user into the API shape */
function toFriendship(
  f: { id: string; requesterId: string; addresseeId: string; status: string; createdAt: Date },
  otherUser: FriendUser,
): FriendshipType {
  return {
    id: f.id,
    requesterId: f.requesterId,
    addresseeId: f.addresseeId,
    status: f.status as FriendshipType['status'],
    createdAt: f.createdAt.toISOString(),
    user: otherUser,
  };
}

// ─── List all friendships ────────────────────────────────────────────────────

friendRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;

    const friendships = await prisma.friendship.findMany({
      where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
      include: {
        requester: userSelect,
        addressee: userSelect,
      },
      orderBy: { createdAt: 'desc' },
    });

    const data: FriendshipType[] = friendships.map((f) => {
      const otherUser = f.requesterId === userId ? f.addressee : f.requester;
      return toFriendship(f, otherUser as FriendUser);
    });

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// ─── Send friend request ─────────────────────────────────────────────────────

friendRouter.post('/request', rateLimitFriendRequest, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { username } = req.body;

    if (!username || typeof username !== 'string') {
      throw new BadRequestError('username is required');
    }

    // Find target user (case-insensitive)
    const targetUser = await prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: { id: true, username: true, displayName: true, avatarUrl: true, status: true },
    });
    if (!targetUser) throw new NotFoundError('User');
    if (targetUser.id === userId) throw new BadRequestError('Cannot send friend request to yourself');

    // Check existing friendships in both directions
    const existing = await prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: userId, addresseeId: targetUser.id },
          { requesterId: targetUser.id, addresseeId: userId },
        ],
      },
      include: {
        requester: userSelect,
        addressee: userSelect,
      },
    });

    if (existing) {
      if (existing.status === 'accepted') {
        throw new ConflictError('Already friends');
      }

      // Pending from target → auto-accept
      if (existing.requesterId === targetUser.id && existing.addresseeId === userId) {
        const updated = await prisma.friendship.update({
          where: { id: existing.id },
          data: { status: 'accepted' },
          include: {
            requester: userSelect,
            addressee: userSelect,
          },
        });

        const currentUser = updated.addressee; // me
        const otherUser = updated.requester;    // target

        // Emit accepted to both parties
        const io = getIO();
        const sockets = await io.fetchSockets();
        for (const s of sockets) {
          if (s.data.userId === targetUser.id) {
            s.emit('friend:request_accepted', {
              friendship: toFriendship(updated, currentUser as FriendUser),
            });
          }
        }

        res.json({
          success: true,
          data: toFriendship(updated, otherUser as FriendUser),
          message: 'Friend request auto-accepted',
        });
        return;
      }

      // Pending from me → already sent
      throw new ConflictError('Friend request already sent');
    }

    // Create new pending request
    const friendship = await prisma.friendship.create({
      data: {
        requesterId: userId,
        addresseeId: targetUser.id,
        status: 'pending',
      },
      include: {
        requester: userSelect,
        addressee: userSelect,
      },
    });

    const currentUser = friendship.requester; // me

    // Emit to target user
    const io = getIO();
    const sockets = await io.fetchSockets();
    for (const s of sockets) {
      if (s.data.userId === targetUser.id) {
        s.emit('friend:request_received', {
          friendship: toFriendship(friendship, currentUser as FriendUser),
        });
      }
    }

    res.status(201).json({
      success: true,
      data: toFriendship(friendship, targetUser as FriendUser),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Accept friend request ───────────────────────────────────────────────────

friendRouter.post('/:friendshipId/accept', async (req: Request<{ friendshipId: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { friendshipId } = req.params;

    const friendship = await prisma.friendship.findUnique({
      where: { id: friendshipId },
    });
    if (!friendship) throw new NotFoundError('Friendship');
    if (friendship.addresseeId !== userId) throw new ForbiddenError('Only the addressee can accept a friend request');
    if (friendship.status !== 'pending') throw new BadRequestError('This request is not pending');

    const updated = await prisma.friendship.update({
      where: { id: friendshipId },
      data: { status: 'accepted' },
      include: {
        requester: userSelect,
        addressee: userSelect,
      },
    });

    const currentUser = updated.addressee; // me
    const otherUser = updated.requester;

    // Emit to requester
    const io = getIO();
    const sockets = await io.fetchSockets();
    for (const s of sockets) {
      if (s.data.userId === otherUser.id) {
        s.emit('friend:request_accepted', {
          friendship: toFriendship(updated, currentUser as FriendUser),
        });
      }
    }

    res.json({
      success: true,
      data: toFriendship(updated, otherUser as FriendUser),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Remove / cancel / decline friendship ────────────────────────────────────

friendRouter.delete('/:friendshipId', async (req: Request<{ friendshipId: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { friendshipId } = req.params;

    const friendship = await prisma.friendship.findUnique({
      where: { id: friendshipId },
    });
    if (!friendship) throw new NotFoundError('Friendship');
    if (friendship.requesterId !== userId && friendship.addresseeId !== userId) {
      throw new ForbiddenError('Not part of this friendship');
    }

    const otherUserId = friendship.requesterId === userId ? friendship.addresseeId : friendship.requesterId;

    await prisma.friendship.delete({ where: { id: friendshipId } });

    // Notify the other user so their UI updates in real-time
    const io = getIO();
    const sockets = await io.fetchSockets();
    for (const s of sockets) {
      if (s.data.userId === otherUserId) {
        s.emit('friend:removed', { userId });
      }
    }

    res.json({ success: true, message: 'Friendship removed' });
  } catch (err) {
    next(err);
  }
});

// ─── Check friendship status with a user ─────────────────────────────────────

friendRouter.get('/status/:userId', async (req: Request<{ userId: string }>, res: Response, next: NextFunction) => {
  try {
    const currentUserId = req.user!.userId;
    const { userId: targetUserId } = req.params;

    const friendship = await prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: currentUserId, addresseeId: targetUserId },
          { requesterId: targetUserId, addresseeId: currentUserId },
        ],
      },
    });

    if (!friendship) {
      res.json({ success: true, data: { status: 'none', friendshipId: null } });
      return;
    }

    let status: string;
    if (friendship.status === 'accepted') {
      status = 'friends';
    } else if (friendship.requesterId === currentUserId) {
      status = 'pending_outgoing';
    } else {
      status = 'pending_incoming';
    }

    res.json({ success: true, data: { status, friendshipId: friendship.id } });
  } catch (err) {
    next(err);
  }
});
