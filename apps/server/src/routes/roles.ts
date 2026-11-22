import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail, requireConsent } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  memberGoneAsNotFound,
  prismaErrorCode,
  violatesForeignKey,
  violatesUniqueIndex,
} from '../utils/errors';
import { LOCK_WAIT_TRANSACTION_OPTIONS, retryOnTransactionConflict } from '../utils/transactionRetry';
import { isSortPosition, MAX_SORT_POSITION } from '../utils/sortPosition';
import {
  validateRoleName,
  validateRoleColor,
  LIMITS,
  WS_EVENTS,
  Permissions,
  permissionsFromString,
  permissionsToString,
  mergeKnownPermissions,
  LEGACY_CLIENT_KNOWN_PERMISSIONS,
} from '@voxium/shared';
import type { Role, MemberRole } from '@voxium/shared';
import { getIO } from '../websocket/socketServer';
import { sanitizeLabel } from '../utils/sanitize';
import { rateLimitRoleManage } from '../middleware/rateLimiter';
import {
  computeServerPermissions,
  hasServerPermission,
  hasChannelPermission,
  getHighestRolePosition,
  getEffectivePermissions,
  NO_CHANNEL_EFFECTIVE_PERMISSIONS,
  type PermissionReadClient,
  type ChannelPermissionReadClient,
} from '../utils/permissionCalculator';
import { syncChannelVisibilityRooms } from '../utils/channelVisibilityRooms';
import { planOverrideWrite, readKnownPermissions, readPermissionValue, storedPermissionBits } from '../utils/permissionWrites';

export const roleRouter = Router({ mergeParams: true });

roleRouter.use(authenticate, requireVerifiedEmail, requireConsent);

const ROLE_NAME_TAKEN_MESSAGE = 'A role with this name already exists';

/** The unique index on a role's name within its space (`@@unique([serverId, name])`). */
const ROLE_NAME_INDEX = 'roles_server_id_name_key';

/** A creation by a member whose highest position is 0, @everyone's. */
const ROLE_TOO_LOW_MESSAGE = 'Your role is too low in the role order to create roles';

/**
 * Where a new role goes, given its creator's highest position
 * (getHighestRolePosition: Infinity for the owner) and the highest position
 * of the space's roles. A creation moves no existing role. The owner's goes
 * on top, one above the highest role, at most MAX_SORT_POSITION (the bound of
 * the role reorder: a role already there shares it). Anyone else's
 * goes one position below their own highest role, so that it is below them
 * by the rule every later edit, assignment, override and delete of it is
 * judged by (a role at or above the actor is refused); a role already at
 * that position shares it, and every rank comparison treats the two as
 * equal. Null when no position below the creator's exists: their highest is
 * 0, @everyone's (no role of their own, or only roles at 0).
 */
function newRolePosition(creatorHighest: number, highestRolePosition: number | null): number | null {
  if (creatorHighest === Infinity) return Math.min((highestRolePosition ?? 0) + 1, MAX_SORT_POSITION);
  return creatorHighest >= 1 ? creatorHighest - 1 : null;
}

/**
 * Run a write that sets a role's name. The duplicate check before it is the
 * early answer only: a creation or rename of the same name committed between
 * the check and the write is refused by the unique index, and that refusal
 * gets the check's own 409. Anything else is thrown as it is. Given a
 * transaction run under retryOnTransactionConflict, this wraps the retry, so
 * a deadlock is retried before the answer is decided (a unique violation is
 * never retried).
 */
async function withUniqueRoleName<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (violatesUniqueIndex(err, ROLE_NAME_INDEX)) throw new ConflictError(ROLE_NAME_TAKEN_MESSAGE);
    throw err;
  }
}

/**
 * A write on a role row that is gone by the time it runs (a role delete, or a
 * space delete's cascade, committed since the role was read): no row to
 * update or delete (P2025), thrown as the 404 of a role that does not exist.
 * Anything else is thrown as it is.
 */
function roleGoneAsNotFound(err: unknown): never {
  if (prismaErrorCode(err) === 'P2025') throw new NotFoundError('Role');
  throw err;
}

/** Run a single-statement write on one role row: gone meanwhile, 404 Role. */
async function roleOrMissing<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    return roleGoneAsNotFound(err);
  }
}

/** One entry of a reorder: a role id and its new position. */
function isRoleOrderEntry(entry: unknown): entry is { id: string; position: number } {
  if (!entry || typeof entry !== 'object') return false;
  const { id, position } = entry as Record<string, unknown>;
  return typeof id === 'string' && isSortPosition(position);
}

// List all roles in a server
roleRouter.get('/', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new NotFoundError('Server');

    // id breaks position ties: roles that share a position come in one order
    const roles = await prisma.role.findMany({
      where: { serverId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
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
    if (!order.every(isRoleOrderEntry)) {
      throw new BadRequestError(`Each order entry needs a role id and a whole-number position from 0 to ${MAX_SORT_POSITION}`);
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

    // Update the positions in one transaction, one row after the other in ONE
    // fixed order, sorted by id, whatever order the client sent (as the
    // channel and category reorders do): two reorders of the same roles then
    // lock them in one order and one waits for the other. A role the
    // validation saw and that is gone by the update (deleted meanwhile, or
    // with its space) answers as an unknown one, 404 Role. The long budget
    // (LOCK_WAIT_TRANSACTION_OPTIONS): a role or space delete holds the row
    // through its cascade, and a role save or override write holds it while
    // it checks. The batch is built again for each attempt and run again
    // whole when PostgreSQL aborts it to break a deadlock: it writes absolute
    // positions, so a second run writes what the first would have.
    const sorted = [...order].sort((a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    try {
      await retryOnTransactionConflict(() => prisma.$transaction(
        sorted.map((o: { id: string; position: number }) =>
          prisma.role.update({ where: { id: o.id }, data: { position: o.position } })
        ),
        LOCK_WAIT_TRANSACTION_OPTIONS,
      ), `[Roles] The reorder of roles in ${serverId}`);
    } catch (err) {
      roleGoneAsNotFound(err);
    }

    const updated = await prisma.role.findMany({
      where: { serverId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
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

    const name = sanitizeLabel(req.body.name);
    const nameErr = validateRoleName(name);
    if (nameErr) throw new BadRequestError(nameErr);

    if (name.toLowerCase() === 'everyone') throw new BadRequestError('Cannot use reserved role name "everyone"');

    // Check for duplicate name (the early answer: withUniqueRoleName below)
    const existing = await prisma.role.findFirst({ where: { serverId, name } });
    if (existing) throw new ConflictError(ROLE_NAME_TAKEN_MESSAGE);

    // Check role limit: the roles members create, not the @everyone row every
    // server carries (the client counts the same way, so its "max roles"
    // notice and this refusal agree — counting @everyone here made the 25th
    // custom role fail with a message the client never showed)
    const roleCount = await prisma.role.count({ where: { serverId, isDefault: false } });
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

    // A new role goes strictly below its creator's highest role (the owner's
    // on top): a creator whose highest position is 0 has no position below
    // their own (newRolePosition)
    const actorId = req.user!.userId;
    const actorHighest = await getHighestRolePosition(actorId, serverId);
    if (newRolePosition(actorHighest, null) === null) throw new ForbiddenError(ROLE_TOO_LOW_MESSAGE);

    // Parse permissions from request (default to 0). A creation stores the
    // bits its client knows from what it sent (see utils/permissionWrites.ts;
    // nothing is stored yet, so there is nothing else to keep)
    const known = readKnownPermissions(req.body.knownPermissions);
    let permissions = 0n;
    if (req.body.permissions !== undefined) {
      if (typeof req.body.permissions !== 'string') throw new BadRequestError('permissions must be a string');
      permissions = mergeKnownPermissions(0n, readPermissionValue('permissions', req.body.permissions), known);
      // Cannot grant permissions the actor doesn't have (except owner): every
      // bit a creation stores is one it turns on
      if (actorHighest !== Infinity) {
        const actorPerms = await getEffectivePermissions(actorId, serverId);
        const actorPermBits = permissionsFromString(actorPerms.permissions);
        if ((permissions & ~actorPermBits) !== 0n) {
          throw new ForbiddenError('Cannot grant permissions you do not have');
        }
      }
    }

    // Everything above is the early answer. Then one transaction whose first
    // statement locks the space row (FOR UPDATE, as a channel or category
    // creation takes it): concurrent creations in one space run one after the
    // other, each counting and placing against every creation committed
    // before it. Inside it, on the transaction's client and in the order of
    // the early answer: Manage Roles, the cap and the highest position (one
    // aggregate), the creator's rank and the position it gives
    // (newRolePosition), every bit turned on held; then the insert. The space
    // row is the only existing row it locks, and it writes no existing role.
    // A role reorder, a role assignment or a role delete by someone else takes
    // no space row: one that commits between the rank read and the insert can
    // still leave the new role at or above its creator, and the only
    // consequence is a role its creator cannot manage (no one gains a power).
    // Run again whole when PostgreSQL aborts it to break a deadlock; the long
    // budget (LOCK_WAIT_TRANSACTION_OPTIONS): a space delete holds the space
    // row through its cascade. A name taken meanwhile is answered once the
    // retries are done (withUniqueRoleName).
    const role = await withUniqueRoleName(() => retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
      const space = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM servers WHERE id = ${serverId} FOR UPDATE`;
      if (space.length === 0) throw new NotFoundError('Server');
      const mayManage = await hasServerPermission(actorId, serverId, Permissions.MANAGE_ROLES, tx);
      if (!mayManage) throw new ForbiddenError('You do not have permission to manage roles');
      const { _count, _max } = await tx.role.aggregate({
        where: { serverId, isDefault: false },
        _count: { _all: true },
        _max: { position: true },
      });
      if (_count._all >= LIMITS.MAX_ROLES_PER_SERVER) {
        throw new BadRequestError(`Server can have at most ${LIMITS.MAX_ROLES_PER_SERVER} roles`);
      }
      const highest = await getHighestRolePosition(actorId, serverId, tx);
      const position = newRolePosition(highest, _max.position);
      if (position === null) throw new ForbiddenError(ROLE_TOO_LOW_MESSAGE);
      if (highest !== Infinity && permissions !== 0n) {
        const actorBits = await computeServerPermissions(actorId, serverId, tx);
        if ((permissions & ~actorBits) !== 0n) {
          throw new ForbiddenError('Cannot grant permissions you do not have');
        }
      }
      return tx.role.create({
        data: {
          serverId,
          name,
          color,
          position,
          permissions: permissionsToString(permissions),
        },
      });
    }, LOCK_WAIT_TRANSACTION_OPTIONS), `[Roles] A role creation in ${serverId}`));

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

    const updateData: { name?: string; color?: string | null } = {};

    // Name
    if (req.body.name !== undefined) {
      if (role.isDefault) throw new BadRequestError('Cannot rename the @everyone role');
      if (typeof req.body.name !== 'string') throw new BadRequestError('name must be a string');
      const name = sanitizeLabel(req.body.name);
      const nameErr = validateRoleName(name);
      if (nameErr) throw new BadRequestError(nameErr);
      if (name.toLowerCase() === 'everyone') throw new BadRequestError('Cannot use reserved role name "everyone"');
      // Check for duplicate name (exclude current role; the early answer:
      // both writes below run through withUniqueRoleName)
      const duplicate = await prisma.role.findFirst({ where: { serverId, name, id: { not: roleId } } });
      if (duplicate) throw new ConflictError(ROLE_NAME_TAKEN_MESSAGE);
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

    // Permissions: merged into the stored value, never replacing it (the bits
    // the client knows from the request, every other bit as stored: see
    // utils/permissionWrites.ts). Validated whenever it is sent.
    const known = readKnownPermissions(req.body.knownPermissions);

    if (req.body.permissions === undefined) {
      if (Object.keys(updateData).length === 0) {
        throw new BadRequestError('No fields to update');
      }
      // One statement; a role deleted since it was read finds no row: 404 Role
      const updated = await withUniqueRoleName(() => roleOrMissing(() => prisma.role.update({
        where: { id: roleId },
        data: updateData,
      })));
      getIO().to(`server:${serverId}`).emit(WS_EVENTS.ROLE_UPDATED, {
        serverId,
        role: updated as unknown as Role,
      });
      // Name/color changes don't affect visibility — no room re-sync
      res.json({ success: true, data: updated });
      return;
    }

    if (typeof req.body.permissions !== 'string') throw new BadRequestError('permissions must be a string');
    const sent = readPermissionValue('permissions', req.body.permissions);
    const actorId = req.user!.userId;

    // The actor must hold every bit the write turns ON. A bit it turns off
    // is never refused on that ground (who may manage a role below them may
    // already delete it, or take it from its holders), and a bit it leaves as
    // stored is not the actor's act (a role below them may hold a permission
    // they lack, which they can already hand out by assigning the role). The
    // early answer, against the role as read above; the transaction asks it
    // again against the row it overwrites.
    if (actorHighest !== Infinity) {
      const stored = storedPermissionBits(role.permissions);
      const turnedOn = mergeKnownPermissions(stored, sent, known) & ~stored;
      if (turnedOn !== 0n) {
        const actorPerms = await getEffectivePermissions(actorId, serverId);
        if ((turnedOn & ~permissionsFromString(actorPerms.permissions)) !== 0n) {
          throw new ForbiddenError('Cannot grant permissions you do not have');
        }
      }
    }

    // One transaction under the role row, so the value merged over is the
    // value replaced: the row FIRST (FOR NO KEY UPDATE, the mode a
    // permission-only update takes it: a member-role insert's key check on it
    // still passes; a save that also renames takes the stronger lock at its
    // update, because the name is in a unique index), then the checks above
    // made again on the transaction's client, then the write. Two saves of
    // one role run one after the other; without the lock a save judged
    // against a stale value could put back a permission the actor lacks (a
    // bit taken away meanwhile is turned on again: judged as such), or drop a
    // bit outside its own mask that another save had just set (inside its
    // mask the later save decides, as before). The long budget: a space or
    // role delete holds the row through its cascade. Run again whole when
    // PostgreSQL aborts it to break a deadlock; a name taken meanwhile (a
    // save that also renames) is answered once the retries are done.
    const { updated, changed } = await withUniqueRoleName(() => retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ permissions: string; position: number }[]>`SELECT permissions, position FROM roles WHERE id = ${roleId} AND server_id = ${serverId} FOR NO KEY UPDATE`;
      if (!locked) throw new NotFoundError('Role');
      const mayManage = await hasServerPermission(actorId, serverId, Permissions.MANAGE_ROLES, tx);
      if (!mayManage) throw new ForbiddenError('You do not have permission to manage roles');
      const highest = await getHighestRolePosition(actorId, serverId, tx);
      if (highest !== Infinity && locked.position >= highest) {
        throw new ForbiddenError('Cannot edit a role at or above your own position');
      }
      const stored = storedPermissionBits(locked.permissions);
      const merged = mergeKnownPermissions(stored, sent, known);
      const turnedOn = merged & ~stored;
      if (highest !== Infinity && turnedOn !== 0n) {
        const actorBits = await computeServerPermissions(actorId, serverId, tx);
        if ((turnedOn & ~actorBits) !== 0n) {
          throw new ForbiddenError('Cannot grant permissions you do not have');
        }
      }
      const row = await tx.role.update({
        where: { id: roleId },
        data: { ...updateData, permissions: permissionsToString(merged) },
      });
      return { updated: row, changed: merged !== stored };
    }, LOCK_WAIT_TRANSACTION_OPTIONS), `[Roles] The update of role ${roleId} in ${serverId}`));

    getIO().to(`server:${serverId}`).emit(WS_EVENTS.ROLE_UPDATED, {
      serverId,
      role: updated as unknown as Role,
    });

    // A permission change can grant/revoke VIEW_CHANNEL (or ADMINISTRATOR) —
    // re-sync live socket room membership so real-time events match the new
    // visibility, whenever the merged value differs from the stored one (a
    // write that changed no bit changed no visibility). Fire-and-forget: the
    // util catches its own errors, and the response must not wait on a
    // per-online-member permission sweep.
    if (changed) {
      void syncChannelVisibilityRooms(serverId);
    }

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

    // Cascade: MemberRole and ChannelPermissionOverride are cascade-deleted by
    // the database. A role another delete removed first (or a space delete's
    // cascade) finds no row: 404 Role, and nothing is announced
    await roleOrMissing(() => prisma.role.delete({ where: { id: roleId } }));

    getIO().to(`server:${serverId}`).emit(WS_EVENTS.ROLE_DELETED, { serverId, roleId });

    // Deleting a role (and its cascade-deleted overrides) can change visibility
    void syncChannelVisibilityRooms(serverId);

    res.json({ success: true, message: 'Role deleted' });
  } catch (err) {
    next(err);
  }
});

/**
 * The role assignment's checks, reading through `db` (the shared client for
 * the early answer, the transaction's client inside it): the actor may
 * manage roles, the target is a member, the owner's roles are the owner's
 * alone, every role is one of this server's and not @everyone, and the
 * actor outranks both the roles and the target. Returns the space's owner.
 */
async function assertMayAssignRoles(
  db: PermissionReadClient,
  actorId: string,
  serverId: string,
  memberId: string,
  roleIds: string[],
): Promise<{ ownerId: string } | null> {
  const canManage = await hasServerPermission(actorId, serverId, Permissions.MANAGE_ROLES, db);
  if (!canManage) throw new ForbiddenError('You do not have permission to manage roles');

  // Verify target is a member
  const targetMember = await db.serverMember.findUnique({
    where: { userId_serverId: { userId: memberId, serverId } },
  });
  if (!targetMember) throw new NotFoundError('Member');

  // Cannot modify owner's roles (unless you're the owner)
  const server = await db.server.findUnique({ where: { id: serverId }, select: { ownerId: true } });
  if (server?.ownerId === memberId && actorId !== memberId) {
    throw new ForbiddenError('Cannot modify the server owner\'s roles');
  }

  // Validate all role IDs belong to this server and are not @everyone
  const roles = await db.role.findMany({
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
  const actorHighest = await getHighestRolePosition(actorId, serverId, db);
  if (actorHighest !== Infinity) {
    // Cannot assign roles at or above actor's position
    for (const r of roles) {
      if (r.position >= actorHighest) {
        throw new ForbiddenError('Cannot assign roles at or above your own position');
      }
    }
    // Cannot modify roles of users with equal or higher position
    const targetHighest = await getHighestRolePosition(memberId, serverId, db);
    if (targetHighest >= actorHighest) {
      throw new ForbiddenError('Cannot modify roles of a member with an equal or higher role');
    }
  }
  return server;
}

// Assign roles to a member
roleRouter.patch(
  '/members/:memberId',
  rateLimitRoleManage,
  async (req: Request<{ serverId: string; memberId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, memberId } = req.params;
      const { roleIds } = req.body as { roleIds: string[] };

      if (!Array.isArray(roleIds)) throw new BadRequestError('roleIds must be an array');

      const actorId = req.user!.userId;
      // The early answer, on the shared client; the transaction asks it again
      await assertMayAssignRoles(prisma, actorId, serverId, memberId, roleIds);

      // Replace all member roles atomically. The member row first, in the
      // mode the new rows' key takes it (FOR KEY SHARE): a removal of the
      // member locks that row as its first statement, and this transaction
      // then waits for it before it holds any role row the removal's cascade
      // deletes. Then every check made above, made again on the
      // transaction's client (assertMayAssignRoles), so the one that holds is
      // the one made after the wait; then the writes. The long budget
      // (LOCK_WAIT_TRANSACTION_OPTIONS): the transaction waits for the
      // removal inside it. Run again whole when PostgreSQL aborts it to break
      // a deadlock, the checks included. A refused key answers what is
      // missing: the member (404 Member) or a role deleted meanwhile (404 Role).
      let server: { ownerId: string } | null;
      try {
        server = await retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT user_id FROM server_members WHERE user_id = ${memberId} AND server_id = ${serverId} FOR KEY SHARE`;
          const checked = await assertMayAssignRoles(tx, actorId, serverId, memberId, roleIds);
          await tx.memberRole.deleteMany({ where: { userId: memberId, serverId } });
          for (const roleId of roleIds) {
            await tx.memberRole.create({ data: { userId: memberId, serverId, roleId } });
          }
          return checked;
        }, LOCK_WAIT_TRANSACTION_OPTIONS), `[Roles] The role assignment of ${memberId} in ${serverId}`);
      } catch (err) {
        if (violatesForeignKey(err, 'member_roles_role_id_fkey')) throw new NotFoundError('Role');
        memberGoneAsNotFound(err);
      }

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
        // A member gone since the batch (removed with no role to replace)
        // finds no row (P2025): 404 Member
        try {
          await prisma.serverMember.update({
            where: { userId_serverId: { userId: memberId, serverId } },
            data: { role: legacyRole },
          });
        } catch (err) {
          memberGoneAsNotFound(err);
        }
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

      // The member's role set changed — re-sync their sockets' channel rooms
      void syncChannelVisibilityRooms(serverId, { userId: memberId });

      res.json({ success: true, message: 'Roles updated' });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * The channel an override route acts on, read through `db` (the shared
 * client for the early answer, the transaction's client inside it): one of
 * this space's, not secure, and one the actor can view. Anything else is the
 * 404 of a channel that does not exist, so an id the actor cannot see tells
 * nothing apart from an unknown one: the routes ask it before they read the
 * role, the body or the override. Secure channels carry no role overrides
 * (their access is their membership) and are refused on their own line
 * first: a member of one holds VIEW_CHANNEL there through that membership.
 * The owner and an ADMINISTRATOR view every other channel.
 */
async function assertOverrideChannel(
  actorId: string,
  serverId: string,
  channelId: string,
  db?: ChannelPermissionReadClient,
): Promise<void> {
  const channel = await (db ?? prisma).channel.findFirst({ where: { id: channelId, serverId }, select: { secure: true } });
  if (!channel || channel.secure) throw new NotFoundError('Channel');
  if (!await hasChannelPermission(actorId, channelId, serverId, Permissions.VIEW_CHANNEL, db)) {
    throw new NotFoundError('Channel');
  }
}

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

      // A secure channel, or one the member cannot see: the 404 of a channel
      // that does not exist (assertOverrideChannel)
      await assertOverrideChannel(req.user!.userId, serverId, channelId);

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

/**
 * The write of one role's override on one channel, shared by the PUT (what
 * the client sent, merged with the bits it knows) and the DELETE (a 0/0 write
 * with the 2.1.x set: it clears only the bits such a client knows and keeps
 * any other). allow and deny are each merged over the stored override (see
 * utils/permissionWrites.ts), then stripped of the flags a channel override
 * never carries: ADMINISTRATOR, and the two server-level-only flags
 * CREATE_SECURE_CHANNELS and MANAGE_WEBHOOKS (a channel-scoped grant of
 * either is meaningless and would just confuse effective-permission displays
 * — webhook management is checked against the SERVER permissions, so a
 * channel grant must never look like one). The overlap check and the
 * delete-or-upsert choice judge that result: the row goes when nothing is
 * left in it. The actor must hold every bit the write turns ON, in allow or
 * in deny (each against its own stored mask: denying a permission needs it
 * too); a bit turned off, or left as stored, is never refused on that ground.
 *
 * One transaction under the ROLE row (FOR NO KEY UPDATE, the mode a role
 * update takes it, so an override's key check on it still passes): it is the
 * one row every write of this override takes first, an existing override or
 * not, so two writes of it (or a role save) run one after the other and the
 * value merged over is the value replaced. A lock that finds no role row
 * reads the space first: a space deleted while the write waited answers 404
 * Server (its roles went with it, and the actor holds nothing in a space that
 * is gone). Then every check of the route made again on the transaction's
 * client, in the route's order (manage, the channel as assertOverrideChannel
 * decides it, the role, the rank: a role found missing by the lock in a space
 * still there is answered after the channel, so a channel the actor no longer
 * sees still answers as a missing one), the override read again, and the
 * write. The checks only read: the role row is the one row locked before the
 * write. The PUT's answer, the channel's overrides, is read on the same
 * client before the commit, under the checks that just passed.
 * The long budget: a space, channel or role delete holds these rows through
 * its cascade. Run again whole when PostgreSQL aborts it to break a deadlock:
 * a space delete's cascade reaches the channel before the role, the reverse
 * of this write's order, so the two can meet as a deadlock; both sides run
 * under retryOnTransactionConflict, and whichever is aborted runs again (this
 * write then answers 404 Server, or 200 before the space goes).
 * A write that stores something for a channel deleted while it ran answers
 * 404 Channel; one that leaves nothing to store (a 0/0 write, the DELETE)
 * finds no row to remove and answers as for an override that did not exist.
 * Returns the bits that changed (the room re-sync is decided on them) and,
 * when asked, the channel's overrides after the write.
 */
async function writeChannelOverride(w: {
  serverId: string;
  channelId: string;
  roleId: string;
  actorId: string;
  sentAllow: bigint;
  sentDeny: bigint;
  known: bigint;
  /** The route's own answer to a role at or above the actor. */
  rankRefusal: string;
  /** Read the channel's overrides back before the commit (the PUT's answer). */
  readBack: boolean;
}) {
  const { serverId, channelId, roleId, actorId } = w;
  try {
    return await retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ position: number; is_default: boolean }[]>`SELECT position, is_default FROM roles WHERE id = ${roleId} AND server_id = ${serverId} FOR NO KEY UPDATE`;
      if (!locked) {
        const space = await tx.server.findUnique({ where: { id: serverId }, select: { id: true } });
        if (!space) throw new NotFoundError('Server');
      }
      const mayManage = await hasServerPermission(actorId, serverId, Permissions.MANAGE_ROLES, tx);
      if (!mayManage) throw new ForbiddenError('You do not have permission to manage permissions');
      await assertOverrideChannel(actorId, serverId, channelId, tx);
      if (!locked) throw new NotFoundError('Role');
      const highest = await getHighestRolePosition(actorId, serverId, tx);
      if (highest !== Infinity && !locked.is_default && locked.position >= highest) {
        throw new ForbiddenError(w.rankRefusal);
      }
      const stored = await tx.channelPermissionOverride.findUnique({
        where: { channelId_roleId: { channelId, roleId } },
        select: { allow: true, deny: true },
      });
      const plan = planOverrideWrite(stored, w.sentAllow, w.sentDeny, w.known);
      if (highest !== Infinity && plan.turnedOn !== 0n) {
        const actorBits = await computeServerPermissions(actorId, serverId, tx);
        if ((plan.turnedOn & ~actorBits) !== 0n) {
          throw new ForbiddenError('Cannot set overrides for permissions you do not have');
        }
      }
      if (plan.allow === 0n && plan.deny === 0n) {
        // Nothing left: remove the override (reset to inherit)
        await tx.channelPermissionOverride.deleteMany({ where: { channelId, roleId } });
      } else {
        const values = { allow: permissionsToString(plan.allow), deny: permissionsToString(plan.deny) };
        await tx.channelPermissionOverride.upsert({
          where: { channelId_roleId: { channelId, roleId } },
          update: values,
          create: { channelId, roleId, ...values },
        });
      }
      const overrides = w.readBack
        ? await tx.channelPermissionOverride.findMany({ where: { channelId }, include: { role: true } })
        : null;
      return { changed: plan.changed, overrides };
    }, LOCK_WAIT_TRANSACTION_OPTIONS), `[Roles] The override of role ${roleId} on channel ${channelId}`);
  } catch (err) {
    // A channel deleted while the transaction ran: the new row's key refused
    if (violatesForeignKey(err, 'channel_permission_overrides_channel_id_fkey')) throw new NotFoundError('Channel');
    throw err;
  }
}

/**
 * After an override write: `{ serverId }` only to the space (members refetch
 * what they may see; the channel id and its overrides must not travel on the
 * space-wide room, which reaches members without VIEW_CHANNEL on this channel
 * too), and this channel's rooms re-synced when the merged override differs
 * from the stored one (it may have granted or revoked VIEW_CHANNEL).
 */
function announceOverrideWrite(serverId: string, channelId: string, changed: bigint): void {
  getIO().to(`server:${serverId}`).emit(WS_EVENTS.CHANNEL_PERMISSIONS_UPDATED, { serverId });
  if (changed !== 0n) {
    void syncChannelVisibilityRooms(serverId, { channelId });
  }
}

// Set channel permission override for a role
roleRouter.put(
  '/channels/:channelId/permissions/:roleId',
  rateLimitRoleManage,
  async (req: Request<{ serverId: string; channelId: string; roleId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, channelId, roleId } = req.params;

      const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_ROLES);
      if (!canManage) throw new ForbiddenError('You do not have permission to manage permissions');

      // Secure channels are membership-governed: role overrides do not apply
      // and their existence must not leak; nor may a channel the actor cannot
      // see. Both are indistinguishable from not-found (assertOverrideChannel)
      await assertOverrideChannel(req.user!.userId, serverId, channelId);

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
      const known = readKnownPermissions(req.body.knownPermissions);
      const sentAllow = readPermissionValue('allow', allow);
      const sentDeny = readPermissionValue('deny', deny);
      const actorId = req.user!.userId;

      // The early answer (see writeChannelOverride for the rules), against the
      // override as stored now; the transaction asks it again against the row
      // it overwrites.
      const current = await prisma.channelPermissionOverride.findUnique({
        where: { channelId_roleId: { channelId, roleId } },
        select: { allow: true, deny: true },
      });
      const early = planOverrideWrite(current, sentAllow, sentDeny, known);
      if (actorHighest !== Infinity && early.turnedOn !== 0n) {
        const actorPerms = await getEffectivePermissions(actorId, serverId);
        if ((early.turnedOn & ~permissionsFromString(actorPerms.permissions)) !== 0n) {
          throw new ForbiddenError('Cannot set overrides for permissions you do not have');
        }
      }

      // The caller (who holds MANAGE_ROLES and views the channel) gets the
      // channel's overrides back, read inside the write's transaction
      const { changed, overrides } = await writeChannelOverride({
        serverId, channelId, roleId, actorId, sentAllow, sentDeny, known,
        rankRefusal: 'Cannot set overrides for roles at or above your own position',
        readBack: true,
      });

      announceOverrideWrite(serverId, channelId, changed);

      res.json({ success: true, data: overrides });
    } catch (err) {
      next(err);
    }
  }
);

// Delete a channel permission override: a 0/0 write with the 2.1.x set, like
// every write that names no known bits. It clears what such a client knows
// and keeps any other bit in the row (the row goes only when nothing is left),
// so a 2.1.x client clearing every bit it shows never removes a flag added
// after it. It turns nothing on, so it is never refused for the actor's bits.
roleRouter.delete(
  '/channels/:channelId/permissions/:roleId',
  rateLimitRoleManage,
  async (req: Request<{ serverId: string; channelId: string; roleId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, channelId, roleId } = req.params;

      const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_ROLES);
      if (!canManage) throw new ForbiddenError('You do not have permission to manage permissions');

      // Same opacity rule as the PUT: a secure channel, or one the actor
      // cannot see, reads as not-found
      await assertOverrideChannel(req.user!.userId, serverId, channelId);

      const role = await prisma.role.findFirst({ where: { id: roleId, serverId } });
      if (!role) throw new NotFoundError('Role');

      const rankRefusal = 'Cannot modify overrides for roles at or above your own position';
      const actorHighest = await getHighestRolePosition(req.user!.userId, serverId);
      if (actorHighest !== Infinity && !role.isDefault && role.position >= actorHighest) {
        throw new ForbiddenError(rankRefusal);
      }

      const { changed } = await writeChannelOverride({
        serverId, channelId, roleId, actorId: req.user!.userId,
        sentAllow: 0n, sentDeny: 0n, known: LEGACY_CLIENT_KNOWN_PERMISSIONS,
        rankRefusal,
        readBack: false,
      });

      announceOverrideWrite(serverId, channelId, changed);

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

      // A channel the caller cannot view (another space's, a secure channel
      // they are not a member of, one their overrides hide) answers exactly as
      // an id that names no channel of the space, whoever the target: nothing
      // of it is read for the target. The caller's view is decided by the
      // channel calculation, membership first for a secure channel.
      if (channelId && !await hasChannelPermission(req.user!.userId, channelId, serverId, Permissions.VIEW_CHANNEL)) {
        res.json({ success: true, data: NO_CHANNEL_EFFECTIVE_PERMISSIONS });
        return;
      }

      const result = await getEffectivePermissions(targetUserId, serverId, channelId);

      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);
