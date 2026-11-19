import type { Prisma } from '../generated/prisma/client';

/**
 * Lock the account rows a ban or a report resolution depends on, FIRST in
 * its transaction and in one fixed order (sorted ids, so two of these never
 * wait on each other crosswise). An account deletion (utils/accountDeletion.ts)
 * deletes the account row first and only then reaches its webhooks (SetNull),
 * reports and messages (Cascade) through the foreign keys; a transaction that
 * held one of those rows and then waited on the account row closed a cycle,
 * and when Postgres aborted the deletion its notices, revocations and purges
 * had already run. Taking the account row first means both sides queue on
 * the same row and nothing else.
 *
 * Two strengths, each the weakest that still makes a deletion wait:
 *  - 'update', the account this transaction writes (the one banned): FOR NO
 *    KEY UPDATE, not FOR UPDATE. It conflicts with the deletion and with any
 *    other UPDATE of the row, but not with FOR KEY SHARE, which every insert
 *    of a row referencing the account takes, so a join, a message or a kick
 *    of that account (its membership row, its webhook statement, then its
 *    ban row) never waits on a ban.
 *  - 'keep', an account this transaction only needs to still exist (a
 *    report's reporter, a reported account not being banned): FOR KEY SHARE.
 *    A DELETE still waits for it; an ordinary column update (the presence
 *    write of a reporter who connects while the disarm waits on a webhook
 *    purge) does not.
 * A webhook purge-delete locks the webhook row and never the account's, so it
 * cannot close a cycle with the webhook disarm that follows.
 *
 * The E2E device registration (`PUT /e2e/devices`, routes/e2e.ts) takes the
 * caller's own row in 'update' mode too, to serialise an account's
 * registrations before it counts its devices; where that transaction stands
 * in the account deletion's lock order is written beside it.
 *
 * Returns the accounts that still exist, now held: one deleted since the
 * caller read it locks nothing, and the caller answers as for a missing one.
 */
export async function lockAccountRows(
  tx: Prisma.TransactionClient,
  rows: { id: string | null | undefined; mode: 'update' | 'keep' }[],
): Promise<Set<string>> {
  // One lock per account, the stronger when it is asked for twice
  const modes = new Map<string, 'update' | 'keep'>();
  for (const { id, mode } of rows) {
    if (!id) continue;
    if (modes.get(id) !== 'update') modes.set(id, mode);
  }
  // The accounts that still exist, now held: one deleted since the caller
  // read it locks nothing, and the caller answers as for a missing one
  const locked = new Set<string>();
  for (const id of [...modes.keys()].sort()) {
    const found = modes.get(id) === 'update'
      ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM users WHERE id = ${id} FOR NO KEY UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`SELECT id FROM users WHERE id = ${id} FOR KEY SHARE`;
    if (found.length > 0) locked.add(id);
  }
  return locked;
}
