// Daily registration-hygiene sweep (runs at 4:30 AM, offset from the 4 AM
// attachment cleanup so the two never contend for the DB):
//
//  1. UNVERIFIED-ACCOUNT TTL — accounts that never verified their email are
//     deleted after UNVERIFIED_ACCOUNT_TTL_DAYS. This is the measure that
//     makes bot registration harvests worthless: the rows stop accumulating,
//     and usernames/emails squatted with breached-list addresses return to
//     their real owners automatically. Legitimate users are unaffected — the
//     app is unusable unverified (requireVerifiedEmail gates every functional
//     route), so a real person verifies within minutes, not days. A verified
//     person can still open a direct conversation with such an account: its
//     conversations are settled as an account deletion settles them, before
//     the row goes (deleteStaleUnverifiedAccounts).
//
//  2. IP-RECORD RETENTION — IpRecord rows unseen for IP_RETENTION_DAYS are
//     deleted. IPs are personal data (GDPR/CNIL): we keep them exactly as
//     long as they are useful for abuse attribution and not a day longer.
import { prisma } from './prisma';
import { getRedis, NODE_ID } from './redis';
import { deleteMultipleFromS3 } from './s3';
import { sendAdminAlert, describeEmailError } from './email';
import { logAuditEvent } from './auditLog';
import { msUntilDailySlot, releaseLockIfOwned, lockToken } from './dailySchedule';
import { purgeExpiredSignupState } from '../services/signupService';
import { isFeatureEnabled } from './featureFlags';
import { retryOnTransactionConflict } from './transactionRetry';
import { settleConversationsOfDeletedAccount, type DeletedAccountConversations } from './conversationLifecycle';
import { settleReportsOfDeletedAccounts } from './reportSettlement';
import { announceConversationsOfDeletedAccount } from './accountDeletion';
import { deleteAttachmentBlobs } from './attachmentBlobs';
import { IP_RECORD_RETENTION_DAYS } from '@voxium/shared';
import { runJob, resultOf, type JobRun } from './jobs';

let timeoutId: ReturnType<typeof setTimeout> | null = null;
let spikeIntervalId: ReturnType<typeof setInterval> | null = null;
let stopped = true;

export const SWEEP_HOUR = 4;
export const SWEEP_MINUTE = 30;
export const UNVERIFIED_ACCOUNT_TTL_DAYS = 7;
/** The shared constant (the admin dashboard quotes it), under this module's existing name. */
export const IP_RETENTION_DAYS = IP_RECORD_RETENTION_DAYS;

/** Only one node sweeps. Both would otherwise run the identical `deleteMany`
 *  at 04:30: harmless (the loser matches zero rows) but it makes the loser's
 *  count disagree with its own select, which trips the avatar-safety check and
 *  logs a misleading "spared by the delete guards" warning every night. Same
 *  `SET NX EX` idiom as the spike alert below. */
const HYGIENE_LOCK_KEY = 'lock:reghygiene';
const HYGIENE_LOCK_TTL_SECONDS = 900;
/** Operator-visible run history. Redis, not the DB: it is diagnostics, and a
 *  flush costs nothing (the durable record is the audit-log row). */
const HYGIENE_LAST_RUN_KEY = 'hygiene:last-run';
const HYGIENE_HISTORY_KEY = 'hygiene:history';
const HYGIENE_HISTORY_MAX = 20;

export interface HygieneResult {
  deletedUsers: number;
  deletedIpRecords: number;
  /** Avatar objects handed to S3: those of the accounts actually deleted. */
  deletedAvatars: number;
  /** True ⇒ nothing was deleted; the counts are what WOULD have gone. */
  dryRun: boolean;
  /**
   * Present when a batch of the account deletion failed: the sweep stopped
   * taking batches there, kept what had committed (deletedUsers counts it)
   * and finished the rest of its work. The error's name and code only.
   */
  failedBatch?: { name: string; code: string | null };
}

export interface HygieneRun extends HygieneResult {
  at: string;
  durationMs: number;
  trigger: 'scheduled' | 'manual';
  /** null for the scheduled run — no human asked for it. */
  actorId: string | null;
  nodeId: string;
}
/** Registrations in one hour that trip the operator alert. A healthy young
 *  platform sees a handful; a bot wave is unmistakable at this level. */
export const REGISTRATION_SPIKE_PER_HOUR = 30;
const SPIKE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** One alert per 6h — a sustained wave should not mailbomb the operator. */
const SPIKE_ALERT_DEDUPE_SECONDS = 6 * 60 * 60;

export function startRegistrationHygiene() {
  if (!stopped) return;
  stopped = false;
  scheduleNext(false);
  spikeIntervalId = setInterval(() => {
    checkRegistrationSpike().catch((err) => console.warn('[RegHygiene] Spike check failed:', err));
  }, SPIKE_CHECK_INTERVAL_MS);
}

export function stopRegistrationHygiene() {
  stopped = true;
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
  if (spikeIntervalId) {
    clearInterval(spikeIntervalId);
    spikeIntervalId = null;
  }
}

function scheduleNext(afterRun: boolean) {
  if (stopped) return;
  const delay = msUntilDailySlot(SWEEP_HOUR, SWEEP_MINUTE, afterRun);
  console.log(`[RegHygiene] Next sweep in ${Math.round(delay / 60000)} minutes`);
  timeoutId = setTimeout(() => {
    // Through the job registry's wrapper (utils/jobs.ts), around the lock:
    // switched off, nothing runs and the next slot is taken as after a run
    runJob('registration-hygiene', (run) => runRegistrationHygieneLocked({ trigger: 'scheduled', run }))
      .then(resultOf)
      .catch((err) => console.error('[RegHygiene] Sweep failed:', err))
      .finally(() => scheduleNext(true));
  }, delay);
}

/**
 * The sweep itself. Exported for tests and for the admin trigger, but callers
 * that actually delete should go through `runRegistrationHygieneLocked` so the
 * cluster lock and the run record apply.
 */
export async function runRegistrationHygiene(opts: { dryRun?: boolean; run?: JobRun } = {}): Promise<HygieneResult> {
  const dryRun = opts.dryRun === true;
  const userCutoff = new Date(Date.now() - UNVERIFIED_ACCOUNT_TTL_DAYS * 24 * 60 * 60 * 1000);
  const ipCutoff = new Date(Date.now() - IP_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Verify-first sign-up state past its life: inert already (every check reads
  // the timestamps), purged so the tables stay small. FIRST, in its own try:
  // a failing step of the sweep below cannot skip it, and its failure cannot
  // hide the sweep's result.
  if (!dryRun) {
    try {
      const purged = await purgeExpiredSignupState();
      opts.run?.count('purgedPendingRegistrations', purged.pending);
      opts.run?.count('purgedMailLedger', purged.ledger);
      if (purged.pending || purged.ledger) {
        console.log(`[RegHygiene] Purged ${purged.pending} expired pending registration(s) and ${purged.ledger} sign-up mail ledger row(s)`);
      }
    } catch (err) {
      console.error('[RegHygiene] Sign-up state purge failed:', err instanceof Error ? err.message : err);
    }
  }

  // Defense-in-depth guards on the delete, not just the flag:
  //  - role 'user' only — an unverified admin should be impossible, but a
  //    sweep must never be the thing that deletes one if it happens
  //  - no owned servers — Server.owner is onDelete: Restrict, so such a
  //    delete would throw anyway; excluding it keeps the sweep clean and
  //    covers any pre-verification-era legacy accounts
  const staleUnverified = await prisma.user.findMany({
    where: {
      emailVerified: false,
      createdAt: { lt: userCutoff },
      role: 'user',
      ownedServers: { none: {} },
    },
    // avatarUrl so the blob goes with the row — a DB-only delete leaks the
    // object into the bucket forever (the nightly orphan sweep is a backstop,
    // not an excuse to leak on a path we control).
    select: { id: true, avatarUrl: true },
  });

  // The guards are REPEATED under the lock and on the delete, not just on the
  // select above: a user who verifies their email (or comes to own a space)
  // between the two must survive, and only Postgres can decide that
  // atomically (deleteStaleUnverifiedAccounts). It answers which accounts it
  // deleted, by id, and stops at a failed batch, keeping what committed.
  const swept = dryRun || staleUnverified.length === 0
    ? { deletedIds: [] as string[], failedBatch: null }
    : await deleteStaleUnverifiedAccounts(staleUnverified.map((u) => u.id), userCutoff);
  const deletedIds = new Set(swept.deletedIds);
  const deletedUsers = dryRun ? staleUnverified.length : deletedIds.size;
  if (!dryRun && deletedIds.size < staleUnverified.length && !swept.failedBatch) {
    console.log(`[RegHygiene] ${staleUnverified.length - deletedIds.size} account(s) no longer qualified when the sweep reached them (verified, or owning a space, since the select) and were spared`);
  }

  // AFTER the rows are gone: a failed delete must not strand a live avatar.
  // Exactly the accounts the committed batches deleted, by id: an account
  // the guards spared, or one in a batch that failed, keeps its avatar.
  const avatarKeys = staleUnverified
    .filter((u) => dryRun || deletedIds.has(u.id))
    .map((u) => u.avatarUrl)
    .filter((k): k is string => !!k);
  let deletedAvatars = 0;
  if (avatarKeys.length > 0) {
    if (dryRun) {
      deletedAvatars = avatarKeys.length;
    } else {
      // What S3 ACCEPTED, not what we asked it to take. DeleteObjects answers
      // 200 with a populated Errors[] when the credentials lack
      // s3:DeleteObject, which is exactly why deleteMultipleFromS3 returns a
      // count — reporting the candidate count instead would put a clean number
      // in the durable audit row while nothing moved.
      deletedAvatars = await deleteMultipleFromS3(avatarKeys).catch((err) => {
        console.warn('[RegHygiene] Avatar cleanup failed (the orphan sweep will reclaim them):', err instanceof Error ? err.message : err);
        return 0;
      });
      if (deletedAvatars < avatarKeys.length) {
        console.error(`[RegHygiene] S3 refused ${avatarKeys.length - deletedAvatars} avatar deletion(s) — check the bucket policy / IAM permissions`);
      }
    }
  }

  const { count: deletedIpRecords } = dryRun
    ? { count: await prisma.ipRecord.count({ where: { lastSeenAt: { lt: ipCutoff } } }) }
    : await prisma.ipRecord.deleteMany({ where: { lastSeenAt: { lt: ipCutoff } } });

  return { deletedUsers, deletedIpRecords, deletedAvatars, dryRun, ...(swept.failedBatch && { failedBatch: swept.failedBatch }) };
}

/** Accounts per transaction: the account step and the conversation step run under one lock each. */
export const SWEEP_ACCOUNTS_PER_TRANSACTION = 1000;

/** A batch whose final delete removed another number of accounts than the step settled: rolled back whole. */
export class SweepDeleteMismatchError extends Error {
  readonly code = 'SWEEP_DELETE_MISMATCH';
  constructor(settled: number, deleted: number) {
    super(`The sweep settled the conversations of ${settled} account(s) but its delete removed ${deleted}`);
    this.name = 'SweepDeleteMismatchError';
  }
}

/** An error as the sweep may record it: its name and code, never its message. */
function describeBatchError(err: unknown): { name: string; code: string | null } {
  const name = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  return { name, code: typeof code === 'string' ? code : null };
}

/**
 * Delete the stale unverified accounts `ids` (the select's candidates), and
 * settle their direct conversations the way an account deletion does
 * (settleConversationsOfDeletedAccount, utils/conversationLifecycle.ts), so
 * that nothing rests on the foreign keys from a conversation's sides to the
 * account: what happens to the other person's conversation is the same
 * whatever those keys say. The flag that decides it
 * (account_deletion_keeps_conversations) is read once for the whole sweep.
 * Their moderation reports are settled the same way, by the step and the
 * flag (account_deletion_keeps_reports, read once too) an account deletion
 * uses (settleReportsOfDeletedAccounts, utils/reportSettlement.ts).
 *
 * THE GUARDS, and what each reads: unverified (`users.email_verified`), older
 * than the cutoff (`users.created_at`), role `user` (`users.role`), owning no
 * space (`servers.owner_id`). A row lock re-checks, after a wait, only the
 * guards on the locked row's own columns; the one that reads another table
 * is judged on the statement's snapshot, so an ownership write the lock
 * waited for (it key-shares the account row, it does not update it) would
 * not be seen. So, per SWEEP_ACCOUNTS_PER_TRANSACTION accounts, in one
 * transaction run again whole after a deadlock:
 *  1. the account rows that still satisfy the `users` guards, FOR UPDATE in
 *     id order: an account verified (or promoted, or made younger) since the
 *     select is left out after the wait, and none of these can be verified,
 *     start a conversation or come to own a space until the commit (each of
 *     those writes takes or key-shares the account row);
 *  2. in a statement of its own, so on a snapshot taken after the lock was
 *     granted: the locked accounts that own a space NOW are dropped;
 *  3. every conversation of the accounts left, FOR UPDATE in id order, in one
 *     statement (one order for all of them, as an account deletion takes its
 *     own);
 *  4. with account_deletion_keeps_reports on, BETWEEN that lock and anything
 *     done in a conversation: the reports filed by or about every account
 *     left, in ONE call for the batch (an account need not be a side of any
 *     conversation to be reported), the messages they name, then the
 *     reports, each in id order, then the update that unlinks the accounts
 *     (a report between two accounts of the batch settled once, both sides)
 *     and leaves no link a later statement of the batch would set NULL. The
 *     order of an account deletion's own (accounts, conversations' lock,
 *     messages and reports, conversations' outcome), documented on
 *     deleteAccountRows with the rule it keeps: no report row is written
 *     twice in the transaction. Flag off: no statement, and the delete below
 *     takes the reports through the cascade, as before;
 *  5. the conversation step for each account that is a side of one (its own
 *     lock meets rows the batch already holds): flag off, each conversation
 *     deleted with its rows; flag on, kept for the other person read-only
 *     (an account that never wrote leaves only its side, set NULL, and the
 *     other person's hidden side unhidden) or deleted when nobody can reach
 *     it;
 *  6. the accounts deleted by id, every guard repeated once more; a count
 *     other than the number of accounts the step settled throws
 *     (SweepDeleteMismatchError) and rolls the whole batch back, so no guard
 *     added later can commit a settlement without its delete.
 * After each commit, each step on its own and never failing the sweep: the
 * files of the conversations deleted, and the notices an account deletion
 * sends (dm:conversation:read_only, the calls ended, the rooms emptied).
 * A batch that fails ends the deletion there: the batches before it stay
 * committed and announced, no further batch is taken, and the failure is
 * answered (its name and code) for the run record. Resolves the ids of the
 * accounts deleted.
 */
async function deleteStaleUnverifiedAccounts(
  ids: string[],
  cutoff: Date,
): Promise<{ deletedIds: string[]; failedBatch: { name: string; code: string | null } | null }> {
  const keepConversations = isFeatureEnabled('account_deletion_keeps_conversations');
  const keepReports = isFeatureEnabled('account_deletion_keeps_reports');
  const deletedIds: string[] = [];
  for (let at = 0; at < ids.length; at += SWEEP_ACCOUNTS_PER_TRANSACTION) {
    const batch = ids.slice(at, at + SWEEP_ACCOUNTS_PER_TRANSACTION);
    let committed: { ids: string[]; conversations: DeletedAccountConversations };
    try {
      committed = await retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
        const locked = (await tx.$queryRaw<Array<{ id: string }>>`
          SELECT u.id FROM users u
          WHERE u.id = ANY(${batch}::text[])
            AND u.email_verified = false
            AND u.created_at < ${cutoff}
            AND u.role = 'user'
            AND NOT EXISTS (SELECT 1 FROM servers s WHERE s.owner_id = u.id)
          ORDER BY u.id
          FOR UPDATE OF u`).map((r) => r.id);
        const conversations: DeletedAccountConversations = { kept: [], deleted: [], attachmentKeys: [] };
        if (locked.length === 0) return { ids: [], conversations };

        // The guard on another table, read again now that the rows are held
        const owners = new Set((await tx.$queryRaw<Array<{ ownerId: string }>>`
          SELECT DISTINCT owner_id AS "ownerId" FROM servers WHERE owner_id = ANY(${locked}::text[])`).map((r) => r.ownerId));
        const eligible = locked.filter((id) => !owners.has(id));
        if (eligible.length === 0) return { ids: [], conversations };

        const sides = await tx.$queryRaw<Array<{ user1Id: string | null; user2Id: string | null }>>`
          SELECT user1_id AS "user1Id", user2_id AS "user2Id"
          FROM conversations
          WHERE user1_id = ANY(${eligible}::text[]) OR user2_id = ANY(${eligible}::text[])
          ORDER BY id
          FOR UPDATE`;
        // Their reports, for every account left, between the conversations'
        // lock above and what is done in them below (step 4), so that no
        // report row is written twice in the batch
        if (keepReports) await settleReportsOfDeletedAccounts(tx, eligible);

        const sideIds = new Set(sides.flatMap((c) => [c.user1Id, c.user2Id]));
        for (const userId of eligible) {
          if (!sideIds.has(userId)) continue;
          const settled = await settleConversationsOfDeletedAccount(tx, userId, { keep: keepConversations });
          // a conversation kept for one swept account and then deleted for the
          // other (both its sides swept) is deleted
          conversations.kept = conversations.kept.filter((id) => !settled.deleted.includes(id)).concat(settled.kept);
          conversations.deleted.push(...settled.deleted);
          conversations.attachmentKeys.push(...settled.attachmentKeys);
        }

        const { count } = await tx.user.deleteMany({
          where: {
            id: { in: eligible },
            emailVerified: false,
            createdAt: { lt: cutoff },
            role: 'user',
            ownedServers: { none: {} },
          },
        });
        if (count !== eligible.length) throw new SweepDeleteMismatchError(eligible.length, count);
        return { ids: eligible, conversations };
      }, { timeout: 60_000, maxWait: 10_000 }), '[RegHygiene] The deletion of stale unverified accounts');
    } catch (err) {
      const failedBatch = describeBatchError(err);
      console.error(`[RegHygiene] A batch of the unverified-account deletion failed (${failedBatch.name}${failedBatch.code ? ` ${failedBatch.code}` : ''}); ${deletedIds.length} account(s) deleted before it are kept deleted, the rest wait for the next sweep`);
      return { deletedIds, failedBatch };
    }
    deletedIds.push(...committed.ids);
    // What follows the commit never undoes it: each step on its own, a failure
    // logged, the batch still counted and the next one still taken (the nightly
    // orphan sweep takes the files a failed step left)
    try {
      deleteAttachmentBlobs([...new Set(committed.conversations.attachmentKeys)], '[RegHygiene]', 'the conversations of swept accounts');
    } catch (err) {
      console.warn('[RegHygiene] After a batch of the unverified-account deletion, the attachment file cleanup failed:', err instanceof Error ? err.message : err);
    }
    try {
      await announceConversationsOfDeletedAccount(committed.conversations, '[RegHygiene]');
    } catch (err) {
      console.warn('[RegHygiene] After a batch of the unverified-account deletion, the notices of its direct conversations failed:', err instanceof Error ? err.message : err);
    }
  }
  return { deletedIds, failedBatch: null };
}

/** A sweep that stopped at a failed batch, after recording what it did: the error's name and code only. */
export class HygieneBatchFailedError extends Error {
  constructor(public readonly failedBatch: { name: string; code: string | null }, public readonly deletedUsers: number) {
    super(`The hygiene sweep stopped at a failed batch (${failedBatch.name}${failedBatch.code ? ` ${failedBatch.code}` : ''}) after deleting ${deletedUsers} account(s)`);
    this.name = 'HygieneBatchFailedError';
  }
}

/**
 * The sweep, with the cluster lock and the run record around it. This is what
 * the scheduler and the admin trigger both call.
 *
 * A dry run takes no lock and records nothing: it deletes nothing, so there is
 * no concurrency to guard and no history worth keeping. `run` (the job
 * registry's handle, utils/jobs.ts, given by the scheduler and by the admin
 * trigger) is told the lock's answer and the counts.
 */
export async function runRegistrationHygieneLocked(
  opts: { trigger: 'scheduled' | 'manual'; actorId?: string | null; dryRun?: boolean; run?: JobRun },
): Promise<HygieneRun | { skipped: 'locked' }> {
  const startedAt = Date.now();
  const base = {
    at: new Date(startedAt).toISOString(),
    trigger: opts.trigger,
    actorId: opts.actorId ?? null,
    nodeId: NODE_ID(),
  };

  if (opts.dryRun) {
    const result = await runRegistrationHygiene({ dryRun: true });
    const run: HygieneRun = { ...base, ...result, durationMs: Date.now() - startedAt };
    console.log(`[RegHygiene] Dry run in ${run.durationMs}ms — WOULD delete ${result.deletedUsers} unverified account(s), ${result.deletedAvatars} avatar(s), ${result.deletedIpRecords} IP record(s)`);
    return run;
  }

  const owner = lockToken();
  let claimed: string | null;
  try {
    claimed = await getRedis().set(HYGIENE_LOCK_KEY, owner, { NX: true, EX: HYGIENE_LOCK_TTL_SECONDS });
  } catch (err) {
    // Fail CLOSED. Skipping a night costs nothing — the accounts are still
    // there tomorrow — whereas racing a peer produces the confusing
    // guard-mismatch warning this lock exists to prevent.
    console.warn('[RegHygiene] Could not claim the sweep lock — skipping this run:', err instanceof Error ? err.message : err);
    opts.run?.skip('store-unavailable');
    return { skipped: 'locked' };
  }
  if (claimed === null) {
    console.log('[RegHygiene] Another node holds the sweep lock — skipping this run');
    opts.run?.lockHeld();
    return { skipped: 'locked' };
  }

  try {
    const result = await runRegistrationHygiene({ run: opts.run });
    const run: HygieneRun = { ...base, ...result, durationMs: Date.now() - startedAt };
    opts.run?.count('deletedUsers', result.deletedUsers);
    opts.run?.count('deletedAvatars', result.deletedAvatars);
    opts.run?.count('deletedIpRecords', result.deletedIpRecords);

    // Unconditional: "it ran and found nothing" is the answer an operator most
    // often needs, and the old log only spoke when it deleted something.
    console.log(`[RegHygiene] Sweep ${result.failedBatch ? 'stopped at a failed batch' : 'complete'} in ${run.durationMs}ms — deleted ${result.deletedUsers} unverified account(s) older than ${UNVERIFIED_ACCOUNT_TTL_DAYS}d, ${result.deletedAvatars} avatar(s), ${result.deletedIpRecords} IP record(s) unseen for ${IP_RETENTION_DAYS}d`);

    await recordHygieneRun(run);
    // Durable trail, unlike the Redis history: survives a flush and shows up in
    // the admin audit log next to every other destructive action.
    logAuditEvent({
      actorId: run.actorId,
      action: 'registration.hygiene_sweep',
      targetType: 'registration',
      metadata: {
        trigger: run.trigger,
        nodeId: run.nodeId,
        deletedUsers: run.deletedUsers,
        deletedAvatars: run.deletedAvatars,
        deletedIpRecords: run.deletedIpRecords,
        durationMs: run.durationMs,
        ...(run.failedBatch && { failedBatch: run.failedBatch }),
      },
    });
    // A run that stopped at a failed batch is recorded above with what it
    // did, and then reported as the failure it is: the scheduler logs it and
    // takes the next nightly slot as usual (the accounts left are still
    // stale then), and the admin trigger answers it as an error.
    if (run.failedBatch) {
      throw new HygieneBatchFailedError(run.failedBatch, run.deletedUsers);
    }
    return run;
  } finally {
    // Only if we still own it: a large backlog can outrun the 15-minute TTL,
    // and a blind DEL would then release a lock another runner now holds.
    await releaseLockIfOwned(getRedis(), HYGIENE_LOCK_KEY, owner).catch((err) =>
      console.warn('[RegHygiene] Lock release failed (it expires on its own):', err instanceof Error ? err.message : err));
  }
}

/** Best-effort: a failed write must never fail the sweep that already ran. */
async function recordHygieneRun(run: HygieneRun): Promise<void> {
  try {
    const redis = getRedis();
    const json = JSON.stringify(run);
    await redis.set(HYGIENE_LAST_RUN_KEY, json);
    await redis.lPush(HYGIENE_HISTORY_KEY, json);
    await redis.lTrim(HYGIENE_HISTORY_KEY, 0, HYGIENE_HISTORY_MAX - 1);
  } catch (err) {
    console.warn('[RegHygiene] Could not record the run:', err instanceof Error ? err.message : err);
  }
}

/**
 * When the sweep last ran and what it took, newest first. `lastRun` is null
 * when it has never run on this deployment — which is itself the answer to
 * "is this thing actually working?", and was previously unanswerable.
 */
export async function getHygieneHistory(): Promise<{ lastRun: HygieneRun | null; history: HygieneRun[] }> {
  try {
    const redis = getRedis();
    const [lastRaw, historyRaw] = await Promise.all([
      redis.get(HYGIENE_LAST_RUN_KEY),
      redis.lRange(HYGIENE_HISTORY_KEY, 0, HYGIENE_HISTORY_MAX - 1),
    ]);
    const parse = (raw: string): HygieneRun | null => {
      try { return JSON.parse(raw) as HygieneRun; } catch { return null; }
    };
    return {
      lastRun: lastRaw ? parse(lastRaw) : null,
      history: (historyRaw ?? []).map(parse).filter((r): r is HygieneRun => r !== null),
    };
  } catch (err) {
    console.warn('[RegHygiene] Could not read the run history:', err instanceof Error ? err.message : err);
    return { lastRun: null, history: [] };
  }
}

/**
 * Hourly spike check (exported for tests). An operator learning about a bot
 * wave from the morning sweep report is a day late — this mails them within
 * the hour, Redis-deduped so a sustained wave sends one alert per window,
 * cross-node safe (SET NX means only one node wins the send).
 */
export async function checkRegistrationSpike(): Promise<void> {
  const alertTo = process.env.CLEANUP_REPORT_EMAIL;
  if (!alertTo) return; // alerting is opt-in, same switch as the cleanup report

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const lastHour = await prisma.user.count({ where: { createdAt: { gte: hourAgo } } });
  if (lastHour < REGISTRATION_SPIKE_PER_HOUR) return;

  try {
    const claimed = await getRedis().set('alert:regspike', '1', { NX: true, EX: SPIKE_ALERT_DEDUPE_SECONDS });
    if (claimed === null) return; // already alerted this window (any node)
  } catch (err) {
    console.warn('[RegHygiene] Spike-alert dedupe failed (sending anyway):', err);
  }

  console.warn(`[RegHygiene] Registration spike: ${lastHour} signups in the last hour`);
  try {
    await sendAdminAlert(alertTo, `Registration spike: ${lastHour} signups in the last hour`, [
      `${lastHour} accounts were registered in the last hour (threshold ${REGISTRATION_SPIKE_PER_HOUR}).`,
      'Review the admin dashboard registration panel: top registering IPs, unverified backlog.',
      'If this is an attack: ban the source IPs (one address per ban), or flip the registration feature flag off.',
    ]);
  } catch (err) {
    console.error('[RegHygiene] Spike alert email failed:', describeEmailError(err));
  }
}
