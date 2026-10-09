import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, requireVerifiedEmail, requireConsent } from '../middleware/auth';
import { rateLimitDiscoveryBrowse, rateLimitDiscoveryJoin } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { getRedis } from '../utils/redis';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { sanitizeText } from '../utils/sanitize';
import { isFeatureEnabled } from '../utils/featureFlags';
import { joinServerMember } from '../utils/serverJoin';
import { serverSelect } from '../utils/serverSelect';
import { emitToModerators } from '../utils/moderatorAudience';
import { encodeDiscoveryCursor, decodeDiscoveryCursor, hashDiscoveryQuery } from '../utils/discoveryCursor';
import {
  DISCOVERY_PAGE_SIZE,
  DISCOVERY_MAX_PAGE_SIZE,
  DISCOVERY_MAX_PAGES,
  DISCOVERY_TOTAL_CAP,
  DISCOVERY_SORTS,
  JOIN_REQUEST_DECLINE_COOLDOWN_DAYS,
  WS_EVENTS,
  isDiscoveryTag,
  validateDiscoveryQuery,
  validateJoinRequestMessage,
} from '@voxium/shared';
import type { DiscoveryServer, DiscoveryPage, DiscoverySort, ServerJoinMode, ServerJoinRequest } from '@voxium/shared';
import { Prisma } from '../generated/prisma/client';

export const discoveryRouter = Router();

discoveryRouter.use(authenticate, requireVerifiedEmail, requireConsent);

// The kill switch: off turns the whole directory off cluster-wide. Invites,
// bans and existing memberships are unaffected; profiles and pending requests
// are kept for when it returns.
discoveryRouter.use((_req: Request, _res: Response, next: NextFunction) => {
  if (!isFeatureEnabled('server_discovery')) {
    next(new ForbiddenError('Server discovery is currently disabled'));
    return;
  }
  next();
});

/** Page cache TTL — the public part of a page; per-user flags are never cached. */
export const DISCOVERY_PAGE_CACHE_TTL_S = 60;

/** Exactly the columns a card shows (plus featuredAt → `featured`). */
const cardSelect = {
  id: true, name: true, iconUrl: true, description: true, tags: true,
  memberCount: true, onlineCount: true, weeklyMessages: true, joinMode: true,
  featuredAt: true, createdAt: true, statsRefreshedAt: true,
} as const;

type CardRow = {
  id: string; name: string; iconUrl: string | null; description: string | null; tags: string[];
  memberCount: number; onlineCount: number; weeklyMessages: number; joinMode: string;
  featuredAt: Date | null; createdAt: Date; statsRefreshedAt: Date | null;
};

/** The cacheable part of a card: everything but the two per-user flags. */
type PublicCard = Omit<DiscoveryServer, 'isMember' | 'requestPending'>;

interface PublicPage {
  featured: PublicCard[];
  servers: PublicCard[];
  nextCursor: string | null;
  totalCapped: number;
}

function toPublicCard(row: CardRow): PublicCard {
  return {
    id: row.id,
    name: row.name,
    iconUrl: row.iconUrl,
    description: row.description,
    tags: row.tags,
    memberCount: row.memberCount,
    onlineCount: row.onlineCount,
    weeklyMessages: row.weeklyMessages,
    joinMode: row.joinMode as ServerJoinMode,
    featured: row.featuredAt !== null,
    createdAt: row.createdAt.toISOString(),
    statsRefreshedAt: row.statsRefreshedAt ? row.statsRefreshedAt.toISOString() : null,
  };
}

/** One index per sort, each ending in id so the keyset cursor is one range scan. */
function orderFor(sort: DiscoverySort): Prisma.ServerOrderByWithRelationInput[] {
  switch (sort) {
    case 'members': return [{ memberCount: 'desc' }, { id: 'desc' }];
    case 'newest': return [{ createdAt: 'desc' }, { id: 'desc' }];
    case 'name': return [{ name: 'asc' }, { id: 'asc' }];
    case 'active':
    default: return [{ activityScore: 'desc' }, { id: 'desc' }];
  }
}

/** ILIKE pattern for the capped total's raw count — `%`, `_` and `\` escaped (Prisma escapes its own `contains`). */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, '\\$&')}%`;
}

/** The ORDER BY of each sort's index, for the capped count's planner hint. */
const COUNT_ORDER: Record<DiscoverySort, Prisma.Sql> = {
  active: Prisma.sql`ORDER BY discovery_activity_score DESC, id DESC`,
  members: Prisma.sql`ORDER BY member_count DESC, id DESC`,
  newest: Prisma.sql`ORDER BY created_at DESC, id DESC`,
  name: Prisma.sql`ORDER BY name ASC, id ASC`,
};

/**
 * Never a full count: COUNT over a subquery limited to CAP + 1 rows. The
 * client shows "1,000+" above the cap.
 *
 * The shape differs per filter combination because a bare `LIMIT 1001`
 * subquery lets the planner pick a sequential scan whenever it expects
 * matches to be dense (an unfiltered page, a common search word), and a
 * scan that stops early on a dense estimate is a full scan on a wrong one.
 * Measured at one million listed servers (scripts/measure-discovery.ts):
 *  - no query: ORDER BY the sort's index → index-only scan, stops at 1,001;
 *    a tag filter rides it as a filter (≈ 20 ms for the most common tag);
 *  - a query: ORDER BY (name, id) → the covering name index with the ILIKE
 *    as its filter for common words (≈ 13 ms), the trigram bitmap for rare
 *    ones (≈ 3 ms) — through the activity index the same count read heap
 *    rows for 130 ms;
 *  - a query AND a tag: a plain count, capped in code — the planner answers
 *    it with the trigram bitmap and the tag as a filter (≈ 60 ms even for a
 *    three-letter fragment), while every ordered LIMIT form walked a sort
 *    index for half a second.
 */
async function countCapped(q: string, tag: string, sort: DiscoverySort): Promise<number> {
  if (q && tag) {
    const rows = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM servers
      WHERE discovery_listed = true AND name ILIKE ${likePattern(q)} AND ${tag} = ANY(tags)`;
    return Math.min(rows[0]?.n ?? 0, DISCOVERY_TOTAL_CAP + 1);
  }
  const order = q ? COUNT_ORDER.name : COUNT_ORDER[sort];
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM (
      SELECT 1 FROM servers
      WHERE discovery_listed = true
        ${q ? Prisma.sql`AND name ILIKE ${likePattern(q)}` : Prisma.empty}
        ${tag ? Prisma.sql`AND ${tag} = ANY(tags)` : Prisma.empty}
      ${order}
      LIMIT ${DISCOVERY_TOTAL_CAP + 1}
    ) t`;
  return rows[0]?.n ?? 0;
}

function parseLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return DISCOVERY_PAGE_SIZE;
  return Math.min(n, DISCOVERY_MAX_PAGE_SIZE);
}

/** The card payload with the caller's two flags resolved: isMember, requestPending. */
async function withUserFlags(userId: string, cards: PublicCard[]): Promise<DiscoveryServer[]> {
  if (cards.length === 0) return [];
  const ids = cards.map((c) => c.id);
  const [memberships, requests] = await Promise.all([
    prisma.serverMember.findMany({ where: { userId, serverId: { in: ids } }, select: { serverId: true } }),
    prisma.serverJoinRequest.findMany({ where: { userId, serverId: { in: ids }, status: 'pending' }, select: { serverId: true } }),
  ]);
  const member = new Set(memberships.map((m) => m.serverId));
  const pending = new Set(requests.map((r) => r.serverId));
  return cards.map((c) => ({ ...c, isMember: member.has(c.id), requestPending: pending.has(c.id) }));
}

// ─── Browse ─────────────────────────────────────────────────────────────────

discoveryRouter.get('/servers', rateLimitDiscoveryBrowse, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      const qErr = validateDiscoveryQuery(q);
      if (qErr) throw new BadRequestError(qErr);
    }
    const rawTag = typeof req.query.tag === 'string' ? req.query.tag : '';
    if (rawTag && !isDiscoveryTag(rawTag)) throw new BadRequestError('Unknown tag');
    const tag = rawTag;
    const rawSort = typeof req.query.sort === 'string' ? req.query.sort : 'active';
    if (!(DISCOVERY_SORTS as readonly string[]).includes(rawSort)) throw new BadRequestError('Unknown sort');
    const sort = rawSort as DiscoverySort;
    const limit = parseLimit(req.query.limit);
    const qHash = hashDiscoveryQuery(q);

    const cursorToken = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : '';
    const cursor = cursorToken ? decodeDiscoveryCursor(cursorToken, { sort, tag, q: qHash }) : null;
    if (cursorToken && !cursor) throw new BadRequestError('Invalid cursor');
    if (cursor && cursor.page > DISCOVERY_MAX_PAGES) throw new BadRequestError('Refine your search');
    const page = cursor ? cursor.page : 1;

    // The public part of the page is shared by every viewer for a minute —
    // this is what absorbs the burst when a popular server links to Explore.
    const cacheKey = `discovery:page:${sort}:${tag}:${qHash}:${cursorToken}:${limit}`;
    let publicPage: PublicPage | null = null;
    try {
      const cached = await getRedis().get(cacheKey);
      if (cached) publicPage = JSON.parse(cached) as PublicPage;
    } catch (err) {
      console.warn('[Discovery] Page cache read failed (serving uncached):', err instanceof Error ? err.message : err);
    }

    if (!publicPage) {
      const where: Prisma.ServerWhereInput = {
        // discoveryListed alone — materialised eligibility, no joins, no ORs
        discoveryListed: true,
        ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
        ...(tag ? { tags: { has: tag } } : {}),
      };

      const [rows, featuredRows, totalCapped] = await Promise.all([
        prisma.server.findMany({
          where,
          orderBy: orderFor(sort),
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
          select: cardSelect,
        }),
        // Featured only on the first page without a query: a separate row,
        // never mixed into the ranked list. A tag filter still applies.
        page === 1 && !q
          ? prisma.server.findMany({
              where: { discoveryListed: true, featuredAt: { not: null }, ...(tag ? { tags: { has: tag } } : {}) },
              orderBy: [{ featuredAt: 'desc' }, { id: 'desc' }],
              take: DISCOVERY_PAGE_SIZE,
              select: cardSelect,
            })
          : Promise.resolve([] as CardRow[]),
        countCapped(q, tag, sort),
      ]);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const last = pageRows[pageRows.length - 1];
      // No cursor is issued past the depth cap — the answer there is "refine
      // your search", and the client never has to be told twice.
      const nextCursor = hasMore && last && page + 1 <= DISCOVERY_MAX_PAGES
        ? encodeDiscoveryCursor({ sort, tag, q: qHash, id: last.id, page: page + 1 })
        : null;

      publicPage = {
        featured: featuredRows.map(toPublicCard),
        servers: pageRows.map(toPublicCard),
        nextCursor,
        totalCapped,
      };
      try {
        await getRedis().set(cacheKey, JSON.stringify(publicPage), { EX: DISCOVERY_PAGE_CACHE_TTL_S });
      } catch (err) {
        console.warn('[Discovery] Page cache write failed:', err instanceof Error ? err.message : err);
      }
    }

    // isMember / requestPending are the caller's, never cached: two IN (ids)
    // lookups on primary keys per page.
    const [featured, servers] = await Promise.all([
      withUserFlags(req.user!.userId, publicPage.featured),
      withUserFlags(req.user!.userId, publicPage.servers),
    ]);
    const data: DiscoveryPage = { featured, servers, nextCursor: publicPage.nextCursor, totalCapped: publicPage.totalCapped };
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// ─── One card ───────────────────────────────────────────────────────────────

/**
 * Opacity: a hidden server answers exactly like a nonexistent one, on every
 * directory endpoint (card, join, request, cancel) — byte-identical body.
 * Returns the card row (what every one of them needs at most).
 */
async function listedServerOrThrow(serverId: string): Promise<CardRow> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { ...cardSelect, discoveryListed: true },
  });
  if (!server || !server.discoveryListed) throw new NotFoundError('Server');
  return server;
}

discoveryRouter.get('/servers/:serverId', rateLimitDiscoveryBrowse, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const row = await listedServerOrThrow(req.params.serverId);
    const [card] = await withUserFlags(req.user!.userId, [toPublicCard(row)]);
    res.json({ success: true, data: card });
  } catch (err) {
    next(err);
  }
});

// ─── Join / request to join ─────────────────────────────────────────────────

const requestUserSelect = { id: true, username: true, displayName: true, avatarUrl: true } as const;

function formatRequest(row: {
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

discoveryRouter.post('/servers/:serverId/join', rateLimitDiscoveryJoin, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const server = await listedServerOrThrow(req.params.serverId);
    const serverId = server.id;

    if (server.joinMode === 'open') {
      // Open mode: the same sequence as the invite join (ban, duplicate,
      // limit, the membership + count transaction, the room invariant,
      // seeding), and the same response shape so the client store path is
      // shared.
      await joinServerMember(userId, serverId, { via: 'discovery' });
      const joined = await prisma.server.findUnique({ where: { id: serverId }, select: serverSelect });
      res.json({ success: true, data: joined });
      return;
    }

    // Approval mode: a request the moderators approve or decline.
    const ban = await prisma.serverBan.findUnique({ where: { serverId_userId: { serverId, userId } }, select: { userId: true } });
    if (ban) throw new ForbiddenError('You are banned from this server');
    const membership = await prisma.serverMember.findUnique({ where: { userId_serverId: { userId, serverId } }, select: { userId: true } });
    if (membership) throw new BadRequestError('You are already a member of this server');

    let message: string | null = null;
    const rawMessage: unknown = req.body?.message;
    if (rawMessage !== undefined && rawMessage !== null) {
      if (typeof rawMessage !== 'string') throw new BadRequestError('message must be a string');
      const sanitized = sanitizeText(rawMessage);
      const msgErr = validateJoinRequestMessage(sanitized);
      if (msgErr) throw new BadRequestError(msgErr);
      message = sanitized.length > 0 ? sanitized : null;
    }

    const existing = await prisma.serverJoinRequest.findUnique({
      where: { serverId_userId: { serverId, userId } },
      select: { id: true, status: true, decidedAt: true },
    });
    if (existing?.status === 'pending') {
      // Idempotent: asking twice is one request
      res.json({ success: true, data: { status: 'pending' } });
      return;
    }
    if (existing?.status === 'declined' && existing.decidedAt) {
      const cooldownEnds = existing.decidedAt.getTime() + JOIN_REQUEST_DECLINE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
      if (Date.now() < cooldownEnds) throw new ForbiddenError('Your request was declined recently. Please try again later.');
    }

    // A declined row past its cooldown is reused (the sweep may not have
    // reached it yet); otherwise a fresh one.
    const request = existing
      ? await prisma.serverJoinRequest.update({
          where: { id: existing.id },
          data: { status: 'pending', message, decidedById: null, decidedAt: null, createdAt: new Date() },
          include: { user: { select: requestUserSelect } },
        })
      : await prisma.serverJoinRequest.create({
          data: { serverId, userId, message },
          include: { user: { select: requestUserSelect } },
        });

    // Moderators only — never the server room (that would show every member
    // who is asking to join).
    await emitToModerators(serverId, WS_EVENTS.SERVER_JOIN_REQUEST, { serverId, request: formatRequest(request) });

    res.status(202).json({ success: true, data: { status: 'pending' } });
  } catch (err) {
    next(err);
  }
});

discoveryRouter.delete('/servers/:serverId/join', rateLimitDiscoveryJoin, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const server = await listedServerOrThrow(req.params.serverId);
    const serverId = server.id;

    const { count } = await prisma.serverJoinRequest.deleteMany({ where: { serverId, userId, status: 'pending' } });
    if (count === 0) throw new NotFoundError('Join request');

    await emitToModerators(serverId, WS_EVENTS.SERVER_JOIN_REQUEST_RESOLVED, { serverId, userId, outcome: 'cancelled' });

    res.json({ success: true, message: 'Join request cancelled' });
  } catch (err) {
    next(err);
  }
});
