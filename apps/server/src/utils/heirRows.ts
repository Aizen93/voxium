import { prisma } from './prisma';

/**
 * Before an ownership transfer's transaction: wait, holding nothing, for the
 * heir's rows that transaction takes after the space row, so whatever
 * transaction holds one of them (an account deletion or a removal of the
 * heir) is waited for before the space row is taken, and the space's joins
 * and creations do not queue behind the transfer. One statement per row, on
 * the shared client and outside any transaction, each in the mode the
 * transfer takes the row in, so the lock is let go as soon as it is granted:
 * the heir's member row FOR NO KEY UPDATE (a secure-channel writer's key
 * share on it is not waited for; an heir who is not a member has none), then
 * the heir's account row FOR KEY SHARE (the mode the new owner's key takes
 * it in). The caller reads the heir's membership after these, so it decides
 * from what is true once a transaction holding the member row has ended.
 */
export async function waitForHeirRows(heirId: string, serverId: string): Promise<void> {
  await prisma.$queryRaw`SELECT user_id FROM server_members WHERE user_id = ${heirId} AND server_id = ${serverId} FOR NO KEY UPDATE`;
  await prisma.$queryRaw`SELECT id FROM users WHERE id = ${heirId} FOR KEY SHARE`;
}
