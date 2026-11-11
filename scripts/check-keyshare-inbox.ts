#!/usr/bin/env tsx
/**
 * Check the key-share inbox statements (apps/server/src/utils/keyShareInbox.ts,
 * docs/e2e-dm-spec.md §12.3) on a real PostgreSQL that has migration
 * 20261111140000_e2e_keyshare_lease: the lease and its expiry, ownership, the
 * UTC database clock under a non-UTC session, and what two sessions can run
 * into (two claims in flight, a legacy claim beside a leasing one, a claim
 * racing an acknowledgement either way, a store and an eviction racing a
 * claim). The route tests mock Prisma and can show none of this.
 *
 *   KEYSHARE_INBOX_CHECK=1 DATABASE_URL=postgresql://... npx tsx scripts/check-keyshare-inbox.ts
 *
 * It writes only rows addressed to a recipient it makes up for the run (the
 * table has no foreign keys), moves only their leases, and deletes them all
 * before it exits, whatever happens. Exit code 1 on any failed check.
 */
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '../apps/server/src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  acknowledgeKeyShares,
  claimAndDeleteKeyShares,
  leaseKeyShares,
  type ClaimedKeyShareRow,
} from '../apps/server/src/utils/keyShareInbox';
import { E2E_LIMITS } from '../packages/shared/src/e2e';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL not set');
if (process.env.KEYSHARE_INBOX_CHECK !== '1') {
  throw new Error('Refusing: set KEYSHARE_INBOX_CHECK=1 to write (and then delete) check rows in e2e_key_shares');
}

const a = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const b = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
type Db = typeof a;
type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

const tag = randomBytes(6).toString('hex');
/** Every row of this run is addressed to a user id starting with this. */
const user = `kscheck${tag}`;
const results: Array<{ ok: boolean; label: string; detail: string }> = [];
const check = (label: string, ok: boolean, detail = '') => results.push({ ok, label, detail });
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).join(',');

let seq = 0;
/** Shares for one device of the run's user, `step` seconds apart, oldest first. */
async function seed(device: string, n: number, step = 1): Promise<string[]> {
  const made: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${user}share${String(++seq).padStart(4, '0')}`;
    made.push(id);
    await a.$executeRaw`
      INSERT INTO e2e_key_shares (id, recipient_user_id, recipient_device_id, sender_user_id, sender_device_id,
                                  conversation_id, session_id, body, created_at)
      VALUES (${id}, ${user}, ${device}, ${`${user}sender`}, ${'checksenderdev'}, ${'checkconv'}, ${'c2Vzcw'}, ${'{}'},
              (now() AT TIME ZONE 'UTC') + make_interval(secs => ${i * step}))`;
  }
  return made;
}

/** Run `body` in a transaction of `client` that stays open until release(). */
function holdOpen<T>(client: Db, body: (tx: Tx) => Promise<T>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached!: (value: T) => void;
  const inside = new Promise<T>((resolve) => (reached = resolve));
  const done = client.$transaction(
    async (tx) => {
      reached(await body(tx));
      await gate;
    },
    { timeout: 20_000 }
  );
  return { inside, release, done };
}

const settledWithin = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

async function remaining(device: string): Promise<string> {
  const rows = await a.e2EKeyShare.findMany({
    where: { recipientUserId: user, recipientDeviceId: device },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return ids(rows);
}

async function oneSession(): Promise<void> {
  const [s1, s2, s3] = await seed('one', 3);
  const [z] = await seed('two', 1);

  // a non-UTC session time zone: the lease is still set on the UTC clock
  const { first, seconds } = await a.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'America/New_York'`);
    const claimed = await leaseKeyShares(tx, user, 'one');
    const lease = await tx.$queryRaw<Array<{ s: number }>>`
      SELECT extract(epoch FROM leased_until - (now() AT TIME ZONE 'UTC'))::float8 AS s
      FROM e2e_key_shares WHERE id = ${s1}`;
    return { first: claimed, seconds: lease[0].s };
  });
  check('a leasing claim hands out the page oldest first', ids(first) === [s1, s2, s3].join(','), ids(first));
  check(
    'the lease is KEYSHARE_LEASE_MS on the UTC clock, under a non-UTC session',
    Math.abs(seconds - E2E_LIMITS.KEYSHARE_LEASE_MS / 1000) < 1,
    `${seconds.toFixed(3)} s`
  );
  check('the leasing claim deletes nothing', (await remaining('one')) === [s1, s2, s3].join(','));
  check('a second leasing claim within the lease gets nothing', (await leaseKeyShares(a, user, 'one')).length === 0);
  check('a legacy claim skips shares under a live lease', (await claimAndDeleteKeyShares(a, user, 'one')).length === 0);
  check('another device claims only its own', ids(await leaseKeyShares(a, user, 'two')) === z);
  check('an acknowledgement from another device deletes nothing', (await acknowledgeKeyShares(a, user, 'two', [s1])) === 0);
  check('an acknowledgement from another account deletes nothing', (await acknowledgeKeyShares(a, `${user}x`, 'one', [s1])) === 0);
  check('an acknowledgement deletes exactly the named share', (await acknowledgeKeyShares(a, user, 'one', [s1, `${user}none`])) === 1);
  check('acknowledging it again counts nothing', (await acknowledgeKeyShares(a, user, 'one', [s1])) === 0);

  // the lease passes: moved back on this run's rows only
  await a.$executeRaw`UPDATE e2e_key_shares SET leased_until = leased_until - interval '61 seconds' WHERE recipient_user_id = ${user}`;
  check('an expired lease makes an unacknowledged share claimable again', ids(await leaseKeyShares(a, user, 'one')) === [s2, s3].join(','));
  check('an acknowledgement after the lease passed still deletes', (await acknowledgeKeyShares(a, user, 'one', [s2])) === 1);
  await a.$executeRaw`UPDATE e2e_key_shares SET leased_until = leased_until - interval '61 seconds' WHERE recipient_user_id = ${user}`;
  const legacy = await claimAndDeleteKeyShares(a, user, 'one');
  check('a legacy claim takes and deletes a share whose lease passed', ids(legacy) === s3 && (await remaining('one')) === '');
}

async function twoSessions(): Promise<void> {
  {
    const all = await seed('inflight', 3);
    const first = holdOpen(a, (tx) => leaseKeyShares(tx, user, 'inflight'));
    const mine = await first.inside;
    const t0 = Date.now();
    const other = await leaseKeyShares(b, user, 'inflight');
    const waited = Date.now() - t0;
    first.release();
    await first.done;
    check('two claims in flight: the first holds the page', ids(mine) === all.join(','));
    check('two claims in flight: the second gets none of it, without waiting', other.length === 0 && waited < 1000, `${waited} ms`);
    check('a claim after the first committed gets nothing while the lease runs', (await leaseKeyShares(b, user, 'inflight')).length === 0);
  }
  {
    await seed('mixed', 2);
    const leasing = holdOpen(a, (tx) => leaseKeyShares(tx, user, 'mixed'));
    const leased: ClaimedKeyShareRow[] = await leasing.inside;
    const during = await claimAndDeleteKeyShares(b, user, 'mixed');
    leasing.release();
    await leasing.done;
    const after = await claimAndDeleteKeyShares(b, user, 'mixed');
    check(
      'a legacy claim racing a leasing one takes nothing, then or after its commit',
      leased.length === 2 && during.length === 0 && after.length === 0 && (await remaining('mixed')).split(',').length === 2
    );
  }
  {
    const [x, y] = await seed('claim-first', 2);
    const claim = holdOpen(a, (tx) => leaseKeyShares(tx, user, 'claim-first'));
    await claim.inside;
    const ack = acknowledgeKeyShares(b, user, 'claim-first', [x]);
    const early = await settledWithin(ack, 500);
    claim.release();
    await claim.done;
    const cleared = await ack;
    check(
      'an acknowledgement racing a claim that holds the share waits for it, then deletes it',
      !early && cleared === 1 && (await remaining('claim-first')) === y
    );
  }
  {
    const [x, y] = await seed('ack-first', 2);
    const ack = holdOpen(b, (tx) => acknowledgeKeyShares(tx, user, 'ack-first', [x]));
    await ack.inside;
    const t0 = Date.now();
    const claimed = await leaseKeyShares(a, user, 'ack-first');
    const waited = Date.now() - t0;
    ack.release();
    await ack.done;
    check(
      'a claim racing an acknowledgement that holds a share skips it without waiting',
      ids(claimed) === y && waited < 1000 && (await remaining('ack-first')) === y,
      `${waited} ms`
    );
  }
  {
    const [old] = await seed('store', 1);
    const stored = `${user}stored`;
    const store = holdOpen(b, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO e2e_key_shares (id, recipient_user_id, recipient_device_id, sender_user_id, sender_device_id,
                                    conversation_id, session_id, body, created_at)
        VALUES (${stored}, ${user}, ${'store'}, ${`${user}sender`}, ${'checksenderdev'}, ${'checkconv'}, ${'c2Vzcw'},
                ${'{}'}, (now() AT TIME ZONE 'UTC') + interval '1 minute')`;
      return true;
    });
    await store.inside;
    const during = await leaseKeyShares(a, user, 'store');
    store.release();
    await store.done;
    const after = await leaseKeyShares(a, user, 'store');
    check('a claim racing a store gets only committed shares, the stored one at the next claim', ids(during) === old && ids(after) === stored);
  }
  {
    const [oldest, next] = await seed('evict', 2);
    const evict = holdOpen(b, (tx) => tx.e2EKeyShare.deleteMany({ where: { id: { in: [oldest] } } }));
    await evict.inside;
    const during = await leaseKeyShares(a, user, 'evict');
    evict.release();
    await evict.done;
    check('a claim racing an eviction skips the share being evicted', ids(during) === next);
  }
}

async function main(): Promise<number> {
  const column = await a.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_name = 'e2e_key_shares' AND column_name = 'leased_until'`;
  if (column[0].n === 0) throw new Error('e2e_key_shares has no leased_until: apply the migrations first');
  try {
    await oneSession();
    await twoSessions();
  } finally {
    const { count } = await a.e2EKeyShare.deleteMany({ where: { recipientUserId: { startsWith: user } } });
    console.log(`removed the run's ${count} row(s)`);
  }
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? `  (${r.detail})` : ''}`);
  return results.every((r) => r.ok) ? 0 : 1;
}

main()
  .then(async (code) => {
    await a.$disconnect();
    await b.$disconnect();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    console.error('key-share inbox check failed:', err instanceof Error ? err.message : err);
    await a.$disconnect();
    await b.$disconnect();
    process.exit(1);
  });
