// Daily S3 orphan sweep (05:00 local — offset from the 04:00 attachment
// cleanup and the 04:30 registration hygiene so the three never contend).
//
// WHY A SWEEP AT ALL. Several delete paths drop the DB row without the blob:
// the unverified-account sweep, the admin delete-user and delete-server
// actions. Each is worth fixing at the source (and some now are), but a
// backstop catches the ones nobody thought of — including an upload whose
// message was never sent.
//
// WHY IT IS AGE-GATED, AND WHY THAT IS THE LOAD-BEARING PART. Uploading and
// writing the DB row are separate, client-driven steps: the client presigns
// and PUTs an attachment the moment the file is attached, and the
// MessageAttachment row is only created when the message is SENT. Avatars and
// server icons are the same shape (PUT, then a later PATCH). A user who
// attaches a file and then types for ten minutes has a live object with no
// row. An un-gated "delete everything unreferenced" sweep would delete it and
// they would send a permanently broken attachment. The grace period has to
// dominate any plausible compose window, so it is measured in DAYS.
//
// ORDER MATTERS TOO: LIST first, then read the DB. A row written while the
// listing is in flight is then guaranteed to be seen; the reverse order (or
// running them concurrently, as the admin endpoint originally did) leaves a
// window even with the age gate.
import { prisma } from './prisma';
import { listAllS3Objects, deleteMultipleFromS3, VALID_S3_KEY_RE, VALID_ATTACHMENT_KEY_RE } from './s3';
import { getRedis, NODE_ID } from './redis';
import { msUntilDailySlot } from './dailySchedule';

let timeoutId: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

const SWEEP_HOUR = 5;
const SWEEP_MINUTE = 0;
/** Objects younger than this are never touched — see the ordering note above. */
export const ORPHAN_GRACE_DAYS = 7;
const PAGE_SIZE = 1000;
/** Only one node runs the sweep: production is multi-node and two concurrent
 *  full-bucket destructive scans, from two different snapshots, is not a thing
 *  we want. Same `SET NX EX` idiom as the registration spike alert. */
const LOCK_KEY = 'lock:orphan-sweep';
const LOCK_TTL_SECONDS = 3600;

export interface OrphanSweepResult {
  scanned: number;
  orphaned: number;
  deleted: number;
  /** Unreferenced but inside the grace window — an in-flight upload, most likely. */
  tooYoung: number;
  /** Unreferenced and old, but not shaped like anything this app writes. */
  foreign: number;
  skipped?: 'not-leader';
}

const EMPTY: OrphanSweepResult = { scanned: 0, orphaned: 0, deleted: 0, tooYoung: 0, foreign: 0 };

export function startOrphanCleanup() {
  if (!stopped) return;
  stopped = false;
  scheduleNext(false);
}

export function stopOrphanCleanup() {
  stopped = true;
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

function scheduleNext(afterRun: boolean) {
  if (stopped) return;
  const delay = msUntilDailySlot(SWEEP_HOUR, SWEEP_MINUTE, afterRun);
  console.log(`[OrphanSweep] Next sweep in ${Math.round(delay / 60000)} minutes`);
  timeoutId = setTimeout(() => {
    runScheduledOrphanCleanup()
      .catch((err) => console.error('[OrphanSweep] Sweep failed:', err))
      .finally(() => scheduleNext(true));
  }, delay);
  timeoutId.unref?.();
}

/** The scheduled entry point: claims the cluster lock, then sweeps. */
export async function runScheduledOrphanCleanup(): Promise<OrphanSweepResult> {
  let claimed: string | null;
  try {
    claimed = await getRedis().set(LOCK_KEY, NODE_ID(), { NX: true, EX: LOCK_TTL_SECONDS });
  } catch (err) {
    // Fail CLOSED: without the lock we cannot tell whether a peer is already
    // scanning, and a destructive sweep is not worth racing.
    console.warn('[OrphanSweep] Could not claim the sweep lock — skipping this run:', err instanceof Error ? err.message : err);
    return { ...EMPTY, skipped: 'not-leader' };
  }
  if (claimed === null) return { ...EMPTY, skipped: 'not-leader' };

  try {
    return await runOrphanCleanup();
  } finally {
    // Release rather than waiting out the TTL, so a sweep that fails early can
    // be retried inside the hour instead of being locked out by its own corpse.
    await getRedis().del(LOCK_KEY).catch((err) =>
      console.warn('[OrphanSweep] Lock release failed (it expires on its own):', err instanceof Error ? err.message : err));
  }
}

/**
 * Delete S3 objects that nothing in the database references and that are older
 * than the grace period. Exported for the admin endpoint and for tests.
 *
 * `dryRun` reports what WOULD go without deleting anything — the honest way to
 * inspect a bucket before trusting the sweep with it.
 */
export async function runOrphanCleanup(
  opts: { minAgeMs?: number; dryRun?: boolean } = {},
): Promise<OrphanSweepResult> {
  const minAgeMs = opts.minAgeMs ?? ORPHAN_GRACE_DAYS * 24 * 60 * 60 * 1000;
  const listedAt = Date.now();

  // LIST first — anything written while this runs is caught by the DB reads
  // that follow, so it can never be classified as an orphan.
  const objects = await listAllS3Objects();
  const referenced = await referencedKeys();

  let tooYoung = 0;
  let foreign = 0;
  const orphanKeys: string[] = [];
  for (const obj of objects) {
    if (referenced.has(obj.key)) continue;
    // Key-SHAPE whitelist on top of the reference check. The bucket may hold
    // things this app never wrote — a staging deployment pointed at the same
    // bucket, DB dumps, operator uploads — and none of those appear in our
    // three columns either. Behind a manual admin button that was the
    // operator's call to make; unattended and nightly it would be silent
    // destruction of somebody else's data.
    if (!VALID_S3_KEY_RE.test(obj.key) && !VALID_ATTACHMENT_KEY_RE.test(obj.key)) { foreign++; continue; }
    // No timestamp = cannot prove it is old = do not touch it (NaN fails the
    // comparison, which is the direction we want).
    const age = obj.lastModified ? listedAt - Date.parse(obj.lastModified) : NaN;
    if (!(age >= minAgeMs)) { tooYoung++; continue; }
    orphanKeys.push(obj.key);
  }

  let deleted = 0;
  if (!opts.dryRun && orphanKeys.length > 0) {
    // Batched (1000/call) rather than one DeleteObject per key — a bucket with
    // 10k orphans was 10k sequential round trips inside one HTTP request. The
    // return value is what S3 ACCEPTED: reporting the candidate count instead
    // would log deleted=5000 every night while a missing s3:DeleteObject
    // permission quietly moved nothing.
    deleted = await deleteMultipleFromS3(orphanKeys);
  }

  const result: OrphanSweepResult = {
    scanned: objects.length,
    orphaned: orphanKeys.length,
    deleted,
    tooYoung,
    foreign,
  };
  console.log(
    `[OrphanSweep] scanned=${result.scanned} orphaned=${result.orphaned} deleted=${result.deleted} within-grace=${result.tooYoung} not-ours=${result.foreign}${opts.dryRun ? ' (dry run)' : ''}`
  );
  if (!opts.dryRun && deleted < orphanKeys.length) {
    console.error(`[OrphanSweep] S3 refused ${orphanKeys.length - deleted} deletion(s) — check the bucket policy / IAM permissions`);
  }
  return result;
}

/**
 * Every S3 key the database still points at.
 *
 * This is an implicit WHITELIST of the three things that write to the bucket
 * (avatars, server icons, message attachments — the only callers of
 * `generatePresignedPutUrl`). A future upload kind that is not added here will
 * be swept as an orphan once it passes the grace period.
 */
async function referencedKeys(): Promise<Set<string>> {
  const keys = new Set<string>();

  const [users, servers] = await Promise.all([
    prisma.user.findMany({ where: { avatarUrl: { not: null } }, select: { avatarUrl: true } }),
    prisma.server.findMany({ where: { iconUrl: { not: null } }, select: { iconUrl: true } }),
  ]);
  for (const u of users) if (u.avatarUrl) keys.add(u.avatarUrl);
  for (const s of servers) if (s.iconUrl) keys.add(s.iconUrl);

  // Attachments are the unbounded one — page by id cursor rather than reading
  // the whole table into memory.
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.messageAttachment.findMany({
      where: { expired: false },
      select: { id: true, s3Key: true },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const a of page) keys.add(a.s3Key);
    if (page.length < PAGE_SIZE) break;
    cursor = page[page.length - 1].id;
  }

  return keys;
}
