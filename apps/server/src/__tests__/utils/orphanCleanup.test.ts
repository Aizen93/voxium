import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockList, mockDeleteMany, mockRedisSet, mockRedisDel, mockRedisEval } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findMany: vi.fn().mockResolvedValue([]) },
    server: { findMany: vi.fn().mockResolvedValue([]) },
    messageAttachment: { findMany: vi.fn().mockResolvedValue([]) },
  },
  mockList: vi.fn().mockResolvedValue([]),
  mockDeleteMany: vi.fn(async (keys: string[]) => keys.length),
  mockRedisSet: vi.fn().mockResolvedValue('OK'),
  mockRedisDel: vi.fn().mockResolvedValue(1),
  mockRedisEval: vi.fn().mockResolvedValue(1),
}));

vi.mock('../../utils/prisma', () => ({ prisma: mockPrisma }));
vi.mock('../../utils/s3', async (importOriginal) => ({
  listAllS3Objects: mockList,
  deleteMultipleFromS3: mockDeleteMany,
  // The key-shape whitelist is a real guard, not a stub — a foreign object
  // must survive the sweep, so the actual regexes have to run.
  VALID_S3_KEY_RE: (await importOriginal<typeof import('../../utils/s3')>()).VALID_S3_KEY_RE,
  VALID_ATTACHMENT_KEY_RE: (await importOriginal<typeof import('../../utils/s3')>()).VALID_ATTACHMENT_KEY_RE,
}));
vi.mock('../../utils/redis', () => ({
  getRedis: () => ({ set: mockRedisSet, del: mockRedisDel, eval: mockRedisEval }),
  NODE_ID: () => 'node-1',
}));

import { runOrphanCleanup, runScheduledOrphanCleanup, ORPHAN_GRACE_DAYS, ORPHAN_MAX_DELETES_PER_RUN, ORPHAN_MAX_FRACTION, ORPHAN_FRACTION_FLOOR } from '../../utils/orphanCleanup';

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function s3(key: string, ageMs: number, lastModified?: string | null) {
  return { key, size: 1, lastModified: lastModified === undefined ? ago(ageMs) : lastModified };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.server.findMany.mockResolvedValue([]);
  mockPrisma.messageAttachment.findMany.mockResolvedValue([]);
  mockList.mockResolvedValue([]);
  mockDeleteMany.mockImplementation(async (keys: string[]) => keys.length);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockRedisEval.mockResolvedValue(1);
});

describe('orphan sweep — blast-radius ceiling', () => {
  // Everything this job deletes is something the DB said nothing points at, so
  // `referencedKeys()` is load-bearing in a way nothing else here is. A renamed
  // column, a query that silently returns fewer rows, an upload kind nobody
  // added — each turns "delete the orphans" into "delete the bucket", and
  // neither the age gate nor the shape whitelist helps, because live objects
  // pass both.
  it('refuses the whole run rather than deleting an implausible number of objects', async () => {
    const many = Array.from({ length: ORPHAN_MAX_DELETES_PER_RUN + 1 }, (_, i) => s3(`avatars/u-${i}.webp`, 30 * DAY));
    mockList.mockResolvedValue(many);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runOrphanCleanup();

    // Reported, so an operator can see what it found — but nothing deleted
    expect(result.orphaned).toBe(ORPHAN_MAX_DELETES_PER_RUN + 1);
    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe('over-cap');
    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('REFUSING to delete'));

    error.mockRestore();
  });

  it('deletes normally right up to the ceiling when the orphans are a small share of the bucket', async () => {
    const orphans = Array.from({ length: ORPHAN_MAX_DELETES_PER_RUN }, (_, i) => s3(`avatars/u-${i}.webp`, 30 * DAY));
    // Enough referenced objects that 50k is under the proportional bound
    const liveCount = Math.ceil(ORPHAN_MAX_DELETES_PER_RUN / ORPHAN_MAX_FRACTION);
    const live = Array.from({ length: liveCount }, (_, i) => s3(`avatars/live-${i}.webp`, 30 * DAY));
    mockList.mockResolvedValue([...orphans, ...live]);
    mockPrisma.user.findMany.mockResolvedValue(live.map((o, i) => ({ id: `u-${i}`, avatarUrl: o.key })));

    const result = await runOrphanCleanup();

    expect(result.deleted).toBe(ORPHAN_MAX_DELETES_PER_RUN);
    expect(result.skipped).toBeUndefined();
  });

  // The absolute ceiling protects no bucket smaller than itself — and this
  // one is (attachment blobs go at 3 days, grace is 7). A reference query that
  // returned nothing used to delete every live object of a 20k bucket and log
  // it like a healthy night. The real hazard is the PROPORTION.
  it('refuses when more than the fraction bound of the bucket looks orphaned — a broken reference query, not a dirty bucket', async () => {
    const total = 2000;
    const all = Array.from({ length: total }, (_, i) => s3(`avatars/u-${i}.webp`, 30 * DAY));
    mockList.mockResolvedValue(all);
    mockPrisma.user.findMany.mockResolvedValue([]); // "nothing is referenced"
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runOrphanCleanup();

    expect(result.orphaned).toBe(total);
    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe('over-fraction');
    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('REFUSING to delete'));
    error.mockRestore();
  });

  it('the proportional bound is exactly ORPHAN_MAX_FRACTION of what was scanned', async () => {
    const total = 4000;
    const orphanCount = Math.floor(total * ORPHAN_MAX_FRACTION);
    const all = Array.from({ length: total }, (_, i) => s3(`avatars/u-${i}.webp`, 30 * DAY));
    mockList.mockResolvedValue(all);
    const referenced = all.slice(orphanCount).map((o, i) => ({ id: `u-${i}`, avatarUrl: o.key }));
    mockPrisma.user.findMany.mockResolvedValue(referenced);

    // Exactly at the fraction: allowed
    const atBound = await runOrphanCleanup();
    expect(atBound.skipped).toBeUndefined();
    expect(atBound.deleted).toBe(orphanCount);

    // One more orphan: refused
    mockPrisma.user.findMany.mockResolvedValue(referenced.slice(1));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const overBound = await runOrphanCleanup();
    expect(overBound.skipped).toBe('over-fraction');
    expect(overBound.deleted).toBe(0);
    error.mockRestore();
  });

  it('never applies the fraction bound below the floor, so a tiny or fresh bucket sweeps normally', async () => {
    // 100% orphaned, but only ORPHAN_FRACTION_FLOOR of them: ordinary churn on
    // a small self-hosted bucket, not a sign of a broken query
    const few = Array.from({ length: ORPHAN_FRACTION_FLOOR }, (_, i) => s3(`avatars/u-${i}.webp`, 30 * DAY));
    mockList.mockResolvedValue(few);

    const result = await runOrphanCleanup();

    expect(result.skipped).toBeUndefined();
    expect(result.deleted).toBe(ORPHAN_FRACTION_FLOOR);
  });

  it('force lifts the proportional bound but NEVER the absolute ceiling', async () => {
    const total = 2000;
    mockList.mockResolvedValue(Array.from({ length: total }, (_, i) => s3(`avatars/u-${i}.webp`, 30 * DAY)));
    const forced = await runOrphanCleanup({ force: true });
    expect(forced.skipped).toBeUndefined();
    expect(forced.deleted).toBe(total);

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockList.mockResolvedValue(Array.from({ length: ORPHAN_MAX_DELETES_PER_RUN + 1 }, (_, i) => s3(`avatars/u-${i}.webp`, 30 * DAY)));
    const stillCapped = await runOrphanCleanup({ force: true });
    expect(stillCapped.skipped).toBe('over-cap');
    expect(stillCapped.deleted).toBe(0);
    error.mockRestore();
  });

  it('a dry run reports the refusal too, so an operator can see it coming', async () => {
    mockList.mockResolvedValue(Array.from({ length: 2000 }, (_, i) => s3(`avatars/u-${i}.webp`, 30 * DAY)));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runOrphanCleanup({ dryRun: true });

    expect(result.skipped).toBe('over-fraction');
    expect(result.orphaned).toBe(2000);
    expect(mockDeleteMany).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('orphan sweep — what it deletes', () => {
  it('deletes an old, unreferenced object', async () => {
    mockList.mockResolvedValue([s3('avatars/abandoned-1.webp', 30 * DAY)]);

    const result = await runOrphanCleanup();

    expect(mockDeleteMany).toHaveBeenCalledWith(['avatars/abandoned-1.webp']);
    expect(result).toMatchObject({ scanned: 1, orphaned: 1, deleted: 1, tooYoung: 0 });
  });

  it('spares an object that is still referenced, however old', async () => {
    mockList.mockResolvedValue([
      s3('avatars/live-1.webp', 400 * DAY),
      s3('server-icons/live-2.webp', 400 * DAY),
      s3('attachments/ch-abc/1712345678-live.png', 400 * DAY),
    ]);
    mockPrisma.user.findMany.mockResolvedValue([{ avatarUrl: 'avatars/live-1.webp' }]);
    mockPrisma.server.findMany.mockResolvedValue([{ iconUrl: 'server-icons/live-2.webp' }]);
    mockPrisma.messageAttachment.findMany.mockResolvedValue([{ id: 'a1', s3Key: 'attachments/ch-abc/1712345678-live.png' }]);

    const result = await runOrphanCleanup();

    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ orphaned: 0 });
  });

  it('SPARES an object that is not shaped like anything this app writes', async () => {
    // The bucket may hold a staging deployment's objects, DB dumps, operator
    // uploads. None of them appear in our three columns either, so the
    // reference check alone would delete them — tolerable behind a manual
    // admin button, silent destruction on a nightly timer.
    mockList.mockResolvedValue([
      s3('db-dumps/2026-08-20.sql', 400 * DAY),
      s3('staging/whatever.bin', 400 * DAY),
      s3('avatars/ours.webp', 400 * DAY),
    ]);

    const result = await runOrphanCleanup();

    expect(mockDeleteMany).toHaveBeenCalledWith(['avatars/ours.webp']);
    expect(result).toMatchObject({ orphaned: 1, foreign: 2 });
  });

  it('reports what S3 ACCEPTED, not what it was asked to delete', async () => {
    // DeleteObjects answers 200 with a populated Errors[] when the credentials
    // lack s3:DeleteObject — a log line claiming deleted=N every night while
    // nothing moves is worse than no log line at all.
    mockList.mockResolvedValue([
      s3('avatars/a.webp', 30 * DAY),
      s3('avatars/b.webp', 30 * DAY),
    ]);
    mockDeleteMany.mockResolvedValue(0);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runOrphanCleanup();

    expect(result).toMatchObject({ orphaned: 2, deleted: 0 });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  // THE reason this sweep is safe to schedule at all. Uploading and writing
  // the DB row are separate, client-driven steps: an attachment is PUT the
  // moment the file is attached and the row appears only when the message is
  // SENT. Without the age gate, a nightly sweep deletes the object of anyone
  // who left a composer open, and they ship a permanently broken attachment.
  it('SPARES an unreferenced object inside the grace window (an upload in flight)', async () => {
    mockList.mockResolvedValue([s3('attachments/ch-abc/1712345678-being-typed.png', 30 * 60 * 1000)]);

    const result = await runOrphanCleanup();

    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ orphaned: 0, tooYoung: 1 });
  });

  it('spares an object right up to the grace boundary and deletes just past it', async () => {
    mockList.mockResolvedValue([
      s3('avatars/just-inside.webp', ORPHAN_GRACE_DAYS * DAY - 60_000),
      s3('avatars/just-outside.webp', ORPHAN_GRACE_DAYS * DAY + 60_000),
    ]);

    await runOrphanCleanup();

    expect(mockDeleteMany).toHaveBeenCalledWith(['avatars/just-outside.webp']);
  });

  it('spares an object with no timestamp — unprovable age is not old enough', async () => {
    mockList.mockResolvedValue([s3('avatars/no-date.webp', 0, null)]);

    const result = await runOrphanCleanup();

    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ tooYoung: 1 });
  });

  it('LISTS before reading the DB, so a row written mid-listing is never an orphan', async () => {
    // Running the two concurrently (as the admin endpoint used to) leaves a
    // window the age gate cannot close on a bucket whose LIST takes minutes.
    const order: string[] = [];
    mockList.mockImplementation(async () => { order.push('list'); return []; });
    mockPrisma.user.findMany.mockImplementation(async () => { order.push('db'); return []; });

    await runOrphanCleanup();

    expect(order[0]).toBe('list');
    expect(order).toContain('db');
  });

  it('dryRun reports without deleting', async () => {
    mockList.mockResolvedValue([s3('avatars/old.webp', 30 * DAY)]);

    const result = await runOrphanCleanup({ dryRun: true });

    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ orphaned: 1, deleted: 0 });
  });

  it('deletes in ONE batched call rather than a round trip per key', async () => {
    mockList.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => s3(`avatars/old-${i}.webp`, 30 * DAY)),
    );

    await runOrphanCleanup();

    expect(mockDeleteMany).toHaveBeenCalledTimes(1);
    expect(mockDeleteMany.mock.calls[0][0]).toHaveLength(50);
  });

  it('pages the attachment table by id cursor instead of reading it whole', async () => {
    mockList.mockResolvedValue([]);
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `att-${from + i}`, s3Key: `k-${from + i}` }));
    mockPrisma.messageAttachment.findMany
      .mockResolvedValueOnce(page(1000, 0))
      .mockResolvedValueOnce(page(3, 1000));

    await runOrphanCleanup();

    expect(mockPrisma.messageAttachment.findMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.messageAttachment.findMany.mock.calls[1][0]).toMatchObject({
      cursor: { id: 'att-999' },
      skip: 1,
    });
  });
});

/**
 * A tiny Redis with REAL `SET NX EX` / compare-and-delete semantics, so the
 * lock tests exercise what the Lua script does rather than a stub that
 * answers 0 or 1 regardless — which passed against a blind DEL.
 */
function fakeLockStore() {
  const store = new Map<string, string>();
  mockRedisSet.mockImplementation(async (key: string, value: string, opts?: { NX?: boolean }) => {
    if (opts?.NX && store.has(key)) return null;
    store.set(key, value);
    return 'OK';
  });
  mockRedisEval.mockImplementation(async (script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) => {
    expect(script).toContain("redis.call('get', KEYS[1]) == ARGV[1]");
    if (store.get(keys[0]) === args[0]) { store.delete(keys[0]); return 1; }
    return 0;
  });
  return store;
}

describe('orphan sweep — cluster leadership', () => {
  it('sweeps when it wins the lock, and releases it by compare-and-delete with its OWN token', async () => {
    const store = fakeLockStore();
    mockList.mockResolvedValue([s3('avatars/old.webp', 30 * DAY)]);

    const result = await runScheduledOrphanCleanup();

    expect(mockRedisSet).toHaveBeenCalledWith('lock:orphan-sweep', expect.stringMatching(/^node-1:[0-9a-f-]{36}$/), { NX: true, EX: 3600 });
    expect(result.deleted).toBe(1);
    // Released rather than left to expire, so a sweep that fails early can be
    // retried inside the hour instead of being locked out by its own corpse —
    // and released by compare-and-delete, never a blind DEL: a full-bucket scan
    // can outrun the one-hour TTL, at which point the lock in Redis belongs to
    // whoever started next.
    expect(mockRedisDel).not.toHaveBeenCalled();
    const token = mockRedisSet.mock.calls[0][1];
    expect(mockRedisEval).toHaveBeenCalledWith(expect.any(String), { keys: ['lock:orphan-sweep'], arguments: [token] });
    expect(store.has('lock:orphan-sweep')).toBe(false);
  });

  it('does NOT release a lock that a later acquisition holds — even one from the SAME process', async () => {
    // A full-bucket scan can outrun the one-hour TTL. By then Redis holds the
    // NEXT runner's value, and a blind DEL would hand their lock to a third —
    // which is the mutual exclusion this lock exists to provide, gone. The
    // next runner can be THIS node: an admin's manual trigger runs in the same
    // process as the scheduler, and a per-process token (NODE_ID) made the
    // scheduled run's release match it.
    const store = fakeLockStore();
    let resolveList!: (v: never[]) => void;
    mockList.mockReturnValueOnce(new Promise<never[]>((r) => { resolveList = r; }));

    const first = runScheduledOrphanCleanup();
    await vi.waitFor(() => expect(mockRedisSet).toHaveBeenCalledTimes(1));
    // TTL expiry mid-scan, then the manual run claims the lock with its own token
    store.delete('lock:orphan-sweep');
    mockList.mockResolvedValue([]);
    const second = await runScheduledOrphanCleanup();
    expect(second.skipped).toBeUndefined();
    const secondToken = mockRedisSet.mock.calls[1][1];
    expect(secondToken).not.toBe(mockRedisSet.mock.calls[0][1]);
    // Put the second runner's lock back as if it were still mid-scan, then let
    // the first finish: it must leave that lock alone.
    store.set('lock:orphan-sweep', secondToken);
    resolveList([]);
    await first;

    expect(mockRedisDel).not.toHaveBeenCalled();
    expect(store.get('lock:orphan-sweep')).toBe(secondToken);
  });

  it('mints a fresh token for every acquisition', async () => {
    fakeLockStore();
    mockList.mockResolvedValue([]);

    await runScheduledOrphanCleanup();
    await runScheduledOrphanCleanup();

    const [a, b] = mockRedisSet.mock.calls.map((c) => c[1]);
    expect(a).toMatch(/^node-1:/);
    expect(b).toMatch(/^node-1:/);
    expect(a).not.toBe(b);
  });

  it('does nothing when a peer already holds the lock', async () => {
    // Production runs 2+ nodes; two concurrent full-bucket destructive scans
    // from two different snapshots is not a thing we want.
    mockRedisSet.mockResolvedValue(null);

    const result = await runScheduledOrphanCleanup();

    expect(mockList).not.toHaveBeenCalled();
    expect(result.skipped).toBe('not-leader');
  });

  it('FAILS CLOSED when the lock cannot be reached', async () => {
    mockRedisSet.mockRejectedValue(new Error('redis down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runScheduledOrphanCleanup();

    expect(mockList).not.toHaveBeenCalled();
    expect(result.skipped).toBe('not-leader');
    warn.mockRestore();
  });
});
