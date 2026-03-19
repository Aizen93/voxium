import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import {
  validateRoleName,
  validateRoleColor,
  LIMITS,
  WS_EVENTS,
  Permissions,
  DEFAULT_EVERYONE_PERMISSIONS,
  permissionsFromString,
  permissionsToString,
  ALL_PERMISSIONS,
} from '@voxium/shared';
import type { Role, ChannelPermissionOverride, MemberRole } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { sanitizeText } from '../utils/sanitize';
import { rateLimitRoleManage } from '../middleware/rateLimiter';
import { hasServerPermission, getHighestRolePosition, getEffectivePermissions } from '../utils/permissionCalculator';

export const roleRouter = Router({ mergeParams: true });

roleRouter.use(authenticate, requireVerifiedEmail);

// List all roles in a server
roleRouter.get('/', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new NotFoundError('Server');

    const roles = await prisma.role.findMany({
      where: { serverId },
      orderBy: { position: 'asc' },
    });

    res.json({ success: true, data: roles });
  } catch (err) {
    next(err);
  }
});

// Reorder roles (bulk position update) — MUST be before /:roleId to avoid treating "reorder" as a param
roleRouter.put('/reorder', rateLimitRoleManage, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_ROLES);
    if (!canManage) throw new ForbiddenError('You do not have permission to manage roles');

    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      throw new BadRequestError('order must be a non-empty array');
    }

    const actorHighest = await getHighestRolePosition(req.user!.userId, serverId);

    // Validate all role IDs belong to this server and are below actor's position
    const roleIds = order.map((o: { id: string }) => o.id);
    const roles = await prisma.role.findMany({
      where: { id: { in: roleIds }, serverId },
      select: { id: true, position: true, isDefault: true },
    });
    if (roles.length !== roleIds.length) {
      throw new BadRequestError('One or more role IDs do not belong to this server');
    }

    // Check that actor can reorder these roles (all must be below their position)
    if (actorHighest !== Infinity) {
      for (const r of roles) {
        if (r.position >= actorHighest) {
          throw new ForbiddenError('Cannot reorder roles at or above your own position');
        }
      }
    }

    // @everyone must stay at position 0, and no role can be moved above actor's position
    for (const o of order) {
      const r = roles.find((role) => role.id === o.id);
      if (r?.isDefault && o.position !== 0) {
        throw new BadRequestError('The @everyone role must stay at position 0');
      }
      if (actorHighest !== Infinity && !r?.isDefault && o.position >= actorHighest) {
        throw new ForbiddenError('Cannot set a role position at or above your own');
      }
    }

    // Validate no duplicate positions
    const positions = order.map((o: { position: number }) => o.position);
    if (new Set(positions).size !== positions.length) {
      throw new BadRequestError('Role positions must be unique');
    }

    await prisma.$transaction(
      order.map((o: { id: string; position: number }) =>
        prisma.role.update({ where: { id: o.id }, data: { position: o.position } })
      )
    );

    const updated = await prisma.role.findMany({
      where: { serverId },
      orderBy: { position: 'asc' },
      select: { id: true, position: true },
    });

    getIO().to(`server:${serverId}`).emit(WS_EVENTS.ROLE_REORDERED, {
      serverId,
      roles: updated,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Create a new role
roleRouter.post('/', rateLimitRoleManage, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_ROLES);
    if (!canManage) throw new ForbiddenError('You do not have permission to manage roles');

    const name = sanitizeText(req.body.name ?? '');
    const nameErr = validateRoleName(name);
    if (nameErr) throw new BadRequestError(nameErr);

    if (name.toLowerCase() === 'everyone') throw new BadRequestError('Cannot use reserved role name "everyone"');

    // Check for duplicate name
    const existing = await prisma.role.findFirst({ where: { serverId, name } });
    if (existing) throw new ConflictError('A role with this name already exists');

    // Check role limit
    const roleCount = await prisma.role.count({ where: { serverId } });
    if (roleCount >= LIMITS.MAX_ROLES_PER_SERVER) {
      throw new BadRequestError(`Server can have at most ${LIMITS.MAX_ROLES_PER_SERVER} roles`);
    }

    // Validate color if provided
    let color: string | null = null;
    if (req.body.color) {
      if (typeof req.body.color !== 'string') throw new BadRequestError('color must be a string');
      const colorErr = validateRoleColor(req.body.color);
      if (colorErr) throw new BadRequestError(colorErr);
      color = req.body.color;
    }

    // New roles are created at position just below the actor's highest role
    const actorHighest = await getHighestRolePosition(req.user!.userId, serverId);
    // Insert at position 1 (above @everyone which is 0), shift others up if needed
    const highestPosition = await prisma.role.aggregate({
      where: { serverId, isDefault: false },
      _max: { position: true },
    });
    const newPosition = Math.min(
      (highestPosition._max.position ?? 0) + 1,
      actorHighest === Infinity ? 999 : actorHighest,
    );

    // Parse permissions from request (default to 0)
    let permissions = 0n;
    if (req.body.permissions !== undefined) {
      if (typeof req.body.permissions !== 'string') throw new BadRequestError('permissions must be a string');
      permissions = permissionsFromString(req.body.permissions);
      // Cannot grant permissions the actor doesn't have (except owner)
      if (actorHighest !== Infinity) {
        const actorPerms = await getEffectivePermissions(req.user!.userId, serverId);
        const actorPermBits = permissionsFromString(actorPerms.permissions);
        if ((permissions & ~actorPermBits) !== 0n) {
          throw new ForbiddenError('Cannot grant permissions you do not have');
        }
      }
    }

    const role = await prisma.role.create({
      data: {
        serverId,
        name,
        color,
        position: newPosition,
        permissions: permissionsToString(permissions),
      },
    });

    getIO().to(`server:${serverId}`).emit(WS_EVENTS.ROLE_CREATED, {
      serverId,
      role: role as unknown as Role,
    });

    res.status(201).json({ success: true, data: role });
  } catch (err) {
    next(err);
  }
});

// Update a role
roleRouter.patch('/:roleId', rateLimitRoleManage, async (req: Request<{ serverId: string; roleId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, roleId } = req.params;

    const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_ROLES);
    if (!canManage) throw new ForbiddenError('You do not have permission to manage roles');

    const role = await prisma.role.findFirst({ where: { id: roleId, serverId } });
    if (!role) throw new NotFoundError('Role');

    // Cannot edit roles at or above actor's highest position (unless owner)
    const actorHighest = await getHighestRolePosition(req.user!.userId, serverId);
    if (actorHighest !== Infinity && role.position >= actorHighest) {
      throw new ForbiddenError('Cannot edit a role at or above your own position');
    }

    const updateData: Record<string, unknown> = {};

    // Name
    if (req.body.name !== undefined) {
      if (role.isDefault) throw new BadRequestError('Cannot rename the @everyone role');
      if (typeof req.body.name !== 'string') throw new BadRequestError('name must be a string');
      const name = sanitizeText(req.body.name);
      const nameErr = validateRoleName(name);
      if (nameErr) throw new BadRequestError(nameErr);
      if (name.toLowerCase() === 'everyone') throw new BadRequestError('Cannot use reserved role name "everyone"');
      // Check for duplicate name (exclude current role)
      const duplicate = await prisma.role.findFirst({ where: { serverId, name, id: { not: roleId } } });
      if (duplicate) throw new ConflictError('A role with this name already exists');
      updateData.name = name;
    }

    // Color
    if (req.body.color !== undefined) {
      if (req.body.color === null) {
        updateData.color = null;
      } else {
        if (typeof req.body.color !== 'string') throw new BadRequestError('color must be a string');
        const colorErr = validateRoleColor(req.body.color);
        if (colorErr) throw new BadRequestError(colorErr);
        updateData.color = req.body.color;
      }
    }

    // Permissions
    if (req.body.permissions !== undefined) {
      if (typeof req.body.permissions !== 'string') throw new BadRequestError('permissions must be a string');
      const newPerms = permissionsFromString(req.body.permissions);

      // Cannot grant permissions the actor doesn't have (except owner)
      if (actorHighest !== Infinity) {
        const actorPerms = await getEffectivePermissions(req.user!.userId, serverId);
        const actorPermBits = permissionsFromString(actorPerms.permissions);
        if ((newPerms & ~actorPermBits) !== 0n) {
          throw new ForbiddenError('Cannot grant permissions you do not have');
        }
      }

      updateData.permissions = permissionsToString(newPerms);
    }

    if (Object.keys(updateData).length === 0) {
      throw new BadRequestError('No fields to update');
    }

    const updated = await prisma.role.update({
      where: { id: roleId },
      data: updateData,
    });

    getIO().to(`server:${serverId}`).emit(WS_EVENTS.ROLE_UPDATED, {
      serverId,
      role: updated as unknown as Role,
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// Delete a role
roleRouter.delete('/:roleId', rateLimitRoleManage, async (req: Request<{ serverId: string; roleId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, roleId } = req.params;

    const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_ROLES);
    if (!canManage) throw new ForbiddenError('You do not have permission to manage roles');

    const role = await prisma.role.findFirst({ where: { id: roleId, serverId } });
    if (!role) throw new NotFoundError('Role');
    if (role.isDefault) throw new ForbiddenError('Cannot delete the @everyone role');

    const actorHighest = await getHighestRolePosition(req.user!.userId, serverId);
    if (actorHighest !== Infinity && role.position >= actorHighest) {
      throw new ForbiddenError('Cannot delete a role at or above your own position');
    }

    // Cascade: MemberRole and ChannelPermissionOverride are cascade-deleted by Prisma
    await prisma.role.delete({ where: { id: roleId } });

    getIO().to(`server:${serverId}`).emit(WS_EVENTS.ROLE_DELETED, { serverId, roleId });

    res.json({ success: true, message: 'Role deleted' });
  } catch (err) {
    next(err);
  }
});

// Assign roles to a member
roleRouter.patch(
  '/members/:memberId',
  rateLimitRoleManage,
  async (req: Request<{ serverId: string; memberId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, memberId } = req.params;
      const { roleIds } = req.body as { roleIds: string[] };

      if (!Array.isArray(roleIds)) throw new BadRequestError('roleIds must be an array');

      const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_ROLES);
      if (!canManage) throw new ForbiddenError('You do not have permission to manage roles');

      // Verify target is a member
      const targetMember = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: memberId, serverId } },
      });
      if (!targetMember) throw new NotFoundError('Member');

      // Cannot modify owner's roles (unless you're the owner)
      const server = await prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } });
      if (server?.ownerId === memberId && req.user!.userId !== memberId) {
        throw new ForbiddenError('Cannot modify the server owner\'s roles');
      }

      // Validate all role IDs belong to this server and are not @everyone
      const roles = await prisma.role.findMany({
        where: { id: { in: roleIds }, serverId },
        select: { id: true, position: true, isDefault: true },
      });
      if (roles.length !== roleIds.length) {
        throw new BadRequestError('One or more role IDs are invalid');
      }
      if (roles.some((r) => r.isDefault)) {
        throw new BadRequestError('Cannot explicitly assign the @everyone role');
      }

      // Hierarchy check: actor can only assign roles below their own highest position
      const actorHighest = await getHighestRolePosition(req.user!.userId, serverId);
      if (actorHighest !== Infinity) {
        // Cannot assign roles at or above actor's position
        for (const r of roles) {
          if (r.position >= actorHighest) {
            throw new ForbiddenError('Cannot assign roles at or above your own position');
          }
        }
        // Cannot modify roles of users with equal or higher position
        const targetHighest = await getHighestRolePosition(memberId, serverId);
        if (targetHighest >= actorHighest) {
          throw new ForbiddenError('Cannot modify roles of a member with an equal or higher role');
        }
      }

      // Replace all member roles atomically
      await prisma.$transaction([
        prisma.memberRole.deleteMany({ where: { userId: memberId, serverId } }),
        ...roleIds.map((roleId) =>
          prisma.memberRole.create({
            data: { userId: memberId, serverId, roleId },
          })
        ),
      ]);

      // Also update the legacy `role` field for backward compat
      // If any assigned role has ADMINISTRATOR or MANAGE_* permissions, set to 'admin'
      const assignedRoles = await prisma.role.findMany({
        where: { id: { in: roleIds } },
        select: { permissions: true },
      });
      const combinedPerms = assignedRoles.reduce(
        (acc, r) => acc | permissionsFromString(r.permissions),
        0n,
      );
      const isAdminLevel = (combinedPerms & Permissions.ADMINISTRATOR) !== 0n ||
        (combinedPerms & Permissions.MANAGE_CHANNELS) !== 0n ||
        (combinedPerms & Permissions.MANAGE_SERVER) !== 0n;

      // Only update legacy role if not owner
      let legacyRole: MemberRole = 'member';
      if (server?.ownerId !== memberId) {
        legacyRole = isAdminLevel ? 'admin' : 'member';
        await prisma.serverMember.update({
          where: { userId_serverId: { userId: memberId, serverId } },
          data: { role: legacyRole },
        });
      } else {
        legacyRole = 'owner';
      }

      const io = getIO();
      io.to(`server:${serverId}`).emit(WS_EVENTS.MEMBER_ROLES_UPDATED, {
        serverId,
        userId: memberId,
        roleIds,
      });
      // Also emit legacy role update so frontend MemberSidebar grouping stays in sync
      io.to(`server:${serverId}`).emit(WS_EVENTS.MEMBER_ROLE_UPDATED, {
        serverId,
        userId: memberId,
        role: legacyRole,
      });

      res.json({ success: true, message: 'Roles updated' });
    } catch (err) {
      next(err);
    }
  }
);

// Get channel permission overrides for a channel
roleRouter.get(
  '/channels/:channelId/permissions',
  async (req: Request<{ serverId: string; channelId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, channelId } = req.params;

      const membership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.user!.userId, serverId } },
      });
      if (!membership) throw new NotFoundError('Server');

      const channel = await prisma.channel.findFirst({ where: { id: channelId, serverId } });
      if (!channel) throw new NotFoundError('Channel');

      const overrides = await prisma.channelPermissionOverride.findMany({
        where: { channelId },
        include: { role: true },
      });

      res.json({ success: true, data: overrides });
    } catch (err) {
      next(err);
    }
  }
);

// Set channel permission override for a role
roleRouter.put(
  '/channels/:channelId/permissions/:roleId',
  rateLimitRoleManage,
  async (req: Request<{ serverId: string; channelId: string; roleId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, channelId, roleId } = req.params;

      const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_ROLES);
      if (!canManage) throw new ForbiddenError('You do not have permission to manage permissions');

      const channel = await prisma.channel.findFirst({ where: { id: channelId, serverId } });
      if (!channel) throw new NotFoundError('Channel');

      const role = await prisma.role.findFirst({ where: { id: roleId, serverId } });
      if (!role) throw new NotFoundError('Role');

      // Hierarchy check
      const actorHighest = await getHighestRolePosition(req.user!.userId, serverId);
      if (actorHighest !== Infinity && !role.isDefault && role.position >= actorHighest) {
        throw new ForbiddenError('Cannot set overrides for roles at or above your own position');
      }

      const { allow, deny } = req.body;
      if (typeof allow !== 'string' || typeof deny !== 'string') {
        throw new BadRequestError('allow and deny must be strings (decimal bigint)');
      }

      // Validate that allow and deny don't overlap, and strip ADMINISTRATOR (cannot be granted via channel overrides)
      const CHANNEL_OVERRIDE_MASK = ALL_PERMISSIONS & ~Permissions.ADMINISTRATOR;
      const allowBits = permissionsFromString(allow) & CHANNEL_OVERRIDE_MASK;
      const denyBits = permissionsFromString(deny) & CHANNEL_OVERRIDE_MASK;
      if ((allowBits & denyBits) !== 0n) {
        throw new BadRequestError('allow and deny cannot have overlapping bits');
      }

      // Validate that actor has the permissions they're trying to grant/deny
      if (actorHighest !== Infinity) {
        const actorPerms = await getEffectivePermissions(req.user!.userId, serverId);
        const actorPermBits = permissionsFromString(actorPerms.permissions);
        const combined = allowBits | denyBits;
        if ((combined & ~actorPermBits) !== 0n) {
          throw new ForbiddenError('Cannot set overrides for permissions you do not have');
        }
      }

      // Upsert the override (use sanitized bitmask values, not raw input)
      const sanitizedAllow = permissionsToString(allowBits);
      const sanitizedDeny = permissionsToString(denyBits);
      if (allowBits === 0n && denyBits === 0n) {
        // Remove override if both are zero (reset to inherit)
        await prisma.channelPermissionOverride.deleteMany({
          where: { channelId, roleId },
        });
      } else {
        await prisma.channelPermissionOverride.upsert({
          where: { channelId_roleId: { channelId, roleId } },
          update: { allow: sanitizedAllow, deny: sanitizedDeny },
          create: { channelId, roleId, allow: sanitizedAllow, deny: sanitizedDeny },
        });
      }

      // Fetch all overrides for the channel to broadcast
      const allOverrides = await prisma.channelPermissionOverride.findMany({
        where: { channelId },
        include: { role: true },
      });

      getIO().to(`server:${serverId}`).emit(WS_EVENTS.CHANNEL_PERMISSIONS_UPDATED, {
        serverId,
        channelId,
        overrides: allOverrides as unknown as ChannelPermissionOverride[],
      });

      res.json({ success: true, data: allOverrides });
    } catch (err) {
      next(err);
    }
  }
);

// Delete a channel permission override
roleRouter.delete(
  '/channels/:channelId/permissions/:roleId',
  rateLimitRoleManage,
  async (req: Request<{ serverId: string; channelId: string; roleId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, channelId, roleId } = req.params;

      const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_ROLES);
      if (!canManage) throw new ForbiddenError('You do not have permission to manage permissions');

      const channel = await prisma.channel.findFirst({ where: { id: channelId, serverId } });
      if (!channel) throw new NotFoundError('Channel');

      const role = await prisma.role.findFirst({ where: { id: roleId, serverId } });
      if (!role) throw new NotFoundError('Role');

      const actorHighest = await getHighestRolePosition(req.user!.userId, serverId);
      if (actorHighest !== Infinity && !role.isDefault && role.position >= actorHighest) {
        throw new ForbiddenError('Cannot modify overrides for roles at or above your own position');
      }

      await prisma.channelPermissionOverride.deleteMany({
        where: { channelId, roleId },
      });

      const allOverrides = await prisma.channelPermissionOverride.findMany({
        where: { channelId },
        include: { role: true },
      });

      getIO().to(`server:${serverId}`).emit(WS_EVENTS.CHANNEL_PERMISSIONS_UPDATED, {
        serverId,
        channelId,
        overrides: allOverrides as unknown as ChannelPermissionOverride[],
      });

      res.json({ success: true, message: 'Override removed' });
    } catch (err) {
      next(err);
    }
  }
);

// Get effective permissions for a user in a server/channel
roleRouter.get(
  '/permissions/effective',
  async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId } = req.params;
      const targetUserId = (req.query.userId as string) || req.user!.userId;
      const channelId = req.query.channelId as string | undefined;

      const membership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.user!.userId, serverId } },
      });
      if (!membership) throw new NotFoundError('Server');

      // Non-admin users can only check their own permissions
      const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_ROLES);
      if (targetUserId !== req.user!.userId && !canManage) {
        throw new ForbiddenError('You can only view your own effective permissions');
      }

      // Verify target is a member
      if (targetUserId !== req.user!.userId) {
        const targetMember = await prisma.serverMember.findUnique({
          where: { userId_serverId: { userId: targetUserId, serverId } },
        });
        if (!targetMember) throw new NotFoundError('Member');
      }

      const result = await getEffectivePermissions(targetUserId, serverId, channelId);

      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);
