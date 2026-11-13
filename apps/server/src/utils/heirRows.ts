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
 * share on it is not waited for), then the heir's account row FOR KEY SHARE
 * (the mode the new owner's key takes it in). `member: false` for an heir
 * who is not a member yet: the transfer creates their member row.
 */
export async function waitForHeirRows(heirId: string, serverId: string, opts: { member: boolean }): Promise<void> {
  if (opts.member) {
    await prisma.$queryRaw`SELECT user_id FROM server_members WHERE user_id = ${heirId} AND server_id = ${serverId} FOR NO KEY UPDATE`;
  }
  await prisma.$queryRaw`SELECT id FROM users WHERE id = ${heirId} FOR KEY SHARE`;
}
