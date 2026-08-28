// Daily registration-hygiene sweep (runs at 4:30 AM, offset from the 4 AM
// attachment cleanup so the two never contend for the DB):
//
//  1. UNVERIFIED-ACCOUNT TTL — accounts that never verified their email are
//     deleted after UNVERIFIED_ACCOUNT_TTL_DAYS. This is the measure that
//     makes bot registration harvests worthless: the rows stop accumulating,
//     and usernames/emails squatted with breached-list addresses return to
//     their real owners automatically. Legitimate users are unaffected — the
//     app is unusable unverified (requireVerifiedEmail gates every functional
//     route), so a real person verifies within minutes, not days.
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

let timeoutId: ReturnType<typeof setTimeout> | null = null;
let spikeIntervalId: ReturnType<typeof setInterval> | null = null;
let stopped = true;

const SWEEP_HOUR = 4;
const SWEEP_MINUTE = 30;
export const UNVERIFIED_ACCOUNT_TTL_DAYS = 7;
export const IP_RETENTION_DAYS = 180;

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
  /** Avatar objects handed to S3. Zero when the guard counts disagreed. */
  deletedAvatars: number;
  /** True ⇒ nothing was deleted; the counts are what WOULD have gone. */
  dryRun: boolean;
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
    runRegistrationHygieneLocked({ trigger: 'scheduled' })
      .catch((err) => console.error('[RegHygiene] Sweep failed:', err))
      .finally(() => scheduleNext(true));
  }, delay);
}

/**
 * The sweep itself. Exported for tests and for the admin trigger, but callers
 * that actually delete should go through `runRegistrationHygieneLocked` so the
 * cluster lock and the run record apply.
 */
export async function runRegistrationHygiene(opts: { dryRun?: boolean } = {}): Promise<HygieneResult> {
  const dryRun = opts.dryRun === true;
  const userCutoff = new Date(Date.now() - UNVERIFIED_ACCOUNT_TTL_DAYS * 24 * 60 * 60 * 1000);
  const ipCutoff = new Date(Date.now() - IP_RETENTION_DAYS * 24 * 60 * 60 * 1000);

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

  // The guards are REPEATED on the delete, not just on the select above: a
  // user who verifies their email between the two statements must survive, and
  // only Postgres can decide that atomically.
  const { count: deletedUsers } = dryRun
    ? { count: staleUnverified.length }
    : staleUnverified.length > 0
      ? await prisma.user.deleteMany({
          where: {
            id: { in: staleUnverified.map((u) => u.id) },
            emailVerified: false,
            createdAt: { lt: userCutoff },
            role: 'user',
            ownedServers: { none: {} },
          },
        })
      : { count: 0 };

  // AFTER the rows are gone: a failed delete must not strand a live avatar.
  // If the counts disagree, someone in the batch was spared by the guards and
  // we cannot tell WHICH — so delete nothing and let the nightly orphan sweep
  // reclaim them in a week. Losing a live user's avatar is much worse than
  // holding a few dead blobs a little longer.
  const avatarKeys = staleUnverified.map((u) => u.avatarUrl).filter((k): k is string => !!k);
  let deletedAvatars = 0;
  if (avatarKeys.length > 0 && deletedUsers === staleUnverified.length) {
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
  } else if (avatarKeys.length > 0) {
    console.warn(`[RegHygiene] ${staleUnverified.length - deletedUsers} account(s) were spared by the delete guards — leaving their avatars to the orphan sweep`);
  }

  const { count: deletedIpRecords } = dryRun
    ? { count: await prisma.ipRecord.count({ where: { lastSeenAt: { lt: ipCutoff } } }) }
    : await prisma.ipRecord.deleteMany({ where: { lastSeenAt: { lt: ipCutoff } } });

  return { deletedUsers, deletedIpRecords, deletedAvatars, dryRun };
}

/**
 * The sweep, with the cluster lock and the run record around it. This is what
 * the scheduler and the admin trigger both call.
 *
 * A dry run takes no lock and records nothing: it deletes nothing, so there is
 * no concurrency to guard and no history worth keeping.
 */
export async function runRegistrationHygieneLocked(
  opts: { trigger: 'scheduled' | 'manual'; actorId?: string | null; dryRun?: boolean },
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
    return { skipped: 'locked' };
  }
  if (claimed === null) {
    console.log('[RegHygiene] Another node holds the sweep lock — skipping this run');
    return { skipped: 'locked' };
  }

  try {
    const result = await runRegistrationHygiene();
    const run: HygieneRun = { ...base, ...result, durationMs: Date.now() - startedAt };

    // Unconditional: "it ran and found nothing" is the answer an operator most
    // often needs, and the old log only spoke when it deleted something.
    console.log(`[RegHygiene] Sweep complete in ${run.durationMs}ms — deleted ${result.deletedUsers} unverified account(s) older than ${UNVERIFIED_ACCOUNT_TTL_DAYS}d, ${result.deletedAvatars} avatar(s), ${result.deletedIpRecords} IP record(s) unseen for ${IP_RETENTION_DAYS}d`);

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
      },
    });
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
      'If this is an attack: ban the source IPs/ranges, or flip the registration feature flag off.',
    ]);
  } catch (err) {
    console.error('[RegHygiene] Spike alert email failed:', describeEmailError(err));
  }
}
