import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail, requireConsent } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import crypto from 'crypto';
import { INVITE_CODE_LENGTH, Permissions } from '@voxium/shared';
import { isFeatureEnabled } from '../utils/featureFlags';
import { hasServerPermission } from '../utils/permissionCalculator';
import { joinServerMember } from '../utils/serverJoin';

export const inviteRouter = Router();

inviteRouter.use(authenticate, requireVerifiedEmail, requireConsent);

// Create an invite for a server
inviteRouter.post('/servers/:serverId', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    if (!isFeatureEnabled('invites')) throw new ForbiddenError('Server invites are currently disabled');
    const { serverId } = req.params;

    const canInvite = await hasServerPermission(req.user!.userId, serverId, Permissions.CREATE_INVITES);
    if (!canInvite) throw new ForbiddenError('You do not have permission to create invites');

    const server = await prisma.server.findUnique({ where: { id: serverId }, select: { invitesLocked: true } });
    if (server?.invitesLocked) throw new ForbiddenError('Invites are locked for this server');

    const invite = await prisma.invite.create({
      data: {
        code: crypto.randomBytes(INVITE_CODE_LENGTH).toString('base64url').slice(0, INVITE_CODE_LENGTH),
        serverId,
        createdBy: req.user!.userId,
      },
    });

    res.status(201).json({ success: true, data: invite });
  } catch (err) {
    next(err);
  }
});

// Use an invite to join a server
inviteRouter.post('/:code/join', async (req: Request<{ code: string }>, res: Response, next: NextFunction) => {
  try {
    if (!isFeatureEnabled('invites')) throw new ForbiddenError('Server invites are currently disabled');
    const { code } = req.params;

    const invite = await prisma.invite.findUnique({
      where: { code },
      include: { server: true },
    });

    if (!invite) throw new NotFoundError('Invite');
    if (invite.server.invitesLocked) throw new ForbiddenError('Invites are locked for this server');

    if (invite.expiresAt && invite.expiresAt < new Date()) {
      await prisma.invite.delete({ where: { code } });
      throw new BadRequestError('This invite has expired');
    }

    // The join sequence (ban check, duplicate check, member limit, the
    // membership + count transaction, the room invariant, ChannelRead
    // seeding) lives in joinServerMember. The invite delete rides in its
    // transaction as the extra write: a single-use invite that was consumed
    // between the lookup above and here finds no row, the transaction fails,
    // and no membership is created.
    try {
      await joinServerMember(req.user!.userId, invite.serverId, {
        via: 'invite',
        extraWrites: [prisma.invite.delete({ where: { code } })],
      });
    } catch (err) {
      // P2025 = the delete found no row: the invite was already consumed.
      if ((err as { code?: unknown })?.code === 'P2025') throw new NotFoundError('Invite');
      throw err;
    }

    res.json({ success: true, data: invite.server });
  } catch (err) {
    next(err);
  }
});

// Get invite info (preview)
inviteRouter.get('/:code', async (req: Request<{ code: string }>, res: Response, next: NextFunction) => {
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

    if (invite.expiresAt && invite.expiresAt < new Date()) {
      await prisma.invite.delete({ where: { code } });
      throw new BadRequestError('This invite has expired');
    }

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
