import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lazyStatement } from '../helpers/lazyStatement';
import * as store from '../../utils/sessionStore';

/**
 * The SQL of the sign-in sessions. These statements were run as written
 * against a real PostgreSQL 16 whose connections use a TimeZone of UTC+14
 * (Pacific/Kiritimati), from a Node process in America/Los_Angeles: the
 * expiry, the grace window and the sweep's cutoff came out on the database's
 * UTC clock to the second; the conditional UPDATE, raced from two
 * connections in both orders, updated one row and left the other waiting
 * and then updating none (and 500 racing pairs of statements never produced
 * two winners or none); the sweep deleted exactly the rows more than one
 * hour past their expiry and those below their account's token version.
 * What this pins is the shape that made that so. Each statement is recorded
 * when it RUNS (lazyStatement), not when it is built.
 */

interface Call { name: string; sql: string; values: unknown[] }

let calls: Call[];
let ran: string[];
let results: unknown[];

function db() {
  const record = (kind: string) => vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    const name = `${kind}#${calls.length}`;
    calls.push({ name, sql, values });
    return lazyStatement(ran, name, results.length ? results.shift() : []);
  });
  return { $queryRaw: record('query'), $executeRaw: record('execute') } as unknown as store.SessionDb;
}

beforeEach(() => {
  calls = [];
  ran = [];
  results = [];
});

/** Every "now" a statement reads is the database's, in UTC. */
function expectDatabaseClockOnly(sql: string) {
  const nows = sql.match(/now\(\)[^,)]*/gi) ?? [];
  for (const n of nows) expect(n, sql).toMatch(/^now\(\) AT TIME ZONE 'UTC'/);
  expect(sql).not.toMatch(/CURRENT_TIMESTAMP|LOCALTIMESTAMP|clock_timestamp/i);
}

describe('sessionStore — writing and renewing a session', () => {
  it('insertSession: generation 1, created = rotated = the database\'s now, expiry the idle window capped by the maximum age, exp in epoch seconds', async () => {
    results.push([{ id: 'sid-1', generation: 1, remember_me: false, exp: 1_800_000_000 }]);
    const out = await store.insertSession(db(), {
      id: 'sid-1', userId: 'u-1', rememberMe: false, tokenVersion: 4, clientKind: 'web', clientOs: 'linux', idleSeconds: 86_400, maxAgeSeconds: 31_536_000,
    });

    const [{ sql, values }] = calls;
    expect(sql).toMatch(/^INSERT INTO sessions \(id, user_id, generation, rotated_at, created_at, expires_at, remember_me, token_version, client_kind, client_os\)/);
    expect(sql).toContain('SELECT ?, ?, 1, t.now, t.now, least(t.now + make_interval(secs => ?::float8), t.now + make_interval(secs => ?::float8))');
    expect(sql).toContain(`FROM (SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS now) t`);
    expect(sql).toContain('RETURNING id, generation, remember_me, floor(extract(epoch FROM expires_at))::float8 AS exp');
    expect(values).toEqual(['sid-1', 'u-1', 86_400, 31_536_000, false, 4, 'web', 'linux']);
    expectDatabaseClockOnly(sql);
    expect(out).toEqual({ id: 'sid-1', generation: 1, rememberMe: false, exp: 1_800_000_000 });
  });

  it('insertSession that returns nothing throws (a 500), never a session without a row', async () => {
    await expect(store.insertSession(db(), {
      id: 's', userId: 'u', rememberMe: true, tokenVersion: 0, clientKind: 'web', clientOs: 'other', idleSeconds: 1, maxAgeSeconds: 2,
    })).rejects.toThrow('returned no row');
  });

  it('readSessionForRefresh: the row and its account in one statement; expiry and grace decided on the database\'s clock', async () => {
    results.push([{
      generation: 3, row_version: 1, remember_me: true, client_kind: 'desktop', expired: false, within_grace: true,
      since_rotation: 12, exp: 1_800_000_000, username: 'alice', role: 'admin', account_version: 1, banned: false,
    }]);
    const out = await store.readSessionForRefresh(db(), 'sid-1', 'u-1', 120);

    const [{ sql, values }] = calls;
    expect(sql).toContain('s.expires_at <= t.now AS expired');
    expect(sql).toContain('t.now - s.rotated_at <= make_interval(secs => ?::float8) AS within_grace');
    expect(sql).toContain('FROM sessions s JOIN users u ON u.id = s.user_id');
    expect(sql).toContain('WHERE s.id = ? AND s.user_id = ?');
    expect(values).toEqual([120, 'sid-1', 'u-1']);
    expectDatabaseClockOnly(sql);
    expect(out).toEqual({
      generation: 3, rowVersion: 1, rememberMe: true, clientKind: 'desktop', expired: false, withinGrace: true,
      secondsSinceRotation: 12, exp: 1_800_000_000, username: 'alice', role: 'admin', accountVersion: 1, banned: false,
    });
  });

  it('readSessionForRefresh: no row is null', async () => {
    await expect(store.readSessionForRefresh(db(), 'sid-1', 'u-1', 120)).resolves.toBeNull();
  });

  it('rotateSession: ONE conditional UPDATE on the generation read, never on an expired row; null when it updated nothing', async () => {
    results.push([{ id: 'sid-1', generation: 4, remember_me: true, exp: 1_800_000_000 }], []);
    const won = await store.rotateSession(db(), { sid: 'sid-1', fromGeneration: 3, toGeneration: 4, idleSeconds: 2_592_000, maxAgeSeconds: 31_536_000 });
    const lost = await store.rotateSession(db(), { sid: 'sid-1', fromGeneration: 3, toGeneration: 4, idleSeconds: 2_592_000, maxAgeSeconds: 31_536_000 });

    const { sql, values } = calls[0];
    expect(sql).toMatch(/^UPDATE sessions s SET generation = \?::integer, rotated_at = t\.now, expires_at = least\(t\.now \+ make_interval\(secs => \?::float8\), s\.created_at \+ make_interval\(secs => \?::float8\)\)/);
    expect(sql).toContain('WHERE s.id = ? AND s.generation = ?::integer AND s.expires_at > t.now');
    expect(values).toEqual([4, 2_592_000, 31_536_000, 'sid-1', 3]);
    expectDatabaseClockOnly(sql);
    expect(won).toEqual({ id: 'sid-1', generation: 4, rememberMe: true, exp: 1_800_000_000 });
    expect(lost).toBeNull();
  });

  it('rekeySession: the caller\'s own row (id AND account) still at the admitted version, the new version, the next generation, its own idle window', async () => {
    results.push([{ id: 'sid-1', generation: 6, remember_me: false, exp: 1_800_000_000 }], []);
    const args = { sid: 'sid-1', userId: 'u-1', fromTokenVersion: 8, tokenVersion: 9, rememberIdleSeconds: 2_592_000, sessionIdleSeconds: 86_400, maxAgeSeconds: 31_536_000 };
    const out = await store.rekeySession(db(), args);

    const [{ sql, values }] = calls;
    expect(sql).toContain('SET token_version = ?::integer, generation = s.generation + 1, rotated_at = t.now');
    expect(sql).toContain('CASE WHEN s.remember_me THEN ?::float8 ELSE ?::float8 END');
    // A row a reset or another change moved, or one left behind, is not
    // the caller's session any more: the version is part of the condition
    expect(sql).toContain('WHERE s.id = ? AND s.user_id = ? AND s.token_version = ?::integer AND s.expires_at > t.now');
    expect(values).toEqual([9, 2_592_000, 86_400, 31_536_000, 'sid-1', 'u-1', 8]);
    expectDatabaseClockOnly(sql);
    expect(out).toEqual({ id: 'sid-1', generation: 6, rememberMe: false, exp: 1_800_000_000 });
    // Gone, expired or of another version: nothing updated, null
    await expect(store.rekeySession(db(), args)).resolves.toBeNull();
  });
});

describe('sessionStore — ending sessions', () => {
  it('deleteSession: one session of ONE account, any generation, any version', async () => {
    results.push(1);
    await expect(store.deleteSession(db(), 'sid-1', 'u-1')).resolves.toBe(1);
    expect(calls[0].sql).toBe('DELETE FROM sessions WHERE id = ? AND user_id = ?');
    expect(calls[0].values).toEqual(['sid-1', 'u-1']);
  });

  it('deleteStaleSession and deleteExpiredSession repeat their condition, so a re-key or a renewal since keeps the row', async () => {
    results.push(1, 0);
    await store.deleteStaleSession(db(), 'sid-1', 2);
    await store.deleteExpiredSession(db(), 'sid-1');
    expect(calls[0].sql).toBe('DELETE FROM sessions WHERE id = ? AND token_version = ?::integer');
    expect(calls[0].values).toEqual(['sid-1', 2]);
    expect(calls[1].sql).toBe(`DELETE FROM sessions WHERE id = ? AND expires_at <= (now() AT TIME ZONE 'UTC')::timestamp(3)`);
  });

  it('evictSessionsBeyond: the account\'s others beyond `keep`, dead rows first, the kept one excluded in the choice AND the delete', async () => {
    results.push([{ id: 'old-1' }, { id: 'old-2' }]);
    await expect(store.evictSessionsBeyond(db(), 'u-1', 'sid-new', 24)).resolves.toEqual(['old-1', 'old-2']);

    const [{ sql, values }] = calls;
    expect(calls).toHaveLength(1);
    // The ranking: the account's others, live first, then the most
    // recently renewed
    expect(sql).toMatch(/^WITH ranked AS MATERIALIZED \( SELECT s\.id, s\.generation, s\.token_version FROM sessions s JOIN users u ON u\.id = s\.user_id WHERE s\.user_id = \? AND s\.id <> \?/);
    expect(sql).toContain(`ORDER BY (s.token_version = u.token_version AND s.expires_at > (now() AT TIME ZONE 'UTC')::timestamp(3)) DESC, s.rotated_at DESC, s.id DESC`);
    expect(sql).toContain('OFFSET ?::integer )');
    expect(values).toEqual(['u-1', 'sid-new', 24, 'u-1', 'sid-new']);
    expectDatabaseClockOnly(sql);
  });

  it('evictSessionsBeyond compares and deletes on what it ranked: the lock step and the delete both require the ranked generation AND token version, a held row is skipped, never waited for', async () => {
    results.push([]);
    await store.evictSessionsBeyond(db(), 'u-1', 'sid-new', 24);
    const { sql } = calls[0];
    const CAS = 's.generation = c.generation AND s.token_version = c.token_version';
    // The lock step: each ranked row's latest version, compared, locked
    // without waiting
    expect(sql).toContain(`claimed AS MATERIALIZED ( SELECT s.id FROM sessions s JOIN ranked c ON c.id = s.id WHERE ${CAS} FOR UPDATE OF s SKIP LOCKED )`);
    // The delete: only rows it claimed, the comparison and the account's
    // conditions repeated, the ids deleted
    expect(sql).toMatch(new RegExp(
      `DELETE FROM sessions s USING ranked c, claimed k WHERE s\\.id = c\\.id AND s\\.id = k\\.id AND ${CAS.replace(/\./g, '\\.')} `
      + 'AND s\\.user_id = \\? AND s\\.id <> \\? RETURNING s\\.id$',
    ));
    // Not a plain IN (...) over the ranked ids: a row renewed after the
    // ranking must be kept
    expect(sql).not.toMatch(/WHERE id IN \(/);
    expect(sql.match(/FOR UPDATE/g)).toHaveLength(1);
    expect(sql).not.toMatch(/NOWAIT/);
  });
});

describe('sessionStore — refresh tokens issued before sessions', () => {
  it('claimLegacyRedemption never raises a unique violation: ON CONFLICT DO NOTHING, false when it was claimed already', async () => {
    results.push([{ digest: 'd' }], []);
    await expect(store.claimLegacyRedemption(db(), 'd', 1_800_000_000)).resolves.toBe(true);
    await expect(store.claimLegacyRedemption(db(), 'd', 1_800_000_000)).resolves.toBe(false);
    expect(calls[0].sql).toBe(`INSERT INTO legacy_refresh_redemptions (digest, session_id, expires_at) VALUES (?, NULL, (to_timestamp(?::float8) AT TIME ZONE 'UTC')::timestamp(3)) ON CONFLICT (digest) DO NOTHING RETURNING digest`);
  });

  it('readLegacyRedemption and linkLegacyRedemption', async () => {
    results.push([], [{ session_id: null }], [{ session_id: 'sid-1' }], 1);
    await expect(store.readLegacyRedemption(db(), 'd')).resolves.toBeNull();
    await expect(store.readLegacyRedemption(db(), 'd')).resolves.toEqual({ sessionId: null });
    await expect(store.readLegacyRedemption(db(), 'd')).resolves.toEqual({ sessionId: 'sid-1' });
    await store.linkLegacyRedemption(db(), 'd', 'sid-1');
    expect(calls[3].sql).toBe('UPDATE legacy_refresh_redemptions SET session_id = ? WHERE digest = ?');
  });

  it('spendLegacyRedemption: the session the record names deleted FIRST, then the claim (the order every other session delete takes the two rows in)', async () => {
    // read (names sid-1), delete sid-1, claim (found: no insert), read again (null since the delete)
    results.push([{ session_id: 'sid-1' }], 1, [], [{ session_id: null }]);
    await expect(store.spendLegacyRedemption(db(), 'd', 1_800_000_000, 'u-1')).resolves.toEqual(['sid-1']);
    expect(ran).toEqual(['query#0', 'execute#1', 'query#2', 'query#3']);
    expect(calls[0].sql).toBe('SELECT session_id FROM legacy_refresh_redemptions WHERE digest = ?');
    expect(calls[1].sql).toBe('DELETE FROM sessions WHERE id = ? AND user_id = ?');
    expect(calls[1].values).toEqual(['sid-1', 'u-1']);
    expect(calls[2].sql).toMatch(/^INSERT INTO legacy_refresh_redemptions .* ON CONFLICT \(digest\) DO NOTHING/);
    // No statement locks the record before the session row
    for (const c of calls) expect(c.sql).not.toMatch(/FOR UPDATE/);
  });

  it('spendLegacyRedemption: never presented, the claim inserts the record with no session, and nothing else runs', async () => {
    results.push([], [{ digest: 'd' }]);
    await expect(store.spendLegacyRedemption(db(), 'd', 1_800_000_000, 'u-1')).resolves.toEqual([]);
    expect(ran).toEqual(['query#0', 'query#1']);
  });

  it('spendLegacyRedemption: an upgrade that claimed the digest while this ran has committed by the claim\'s answer: the session it linked is deleted too', async () => {
    // read (nothing yet), claim (conflict: the upgrade's record), read again (the upgrade's session), delete it
    results.push([], [], [{ session_id: 'sid-up' }], 1);
    await expect(store.spendLegacyRedemption(db(), 'd', 1_800_000_000, 'u-1')).resolves.toEqual(['sid-up']);
    expect(ran).toEqual(['query#0', 'query#1', 'query#2', 'execute#3']);
    expect(calls[3].values).toEqual(['sid-up', 'u-1']);
  });

  it('spendLegacyRedemption: spent before, or its session already gone, deletes nothing', async () => {
    results.push([{ session_id: null }], [], [{ session_id: null }]);
    await expect(store.spendLegacyRedemption(db(), 'd', 1_800_000_000, 'u-1')).resolves.toEqual([]);

    results.push([{ session_id: 'sid-2' }], 0, [], [{ session_id: null }]);
    await expect(store.spendLegacyRedemption(db(), 'd', 1_800_000_000, 'u-1')).resolves.toEqual([]);
  });
});

describe('sessionStore — the sweep\'s statements', () => {
  const EXPIRED = `expires_at < (now() AT TIME ZONE 'UTC')::timestamp(3) - make_interval(secs => ?::float8)`;
  const esc = (t: string) => t.replace(/[()*+?.^$|[\]\\]/g, '\\$&');

  it('the margin is an hour and a batch 5000', () => {
    expect(store.SWEEP_MARGIN_SECONDS).toBe(3600);
    expect(store.SWEEP_BATCH_SIZE).toBe(5000);
  });

  it('countSweepableSessions: each predicate, either, and every session', async () => {
    results.push([{ expired: 2, outdated: 1, due: 3, total: 10 }]);
    await expect(store.countSweepableSessions(db())).resolves.toEqual({ expired: 2, outdated: 1, due: 3, total: 10 });
    const { sql, values } = calls[0];
    expect(sql).toContain(`count(*) FILTER ( WHERE s.${EXPIRED} )::float8 AS expired`);
    expect(sql).toContain('count(*) FILTER ( WHERE s.token_version < u.token_version )::float8 AS outdated');
    expect(sql).toContain(`count(*) FILTER ( WHERE s.${EXPIRED} OR s.token_version < u.token_version )::float8 AS due`);
    expect(sql).toContain('FROM sessions s JOIN users u ON u.id = s.user_id');
    expect(values).toEqual([3600, 3600]);
    expectDatabaseClockOnly(sql);
  });

  it('countSweepableSessions: no row is all zeros', async () => {
    await expect(store.countSweepableSessions(db())).resolves.toEqual({ expired: 0, outdated: 0, due: 0, total: 0 });
  });

  it('deleteSweepableSessions: the predicates choose the batch AND guard the delete itself; the ids deleted', async () => {
    results.push([{ id: 'a' }, { id: 'b' }]);
    await expect(store.deleteSweepableSessions(db())).resolves.toEqual(['a', 'b']);
    const { sql, values } = calls[0];
    expect(sql).toContain(`WHERE s2.${EXPIRED} OR s2.token_version < u2.token_version LIMIT ?::integer`);
    expect(sql).toMatch(new RegExp(`AND \\(s\\.${esc(EXPIRED)} OR s\\.token_version < u\\.token_version\\) RETURNING s\\.id$`));
    expect(values).toEqual([3600, 5000, 3600]);
    expectDatabaseClockOnly(sql);
  });

  it('sampleExpiredSessions: the expired predicate alone, the rows nearest the boundary first, or spread at random', async () => {
    results.push([{ exp: 1 }, { exp: 2 }], [{ exp: 3 }]);
    await expect(store.sampleExpiredSessions(db(), 100)).resolves.toEqual([1, 2]);
    await expect(store.sampleExpiredSessions(db(), 100, true)).resolves.toEqual([3]);
    expect(calls[0].sql).toBe(`SELECT floor(extract(epoch FROM s.expires_at))::float8 AS exp FROM sessions s WHERE s.${EXPIRED} ORDER BY s.expires_at DESC LIMIT ?::integer`);
    expect(calls[1].sql).toBe(`SELECT floor(extract(epoch FROM s.expires_at))::float8 AS exp FROM sessions s WHERE s.${EXPIRED} ORDER BY random() LIMIT ?::integer`);
    expect(calls[0].values).toEqual([3600, 100]);
    expect(calls[1].values).toEqual([3600, 100]);
  });

  it('sampleOutdatedSessions: the outdated predicate alone, the rows nearest their account\'s version first, or spread at random', async () => {
    results.push([{ id: 'a' }], [{ id: 'b' }]);
    await expect(store.sampleOutdatedSessions(db(), 100)).resolves.toEqual(['a']);
    await expect(store.sampleOutdatedSessions(db(), 100, true)).resolves.toEqual(['b']);
    expect(calls[0].sql).toBe('SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_version < u.token_version ORDER BY u.token_version - s.token_version, s.id LIMIT ?::integer');
    expect(calls[1].sql).toBe('SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_version < u.token_version ORDER BY random() LIMIT ?::integer');
  });

  it('the samples read the very predicates the delete applies (one text each)', async () => {
    results.push([], [], [], [], []);
    await store.deleteSweepableSessions(db());
    await store.sampleExpiredSessions(db(), 1);
    await store.sampleExpiredSessions(db(), 1, true);
    await store.sampleOutdatedSessions(db(), 1);
    await store.sampleOutdatedSessions(db(), 1, true);
    const del = calls[0].sql;
    expect(del).toContain(`s.${EXPIRED}`);
    expect(del).toContain('s.token_version < u.token_version');
    for (const c of calls.slice(1, 3)) expect(c.sql).toContain(`WHERE s.${EXPIRED} ORDER BY`);
    for (const c of calls.slice(3)) expect(c.sql).toContain('WHERE s.token_version < u.token_version ORDER BY');
  });

  it('sampleExpiredLegacyRedemptions and deleteExpiredLegacyRedemptions: past the token\'s expiry by the same margin, in the sample, the choice and the delete', async () => {
    results.push([{ exp: 5 }], 2);
    await expect(store.sampleExpiredLegacyRedemptions(db(), 100)).resolves.toEqual([5]);
    await store.deleteExpiredLegacyRedemptions(db());
    expect(calls[0].sql).toBe(`SELECT floor(extract(epoch FROM expires_at))::float8 AS exp FROM legacy_refresh_redemptions WHERE ${EXPIRED} ORDER BY expires_at DESC LIMIT ?::integer`);
    const { sql, values } = calls[1];
    expect(sql.match(new RegExp(esc(EXPIRED), 'g'))).toHaveLength(2);
    expect(values).toEqual([3600, 5000, 3600]);
  });
});

describe('sessionStore — the list, and signing out of the other sessions', () => {
  it('listLiveSessions: live rows only (the account\'s version, not expired, on the database\'s clock), the sign-in rounded down to its day and the renewal to its hour in SQL, the caller\'s first, bounded', async () => {
    results.push([{ id: 'sid-1', client_kind: 'desktop', client_os: 'windows', signed_in: 1_790_000_000, last_active: 1_790_003_600 }]);
    await expect(store.listLiveSessions(db(), 'u-1', 'sid-1', 50)).resolves.toEqual([
      { id: 'sid-1', clientKind: 'desktop', clientOs: 'windows', signedInAt: 1_790_000_000, lastActiveAt: 1_790_003_600 },
    ]);
    const { sql, values } = calls[0];
    // The sign-in to its day, the last renewal to its hour
    expect(sql).toContain("extract(epoch FROM date_trunc('day', s.created_at))::float8 AS signed_in");
    expect(sql).toContain("extract(epoch FROM date_trunc('hour', s.rotated_at))::float8 AS last_active");
    expect(sql).toContain('FROM sessions s JOIN users u ON u.id = s.user_id');
    expect(sql).toContain('WHERE s.user_id = ? AND s.token_version = u.token_version AND s.expires_at > t.now');
    expect(sql).toContain('ORDER BY (s.id = ?) IS TRUE DESC, s.rotated_at DESC, s.id DESC LIMIT ?::integer');
    expect(values).toEqual(['u-1', 'sid-1', 50]);
    expectDatabaseClockOnly(sql);
    // Nothing finer than the hour, and no other column, leaves the database
    expect(sql).not.toMatch(/SELECT[^]*\b(expires_at|remember_me|generation|token_version)\b[^]*FROM sessions s JOIN/);
  });

  it('listLiveSessions: a caller whose token names no session passes null (no row is the current one)', async () => {
    await store.listLiveSessions(db(), 'u-1', null, 50);
    expect(calls[0].values).toEqual(['u-1', null, 50]);
  });

  it('deleteOtherSessions: every session of the account but the kept one, whatever its state; each with whether it was live at the version before the bump', async () => {
    results.push([{ id: 'a', live: true }, { id: 'b', live: false }]);
    await expect(store.deleteOtherSessions(db(), 'u-1', 'sid-keep', 4)).resolves.toEqual([{ id: 'a', live: true }, { id: 'b', live: false }]);
    const { sql, values } = calls[0];
    expect(sql).toMatch(/^DELETE FROM sessions s USING \(SELECT \(now\(\) AT TIME ZONE 'UTC'\)::timestamp\(3\) AS now\) t WHERE s\.user_id = \? AND s\.id <> \? RETURNING s\.id, \(s\.token_version = \?::integer AND s\.expires_at > t\.now\) AS live$/);
    expect(values).toEqual(['u-1', 'sid-keep', 4]);
    expectDatabaseClockOnly(sql);
  });
});
