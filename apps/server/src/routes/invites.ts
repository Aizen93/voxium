import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { nanoid } from 'nanoid';
import { INVITE_CODE_LENGTH } from '@voxium/shared';

export const inviteRouter = Router();

inviteRouter.use(authenticate);

// Create an invite for a server
inviteRouter.post('/servers/:serverId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const { maxUses, expiresInHours } = req.body;

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new ForbiddenError('Not a member of this server');

    const expiresAt = expiresInHours
      ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000)
      : null;

    const invite = await prisma.invite.create({
      data: {
        code: nanoid(INVITE_CODE_LENGTH),
        serverId,
        createdBy: req.user!.userId,
        maxUses: maxUses || null,
        expiresAt,
      },
    });

    res.status(201).json({ success: true, data: invite });
  } catch (err) {
    next(err);
  }
});

// Use an invite to join a server
inviteRouter.post('/:code/join', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.params;

    const invite = await prisma.invite.findUnique({
      where: { code },
      include: { server: true },
    });

    if (!invite) throw new NotFoundError('Invite');

    if (invite.expiresAt && invite.expiresAt < new Date()) {
      throw new BadRequestError('This invite has expired');
    }

    if (invite.maxUses && invite.uses >= invite.maxUses) {
      throw new BadRequestError('This invite has reached its max uses');
    }

    const existing = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId: invite.serverId } },
    });
    if (existing) throw new BadRequestError('You are already a member of this server');

    await prisma.$transaction([
      prisma.serverMember.create({
        data: { userId: req.user!.userId, serverId: invite.serverId },
      }),
      prisma.invite.update({
        where: { code },
        data: { uses: { increment: 1 } },
      }),
    ]);

    res.json({ success: true, data: invite.server });
  } catch (err) {
    next(err);
  }
});

// Get invite info (preview)
inviteRouter.get('/:code', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.params;

    const invite = await prisma.invite.findUnique({
      where: { code },
      include: {
        server: {
          select: { id: true, name: true, iconUrl: true, _count: { select: { members: true } } },
        },
      },
    });

    if (!invite) throw new NotFoundError('Invite');

    res.json({
      success: true,
      data: {
        code: invite.code,
        server: {
          id: invite.server.id,
          name: invite.server.name,
          iconUrl: invite.server.iconUrl,
          memberCount: invite.server._count.members,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});
