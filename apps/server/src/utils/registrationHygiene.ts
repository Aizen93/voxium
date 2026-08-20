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
import { getRedis } from './redis';
import { sendAdminAlert, describeEmailError } from './email';

let timeoutId: ReturnType<typeof setTimeout> | null = null;
let spikeIntervalId: ReturnType<typeof setInterval> | null = null;
let stopped = true;

const SWEEP_HOUR = 4;
const SWEEP_MINUTE = 30;
export const UNVERIFIED_ACCOUNT_TTL_DAYS = 7;
export const IP_RETENTION_DAYS = 180;
/** Registrations in one hour that trip the operator alert. A healthy young
 *  platform sees a handful; a bot wave is unmistakable at this level. */
export const REGISTRATION_SPIKE_PER_HOUR = 30;
const SPIKE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** One alert per 6h — a sustained wave should not mailbomb the operator. */
const SPIKE_ALERT_DEDUPE_SECONDS = 6 * 60 * 60;

function msUntilNextSweep(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(SWEEP_HOUR, SWEEP_MINUTE, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

export function startRegistrationHygiene() {
  if (!stopped) return;
  stopped = false;
  scheduleNext();
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

function scheduleNext() {
  if (stopped) return;
  const delay = msUntilNextSweep();
  console.log(`[RegHygiene] Next sweep in ${Math.round(delay / 60000)} minutes`);
  timeoutId = setTimeout(() => {
    runRegistrationHygiene()
      .catch((err) => console.error('[RegHygiene] Sweep failed:', err))
      .finally(scheduleNext);
  }, delay);
}

/** Exported for tests and for a manual admin trigger. */
export async function runRegistrationHygiene(): Promise<{ deletedUsers: number; deletedIpRecords: number }> {
  const userCutoff = new Date(Date.now() - UNVERIFIED_ACCOUNT_TTL_DAYS * 24 * 60 * 60 * 1000);
  const ipCutoff = new Date(Date.now() - IP_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Defense-in-depth guards on the delete, not just the flag:
  //  - role 'user' only — an unverified admin should be impossible, but a
  //    sweep must never be the thing that deletes one if it happens
  //  - no owned servers — Server.owner is onDelete: Restrict, so such a
  //    delete would throw anyway; excluding it keeps the sweep clean and
  //    covers any pre-verification-era legacy accounts
  const { count: deletedUsers } = await prisma.user.deleteMany({
    where: {
      emailVerified: false,
      createdAt: { lt: userCutoff },
      role: 'user',
      ownedServers: { none: {} },
    },
  });

  const { count: deletedIpRecords } = await prisma.ipRecord.deleteMany({
    where: { lastSeenAt: { lt: ipCutoff } },
  });

  if (deletedUsers > 0 || deletedIpRecords > 0) {
    console.log(`[RegHygiene] Deleted ${deletedUsers} unverified account(s) older than ${UNVERIFIED_ACCOUNT_TTL_DAYS}d and ${deletedIpRecords} IP record(s) unseen for ${IP_RETENTION_DAYS}d`);
  }

  return { deletedUsers, deletedIpRecords };
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
