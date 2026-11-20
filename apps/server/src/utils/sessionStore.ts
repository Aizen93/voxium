import type { PrismaClient } from '../generated/prisma/client';

// The statements of the sign-in sessions (services/sessionService.ts, the one
// caller), kept apart from the service so the proof against a real
// PostgreSQL runs exactly these. Every timestamp is written and compared on
// the database's clock, in UTC like the tables' other timestamp columns
// (`now() AT TIME ZONE 'UTC'`, then truncated to the column's milliseconds),
// never a node's: an expiry, the reuse grace window and the sweep's cutoff
// all mean the same thing whatever the nodes' clocks and whatever the
// connection's TimeZone. A time handed back to the service is epoch seconds
// computed here (`extract(epoch from <timestamp without time zone>)` counts
// the stored UTC wall clock as UTC), so the token's `exp` is the row's
// `expires_at` to the second.

/** What the statements need: the client, or a transaction of it. */
export type SessionDb = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

/** A row as a refresh reads it, with the decisions the database made on its own clock. */
export interface SessionRefreshRow {
  generation: number;
  rowVersion: number;
  rememberMe: boolean;
  clientKind: string;
  /** expires_at has passed. */
  expired: boolean;
  /** rotated_at is no more than the grace window ago. */
  withinGrace: boolean;
  /** Whole seconds since rotated_at (for the reuse log line). */
  secondsSinceRotation: number;
  /** expires_at as epoch seconds, rounded down: the `exp` of a token reissued for this generation. */
  exp: number;
  username: string;
  role: string;
  accountVersion: number;
  banned: boolean;
}

/** A row after an insert, a rotation or a re-key. */
export interface IssuedSessionRow {
  id: string;
  generation: number;
  rememberMe: boolean;
  /** expires_at as epoch seconds, rounded down. */
  exp: number;
}

export interface NewSessionRow {
  id: string;
  userId: string;
  rememberMe: boolean;
  tokenVersion: number;
  clientKind: string;
  clientOs: string;
  /** The idle window of this row (its "Remember me" choice). */
  idleSeconds: number;
  maxAgeSeconds: number;
}

/**
 * Write a new session at generation 1: created, rotated and expiring on the
 * database's clock. The key to `users` key-shares the account row, so an
 * account deletion holding it is waited for and the insert then fails on
 * sessions_user_id_fkey.
 */
export async function insertSession(db: SessionDb, row: NewSessionRow): Promise<IssuedSessionRow> {
  const rows = await db.$queryRaw<Array<{ id: string; generation: number; remember_me: boolean; exp: number }>>`
    INSERT INTO sessions (id, user_id, generation, rotated_at, created_at, expires_at,
                          remember_me, token_version, client_kind, client_os)
    SELECT ${row.id}, ${row.userId}, 1, t.now, t.now,
           least(t.now + make_interval(secs => ${row.idleSeconds}::float8),
                 t.now + make_interval(secs => ${row.maxAgeSeconds}::float8)),
           ${row.rememberMe}, ${row.tokenVersion}::integer, ${row.clientKind}, ${row.clientOs}
    FROM (SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS now) t
    RETURNING id, generation, remember_me, floor(extract(epoch FROM expires_at))::float8 AS exp`;
  const inserted = rows[0];
  if (!inserted) throw new Error('The session insert returned no row');
  return { id: inserted.id, generation: inserted.generation, rememberMe: inserted.remember_me, exp: inserted.exp };
}

/** The session `sid` of `userId`, joined with the account, as a refresh decides on it. */
export async function readSessionForRefresh(
  db: SessionDb,
  sid: string,
  userId: string,
  graceSeconds: number,
): Promise<SessionRefreshRow | null> {
  const rows = await db.$queryRaw<Array<{
    generation: number; row_version: number; remember_me: boolean; client_kind: string;
    expired: boolean; within_grace: boolean; since_rotation: number; exp: number;
    username: string; role: string; account_version: number; banned: boolean;
  }>>`
    SELECT s.generation, s.token_version AS row_version, s.remember_me, s.client_kind,
           s.expires_at <= t.now AS expired,
           t.now - s.rotated_at <= make_interval(secs => ${graceSeconds}::float8) AS within_grace,
           floor(extract(epoch FROM t.now - s.rotated_at))::float8 AS since_rotation,
           floor(extract(epoch FROM s.expires_at))::float8 AS exp,
           u.username, u.role, u.token_version AS account_version, (u.banned_at IS NOT NULL) AS banned
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    CROSS JOIN (SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS now) t
    WHERE s.id = ${sid} AND s.user_id = ${userId}`;
  const r = rows[0];
  if (!r) return null;
  return {
    generation: r.generation,
    rowVersion: r.row_version,
    rememberMe: r.remember_me,
    clientKind: r.client_kind,
    expired: r.expired,
    withinGrace: r.within_grace,
    secondsSinceRotation: r.since_rotation,
    exp: r.exp,
    username: r.username,
    role: r.role,
    accountVersion: r.account_version,
    banned: r.banned,
  };
}

/**
 * The rotation: ONE conditional UPDATE on the generation. Of two renewals
 * that read the same generation, the second waits for the first's row lock
 * and then finds the generation moved, so it updates nothing and answers
 * null: never two new generations from one. An expired row is not rotated.
 */
export async function rotateSession(
  db: SessionDb,
  args: { sid: string; fromGeneration: number; toGeneration: number; idleSeconds: number; maxAgeSeconds: number },
): Promise<IssuedSessionRow | null> {
  const rows = await db.$queryRaw<Array<{ id: string; generation: number; remember_me: boolean; exp: number }>>`
    UPDATE sessions s
    SET generation = ${args.toGeneration}::integer,
        rotated_at = t.now,
        expires_at = least(t.now + make_interval(secs => ${args.idleSeconds}::float8),
                           s.created_at + make_interval(secs => ${args.maxAgeSeconds}::float8))
    FROM (SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS now) t
    WHERE s.id = ${args.sid} AND s.generation = ${args.fromGeneration}::integer AND s.expires_at > t.now
    RETURNING s.id, s.generation, s.remember_me, floor(extract(epoch FROM s.expires_at))::float8 AS exp`;
  const r = rows[0];
  return r ? { id: r.id, generation: r.generation, rememberMe: r.remember_me, exp: r.exp } : null;
}

/**
 * A password change keeps its caller signed in: the caller's own row moves to
 * the account's new token version and to a new generation, in the
 * transaction that bumped the version. Only while the row still holds
 * `fromTokenVersion`, the version the caller was admitted with: a row a
 * reset or another change moved (or left behind) is not the caller's
 * session any more. Its idle window follows the row's own "Remember me".
 * Null when the row is gone, expired or of another version.
 */
export async function rekeySession(
  db: SessionDb,
  args: {
    sid: string; userId: string; fromTokenVersion: number; tokenVersion: number;
    rememberIdleSeconds: number; sessionIdleSeconds: number; maxAgeSeconds: number;
  },
): Promise<IssuedSessionRow | null> {
  const rows = await db.$queryRaw<Array<{ id: string; generation: number; remember_me: boolean; exp: number }>>`
    UPDATE sessions s
    SET token_version = ${args.tokenVersion}::integer,
        generation = s.generation + 1,
        rotated_at = t.now,
        expires_at = least(
          t.now + make_interval(secs => CASE WHEN s.remember_me THEN ${args.rememberIdleSeconds}::float8
                                             ELSE ${args.sessionIdleSeconds}::float8 END),
          s.created_at + make_interval(secs => ${args.maxAgeSeconds}::float8))
    FROM (SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS now) t
    WHERE s.id = ${args.sid} AND s.user_id = ${args.userId}
      AND s.token_version = ${args.fromTokenVersion}::integer AND s.expires_at > t.now
    RETURNING s.id, s.generation, s.remember_me, floor(extract(epoch FROM s.expires_at))::float8 AS exp`;
  const r = rows[0];
  return r ? { id: r.id, generation: r.generation, rememberMe: r.remember_me, exp: r.exp } : null;
}

/** End one session of one account, whatever its generation or version. The number of rows deleted (0 or 1). */
export async function deleteSession(db: SessionDb, sid: string, userId: string): Promise<number> {
  return db.$executeRaw`DELETE FROM sessions WHERE id = ${sid} AND user_id = ${userId}`;
}

/** Delete a row a version bump left behind, only while it still holds that version (a re-key since keeps it). */
export async function deleteStaleSession(db: SessionDb, sid: string, rowVersion: number): Promise<number> {
  return db.$executeRaw`DELETE FROM sessions WHERE id = ${sid} AND token_version = ${rowVersion}::integer`;
}

/** Delete a row whose expiry has passed, only while it has (a rotation since keeps it). */
export async function deleteExpiredSession(db: SessionDb, sid: string): Promise<number> {
  return db.$executeRaw`
    DELETE FROM sessions WHERE id = ${sid} AND expires_at <= (now() AT TIME ZONE 'UTC')::timestamp(3)`;
}

/**
 * The cap: of an account's sessions other than `keepId`, keep the
 * `keep` most recently renewed live ones and delete the rest, dead rows (a
 * version below the account's, an expiry passed) first. The ids deleted.
 *
 * Compare-and-delete on what was ranked: a row goes only while its
 * generation and token version are still the ones the ranking read, so a
 * renewal or a re-key (a password change, signing out of the other
 * sessions, from that very session) that commits after the ranking keeps
 * its row, and the pair it handed out stays good. The lock step reads each
 * row's latest version and applies the comparison to it; the delete
 * repeats it. A row another transaction holds at that moment (a renewal, a
 * re-key, a sign-out in flight) is skipped, never waited for (SKIP LOCKED):
 * the trim waits on no row, so it can never be part of a deadlock (a
 * sign-out of the other sessions takes the caller's row first and then the
 * rest; no order of the trim's own would match it). Either way an account
 * may stay one over the cap until its next sign-in trims again: accepted,
 * the cap bounds how many rows an account holds and decides no access.
 */
export async function evictSessionsBeyond(db: SessionDb, userId: string, keepId: string, keep: number): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    WITH ranked AS MATERIALIZED (
      SELECT s.id, s.generation, s.token_version FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.user_id = ${userId} AND s.id <> ${keepId}
      ORDER BY (s.token_version = u.token_version
                AND s.expires_at > (now() AT TIME ZONE 'UTC')::timestamp(3)) DESC,
               s.rotated_at DESC, s.id DESC
      OFFSET ${keep}::integer
    ), claimed AS MATERIALIZED (
      SELECT s.id FROM sessions s
      JOIN ranked c ON c.id = s.id
      WHERE s.generation = c.generation AND s.token_version = c.token_version
      FOR UPDATE OF s SKIP LOCKED
    )
    DELETE FROM sessions s
    USING ranked c, claimed k
    WHERE s.id = c.id AND s.id = k.id
      AND s.generation = c.generation AND s.token_version = c.token_version
      AND s.user_id = ${userId} AND s.id <> ${keepId}
    RETURNING s.id`;
  return rows.map((r) => r.id);
}

// ─── The list, and signing out of the other sessions ─────────────────────────

/**
 * A live session as the list shows it: the times rounded down, as epoch
 * seconds.
 */
export interface ListedSessionRow {
  id: string;
  clientKind: string;
  clientOs: string;
  /** created_at rounded down to its day (UTC midnight). */
  signedInAt: number;
  /** rotated_at rounded down to its hour. */
  lastActiveAt: number;
}

/**
 * The live sessions of `userId` (of the account's current token version and
 * not expired, on the database's clock), at most `limit`: `currentId`'s
 * first when it is among them (so the bound never leaves it out), then the
 * most recently renewed. The two times are rounded down here, in SQL (the
 * stored UTC wall clock, which no connection TimeZone moves): the sign-in to
 * its day, the last renewal to its hour. Nothing finer leaves the database.
 */
export async function listLiveSessions(db: SessionDb, userId: string, currentId: string | null, limit: number): Promise<ListedSessionRow[]> {
  const rows = await db.$queryRaw<Array<{ id: string; client_kind: string; client_os: string; signed_in: number; last_active: number }>>`
    SELECT s.id, s.client_kind, s.client_os,
           extract(epoch FROM date_trunc('day', s.created_at))::float8 AS signed_in,
           extract(epoch FROM date_trunc('hour', s.rotated_at))::float8 AS last_active
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    CROSS JOIN (SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS now) t
    WHERE s.user_id = ${userId} AND s.token_version = u.token_version AND s.expires_at > t.now
    ORDER BY (s.id = ${currentId}) IS TRUE DESC, s.rotated_at DESC, s.id DESC
    LIMIT ${limit}::integer`;
  return rows.map((r) => ({ id: r.id, clientKind: r.client_kind, clientOs: r.client_os, signedInAt: r.signed_in, lastActiveAt: r.last_active }));
}

/**
 * Signing out of every other session, in the transaction that bumped the
 * account's version (the account row is held): every session of `userId`
 * but `keepId`, whatever its state. Each id deleted, with whether it was
 * live at `liveVersion` (the version before the bump) on the database's
 * clock: what the caller is told it ended.
 */
export async function deleteOtherSessions(
  db: SessionDb,
  userId: string,
  keepId: string,
  liveVersion: number,
): Promise<Array<{ id: string; live: boolean }>> {
  return db.$queryRaw<Array<{ id: string; live: boolean }>>`
    DELETE FROM sessions s
    USING (SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS now) t
    WHERE s.user_id = ${userId} AND s.id <> ${keepId}
    RETURNING s.id, (s.token_version = ${liveVersion}::integer AND s.expires_at > t.now) AS live`;
}

// ─── Refresh tokens issued before sessions ───────────────────────────────────

/** The redemption record of a token without `sid`, or null when it was never presented. */
export async function readLegacyRedemption(db: SessionDb, digest: string): Promise<{ sessionId: string | null } | null> {
  const rows = await db.$queryRaw<Array<{ session_id: string | null }>>`
    SELECT session_id FROM legacy_refresh_redemptions WHERE digest = ${digest}`;
  return rows[0] ? { sessionId: rows[0].session_id } : null;
}

/**
 * Claim a token's digest, with no session yet. False when it is claimed
 * already: a concurrent claim waits for this one's transaction, then finds
 * the conflict (ON CONFLICT DO NOTHING, never a unique violation that would
 * abort the transaction).
 */
export async function claimLegacyRedemption(db: SessionDb, digest: string, expSeconds: number): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ digest: string }>>`
    INSERT INTO legacy_refresh_redemptions (digest, session_id, expires_at)
    VALUES (${digest}, NULL, (to_timestamp(${expSeconds}::float8) AT TIME ZONE 'UTC')::timestamp(3))
    ON CONFLICT (digest) DO NOTHING
    RETURNING digest`;
  return rows.length === 1;
}

/** Point a claimed digest at the session it was upgraded into. */
export async function linkLegacyRedemption(db: SessionDb, digest: string, sid: string): Promise<number> {
  return db.$executeRaw`UPDATE legacy_refresh_redemptions SET session_id = ${sid} WHERE digest = ${digest}`;
}

/**
 * A sign-out with a token without `sid`: its digest ends recorded as spent
 * (a record with no session), and the session it was upgraded into, if
 * any, is deleted. Run it in one transaction. The ids deleted.
 *
 * The rows in the order an account deletion's cascade, the sweep and every
 * other session delete take them: the session row first (its delete's SET
 * NULL then takes the record's row), never the record first and then the
 * session, which would close a cycle with each of those.
 *  1. The record is read without a lock; the session it names is deleted.
 *  2. The digest is claimed (ON CONFLICT DO NOTHING). Claimed here, the
 *     record is this transaction's with no session, and no upgrade can link
 *     one: an upgrade links only a digest it claimed itself. Found claimed,
 *     the claim has waited for the transaction that claimed it, so an
 *     upgrade in flight at step 1 has committed (or rolled back) by now.
 *  3. Read again: a session linked since step 1 (by that upgrade, the only
 *     writer that can link one) is deleted as well. Nothing can link
 *     another after it.
 */
export async function spendLegacyRedemption(db: SessionDb, digest: string, expSeconds: number, userId: string): Promise<string[]> {
  const ended: string[] = [];
  const first = (await readLegacyRedemption(db, digest))?.sessionId ?? null;
  if (first !== null && (await deleteSession(db, first, userId)) > 0) ended.push(first);
  if (await claimLegacyRedemption(db, digest, expSeconds)) return ended;
  const linked = (await readLegacyRedemption(db, digest))?.sessionId ?? null;
  if (linked !== null && (await deleteSession(db, linked, userId)) > 0) ended.push(linked);
  return ended;
}

// ─── The expiry sweep (utils/sessionSweep.ts) ────────────────────────────────
// Two predicates choose what the sweep deletes, each written the same way in
// the count, in the samples the sweep checks before it deletes anything and
// in the delete itself (sessionStore.test.ts holds the texts equal):
//   expired  s.expires_at < (now() AT TIME ZONE 'UTC')::timestamp(3)
//                           - make_interval(secs => SWEEP_MARGIN_SECONDS)
//   outdated s.token_version < u.token_version   (u the session's account)

/** How far past its expiry a row must be before the sweep deletes it (a margin, never the authority). */
export const SWEEP_MARGIN_SECONDS = 3600;
export const SWEEP_BATCH_SIZE = 5000;

export interface SweepCounts {
  /** Rows past their expiry by the margin. */
  expired: number;
  /** Rows below their account's token version. */
  outdated: number;
  /** Rows either predicate picks (what the sweep would delete). */
  due: number;
  total: number;
}

/** What the sweep would delete, by predicate, and all rows. */
export async function countSweepableSessions(db: SessionDb): Promise<SweepCounts> {
  const rows = await db.$queryRaw<Array<SweepCounts>>`
    SELECT count(*) FILTER (
             WHERE s.expires_at < (now() AT TIME ZONE 'UTC')::timestamp(3) - make_interval(secs => ${SWEEP_MARGIN_SECONDS}::float8)
           )::float8 AS expired,
           count(*) FILTER (
             WHERE s.token_version < u.token_version
           )::float8 AS outdated,
           count(*) FILTER (
             WHERE s.expires_at < (now() AT TIME ZONE 'UTC')::timestamp(3) - make_interval(secs => ${SWEEP_MARGIN_SECONDS}::float8)
                OR s.token_version < u.token_version
           )::float8 AS due,
           count(*)::float8 AS total
    FROM sessions s
    JOIN users u ON u.id = s.user_id`;
  const r = rows[0];
  return { expired: r?.expired ?? 0, outdated: r?.outdated ?? 0, due: r?.due ?? 0, total: r?.total ?? 0 };
}

/**
 * The expiries (epoch seconds) of rows the expired predicate picks, for the
 * sweep's check of that comparison on the node's own clock: the ones nearest
 * the boundary first (`spread` false: a comparison off by any amount shows
 * there first), or drawn at random over every candidate (`spread` true).
 */
export async function sampleExpiredSessions(db: SessionDb, limit: number, spread = false): Promise<number[]> {
  const rows = spread
    ? await db.$queryRaw<Array<{ exp: number }>>`
        SELECT floor(extract(epoch FROM s.expires_at))::float8 AS exp
        FROM sessions s
        WHERE s.expires_at < (now() AT TIME ZONE 'UTC')::timestamp(3) - make_interval(secs => ${SWEEP_MARGIN_SECONDS}::float8)
        ORDER BY random()
        LIMIT ${limit}::integer`
    : await db.$queryRaw<Array<{ exp: number }>>`
        SELECT floor(extract(epoch FROM s.expires_at))::float8 AS exp
        FROM sessions s
        WHERE s.expires_at < (now() AT TIME ZONE 'UTC')::timestamp(3) - make_interval(secs => ${SWEEP_MARGIN_SECONDS}::float8)
        ORDER BY s.expires_at DESC
        LIMIT ${limit}::integer`;
  return rows.map((r) => r.exp);
}

/**
 * The ids of rows the outdated predicate picks, for the sweep's check of
 * that comparison by a separate read (the typed client, compared in
 * JavaScript): the ones nearest to their account's version first (`spread`
 * false: a comparison that also takes equal versions shows there first), or
 * drawn at random over every candidate (`spread` true).
 */
export async function sampleOutdatedSessions(db: SessionDb, limit: number, spread = false): Promise<string[]> {
  const rows = spread
    ? await db.$queryRaw<Array<{ id: string }>>`
        SELECT s.id
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_version < u.token_version
        ORDER BY random()
        LIMIT ${limit}::integer`
    : await db.$queryRaw<Array<{ id: string }>>`
        SELECT s.id
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_version < u.token_version
        ORDER BY u.token_version - s.token_version, s.id
        LIMIT ${limit}::integer`;
  return rows.map((r) => r.id);
}

/**
 * One batch of the sweep: the predicates in the batch's choice AND in the
 * delete itself. The ids deleted (their sockets are ended after the batch).
 */
export async function deleteSweepableSessions(db: SessionDb): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    DELETE FROM sessions s
    USING users u
    WHERE u.id = s.user_id
      AND s.id IN (
        SELECT s2.id FROM sessions s2
        JOIN users u2 ON u2.id = s2.user_id
        WHERE s2.expires_at < (now() AT TIME ZONE 'UTC')::timestamp(3) - make_interval(secs => ${SWEEP_MARGIN_SECONDS}::float8)
           OR s2.token_version < u2.token_version
        LIMIT ${SWEEP_BATCH_SIZE}::integer
      )
      AND (s.expires_at < (now() AT TIME ZONE 'UTC')::timestamp(3) - make_interval(secs => ${SWEEP_MARGIN_SECONDS}::float8)
           OR s.token_version < u.token_version)
    RETURNING s.id`;
  return rows.map((r) => r.id);
}

/**
 * The expiries (epoch seconds) of the redemption records the sweep would
 * delete, nearest the boundary first: checked on the node's clock before
 * any is deleted (a record deleted while a node still accepts the token it
 * names would let a token signed out with be upgraded again).
 */
export async function sampleExpiredLegacyRedemptions(db: SessionDb, limit: number): Promise<number[]> {
  const rows = await db.$queryRaw<Array<{ exp: number }>>`
    SELECT floor(extract(epoch FROM expires_at))::float8 AS exp
    FROM legacy_refresh_redemptions
    WHERE expires_at < (now() AT TIME ZONE 'UTC')::timestamp(3) - make_interval(secs => ${SWEEP_MARGIN_SECONDS}::float8)
    ORDER BY expires_at DESC
    LIMIT ${limit}::integer`;
  return rows.map((r) => r.exp);
}

/** One batch of redemption records past their token's expiry, with the same margin. Rows deleted. */
export async function deleteExpiredLegacyRedemptions(db: SessionDb): Promise<number> {
  return db.$executeRaw`
    DELETE FROM legacy_refresh_redemptions
    WHERE digest IN (
        SELECT digest FROM legacy_refresh_redemptions
        WHERE expires_at < (now() AT TIME ZONE 'UTC')::timestamp(3) - make_interval(secs => ${SWEEP_MARGIN_SECONDS}::float8)
        LIMIT ${SWEEP_BATCH_SIZE}::integer
      )
      AND expires_at < (now() AT TIME ZONE 'UTC')::timestamp(3) - make_interval(secs => ${SWEEP_MARGIN_SECONDS}::float8)`;
}
