import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail, requireConsent } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import {
  validateServerName, validateNickname, validateBanReason, validateServerDescription, validateDiscoveryTags, dedupeDiscoveryTags,
  LIMITS, MEMBER_LIST, MEMBER_DIRECTORY_ROLE_FILTERS, WS_EVENTS, DEFAULT_EVERYONE_PERMISSIONS, SERVER_JOIN_MODES, permissionsToString,
  OPAQUE_ID_RE,
} from '@voxium/shared';
import type { MemberRole, Server, ServerBan, ServerJoinRequest, ServerMember, ServerPeople, MemberDirectoryPage } from '@voxium/shared';
import { Prisma } from '../generated/prisma/client';
import { encodeMemberCursor, decodeMemberCursor, hashMemberQuery } from '../utils/memberCursor';
import { joinServerRoom } from '../utils/memberBroadcast';
import { getIO } from '../websocket/socketServer';
import { sanitizeText } from '../utils/sanitize';
import { rateLimitMemberManage, rateLimitMemberRead, rateLimitMemberLookup, rateLimitSearch } from '../middleware/rateLimiter';
import { VALID_S3_KEY_RE, deleteFromS3 } from '../utils/s3';
import { adoptImageAssetUpload } from '../utils/uploadVerification';
import { hasServerPermission, getHighestRolePosition, filterVisibleChannels } from '../utils/permissionCalculator';
import { Permissions } from '@voxium/shared';
import { deleteServerAndAnnounce } from '../utils/serverDeletion';
import { isFeatureEnabled } from '../utils/featureFlags';
import { getEffectiveLimits } from '../utils/serverLimits';
import { syncChannelVisibilityRooms } from '../utils/channelVisibilityRooms';
import { removeMemberFromServer, OWNER_CANNOT_LEAVE_MESSAGE, KICK_OUTRANKED_MESSAGE } from '../utils/removeMember';
import { retryOnTransactionConflict } from '../utils/transactionRetry';
import { recomputeListed } from '../utils/discoveryListing';
import { bumpDiscoveryPageCache } from '../utils/discoveryPageCache';
import { getTierThresholds, tierOf, nextTierFor } from '../utils/discoveryTiers';
import { joinServerMember } from '../utils/serverJoin';
import { serverSelect } from '../utils/serverSelect';
import { emitToModerators } from '../utils/moderatorAudience';

export const serverRouter = Router();

serverRouter.use(authenticate, requireVerifiedEmail, requireConsent);

const requestUserSelect = { id: true, username: true, displayName: true, avatarUrl: true } as const;

/** API shape of a join request (ServerJoinRequest in the shared types). */
function formatJoinRequest(row: {
  id: string; serverId: string; userId: string; message: string | null; status: string; createdAt: Date;
  user: { id: string; username: string; displayName: string; avatarUrl: string | null };
}): ServerJoinRequest {
  return {
    id: row.id,
    serverId: row.serverId,
    userId: row.userId,
    message: row.message,
    status: row.status as ServerJoinRequest['status'],
    createdAt: row.createdAt.toISOString(),
    user: row.user,
  };
}

/** API shape of a ban row (ServerBan in the shared types). */
function formatBan(ban: {
  serverId: string;
  userId: string;
  reason: string | null;
  createdAt: Date;
  user: { id: string; username: string; displayName: string; avatarUrl: string | null };
  bannedBy: { id: string; username: string; displayName: string } | null;
}): ServerBan {
  return {
    serverId: ban.serverId,
    userId: ban.userId,
    reason: ban.reason,
    createdAt: ban.createdAt.toISOString(),
    user: ban.user,
    bannedBy: ban.bannedBy,
  };
}

// List servers the user is a member of
serverRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const memberships = await prisma.serverMember.findMany({
      where: { userId: req.user!.userId },
      include: {
        server: {
          select: serverSelect,
        },
      },
      orderBy: { joinedAt: 'asc' },
    });

    res.json({
      success: true,
      data: memberships.map((m) => m.server),
    });
  } catch (err) {
    next(err);
  }
});

// Create a new server
// Server create, leave and edit share the management bucket its delete already uses
serverRouter.post('/', rateLimitMemberManage, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isFeatureEnabled('server_creation')) throw new ForbiddenError('Server creation is currently disabled');
    const name = sanitizeText(req.body.name ?? '');
    const nameErr = validateServerName(name);
    if (nameErr) throw new BadRequestError(nameErr);

    const ownedServerCount = await prisma.server.count({
      where: { ownerId: req.user!.userId },
    });
    if (ownedServerCount >= LIMITS.MAX_SERVERS_PER_USER) {
      throw new BadRequestError(`You can only create up to ${LIMITS.MAX_SERVERS_PER_USER} servers`);
    }

    const server = await prisma.$transaction(async (tx) => {
      // Create server with member
      const srv = await tx.server.create({
        data: {
          name,
          ownerId: req.user!.userId,
          // The creator is the one membership that does not go through
          // joinServerMember, so the inline member count (server discovery)
          // is seeded here — the migration backfill only knew about rows that
          // existed at migration time.
          memberCount: 1,
          members: {
            create: { userId: req.user!.userId, role: 'owner' },
          },
        },
      });

      // Create default categories
      const textCategory = await tx.category.create({
        data: { name: 'Text Channels', serverId: srv.id, position: 0 },
      });
      const voiceCategory = await tx.category.create({
        data: { name: 'Voice Channels', serverId: srv.id, position: 1 },
      });

      // Create @everyone default role
      await tx.role.create({
        data: {
          serverId: srv.id,
          name: 'everyone',
          position: 0,
          permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS),
          isDefault: true,
        },
      });

      // Create default channels linked to categories
      await tx.channel.createMany({
        data: [
          { name: 'general', type: 'text', serverId: srv.id, categoryId: textCategory.id, position: 0 },
          { name: 'General', type: 'voice', serverId: srv.id, categoryId: voiceCategory.id, position: 1 },
        ],
      });

      // Fetch the full server with includes
      return tx.server.findUniqueOrThrow({
        where: { id: srv.id },
        include: {
          // id breaks position ties: the order must not depend on how the
          // relation is loaded (one joined statement or a query per relation)
          channels: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
          categories: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
          _count: { select: { members: true } },
        },
      });
    });

    // Listed by default: the new space must be on Explore at its next open,
    // not after the cached pages expire (never throws)
    await bumpDiscoveryPageCache('server create');

    // Add creator's socket to the new server room so server-scoped events work
    await joinServerRoom(req.user!.userId, server.id);

    // Seed ChannelRead for the default text channel so existing messages don't show as unread
    const generalChannel = server.channels.find((c) => c.type === 'text');
    if (generalChannel) {
      await prisma.channelRead.create({
        data: { userId: req.user!.userId, channelId: generalChannel.id, lastReadAt: new Date() },
      });
    }

    res.status(201).json({
      success: true,
      data: { ...server, memberCount: server._count.members },
    });
  } catch (err) {
    next(err);
  }
});

// Get server details
serverRouter.get('/:serverId', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new NotFoundError('Server');

    const server = await prisma.server.findUnique({
      where: { id: serverId },
      include: {
        // id breaks position ties, as in the create's read-back
        channels: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
        categories: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
        roles: { orderBy: { position: 'asc' } },
        _count: { select: { members: true } },
      },
    });

    if (!server) throw new NotFoundError('Server');

    // Filter channels by VIEW_CHANNEL permission
    const visibleChannels = await filterVisibleChannels(req.user!.userId, serverId, server.channels);

    // Members get the Server shape plus the relations, never the platform
    // admin's curation state or the ranking internals: the owner's Discovery
    // tab reads those from its own endpoint (GET /:serverId/discovery).
    const {
      discoveryBlockedAt: _blocked, featuredAt: _featured, discoveryListed: _listed, memberCount: _inline,
      onlineCount: _online, weeklyMessages: _weekly, activityScore: _score, statsRefreshedAt: _stats,
      ...memberView
    } = server;
    res.json({
      success: true,
      data: { ...memberView, channels: visibleChannels, memberCount: server._count.members },
    });
  } catch (err) {
    next(err);
  }
});

// Get server resource limits (read-only for members)
serverRouter.get('/:serverId/limits', async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new NotFoundError('Server');

    const limits = await getEffectiveLimits(serverId);
    res.json({ success: true, data: limits });
  } catch (err) {
    next(err);
  }
});

// ─── Member lists ───────────────────────────────────────────────────────────
//
// Two views, two contracts (CLAUDE.md "Server Membership"):
//   GET /:serverId/members          the DIRECTORY (Server settings → Members):
//                                   server-paged by keyset cursor, searched and
//                                   filtered server-side — the one place every
//                                   member of a big server can be found.
//   GET /:serverId/members/online   the People panel's PRESENCE slice: everyone
//                                   while the server is small, the online
//                                   members (capped, staff and the viewer
//                                   first) above MEMBER_LIST.PEOPLE_MAX_ROWS.
//   GET /:serverId/members/lookup   rows for up to LOOKUP_MAX_IDS ids — what the
//                                   client asks for a message author, a voice
//                                   participant or a presence event it has no
//                                   row for. Non-members are simply absent.
//   GET /:serverId/members/search   name search for pickers and the mention
//                                   autocomplete.

const memberRowInclude = {
  user: {
    select: { id: true, username: true, displayName: true, avatarUrl: true, bio: true, status: true, role: true, isSupporter: true, supporterTier: true, createdAt: true },
  },
  memberRoles: { include: { role: true } },
} as const;

type MemberRow = Prisma.ServerMemberGetPayload<{ include: typeof memberRowInclude }>;

/** The API shape of a member row: `memberRoles` flattened to `roles`. */
function formatMemberRow(m: MemberRow): ServerMember {
  const { memberRoles, ...rest } = m;
  return {
    ...rest,
    role: rest.role as MemberRole,
    joinedAt: rest.joinedAt.toISOString(),
    user: {
      ...rest.user,
      role: rest.user.role as ServerMember['user']['role'],
      status: rest.user.status as ServerMember['user']['status'],
      supporterTier: rest.user.supporterTier as ServerMember['user']['supporterTier'],
      createdAt: rest.user.createdAt.toISOString(),
    },
    roles: memberRoles.map((mr) => ({ ...mr.role, createdAt: mr.role.createdAt.toISOString() })),
  };
}

/** ILIKE pattern with `%`, `_` and `\` escaped (Prisma escapes its own `contains`; raw SQL does not). */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, '\\$&')}%`;
}

/** Owner first, admins next, then everyone — the directory's first sort key. */
const MEMBER_RANK = Prisma.sql`CASE sm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END`;

/** The directory's WHERE for a server, a search text and a role filter (`sm` = server_members, `u` = users). */
function directoryWhere(serverId: string, q: string, role: string): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`sm.server_id = ${serverId}`];
  if (q) {
    const pattern = likePattern(q);
    parts.push(Prisma.sql`(u.username ILIKE ${pattern} OR u.display_name ILIKE ${pattern} OR sm.nickname ILIKE ${pattern})`);
  }
  if (role === 'owner' || role === 'admin') {
    parts.push(Prisma.sql`sm.role = ${role}`);
  } else if (role === 'none') {
    parts.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM member_roles mr WHERE mr.user_id = sm.user_id AND mr.server_id = sm.server_id)`);
  } else if (role) {
    parts.push(Prisma.sql`EXISTS (SELECT 1 FROM member_roles mr WHERE mr.user_id = sm.user_id AND mr.server_id = sm.server_id AND mr.role_id = ${role})`);
  }
  return Prisma.join(parts, ' AND ');
}

// The charset of every id a client may hand us (cuids, role ids, user ids) is
// the shared OPAQUE_ID_RE: a synthesised `webhook:{id}` author can never pass it
/** A C0 control character (a NUL among them) in search text: Postgres refuses
 *  the parameter, which would be a 500 with a stack trace instead of a 400. */
const CONTROL_CHAR_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}]`);

// Get server members — the directory. The heaviest of the four reads (an
// ILIKE scan of the server's members when searched): the member-read budget,
// never the shared global one alone.
serverRouter.get('/:serverId/members', rateLimitMemberRead, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || LIMITS.MEMBERS_PER_PAGE, 1), LIMITS.MEMBERS_PER_PAGE);

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new NotFoundError('Server');

    // Clients from before the directory page by NUMBER (`?page=N`) in join
    // order and read `page`/`hasMore`; they keep working unchanged until
    // they update. Everything else is the keyset directory below.
    if (req.query.cursor === undefined && req.query.page !== undefined) {
      const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
      const [members, total] = await Promise.all([
        prisma.serverMember.findMany({
          where: { serverId },
          include: memberRowInclude,
          skip: (page - 1) * limit,
          take: limit,
          // userId breaks ties: members seeded or imported in one statement share
          // a joinedAt, and a page boundary inside a tie duplicates or skips rows
          orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
        }),
        prisma.serverMember.count({ where: { serverId } }),
      ]);
      res.json({ success: true, data: members.map(formatMemberRow), total, page, limit, hasMore: page * limit < total });
      return;
    }

    const qRaw = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (qRaw.length > MEMBER_LIST.QUERY_MAX) throw new BadRequestError('Search text is too long');
    if (CONTROL_CHAR_RE.test(qRaw)) throw new BadRequestError('Invalid search text');
    const role = typeof req.query.role === 'string' ? req.query.role : '';
    if (role && !(MEMBER_DIRECTORY_ROLE_FILTERS as readonly string[]).includes(role) && !OPAQUE_ID_RE.test(role)) {
      throw new BadRequestError('Invalid role filter');
    }
    const expected = { serverId, q: hashMemberQuery(qRaw), role, limit };
    let cursor = null;
    if (req.query.cursor !== undefined) {
      cursor = decodeMemberCursor(req.query.cursor, expected);
      if (!cursor) throw new BadRequestError('Invalid cursor');
    }

    // The page's KEYS come from one ordered query (the rank, join date and id
    // predicate is a row comparison, so it is "strictly after" in the same
    // order the page is sorted by); the rows with their user and roles come
    // from Prisma by id and are put back in that order. A member removed
    // between the two is simply absent from the page.
    // The key query also returns the sort key of every row, so the cursor is
    // built from the LAST KEY — the position this ORDER BY used — and not
    // from the row fetch, which is a second read and could see a role change.
    const where = directoryWhere(serverId, qRaw, role);
    const keys = await prisma.$queryRaw<Array<{ user_id: string; rank: number; joined_at: Date }>>`
      SELECT sm.user_id, ${MEMBER_RANK} AS rank, sm.joined_at FROM server_members sm
      JOIN users u ON u.id = sm.user_id
      WHERE ${where}
        ${cursor ? Prisma.sql`AND (${MEMBER_RANK}, sm.joined_at, sm.user_id) > (${cursor.rank}::int, ${cursor.joinedAt}::timestamp, ${cursor.id})` : Prisma.empty}
      ORDER BY ${MEMBER_RANK}, sm.joined_at, sm.user_id
      LIMIT ${limit + 1}`;
    const hasMore = keys.length > limit;
    const pageKeys = keys.slice(0, limit);
    const ids = pageKeys.map((k) => k.user_id);

    const [rows, total] = await Promise.all([
      ids.length
        ? prisma.serverMember.findMany({ where: { serverId, userId: { in: ids } }, include: memberRowInclude })
        : Promise.resolve([] as MemberRow[]),
      // Unfiltered, the total is the server's inline count (maintained by the
      // two membership helpers); a filter needs its own count.
      qRaw || role
        ? prisma.$queryRaw<Array<{ n: number }>>`
            SELECT COUNT(*)::int AS n FROM server_members sm JOIN users u ON u.id = sm.user_id WHERE ${where}`
          .then((r) => r[0]?.n ?? 0)
        : prisma.server.findUnique({ where: { id: serverId }, select: { memberCount: true } }).then((srv) => srv?.memberCount ?? 0),
    ]);
    const byId = new Map(rows.map((r) => [r.userId, r]));
    const data = ids.map((id) => byId.get(id)).filter((r): r is MemberRow => r !== undefined).map(formatMemberRow);

    const lastKey = pageKeys[pageKeys.length - 1];
    const page: MemberDirectoryPage = {
      data,
      total: Math.max(total, data.length),
      hasMore,
      nextCursor: hasMore && lastKey
        ? encodeMemberCursor({ ...expected, rank: Number(lastKey.rank), joinedAt: new Date(lastKey.joined_at).toISOString(), id: lastKey.user_id })
        : null,
    };
    res.json({ success: true, ...page });
  } catch (err) {
    next(err);
  }
});

// The People panel's slice
serverRouter.get('/:serverId/members/online', rateLimitMemberRead, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const userId = req.user!.userId;
    const cap = MEMBER_LIST.PEOPLE_MAX_ROWS;

    // The membership check doubles as the viewer's own row: it is always on
    // the panel, whatever the DB says their status is right now.
    const me = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId, serverId } },
      include: memberRowInclude,
    });
    if (!me) throw new NotFoundError('Server');
    const server = await prisma.server.findUnique({ where: { id: serverId }, select: { memberCount: true } });
    if (!server) throw new NotFoundError('Server');

    const orderBy = [{ joinedAt: 'asc' }, { userId: 'asc' }] as const;
    let memberCount = server.memberCount;

    if (server.memberCount <= cap) {
      // Small server: everyone, offline included — take one more than the cap
      // so a count that lags the truth (it is corrected nightly) cannot hand
      // out a silently cut list; past the cap this falls through to the slice.
      const rows = await prisma.serverMember.findMany({ where: { serverId }, include: memberRowInclude, orderBy: [...orderBy], take: cap + 1 });
      if (rows.length <= cap) {
        const data = rows.map(formatMemberRow);
        const people: ServerPeople = {
          data,
          memberCount: data.length,
          onlineCount: data.filter((m) => m.user.status !== 'offline').length,
          full: true,
          truncated: false,
        };
        res.json({ success: true, ...people });
        return;
      }
      // The inline count was below the truth: carry what was just seen
      memberCount = Math.max(memberCount, rows.length);
    }

    // Big server: the online members only. Owner and admins first (they are
    // few and the panel's role colours make them the landmarks), then the
    // rest by join date up to the cap; the viewer is added if the cap cut
    // them or their status lags.
    const online = { status: { not: 'offline' } };
    const [staff, onlineCount] = await Promise.all([
      prisma.serverMember.findMany({ where: { serverId, role: { in: ['owner', 'admin'] }, user: online }, include: memberRowInclude, orderBy: [...orderBy], take: cap }),
      prisma.serverMember.count({ where: { serverId, user: online } }),
    ]);
    const rest = staff.length < cap
      ? await prisma.serverMember.findMany({ where: { serverId, role: 'member', user: online }, include: memberRowInclude, orderBy: [...orderBy], take: cap - staff.length })
      : [];
    const rows = [...staff, ...rest];
    if (!rows.some((r) => r.userId === userId)) rows.unshift(me);
    const people: ServerPeople = {
      data: rows.map(formatMemberRow),
      memberCount,
      onlineCount,
      full: false,
      truncated: onlineCount > staff.length + rest.length,
    };
    res.json({ success: true, ...people });
  } catch (err) {
    next(err);
  }
});

// Rows for a handful of ids (non-members are absent, never an error)
serverRouter.get('/:serverId/members/lookup', rateLimitMemberLookup, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
    const ids = [...new Set(raw.split(',').map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0 || ids.length > MEMBER_LIST.LOOKUP_MAX_IDS || ids.some((id) => !OPAQUE_ID_RE.test(id))) {
      throw new BadRequestError(`ids must name 1 to ${MEMBER_LIST.LOOKUP_MAX_IDS} users`);
    }

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new NotFoundError('Server');

    const rows = await prisma.serverMember.findMany({ where: { serverId, userId: { in: ids } }, include: memberRowInclude });
    res.json({ success: true, data: rows.map(formatMemberRow) });
  } catch (err) {
    next(err);
  }
});

// Search server members by username/displayName/nickname (mention autocomplete, member pickers)
serverRouter.get('/:serverId/members/search', rateLimitSearch, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q || q.length > MEMBER_LIST.QUERY_MAX) {
      res.json({ success: true, data: [] });
      return;
    }
    if (CONTROL_CHAR_RE.test(q)) throw new BadRequestError('Invalid search text');
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || MEMBER_LIST.SEARCH_DEFAULT, 1), MEMBER_LIST.SEARCH_MAX);

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new NotFoundError('Server');

    const members = await prisma.serverMember.findMany({
      where: {
        serverId,
        OR: [
          { user: { username: { contains: q, mode: 'insensitive' } } },
          { user: { displayName: { contains: q, mode: 'insensitive' } } },
          { nickname: { contains: q, mode: 'insensitive' } },
        ],
      },
      include: {
        user: {
          select: { id: true, username: true, displayName: true, avatarUrl: true, status: true },
        },
      },
      take: limit,
      orderBy: { joinedAt: 'asc' },
    });

    res.json({ success: true, data: members });
  } catch (err) {
    next(err);
  }
});

// NOTE: There is no POST /:serverId/join here. Every path that makes a user a
// member runs through utils/serverJoin.ts joinServerMember() — the invite
// (POST /invites/:code/join), the open-mode directory join and an approved
// join request (routes/discovery.ts, the approve route below) — which owns
// the ban, duplicate and maxMembers checks. invitesLocked is enforced on the
// invite path directly and on the directory paths through discoveryListed
// (a locked server is not listed). A bare join-by-id route bypassing the
// helper was HIGH-6 in the stabilization audit.

// Leave a server
serverRouter.post('/:serverId/leave', rateLimitMemberManage, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.user!.userId, serverId } },
    });
    if (!membership) throw new NotFoundError('Server membership');
    // A fast answer; the removal holds the same rule in its own delete, on
    // every attempt (a transfer to this member can commit in between)
    if (membership.role === 'owner') throw new ForbiddenError(OWNER_CANNOT_LEAVE_MESSAGE);

    // The teardown (voice eviction, secure-channel purge, read markers, the
    // membership + count transaction, member:left) is removeMemberFromServer's.
    // No ban: a voluntary leave can come back by invite or through Explore.
    await removeMemberFromServer(req.user!.userId, serverId);

    res.json({ success: true, message: 'Left server' });
  } catch (err) {
    next(err);
  }
});

// Update server settings (owner only)
serverRouter.patch('/:serverId', rateLimitMemberManage, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundError('Server');

    const canManageServer = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_SERVER);
    if (!canManageServer) throw new ForbiddenError('You do not have permission to manage server settings');

    const updateData: Record<string, unknown> = {};

    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string') throw new BadRequestError('name must be a string');
      const name = sanitizeText(req.body.name);
      const nameErr = validateServerName(name);
      if (nameErr) throw new BadRequestError(nameErr);
      updateData.name = name;
    }

    let adoptedIconKey: string | null = null;
    if (req.body.iconUrl !== undefined) {
      let { iconUrl } = req.body;
      if (iconUrl !== null) {
        if (typeof iconUrl !== 'string' || !VALID_S3_KEY_RE.test(iconUrl)) {
          throw new BadRequestError('Invalid icon key');
        }
        if (!iconUrl.startsWith(`server-icons/${serverId}-`)) {
          throw new BadRequestError('Invalid icon key');
        }
        // First reference of a new icon object: the space stores a verified
        // server-side copy (size cap, image header) under a key no upload URL
        // was issued for, never the uploaded key. The current key was adopted
        // when it was set.
        if (iconUrl !== server.iconUrl) {
          iconUrl = adoptedIconKey = await adoptImageAssetUpload(iconUrl, `server-icons/${serverId}-`, LIMITS.MAX_SERVER_ICON_SIZE, 'Invalid icon key');
        }
      }
      updateData.iconUrl = iconUrl;
    }

    if (Object.keys(updateData).length === 0) {
      throw new BadRequestError('No fields to update');
    }

    const oldIconUrl = server.iconUrl;

    let updated;
    try {
      updated = await prisma.server.update({
        where: { id: serverId },
        select: serverSelect,
        data: updateData,
      });
    } catch (err) {
      // The space never stored the adopted copy: nothing else will reference it
      if (adoptedIconKey) {
        const key = adoptedIconKey;
        deleteFromS3(key).catch((delErr) => console.warn(`[S3] Failed to delete unreferenced icon copy ${key}:`, delErr instanceof Error ? delErr.message : delErr));
      }
      throw err;
    }

    // Delete old icon from S3 after DB update confirmed
    if (updateData.iconUrl !== undefined && oldIconUrl && oldIconUrl !== updateData.iconUrl) {
      deleteFromS3(oldIconUrl).catch((err) => console.warn('[S3] Failed to delete old asset:', err));
    }

    // The name and the icon are on the Explore card (never throws)
    await bumpDiscoveryPageCache('server update');

    getIO().to(`server:${serverId}`).emit(WS_EVENTS.SERVER_UPDATED, updated as unknown as Server);

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// Toggle invites lock (owner or admin)
serverRouter.patch('/:serverId/invites-lock', rateLimitMemberManage, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const { locked } = req.body;

    if (typeof locked !== 'boolean') throw new BadRequestError('Provide a boolean "locked" value');

    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundError('Server');

    const canManageServer = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_SERVER);
    if (!canManageServer) throw new ForbiddenError('You do not have permission to manage server settings');

    const updated = await prisma.server.update({
      where: { id: serverId },
      select: serverSelect,
      data: { invitesLocked: locked },
    });

    // invitesLocked is one of the four inputs of the directory's materialised
    // eligibility column: locked means "not taking members", so the server
    // leaves Explore (and comes back on unlock). Never throws.
    await recomputeListed(serverId);

    getIO().to(`server:${serverId}`).emit(WS_EVENTS.SERVER_UPDATED, updated as unknown as Server);

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// Delete a server (owner only)
serverRouter.delete('/:serverId', rateLimitMemberManage, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundError('Server');
    if (server.ownerId !== req.user!.userId) throw new ForbiddenError('Only the server owner can delete it');

    // The row first, then voice, the notice, the room leaves and the icon
    // blob, each best effort (utils/serverDeletion.ts, shared with the admin
    // deletes): a fan-out step that throws no longer leaves members told the
    // space is gone while it is still there.
    await deleteServerAndAnnounce(server, { cacheReason: 'server delete', logPrefix: '[Servers]' });

    res.json({ success: true, message: 'Server deleted' });
  } catch (err) {
    next(err);
  }
});

// Change member role (owner only)
serverRouter.patch(
  '/:serverId/members/:memberId/role',
  rateLimitMemberManage,
  async (req: Request<{ serverId: string; memberId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, memberId } = req.params;
      const { role: newRole } = req.body as { role: string };

      if (!newRole || (newRole !== 'admin' && newRole !== 'member')) {
        throw new BadRequestError('role must be "admin" or "member"');
      }

      const actorMembership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.user!.userId, serverId } },
      });
      if (!actorMembership) throw new NotFoundError('Server');
      if (actorMembership.role !== 'owner') throw new ForbiddenError('Only the server owner can change roles');

      if (memberId === req.user!.userId) throw new BadRequestError('Cannot change your own role');

      const targetMembership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: memberId, serverId } },
      });
      if (!targetMembership) throw new NotFoundError('Member');
      if (targetMembership.role === 'owner') throw new ForbiddenError('Cannot change the owner\'s role');

      await prisma.serverMember.update({
        where: { userId_serverId: { userId: memberId, serverId } },
        data: { role: newRole },
      });

      getIO().to(`server:${serverId}`).emit(WS_EVENTS.MEMBER_ROLE_UPDATED, {
        serverId,
        userId: memberId,
        role: newRole as MemberRole,
      });

      res.json({ success: true, message: `Role updated to ${newRole}` });
    } catch (err) {
      next(err);
    }
  }
);

// Remove a member AND ban them (owner or admin, must outrank target).
// Every removal is a ban since server discovery: the undo is the unban below.
// The path stays /kick — the client already calls it; only the label changed.
serverRouter.post(
  '/:serverId/members/:memberId/kick',
  rateLimitMemberManage,
  async (req: Request<{ serverId: string; memberId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, memberId } = req.params;

      if (memberId === req.user!.userId) throw new BadRequestError('Cannot kick yourself');

      // Optional ban reason, shown to the moderators in the Banned section.
      // Validated before any permission work so a bad body is a cheap 400.
      // (Express 5: req.body is undefined when no JSON body was sent.)
      let reason: string | null = null;
      const rawReason: unknown = req.body?.reason;
      if (rawReason !== undefined && rawReason !== null) {
        if (typeof rawReason !== 'string') throw new BadRequestError('reason must be a string');
        const sanitized = sanitizeText(rawReason);
        const reasonErr = validateBanReason(sanitized);
        if (reasonErr) throw new BadRequestError(reasonErr);
        reason = sanitized.length > 0 ? sanitized : null;
      }

      const actorId = req.user!.userId;
      const assertMayKick = async () => {
        const canKick = await hasServerPermission(actorId, serverId, Permissions.KICK_MEMBERS);
        if (!canKick) throw new ForbiddenError('You do not have permission to kick members');
        // Role hierarchy check: actor must outrank target
        const actorHighest = await getHighestRolePosition(actorId, serverId);
        const targetHighest = await getHighestRolePosition(memberId, serverId);
        if (actorHighest <= targetHighest) throw new ForbiddenError(KICK_OUTRANKED_MESSAGE);
      };

      const canKick = await hasServerPermission(actorId, serverId, Permissions.KICK_MEMBERS);
      if (!canKick) throw new ForbiddenError('You do not have permission to kick members');

      const targetMembership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: memberId, serverId } },
      });
      if (!targetMembership) throw new NotFoundError('Member');

      await assertMayKick();

      // The teardown — voice eviction, secure-channel state, read markers,
      // and one transaction with the ban row, the join-request delete, the
      // membership delete and the member count — lives in
      // removeMemberFromServer, nowhere else. The permission and the
      // hierarchy are checked again inside its transaction, on every attempt
      // (`authorize`): a retried removal must not act on a check made before
      // a role change committed.
      await removeMemberFromServer(memberId, serverId, { ban: { by: actorId, reason }, authorize: assertMayKick });

      // Emit member:kicked directly to the kicked user's per-user room
      // (they're already out of the server room)
      getIO().to(`user:${memberId}`).emit(WS_EVENTS.MEMBER_KICKED, { serverId, userId: memberId });

      res.json({ success: true, message: 'Member removed and banned' });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Server bans (every removal is a ban; unban is the undo) ─────────────────
// Server-level moderation stays out of the platform audit log, as kicks do.

// List bans (KICK_MEMBERS)
serverRouter.get('/:serverId/bans', rateLimitMemberRead, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(LIMITS.MEMBERS_PER_PAGE, Math.max(1, parseInt(req.query.limit as string, 10) || LIMITS.MEMBERS_PER_PAGE));

    const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.KICK_MEMBERS);
    if (!canManage) throw new ForbiddenError('You do not have permission to manage members');

    const [bans, total] = await Promise.all([
      prisma.serverBan.findMany({
        where: { serverId },
        include: {
          user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          bannedBy: { select: { id: true, username: true, displayName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.serverBan.count({ where: { serverId } }),
    ]);

    res.json({
      success: true,
      data: bans.map(formatBan),
      total,
      page,
      limit,
      hasMore: page * limit < total,
    });
  } catch (err) {
    next(err);
  }
});

// Unban (KICK_MEMBERS). The user can then join again by invite, directly or
// by request — nothing is restored, the door is simply open.
serverRouter.delete(
  '/:serverId/bans/:userId',
  rateLimitMemberManage,
  async (req: Request<{ serverId: string; userId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, userId } = req.params;

      const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.KICK_MEMBERS);
      if (!canManage) throw new ForbiddenError('You do not have permission to manage members');

      const { count } = await prisma.serverBan.deleteMany({ where: { serverId, userId } });
      if (count === 0) throw new NotFoundError('Ban');

      res.json({ success: true, message: 'Member unbanned' });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Server discovery: the owner side ────────────────────────────────────────

// Discovery profile and switches (MANAGE_SERVER): "Listed in Explore", who
// can join, description, tags. No stats recompute on write — a relisted
// server shows its last daily figures and joins the next cycle.
// The owner's Discovery tab: the listing state, the curation stamps and the
// figures behind the card. MANAGE_SERVER only — a member gets the Server
// shape from GET /:serverId and never the platform admin's curation state.
serverRouter.get('/:serverId/discovery', rateLimitMemberRead, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const canManageServer = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_SERVER);
    if (!canManageServer) throw new ForbiddenError('You do not have permission to manage server settings');

    const server = await prisma.server.findUnique({
      where: { id: serverId },
      select: {
        onlineCount: true, weeklyMessages: true, statsRefreshedAt: true, activityScore: true,
        discoveryListed: true, discoveryBlockedAt: true, featuredAt: true,
        // the authoritative count, not the inline ranking column
        _count: { select: { members: true } },
      },
    });
    if (!server) throw new NotFoundError('Server');

    // The badge and what the next one takes, from the same cuts the cards use
    const cuts = await getTierThresholds();
    res.json({
      success: true,
      data: {
        memberCount: server._count.members,
        onlineCount: server.onlineCount,
        weeklyMessages: server.weeklyMessages,
        statsRefreshedAt: server.statsRefreshedAt,
        discoveryListed: server.discoveryListed,
        discoveryBlockedAt: server.discoveryBlockedAt,
        featuredAt: server.featuredAt,
        activityScore: server.activityScore,
        tier: tierOf(server.activityScore, cuts),
        nextTier: nextTierFor(server.activityScore, cuts),
        tiersAvailable: !!cuts?.thresholds,
        tierThresholds: cuts?.thresholds ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

serverRouter.patch('/:serverId/discovery', rateLimitMemberManage, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;

    const server = await prisma.server.findUnique({
      where: { id: serverId },
      select: { id: true, discoveryBlockedAt: true },
    });
    if (!server) throw new NotFoundError('Server');

    const canManageServer = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_SERVER);
    if (!canManageServer) throw new ForbiddenError('You do not have permission to manage server settings');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const updateData: { discoverable?: boolean; joinMode?: string; description?: string | null; tags?: string[] } = {};

    if (body.discoverable !== undefined) {
      if (typeof body.discoverable !== 'boolean') throw new BadRequestError('discoverable must be a boolean');
      // Block is the operator's last word: the owner cannot relist until unblocked.
      if (body.discoverable && server.discoveryBlockedAt) throw new ForbiddenError('Listing is disabled by an administrator');
      updateData.discoverable = body.discoverable;
    }
    if (body.joinMode !== undefined) {
      if (typeof body.joinMode !== 'string' || !(SERVER_JOIN_MODES as readonly string[]).includes(body.joinMode)) {
        throw new BadRequestError('joinMode must be "approval" or "open"');
      }
      updateData.joinMode = body.joinMode;
    }
    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') throw new BadRequestError('description must be a string');
      const sanitized = body.description === null ? '' : sanitizeText(body.description);
      const descErr = validateServerDescription(sanitized);
      if (descErr) throw new BadRequestError(descErr);
      updateData.description = sanitized.length > 0 ? sanitized : null;
    }
    if (body.tags !== undefined) {
      const tagsErr = validateDiscoveryTags(body.tags);
      if (tagsErr) throw new BadRequestError(tagsErr);
      updateData.tags = dedupeDiscoveryTags(body.tags as string[]);
    }
    if (Object.keys(updateData).length === 0) throw new BadRequestError('No fields to update');

    const updated = await prisma.server.update({
      where: { id: serverId },
      select: serverSelect,
      data: updateData,
    });

    // discoverable is one of the listing column's four inputs (never throws);
    // description, tags and join mode are on the card, so the pages are
    // bumped whether or not the listing flipped (never throws either)
    await recomputeListed(serverId);
    await bumpDiscoveryPageCache('discovery profile update');

    getIO().to(`server:${serverId}`).emit(WS_EVENTS.SERVER_UPDATED, updated as unknown as Server);

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// Pending join requests, oldest first (KICK_MEMBERS)
serverRouter.get('/:serverId/join-requests', rateLimitMemberRead, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(LIMITS.MEMBERS_PER_PAGE, Math.max(1, parseInt(req.query.limit as string, 10) || LIMITS.MEMBERS_PER_PAGE));

    const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.KICK_MEMBERS);
    if (!canManage) throw new ForbiddenError('You do not have permission to manage members');

    const where = { serverId, status: 'pending' } as const;
    const [requests, total] = await Promise.all([
      prisma.serverJoinRequest.findMany({
        where,
        include: { user: { select: requestUserSelect } },
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.serverJoinRequest.count({ where }),
    ]);

    res.json({
      success: true,
      data: requests.map(formatJoinRequest),
      total,
      page,
      limit,
      hasMore: page * limit < total,
    });
  } catch (err) {
    next(err);
  }
});

// Approve a join request (KICK_MEMBERS): the join helper runs with the row
// delete as its extra write, so ban, member-limit and duplicate checks all
// apply at approval time, and a double approval fails on the missing row.
serverRouter.post(
  '/:serverId/join-requests/:userId/approve',
  rateLimitMemberManage,
  async (req: Request<{ serverId: string; userId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, userId } = req.params;

      const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.KICK_MEMBERS);
      if (!canManage) throw new ForbiddenError('You do not have permission to manage members');

      const request = await prisma.serverJoinRequest.findUnique({
        where: { serverId_userId: { serverId, userId } },
        select: { id: true, status: true },
      });
      if (!request || request.status !== 'pending') throw new NotFoundError('Join request');

      try {
        await joinServerMember(userId, serverId, {
          via: 'approval',
          // status in the where: a decline that commits between the read
          // above and this transaction leaves a row this delete must NOT
          // find, so the approval fails instead of admitting a declined user
          extraWrites: [prisma.serverJoinRequest.delete({ where: { id: request.id, status: 'pending' } })],
        });
      } catch (err) {
        const e = err as { code?: unknown; statusCode?: unknown; message?: unknown };
        // P2025 = the row was cancelled, declined or approved by someone else meanwhile
        if (e?.code === 'P2025') throw new NotFoundError('Join request');
        // The requester came in by another door (an invite, an ownership
        // transfer) and the sweep that takes the row with them raced this
        // request, or never ran: the row is stale, the membership is not.
        // Settle it here so the Members tab stops offering it.
        if (e?.statusCode === 400 && typeof e.message === 'string' && e.message.startsWith('You are already a member')) {
          await prisma.serverJoinRequest.deleteMany({ where: { serverId, userId, status: 'pending' } });
          await emitToModerators(serverId, WS_EVENTS.SERVER_JOIN_REQUEST_RESOLVED, { serverId, userId, outcome: 'joined' });
          res.json({ success: true, message: 'Join request resolved: already a member' });
          return;
        }
        throw err;
      }

      const server = await prisma.server.findUnique({ where: { id: serverId }, select: serverSelect });
      const io = getIO();
      if (server) {
        io.to(`user:${userId}`).emit(WS_EVENTS.SERVER_JOIN_APPROVED, { server: server as unknown as Server });
      }
      await emitToModerators(serverId, WS_EVENTS.SERVER_JOIN_REQUEST_RESOLVED, { serverId, userId, outcome: 'approved' });

      res.json({ success: true, message: 'Join request approved' });
    } catch (err) {
      next(err);
    }
  }
);

// Decline a join request (KICK_MEMBERS). The row stays as the cooldown
// marker; the sweep removes it after JOIN_REQUEST_DECLINE_COOLDOWN_DAYS.
serverRouter.post(
  '/:serverId/join-requests/:userId/decline',
  rateLimitMemberManage,
  async (req: Request<{ serverId: string; userId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, userId } = req.params;

      const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.KICK_MEMBERS);
      if (!canManage) throw new ForbiddenError('You do not have permission to manage members');

      const { count } = await prisma.serverJoinRequest.updateMany({
        where: { serverId, userId, status: 'pending' },
        data: { status: 'declined', decidedById: req.user!.userId, decidedAt: new Date() },
      });
      if (count === 0) throw new NotFoundError('Join request');

      const server = await prisma.server.findUnique({ where: { id: serverId }, select: { name: true } });
      getIO().to(`user:${userId}`).emit(WS_EVENTS.SERVER_JOIN_DECLINED, { serverId, serverName: server?.name ?? '' });
      await emitToModerators(serverId, WS_EVENTS.SERVER_JOIN_REQUEST_RESOLVED, { serverId, userId, outcome: 'declined' });

      res.json({ success: true, message: 'Join request declined' });
    } catch (err) {
      next(err);
    }
  }
);

// Set own nickname (requires CHANGE_NICKNAME permission)
serverRouter.patch(
  '/:serverId/nickname',
  rateLimitMemberManage,
  async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId } = req.params;
      const { nickname } = req.body as { nickname: string | null };

      const membership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.user!.userId, serverId } },
      });
      if (!membership) throw new NotFoundError('Server');

      // Setting to null (clearing) always allowed; setting a new nickname requires permission
      if (nickname !== null) {
        const canChange = await hasServerPermission(req.user!.userId, serverId, Permissions.CHANGE_NICKNAME);
        if (!canChange) throw new ForbiddenError('You do not have permission to change your nickname');

        if (typeof nickname !== 'string') throw new BadRequestError('nickname must be a string');
        const sanitized = sanitizeText(nickname);
        const err = validateNickname(sanitized);
        if (err) throw new BadRequestError(err);

        await prisma.serverMember.update({
          where: { userId_serverId: { userId: req.user!.userId, serverId } },
          data: { nickname: sanitized },
        });

        getIO().to(`server:${serverId}`).emit(WS_EVENTS.MEMBER_NICKNAME_UPDATED, {
          serverId,
          userId: req.user!.userId,
          nickname: sanitized,
        });

        res.json({ success: true, data: { nickname: sanitized } });
      } else {
        await prisma.serverMember.update({
          where: { userId_serverId: { userId: req.user!.userId, serverId } },
          data: { nickname: null },
        });

        getIO().to(`server:${serverId}`).emit(WS_EVENTS.MEMBER_NICKNAME_UPDATED, {
          serverId,
          userId: req.user!.userId,
          nickname: null,
        });

        res.json({ success: true, data: { nickname: null } });
      }
    } catch (err) {
      next(err);
    }
  }
);

// Set another member's nickname (requires MANAGE_NICKNAMES permission)
serverRouter.patch(
  '/:serverId/members/:memberId/nickname',
  rateLimitMemberManage,
  async (req: Request<{ serverId: string; memberId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId, memberId } = req.params;
      const { nickname } = req.body as { nickname: string | null };

      const canManage = await hasServerPermission(req.user!.userId, serverId, Permissions.MANAGE_NICKNAMES);
      if (!canManage) throw new ForbiddenError('You do not have permission to manage nicknames');

      const targetMember = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: memberId, serverId } },
      });
      if (!targetMember) throw new NotFoundError('Member');

      // Hierarchy check: can't manage nicknames of users with equal/higher roles
      const actorHighest = await getHighestRolePosition(req.user!.userId, serverId);
      const targetHighest = await getHighestRolePosition(memberId, serverId);
      if (actorHighest <= targetHighest && actorHighest !== Infinity) {
        throw new ForbiddenError('Cannot manage the nickname of a member with an equal or higher role');
      }

      let sanitized: string | null = null;
      if (nickname !== null) {
        if (typeof nickname !== 'string') throw new BadRequestError('nickname must be a string');
        sanitized = sanitizeText(nickname);
        const err = validateNickname(sanitized);
        if (err) throw new BadRequestError(err);
      }

      await prisma.serverMember.update({
        where: { userId_serverId: { userId: memberId, serverId } },
        data: { nickname: sanitized },
      });

      getIO().to(`server:${serverId}`).emit(WS_EVENTS.MEMBER_NICKNAME_UPDATED, {
        serverId,
        userId: memberId,
        nickname: sanitized,
      });

      res.json({ success: true, data: { nickname: sanitized } });
    } catch (err) {
      next(err);
    }
  }
);

// Transfer ownership (owner only)
serverRouter.post(
  '/:serverId/transfer-ownership',
  rateLimitMemberManage,
  async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
    try {
      const { serverId } = req.params;
      const { targetUserId } = req.body as { targetUserId: string };

      if (!targetUserId || typeof targetUserId !== 'string') throw new BadRequestError('targetUserId is required');
      if (targetUserId === req.user!.userId) throw new BadRequestError('Cannot transfer ownership to yourself');

      const actorMembership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.user!.userId, serverId } },
      });
      if (!actorMembership) throw new NotFoundError('Server');
      if (actorMembership.role !== 'owner') throw new ForbiddenError('Only the server owner can transfer ownership');

      const targetMembership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: targetUserId, serverId } },
      });
      if (!targetMembership) throw new NotFoundError('Target member');

      // A platform ban keeps the membership row (the admin ban route only
      // broadcasts member:left), so a banned member is still a valid target
      // here unless we look. The admin transfer path refuses the same; a
      // banned owner would hide the server from the directory on the next
      // recompute, which is not what the transferring owner asked for.
      const targetUser = await prisma.user.findUnique({ where: { id: targetUserId }, select: { bannedAt: true } });
      if (targetUser?.bannedAt) throw new BadRequestError('Cannot transfer ownership to a banned user');

      // The space row, then the two member rows: the reverse of a removal or
      // an account deletion of the heir, so PostgreSQL may abort the batch to
      // break a deadlock; it then runs again. The checks above are carried by
      // the statements themselves, so they hold on every attempt: the space
      // row only while the actor still owns it, the actor's row only while it
      // is the owner's, the heir's row only while they are a member (P2025
      // otherwise, or P2003 when the heir's account is gone).
      const actorId = req.user!.userId;
      try {
        await retryOnTransactionConflict(() => prisma.$transaction([
          prisma.server.update({ where: { id: serverId, ownerId: actorId }, data: { ownerId: targetUserId } }),
          prisma.serverMember.update({
            where: { userId_serverId: { userId: targetUserId, serverId } },
            data: { role: 'owner' },
          }),
          prisma.serverMember.update({
            where: { userId_serverId: { userId: actorId, serverId }, role: 'owner' },
            data: { role: 'admin' },
          }),
        ]), `[Servers] The transfer of space ${serverId}`);
      } catch (err) {
        const code = (err as { code?: unknown })?.code;
        if (code !== 'P2025' && code !== 'P2003') throw err;
        // Something the checks above saw changed before this attempt: answer
        // what they would answer now
        const [space, heir] = await Promise.all([
          prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } }),
          prisma.serverMember.findUnique({ where: { userId_serverId: { userId: targetUserId, serverId } }, select: { userId: true } }),
        ]);
        if (!space) throw new NotFoundError('Server');
        if (space.ownerId !== actorId) throw new ForbiddenError('Only the server owner can transfer ownership');
        if (!heir) throw new NotFoundError('Target member');
        throw err;
      }

      // ownerId decides WHOSE ban state is one of the listing column's four
      // inputs — recompute after the commit (never throws).
      await recomputeListed(serverId);

      const io = getIO();

      // `server.ownerId` is the pivot of every visibility calculator's owner
      // fast path, so this transfer changes VIEW_CHANNEL for two users at once:
      // the new owner can now see every channel and the old one drops to what
      // their roles grant. channel:{id} rooms are only computed at connect, so
      // without a resync the old owner keeps receiving messages, typing and
      // voice presence for staff-only channels they can no longer view, and
      // the new owner misses every channel-scoped lifecycle event until they
      // reconnect. Two user-scoped recomputes, after the transaction commits
      // (the util re-reads ownerId).
      void syncChannelVisibilityRooms(serverId, { userId: targetUserId });
      void syncChannelVisibilityRooms(serverId, { userId: req.user!.userId });

      // Emit role updates for both users
      io.to(`server:${serverId}`).emit(WS_EVENTS.MEMBER_ROLE_UPDATED, {
        serverId,
        userId: targetUserId,
        role: 'owner' as MemberRole,
      });
      io.to(`server:${serverId}`).emit(WS_EVENTS.MEMBER_ROLE_UPDATED, {
        serverId,
        userId: req.user!.userId,
        role: 'admin' as MemberRole,
      });

      // Emit server:updated with new ownerId
      const updatedServer = await prisma.server.findUnique({
        where: { id: serverId },
        select: serverSelect,
      });
      if (updatedServer) {
        io.to(`server:${serverId}`).emit(WS_EVENTS.SERVER_UPDATED, updatedServer as unknown as Server);
      }

      res.json({ success: true, message: 'Ownership transferred' });
    } catch (err) {
      next(err);
    }
  }
);
