import { prisma } from './prisma';

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
 * Called BEFORE the user row goes, so a failure here aborts the deletion rather
 * than orphaning the material.
 */
export async function purgeE2EMaterial(userId: string): Promise<void> {
  // Devices cascade to their one-time keys; the rest are keyed by userId alone.
  // Ordered device-last so a partial failure cannot leave a device advertising
  // keys whose backing rows are already gone.
  await prisma.e2EKeyShare.deleteMany({ where: { recipientUserId: userId } });
  await prisma.e2EKeyShare.deleteMany({ where: { senderUserId: userId } });
  await prisma.e2EMasterTransfer.deleteMany({ where: { userId } });
  await prisma.e2EMasterKey.deleteMany({ where: { userId } });
  await prisma.e2EDeviceRegistry.deleteMany({ where: { userId } });
  await prisma.e2EDevice.deleteMany({ where: { userId } });
}
