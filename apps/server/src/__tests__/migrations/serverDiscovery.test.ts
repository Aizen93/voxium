import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The server_discovery migration (docs/local/server-discovery-plan.html,
 * "Data model") has two things a schema diff alone would not carry, and they
 * are what these tests pin:
 *
 * - the two BACKFILLS, after the columns exist — without them every existing
 *   server would rank with zero members and start with discovery_listed = true
 *   even when its invites are locked or its owner is banned, and the nightly
 *   pass would be the first thing to fix it;
 * - NO partial indexes — Prisma cannot express them, and `migrate dev` would
 *   read them as drift (the users_username_lower_key problem, again).
 */

const REPO = resolve(__dirname, '../../../../..');
const MIGRATION = resolve(REPO, 'apps/server/prisma/migrations/20261009120000_server_discovery/migration.sql');
const SCHEMA = resolve(REPO, 'apps/server/prisma/schema.prisma');

const sql = readFileSync(MIGRATION, 'utf8');
const schema = readFileSync(SCHEMA, 'utf8');

describe('server_discovery migration', () => {
  it('adds every Server column of the data model', () => {
    for (const col of [
      'description', 'tags', 'discoverable', 'join_mode', 'featured_at', 'discovery_blocked_at',
      'discovery_listed', 'member_count', 'discovery_online_count', 'discovery_weekly_messages',
      'discovery_activity_score', 'discovery_stats_at',
    ]) {
      expect(sql).toMatch(new RegExp(`ADD COLUMN\\s+"${col}"`));
    }
    // listed by default, approval-first by default
    expect(sql).toMatch(/"discoverable" BOOLEAN NOT NULL DEFAULT true/);
    expect(sql).toMatch(/"discovery_listed" BOOLEAN NOT NULL DEFAULT true/);
    expect(sql).toMatch(/"join_mode" TEXT NOT NULL DEFAULT 'approval'/);
  });

  it('creates server_bans with the composite key and server_join_requests with the (server, user) unique', () => {
    expect(sql).toMatch(/CREATE TABLE "server_bans"/);
    expect(sql).toMatch(/CONSTRAINT "server_bans_pkey" PRIMARY KEY \("server_id","user_id"\)/);
    expect(sql).toMatch(/CREATE TABLE "server_join_requests"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "server_join_requests_server_id_user_id_key"/);
    // bans and requests die with the server or the user; the actor column is SET NULL
    expect(sql).toMatch(/"server_bans_server_id_fkey"[^;]*ON DELETE CASCADE/);
    expect(sql).toMatch(/"server_bans_user_id_fkey"[^;]*ON DELETE CASCADE/);
    expect(sql).toMatch(/"server_bans_banned_by_id_fkey"[^;]*ON DELETE SET NULL/);
    expect(sql).toMatch(/"server_join_requests_decided_by_id_fkey"[^;]*ON DELETE SET NULL/);
  });

  it('creates one index per sort, each ending in id DESC/ASC for keyset cursors, plus the stats and featured indexes', () => {
    expect(sql).toMatch(/"servers_discovery_listed_discovery_activity_score_id_idx" ON "servers"\("discovery_listed", "discovery_activity_score" DESC, "id" DESC\)/);
    expect(sql).toMatch(/"servers_discovery_listed_member_count_id_idx" ON "servers"\("discovery_listed", "member_count" DESC, "id" DESC\)/);
    expect(sql).toMatch(/"servers_discovery_listed_created_at_id_idx" ON "servers"\("discovery_listed", "created_at" DESC, "id" DESC\)/);
    expect(sql).toMatch(/"servers_discovery_listed_name_id_idx" ON "servers"\("discovery_listed", "name", "id"\)/);
    expect(sql).toMatch(/"servers_discovery_listed_discovery_stats_at_idx" ON "servers"\("discovery_listed", "discovery_stats_at"\)/);
    expect(sql).toMatch(/"servers_featured_at_idx" ON "servers"\("featured_at"\)/);
  });

  it('serves the tag filter and the substring search with GIN indexes (array_ops, gin_trgm_ops)', () => {
    expect(sql).toMatch(/"servers_tags_idx" ON "servers" USING GIN \("tags" array_ops\)/);
    expect(sql).toMatch(/"servers_name_trgm_idx" ON "servers" USING GIN \("name" gin_trgm_ops\)/);
    // the extension is already installed by the 2026-07-05 migration — never
    // re-created here, so a production run cannot fail on privileges
    expect(sql).not.toMatch(/CREATE EXTENSION/);
  });

  it('has NO partial index (Prisma cannot express one; migrate dev would read it as drift)', () => {
    const indexStatements = sql.match(/CREATE (UNIQUE )?INDEX[^;]*;/g) ?? [];
    expect(indexStatements.length).toBeGreaterThanOrEqual(14);
    for (const stmt of indexStatements) expect(stmt).not.toMatch(/\bWHERE\b/);
  });

  it('backfills member_count from server_members in one statement, after the columns exist', () => {
    const backfill = sql.match(/UPDATE "servers" s\s+SET "member_count" = c\.n\s+FROM \(\s*SELECT "server_id", COUNT\(\*\)::int AS n\s+FROM "server_members"\s+GROUP BY "server_id"\s*\) c\s+WHERE c\."server_id" = s\."id";/);
    expect(backfill).not.toBeNull();
    expect(sql.indexOf('ADD COLUMN     "member_count"')).toBeLessThan(sql.indexOf('SET "member_count" = c.n'));
  });

  it('backfills discovery_listed from its four inputs joined to users, in one statement', () => {
    const backfill = sql.match(/UPDATE "servers" s\s+SET "discovery_listed" = \(\s*s\."discoverable"\s+AND NOT s\."invites_locked"\s+AND s\."discovery_blocked_at" IS NULL\s+AND u\."banned_at" IS NULL\s*\)\s+FROM "users" u\s+WHERE u\."id" = s\."owner_id";/);
    expect(backfill).not.toBeNull();
    expect(sql.indexOf('ADD COLUMN     "discovery_listed"')).toBeLessThan(sql.indexOf('SET "discovery_listed"'));
    // exactly two backfills, nothing else is rewritten
    expect(sql.match(/^UPDATE "servers"/gm)).toHaveLength(2);
  });

  it('never touches the functional username index (expected drift the migration must leave alone)', () => {
    expect(sql).not.toMatch(/users_username_lower_key/);
    expect(sql).not.toMatch(/DROP INDEX/);
    expect(sql).not.toMatch(/DROP TABLE/);
    expect(sql).not.toMatch(/DROP COLUMN/);
  });
});

describe('schema.prisma mirrors the migration (so there is no new drift to live with)', () => {
  it('declares the eight Server indexes', () => {
    expect(schema).toContain('@@index([discoveryListed, activityScore(sort: Desc), id(sort: Desc)])');
    expect(schema).toContain('@@index([discoveryListed, memberCount(sort: Desc), id(sort: Desc)])');
    expect(schema).toContain('@@index([discoveryListed, createdAt(sort: Desc), id(sort: Desc)])');
    expect(schema).toContain('@@index([discoveryListed, name, id])');
    expect(schema).toContain('@@index([discoveryListed, statsRefreshedAt])');
    expect(schema).toContain('@@index([featuredAt])');
    expect(schema).toContain('@@index([tags(ops: ArrayOps)], type: Gin)');
    expect(schema).toContain('@@index([name(ops: raw("gin_trgm_ops"))], type: Gin, map: "servers_name_trgm_idx")');
  });

  it('declares the two models with their four User back-relations', () => {
    expect(schema).toMatch(/model ServerBan \{[\s\S]*@@id\(\[serverId, userId\]\)[\s\S]*@@map\("server_bans"\)/);
    expect(schema).toMatch(/model ServerJoinRequest \{[\s\S]*@@unique\(\[serverId, userId\]\)[\s\S]*@@map\("server_join_requests"\)/);
    for (const rel of ['"ServerBanUser"', '"ServerBanActor"', '"JoinRequestUser"', '"JoinRequestDecider"']) {
      // once on User, once on the owning model
      expect(schema.split(`@relation(${rel}`)).toHaveLength(3);
    }
  });
});
