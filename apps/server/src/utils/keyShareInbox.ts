import { E2E_LIMITS } from '@voxium/shared';
import type { PrismaClient } from '../generated/prisma/client';

// The key-share inbox's three statements (docs/e2e-dm-spec.md §12.3), kept
// apart from the routes so the rolled-back proof of the migration runs exactly
// these. Each one is a single statement: there is no window between reading a
// share and taking it in which a second claim could take it too.
//
// - leaseKeyShares (GET /e2e/keyshares?lease=1): hands a page out under a
//   lease. Nothing is deleted; the device acknowledges what it is done with.
// - claimAndDeleteKeyShares (GET /e2e/keyshares, desktop 2.1.x): the legacy
//   claim, which deletes what it hands out. A client that never acknowledges
//   leaves nothing behind against the inbox caps.
// - acknowledgeKeyShares (POST /e2e/keyshares/ack): deletes the named shares
//   of one device, and nothing of anyone else's.
//
// Both claims take only shares no live lease holds, under FOR UPDATE SKIP
// LOCKED: a share another claim is taking at this moment is skipped (never
// waited for), and one it took and committed is re-checked against the lease
// predicate on its new version and excluded. So no two claims, of either kind,
// hold one share at the same time (Olm pre-key bodies are one-shot). The
// lease is written and compared on the database clock, in UTC like the
// table's other timestamp columns: application nodes' clocks never meet it.

/** What the inbox statements need: the client, or a transaction of it. */
export type KeyShareInboxDb = Pick<PrismaClient, '$queryRaw'> & {
  e2EKeyShare: Pick<PrismaClient['e2EKeyShare'], 'deleteMany'>;
};

/** A claimed share, as the statements return it. */
export interface ClaimedKeyShareRow {
  id: string;
  sender_user_id: string;
  sender_device_id: string;
  conversation_id: string;
  session_id: string;
  body: string;
  created_at: Date;
}

const LEASE_SECONDS = E2E_LIMITS.KEYSHARE_LEASE_MS / 1000;

/**
 * A claimed page oldest first, ties by id, as the inbox is scanned. RETURNING
 * keeps no order (the outer statement joins the subquery's ids, it does not
 * follow its ORDER BY), and the client imports a page in the order it is
 * given: a sender's later share must not come before the earlier one whose Olm
 * message sets up the pairwise session it rides.
 */
export function oldestFirst<T extends { id: string; created_at: Date }>(rows: T[]): T[] {
  const at = (row: T) => new Date(row.created_at).getTime();
  return [...rows].sort((a, b) => at(a) - at(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Hand out up to a page of one device's shares under a lease of KEYSHARE_LEASE_MS. */
export async function leaseKeyShares(
  db: KeyShareInboxDb,
  userId: string,
  deviceId: string
): Promise<ClaimedKeyShareRow[]> {
  const rows = await db.$queryRaw<ClaimedKeyShareRow[]>`
    UPDATE e2e_key_shares
    SET leased_until = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${LEASE_SECONDS})
    WHERE id IN (
      SELECT id FROM e2e_key_shares
      WHERE recipient_user_id = ${userId} AND recipient_device_id = ${deviceId}
        AND (leased_until IS NULL OR leased_until <= (now() AT TIME ZONE 'UTC'))
      ORDER BY created_at, id
      LIMIT ${E2E_LIMITS.KEYSHARE_CLAIM_MAX}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, sender_user_id, sender_device_id, conversation_id, session_id, body, created_at
  `;
  return oldestFirst(rows);
}

/** The legacy claim: hand out up to a page of one device's unleased shares, and delete them. */
export async function claimAndDeleteKeyShares(
  db: KeyShareInboxDb,
  userId: string,
  deviceId: string
): Promise<ClaimedKeyShareRow[]> {
  const rows = await db.$queryRaw<ClaimedKeyShareRow[]>`
    DELETE FROM e2e_key_shares
    WHERE id IN (
      SELECT id FROM e2e_key_shares
      WHERE recipient_user_id = ${userId} AND recipient_device_id = ${deviceId}
        AND (leased_until IS NULL OR leased_until <= (now() AT TIME ZONE 'UTC'))
      ORDER BY created_at, id
      LIMIT ${E2E_LIMITS.KEYSHARE_CLAIM_MAX}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, sender_user_id, sender_device_id, conversation_id, session_id, body, created_at
  `;
  return oldestFirst(rows);
}

/**
 * Delete the named shares of one device, leased or not, lease expired or not.
 * Ids that name nothing, name a share of another device or account, or were
 * deleted already are not counted, and are told apart from each other by
 * nothing: the caller learns only how many of ITS shares went.
 */
export async function acknowledgeKeyShares(
  db: KeyShareInboxDb,
  userId: string,
  deviceId: string,
  ids: string[]
): Promise<number> {
  const { count } = await db.e2EKeyShare.deleteMany({
    where: { id: { in: ids }, recipientUserId: userId, recipientDeviceId: deviceId },
  });
  return count;
}
