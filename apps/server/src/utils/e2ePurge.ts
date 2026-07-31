import { prisma } from './prisma';

/** The subset of the client these deletes need — satisfied by a transaction. */
type PurgeClient = Pick<
  typeof prisma,
  'e2EKeyShare' | 'e2EMasterTransfer' | 'e2EMasterKey' | 'e2EDeviceRegistry' | 'e2EDevice'
>;

/**
 * Delete every trace of a user's E2E key material.
 *
 * The E2E tables predate this and were written without foreign keys to User
 * (only `E2EKeyBackup` has one), so `prisma.user.delete()` leaves all of it
 * behind: device identities, the account master key, pending key shares and
 * device-approval envelopes. Key shares and transfers are age-swept, but the
 * device rows and the master key never expire — a deleted account would keep
 * publishing its public keys forever, and anyone querying the tables directly
 * could still see who had devices, how many, and when they were added.
 *
 * Takes a client so the caller can run it in the SAME transaction as the user
 * delete. Run separately, a failure of the delete after the purge commits
 * leaves a live, loginable account whose devices, master key and registry are
 * gone — every device stranded, needing a new identity, for a deletion that
 * never happened.
 */
export async function purgeE2EMaterial(userId: string, client: PurgeClient = prisma): Promise<void> {
  // Devices cascade to their one-time keys; the rest are keyed by userId alone.
  // Ordered device-last so a partial failure cannot leave a device advertising
  // keys whose backing rows are already gone.
  await client.e2EKeyShare.deleteMany({ where: { recipientUserId: userId } });
  await client.e2EKeyShare.deleteMany({ where: { senderUserId: userId } });
  await client.e2EMasterTransfer.deleteMany({ where: { userId } });
  await client.e2EMasterKey.deleteMany({ where: { userId } });
  await client.e2EDeviceRegistry.deleteMany({ where: { userId } });
  await client.e2EDevice.deleteMany({ where: { userId } });
}
