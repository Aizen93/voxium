import type { Prisma } from '../generated/prisma/client';

/**
 * What a deletion does with the moderation reports filed by or about the
 * accounts it deletes, when the flag `account_deletion_keeps_reports` is on
 * (#48): ONE implementation, called inside the deletion's transaction by an
 * account deletion (deleteAccountRows, utils/accountDeletion.ts, for its one
 * account) and by the registration hygiene sweep (deleteStaleUnverifiedAccounts,
 * utils/registrationHygiene.ts, for every account of a batch at once). Both
 * call it after the accounts' rows are locked FOR UPDATE and their direct
 * conversations are locked FOR UPDATE, and BEFORE anything is done in those
 * conversations (the conversation settlement follows, then the delete of the
 * accounts, the last statement). With the flag off it is not called at all,
 * and the reports go with the account through the cascade of their foreign
 * keys, as they always did.
 *
 * In this order, each statement awaited:
 *  1. the messages those reports name, FOR NO KEY UPDATE, in id order;
 *  2. the reports, FOR UPDATE, in id order;
 *  3. one UPDATE of exactly those rows. A side whose account is deleted here
 *     becomes NULL and gets its deletion mark (the database's clock, in UTC,
 *     as every timestamp of the table). The reported side also loses its
 *     message link (a report's message is always its reported account's,
 *     POST /reports checks it, and it goes with the account: deleted by the
 *     user delete's cascade, or reduced to a placeholder in a direct
 *     conversation kept for the other person) and keeps its username, taken
 *     from the account row when the report has none (one filed by a server
 *     older than the username column). A report whose two sides are both
 *     deleted here (two accounts of one sweep batch) is settled once, both
 *     sides in the one statement: every right-hand side of an UPDATE reads
 *     the row as it was.
 * The report's copy of the reported content (`message_content`, with its
 * `content_source`) is never touched.
 *
 * NO REPORT ROW IS WRITTEN TWICE in the transaction, so the update leaves
 * nothing for a later statement to rewrite on a row it touched. PostgreSQL
 * runs every foreign-key check again (FOR KEY SHARE on the account or the
 * message the row still names) when a transaction updates a row it has
 * already written itself, even when the key did not change, and such a check
 * on the other person's account row meets that person's own deletion. So,
 * on the rows this update touches:
 *  - the reported side's message link goes (above);
 *  - a reporter-side report on a direct-conversation message loses its link
 *    too: the conversation settlement that follows may delete the
 *    conversation, and the cascade of that delete would set the link NULL a
 *    second time. Only the two people of a conversation can report a message
 *    in it, so such a message is in a conversation of an account deleted
 *    here. The condition is the message's own conversation, not the
 *    report's `conversation_id` column, and it does not wait for the
 *    conversation's outcome: a report filed by the deleted account on the
 *    other person's direct message loses its link to that message whether or
 *    not the conversation is kept for them (it keeps its copy of the
 *    content, its conversation id and the reported account);
 *  - `resolved_by_id` goes when the account deleted here resolved the report
 *    (the user delete's SET NULL would otherwise write the row again).
 * The full list of the statements that can write a report row, and why none
 * meets a row this update wrote, is on deleteAccountRows.
 *
 * Why the messages first: every writer that deletes a reported message (its
 * author's own delete, a resolution's `deleteMessage`, a channel's cascade,
 * and the user delete of another deletion that is that message's author)
 * takes the message row and then, through the key's ON DELETE SET NULL, the
 * report row. Taking the report rows first and leaving the messages to a
 * later cascade would be the other order, and a cycle with each of them; a
 * resolution already takes the message before the report for that reason
 * (routes/admin.ts).
 *
 * Why FOR NO KEY UPDATE: a DELETE of the message waits for it, and so does a
 * second deletion that takes the same message here, so two deletions that
 * share a reported message queue on it before either holds a report row. A
 * shared lock (FOR KEY SHARE) would let both hold the message; the one that
 * got the report row first would then reach the message in its user
 * delete's cascade and wait for the other, which waits for that report row:
 * a cycle between the deletions of a reporter and the account they reported.
 * The cost: until the deletion commits, every UPDATE or DELETE of such a
 * message waits for it (an edit, a delete by its author or a moderator, a
 * resolution's `deleteMessage`, the SET NULL of its reply link when the
 * message it replies to is deleted, the delete of the channel, space or
 * conversation that holds it, the deletion of its author's account); an
 * insert that only key-shares the message (a reaction, a reply, a report)
 * does not. Both lists in id order, so two deletions (or a deletion and the
 * sweep) take what they share in one order. Where these steps stand against
 * every other writer of a report is written on deleteAccountRows.
 *
 * Why only after the account rows are locked: a report filed meanwhile
 * key-shares both of its accounts, so none naming an account held here can
 * commit between this step and the delete (the cascade then reaches no report
 * of the account at all), and its insert fails on the foreign key once the
 * account is gone.
 *
 * Resolves the number of reports kept.
 */
export async function settleReportsOfDeletedAccounts(
  tx: Prisma.TransactionClient,
  userIds: string[],
): Promise<number> {
  if (userIds.length === 0) return 0;
  await tx.$queryRaw`
    SELECT m.id FROM messages m
    WHERE m.id IN (
      SELECT r.message_id FROM reports r
      WHERE (r.reporter_id = ANY(${userIds}::text[]) OR r.reported_user_id = ANY(${userIds}::text[]))
        AND r.message_id IS NOT NULL
    )
    ORDER BY m.id
    FOR NO KEY UPDATE OF m`;
  const reports = (await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM reports
    WHERE reporter_id = ANY(${userIds}::text[]) OR reported_user_id = ANY(${userIds}::text[])
    ORDER BY id
    FOR UPDATE`).map((r) => r.id);
  if (reports.length === 0) return 0;
  return tx.$executeRaw`
    UPDATE reports r SET
      reported_username = CASE WHEN r.reported_user_id = ANY(${userIds}::text[])
        THEN COALESCE(r.reported_username, (SELECT u.username FROM users u WHERE u.id = r.reported_user_id))
        ELSE r.reported_username END,
      reported_user_deleted_at = CASE WHEN r.reported_user_id = ANY(${userIds}::text[])
        THEN (now() AT TIME ZONE 'UTC')::timestamp(3) ELSE r.reported_user_deleted_at END,
      message_id = CASE
        WHEN r.reported_user_id = ANY(${userIds}::text[]) THEN NULL
        WHEN EXISTS (SELECT 1 FROM messages m WHERE m.id = r.message_id AND m.conversation_id IS NOT NULL) THEN NULL
        ELSE r.message_id END,
      reported_user_id = CASE WHEN r.reported_user_id = ANY(${userIds}::text[]) THEN NULL ELSE r.reported_user_id END,
      reporter_deleted_at = CASE WHEN r.reporter_id = ANY(${userIds}::text[])
        THEN (now() AT TIME ZONE 'UTC')::timestamp(3) ELSE r.reporter_deleted_at END,
      reporter_id = CASE WHEN r.reporter_id = ANY(${userIds}::text[]) THEN NULL ELSE r.reporter_id END,
      resolved_by_id = CASE WHEN r.resolved_by_id = ANY(${userIds}::text[]) THEN NULL ELSE r.resolved_by_id END
    WHERE r.id = ANY(${reports}::text[])`;
}
