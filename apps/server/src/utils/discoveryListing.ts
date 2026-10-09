import { prisma } from './prisma';

/**
 * The four inputs of `Server.discoveryListed`, the materialised column the
 * directory filters on so the listing query never joins
 * (docs/local/server-discovery-plan.html, "What is listed").
 */
export interface DiscoveryListingInputs {
  discoverable: boolean;
  invitesLocked: boolean;
  discoveryBlockedAt: Date | null;
  ownerBannedAt: Date | null;
}

/** The truth table: listed only when the owner wants it, invites are not
 *  locked ("not taking members" — a button that fails is worse than hiding),
 *  no platform admin blocked it, and the owner is not platform-banned. */
export function isDiscoveryListed(inputs: DiscoveryListingInputs): boolean {
  return (
    inputs.discoverable &&
    !inputs.invitesLocked &&
    inputs.discoveryBlockedAt === null &&
    inputs.ownerBannedAt === null
  );
}

function logFailure(what: string, err: unknown): void {
  console.error(`[Discovery] ${what} — the nightly pass will correct the listing column:`, err instanceof Error ? err.message : err);
}

/**
 * Recompute one server's `discoveryListed` from its four inputs.
 *
 * Called by every write that changes one of them: the discovery PATCH, the
 * invites-lock PATCH and the admin discovery PATCH (owner-side inputs are
 * per-server; the owner-ban input goes through `recomputeListedForOwner`).
 * Writes only when the value changes.
 *
 * Never throws: the caller's own write has already committed, and the column
 * has a nightly drift correction by design — a failed recompute is logged at
 * error level and answered with `null`, not a 500 on a request that did what
 * it was asked. Returns the listed value otherwise, or null when the server
 * no longer exists.
 */
export async function recomputeListed(serverId: string): Promise<boolean | null> {
  try {
    const server = await prisma.server.findUnique({
      where: { id: serverId },
      select: {
        discoverable: true,
        invitesLocked: true,
        discoveryBlockedAt: true,
        discoveryListed: true,
        owner: { select: { bannedAt: true } },
      },
    });
    if (!server) return null;

    const listed = isDiscoveryListed({
      discoverable: server.discoverable,
      invitesLocked: server.invitesLocked,
      discoveryBlockedAt: server.discoveryBlockedAt,
      ownerBannedAt: server.owner.bannedAt,
    });
    if (listed !== server.discoveryListed) {
      // updateMany, not update: a server deleted between the read and the
      // write is a no-op here, not a P2025 to log.
      await prisma.server.updateMany({ where: { id: serverId }, data: { discoveryListed: listed } });
    }
    return listed;
  } catch (err) {
    logFailure(`recomputeListed(${serverId}) failed`, err);
    return null;
  }
}

/**
 * Recompute `discoveryListed` for every server a user owns, after their
 * platform ban state changed (admin ban, admin unban, report-resolve ban).
 * ONE updateMany either way: a banned owner's servers are all hidden; an
 * unbanned owner's servers come back only where the three per-server inputs
 * still allow it. Same never-throws contract as `recomputeListed`. Returns the
 * number of rows changed, or null on failure / unknown user.
 */
export async function recomputeListedForOwner(ownerId: string): Promise<number | null> {
  try {
    const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { bannedAt: true } });
    if (!owner) return null;

    const result = owner.bannedAt
      ? await prisma.server.updateMany({
          where: { ownerId, discoveryListed: true },
          data: { discoveryListed: false },
        })
      : await prisma.server.updateMany({
          where: { ownerId, discoveryListed: false, discoverable: true, invitesLocked: false, discoveryBlockedAt: null },
          data: { discoveryListed: true },
        });
    return result.count;
  } catch (err) {
    logFailure(`recomputeListedForOwner(${ownerId}) failed`, err);
    return null;
  }
}
