import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail, requireConsent } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { validateCategoryName, WS_EVENTS, Permissions } from '@voxium/shared';
import type { Category, Channel } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { sanitizeText } from '../utils/sanitize';
import { rateLimitCategoryManage } from '../middleware/rateLimiter';
import { getEffectiveLimits } from '../utils/serverLimits';
import { hasServerPermission } from '../utils/permissionCalculator';
import { isSortPosition, MAX_SORT_POSITION, positionAfter } from '../utils/sortPosition';
import { retryOnTransactionConflict } from '../utils/transactionRetry';

export const categoryRouter = Router({ mergeParams: true });

categoryRouter.use(authenticate, requireVerifiedEmail, requireConsent);

/** One entry of a reorder: a category id and its new position. */
function isCategoryOrderEntry(entry: unknown): entry is { id: string; position: number } {
  if (!entry || typeof entry !== 'object') return false;
  const { id, position } = entry as Record<string, unknown>;
  return typeof id === 'string' && isSortPosition(position);
}

// Bulk reorder categories
categoryRouter.put('/reorder', rateLimitCategoryManage, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_CATEGORIES);
    if (!canManage) throw new ForbiddenError('You do not have permission to manage categories');

    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      throw new BadRequestError('order must be a non-empty array');
    }
    if (!order.every(isCategoryOrderEntry)) {
      throw new BadRequestError(`Each order entry needs a category id and a whole-number position from 0 to ${MAX_SORT_POSITION}`);
    }

    // Validate all IDs belong to this server
    const categoryIds = order.map((o: { id: string }) => o.id);
    const categories = await prisma.category.findMany({
      where: { id: { in: categoryIds }, serverId },
      select: { id: true },
    });
    if (categories.length !== categoryIds.length) {
      throw new BadRequestError('One or more category IDs do not belong to this server');
    }

    // Update positions in a transaction
    await prisma.$transaction(
      order.map((o: { id: string; position: number }) =>
        prisma.category.update({ where: { id: o.id }, data: { position: o.position } })
      )
    );

    // Re-read updated categories and emit events
    const updated = await prisma.category.findMany({
      where: { id: { in: categoryIds } },
    });
    const io = getIO();
    for (const cat of updated) {
      io.to(`server:${serverId}`).emit(WS_EVENTS.CATEGORY_UPDATED, cat as unknown as Category);
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Create a category
categoryRouter.post('/', rateLimitCategoryManage, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_CATEGORIES);
    if (!canManage) throw new ForbiddenError('You do not have permission to manage categories');

    const name = sanitizeText(req.body.name ?? '');
    const nameErr = validateCategoryName(name);
    if (nameErr) throw new BadRequestError(nameErr);

    const limits = await getEffectiveLimits(serverId);

    // Count, place and insert under the space row lock (FOR UPDATE, as a
    // channel creation takes it), so concurrent creations in one space run
    // one after the other: each counts, and places itself after, the
    // categories committed before it. The space row is the only existing row
    // this transaction locks. Run again when PostgreSQL aborts it to break a
    // deadlock.
    const category = await retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
      // A space deleted since the permission check answers as one
      const space = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM servers WHERE id = ${serverId} FOR UPDATE`;
      if (space.length === 0) throw new NotFoundError('Server');
      const { _count, _max } = await tx.category.aggregate({
        where: { serverId },
        _count: { _all: true },
        _max: { position: true },
      });
      if (_count._all >= limits.maxCategoriesPerServer) {
        throw new BadRequestError(`Server can have at most ${limits.maxCategoriesPerServer} categories`);
      }
      return tx.category.create({
        data: { name, serverId, position: positionAfter(_max.position) },
      });
    }), '[Categories] A category creation');

    getIO().to(`server:${serverId}`).emit(WS_EVENTS.CATEGORY_CREATED, category as unknown as Category);

    res.status(201).json({ success: true, data: category });
  } catch (err) {
    next(err);
  }
});

// Rename a category
categoryRouter.patch('/:categoryId', rateLimitCategoryManage, async (req: Request<{ serverId: string; categoryId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, categoryId } = req.params;

    const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_CATEGORIES);
    if (!canManage) throw new ForbiddenError('You do not have permission to manage categories');

    const category = await prisma.category.findFirst({
      where: { id: categoryId, serverId },
    });
    if (!category) throw new NotFoundError('Category');

    const name = sanitizeText(req.body.name ?? '');
    const nameErr = validateCategoryName(name);
    if (nameErr) throw new BadRequestError(nameErr);

    const updated = await prisma.category.update({
      where: { id: categoryId },
      data: { name },
    });

    getIO().to(`server:${serverId}`).emit(WS_EVENTS.CATEGORY_UPDATED, updated as unknown as Category);

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// Delete a category
categoryRouter.delete('/:categoryId', rateLimitCategoryManage, async (req: Request<{ serverId: string; categoryId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, categoryId } = req.params;

    const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_CATEGORIES);
    if (!canManage) throw new ForbiddenError('You do not have permission to manage categories');

    const category = await prisma.category.findFirst({
      where: { id: categoryId, serverId },
    });
    if (!category) throw new NotFoundError('Category');

    // Collect affected channel IDs before delete (Prisma SetNull will orphan them)
    const affectedChannelIds = (await prisma.channel.findMany({
      where: { categoryId },
      select: { id: true },
    })).map((c) => c.id);

    await prisma.category.delete({ where: { id: categoryId } });

    const io = getIO();
    io.to(`server:${serverId}`).emit(WS_EVENTS.CATEGORY_DELETED, { categoryId, serverId });

    // Re-read the orphaned channels from DB so emitted data is fresh (categoryId is now null)
    if (affectedChannelIds.length > 0) {
      const orphanedChannels = await prisma.channel.findMany({
        where: { id: { in: affectedChannelIds } },
      });
      // Per-channel room, not the server's: these carry the channel NAME, and
      // a staff-only channel orphaned by a category delete must not announce
      // itself to members who cannot view it. (The CATEGORY_DELETED above is
      // server-wide by design — a category has no per-member visibility.)
      for (const ch of orphanedChannels) {
        io.to(`channel:${ch.id}`).emit(WS_EVENTS.CHANNEL_UPDATED, ch as unknown as Channel);
      }
    }

    res.json({ success: true, message: 'Category deleted' });
  } catch (err) {
    next(err);
  }
});
