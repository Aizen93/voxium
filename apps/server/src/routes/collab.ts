import { Router, type Request, type Response, type NextFunction } from 'express';
import * as Y from 'yjs';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { rateLimitCollabDoc } from '../middleware/rateLimiter';
import { hasChannelPermission, hasServerPermission } from '../utils/permissionCalculator';
import { Permissions, CODE_LANGUAGES, WS_EVENTS } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { collabDocs, canvasSnapshots } from '../websocket/collabHandler';

export const collabRouter = Router({ mergeParams: true });

collabRouter.use(authenticate, requireVerifiedEmail);

// GET /channels/:channelId/document — Get the Yjs document snapshot for initial hydration
collabRouter.get('/', rateLimitCollabDoc, async (req: Request<{ channelId: string }>, res: Response, next: NextFunction) => {
  try {
    const { channelId } = req.params;

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { type: true, serverId: true },
    });
    if (!channel) throw new NotFoundError('Channel');
    if (channel.type !== 'canvas' && channel.type !== 'code') {
      throw new BadRequestError('Channel is not a collaborative channel');
    }

    const canView = await hasChannelPermission(req.user!.userId, channelId, channel.serverId, Permissions.VIEW_CHANNEL);
    if (!canView) throw new ForbiddenError('No permission to view this channel');

    const doc = await prisma.channelDocument.findUnique({
      where: { channelId },
      select: { language: true, updatedAt: true },
    });

    res.json({
      success: true,
      data: {
        channelId,
        language: doc?.language ?? null,
        updatedAt: doc?.updatedAt?.toISOString() ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// PUT /channels/:channelId/document/language — Update the code language (code channels only)
collabRouter.put('/language', rateLimitCollabDoc, async (req: Request<{ channelId: string }>, res: Response, next: NextFunction) => {
  try {
    const { channelId } = req.params;
    const { language } = req.body;

    if (typeof language !== 'string' || !(CODE_LANGUAGES as readonly string[]).includes(language)) {
      throw new BadRequestError(`Language must be one of: ${CODE_LANGUAGES.join(', ')}`);
    }

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { type: true, serverId: true },
    });
    if (!channel) throw new NotFoundError('Channel');
    if (channel.type !== 'code') throw new BadRequestError('Only code channels have a language setting');

    const canManage = await hasServerPermission(req.user!.userId, channel.serverId, Permissions.MANAGE_CHANNELS);
    if (!canManage) throw new ForbiddenError('No permission to manage this channel');

    await prisma.channelDocument.update({
      where: { channelId },
      data: { language },
    });

    // Broadcast language change to collab room
    getIO().to(`collab:${channelId}`).emit('collab:language_changed', { channelId, language });

    res.json({ success: true, data: { channelId, language } });
  } catch (err) {
    next(err);
  }
});

// POST /channels/:channelId/document/reset — Reset a collaborative document (admin)
collabRouter.post('/reset', rateLimitCollabDoc, async (req: Request<{ channelId: string }>, res: Response, next: NextFunction) => {
  try {
    const { channelId } = req.params;

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { type: true, serverId: true },
    });
    if (!channel) throw new NotFoundError('Channel');
    if (channel.type !== 'canvas' && channel.type !== 'code') {
      throw new BadRequestError('Channel is not a collaborative channel');
    }

    const canManage = await hasServerPermission(req.user!.userId, channel.serverId, Permissions.MANAGE_CHANNELS);
    if (!canManage) throw new ForbiddenError('No permission to manage this channel');

    // Reset the DB snapshot
    await prisma.channelDocument.update({
      where: { channelId },
      data: { snapshot: null },
    });

    // Reset the in-memory doc/snapshot if it exists
    const cachedDoc = collabDocs.get(channelId);
    if (cachedDoc) {
      cachedDoc.doc.destroy();
      collabDocs.delete(channelId);
    }
    canvasSnapshots.delete(channelId);

    // Broadcast a fresh empty state to all connected clients
    if (channel.type === 'code') {
      const freshDoc = new Y.Doc();
      const emptyState = Buffer.from(Y.encodeStateAsUpdate(freshDoc)).toString('base64');
      freshDoc.destroy();
      getIO().to(`collab:${channelId}`).emit('collab:sync', { channelId, update: emptyState });
    } else {
      // Canvas: send an empty JSON array as base64
      const emptyCanvas = Buffer.from('[]').toString('base64');
      getIO().to(`collab:${channelId}`).emit('collab:sync', { channelId, update: emptyCanvas });
    }

    res.json({ success: true, message: 'Document reset' });
  } catch (err) {
    next(err);
  }
});
