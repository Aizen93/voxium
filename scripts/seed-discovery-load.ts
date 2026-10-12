#!/usr/bin/env tsx
/**
 * Seed a THROWAWAY database with N listed servers for the directory's scale
 * measurement (docs/local/server-discovery-plan.html, "Measurement, part of
 * step 2"). Never the shared dev DB, never production: the script refuses
 * unless DISCOVERY_LOAD_DB=1 is set AND the database name contains "load".
 *
 *   DATABASE_URL=postgresql://.../voxium_discovery_load DISCOVERY_LOAD_DB=1 \
 *     npx tsx scripts/seed-discovery-load.ts [N=1000000]
 *
 * The rows are generated INSIDE Postgres with generate_series, 100,000 per
 * statement: N owners, N servers (names from a word list, random tags,
 * random activity numbers, half with a stats timestamp, 20 featured), one
 * owner membership per server, plus a 1% slice with 5–50 channels and 20
 * messages per channel spread over the last week so the stats job's
 * statements have something real to join. Idempotent (ON CONFLICT DO
 * NOTHING on deterministic ids), so an interrupted run can be resumed.
 * (A first version built the rows in Node through createMany and ran out of
 * heap at ~225k; the database is the right place to make a million rows.)
 */
import { PrismaClient } from '../apps/server/src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { DISCOVERY_TAGS, DISCOVERY_SCORE_WEIGHTS } from '../packages/shared/src/constants';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL not set');
if (process.env.DISCOVERY_LOAD_DB !== '1' || !/load/i.test(new URL(connectionString).pathname)) {
  throw new Error('Refusing: point DATABASE_URL at a throwaway database whose name contains "load" and set DISCOVERY_LOAD_DB=1');
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const N = Number(process.argv[2] || 1_000_000);
const CHUNK = 100_000;
const SLICE_EVERY = 100; // 1% of servers get channels + messages
const MESSAGES_PER_CHANNEL = 20;

const WORDS = [
  'Voxium', 'Lounge', 'Guild', 'Raiders', 'Makers', 'Study', 'Jazz', 'Rust', 'Pixel', 'Night', 'Owl', 'Forge', 'Harbor',
  'Summit', 'Garden', 'Cinema', 'Arcade', 'Atlas', 'Nova', 'Delta', 'Echo', 'Lingua', 'Codex', 'Orbit', 'Tavern',
  'Homelab', 'Kernel', 'Vector', 'Tempo', 'Chorus', 'Gaming', 'Music', 'Science', 'Open', 'Source', 'Art', 'Film',
  'Creators', 'Community', 'Esports', 'Languages', 'Education', 'Programming', 'Nerds', 'Club', 'Crew', 'Lab', 'Room',
];
const sqlArray = (items: readonly string[]) => `ARRAY[${items.map((w) => `'${w}'`).join(',')}]`;
const W = DISCOVERY_SCORE_WEIGHTS;

async function main() {
  const t0 = Date.now();
  console.log(`Seeding ${N.toLocaleString()} listed servers into ${new URL(connectionString!).pathname} …`);

  for (let from = 0; from < N; from += CHUNK) {
    const to = Math.min(N, from + CHUNK) - 1;
    // Owners (2% online so the online aggregate has rows)
    await prisma.$executeRawUnsafe(`
      INSERT INTO users (id, username, email, email_canonical, display_name, password, status, email_verified,
                         terms_accepted_at, privacy_accepted_at, created_at, updated_at)
      SELECT 'lu_'||i, 'load_owner_'||i, 'load'||i||'@loadtest.local', 'load'||i||'@loadtest.local', 'Owner '||i,
             'not-a-real-hash', CASE WHEN random() < 0.02 THEN 'online' ELSE 'offline' END, true, now(), now(), now(), now()
      FROM generate_series(${from}, ${to}) AS i
      ON CONFLICT (id) DO NOTHING`);
    // Servers: deterministic names from the word list, random tags (each
    // with a 15% chance), random activity numbers, half with a stats
    // timestamp within the last 3 days, the first 20 featured
    await prisma.$executeRawUnsafe(`
      INSERT INTO servers (id, name, icon_url, invites_locked, owner_id, created_at, updated_at, description, tags,
                           discoverable, join_mode, featured_at, discovery_blocked_at, discovery_listed, member_count,
                           discovery_online_count, discovery_weekly_messages, discovery_activity_score, discovery_stats_at)
      SELECT 'ls_'||i,
             w[1 + abs(hashtext('a'||i)) % ${WORDS.length}] || ' ' || w[1 + abs(hashtext('b'||i)) % ${WORDS.length}] || ' ' || (i % 997),
             NULL, false, 'lu_'||i, now() - (random() * 400) * interval '1 day', now(),
             CASE WHEN random() < 0.6 THEN 'A community for ' || lower(w[1 + abs(hashtext('c'||i)) % ${WORDS.length}]) || ' people. Voice most evenings.' END,
             (SELECT coalesce(array_agg(t), '{}'::text[]) FROM unnest(${sqlArray(DISCOVERY_TAGS)}) AS t WHERE random() < 0.15 AND i >= 0),
             true, CASE WHEN random() < 0.5 THEN 'approval' ELSE 'open' END,
             CASE WHEN i < 20 THEN now() - i * interval '1 hour' END, NULL, true,
             r.mc, r.oc, r.wm, r.oc * ${W.online} + r.wm * ${W.messages} + r.mc * ${W.members},
             CASE WHEN random() < 0.5 THEN NULL ELSE now() - (random() * 3) * interval '1 day' END
      FROM generate_series(${from}, ${to}) AS i
      CROSS JOIN (SELECT ${sqlArray(WORDS)} AS w) AS words
      CROSS JOIN LATERAL (
        SELECT mc, floor(random() * least(50, mc))::int AS oc, floor(random() * 3000)::int AS wm
        FROM (SELECT 1 + floor(random() * 500)::int AS mc WHERE i >= 0) AS m
      ) AS r
      ON CONFLICT (id) DO NOTHING`);
    await prisma.$executeRawUnsafe(`
      INSERT INTO server_members (user_id, server_id, role, joined_at)
      SELECT 'lu_'||i, 'ls_'||i, 'owner', now() FROM generate_series(${from}, ${to}) AS i
      ON CONFLICT (user_id, server_id) DO NOTHING`);
    console.log(`  ${(to + 1).toLocaleString()} / ${N.toLocaleString()} servers (${Math.round((Date.now() - t0) / 1000)}s)`);
  }

  // The 1% slice: memberships matching member_count (so the online aggregate
  // and the nightly recount run on representative rows), then 5..50 text
  // channels per server and 20 messages each over the last week
  console.log('Seeding the 1% slice with memberships, channels and messages …');
  for (let from = 0; from < N; from += CHUNK) {
    const to = Math.min(N, from + CHUNK) - 1;
    await prisma.$executeRawUnsafe(`
      INSERT INTO server_members (user_id, server_id, role, joined_at)
      SELECT 'lu_' || ((i + k) % ${N}), 'ls_' || i, 'member', now()
      FROM generate_series(${from}, ${to}, ${SLICE_EVERY}) AS i
      CROSS JOIN LATERAL generate_series(1, (SELECT member_count - 1 FROM servers WHERE id = 'ls_' || i)) AS k
      ON CONFLICT (user_id, server_id) DO NOTHING`);
  }
  await prisma.$executeRawUnsafe(`
    INSERT INTO channels (id, name, type, server_id, position, secure, created_at, updated_at)
    SELECT 'lc_'||i||'_'||c, 'channel-'||c, 'text', 'ls_'||i, c, false, now(), now()
    FROM generate_series(0, ${N - 1}, ${SLICE_EVERY}) AS i
    CROSS JOIN LATERAL generate_series(0, 4 + abs(hashtext('ch'||i)) % 46) AS c
    ON CONFLICT (id) DO NOTHING`);
  for (let from = 0; from < N; from += CHUNK) {
    const to = Math.min(N, from + CHUNK) - 1;
    await prisma.$executeRawUnsafe(`
      INSERT INTO messages (id, content, encrypted, type, channel_id, author_id, created_at)
      SELECT ch.id || '_m' || m, 'message ' || m, false, 'user', ch.id, 'lu_' || ch.server_i, now() - (random() * 7) * interval '1 day'
      FROM (
        SELECT c.id, substring(c.id FROM 'lc_(\\d+)_') AS server_i
        FROM channels c
        WHERE c.server_id IN (SELECT 'ls_'||i FROM generate_series(${from}, ${to}, ${SLICE_EVERY}) AS i)
      ) AS ch
      CROSS JOIN generate_series(0, ${MESSAGES_PER_CHANNEL - 1}) AS m
      ON CONFLICT (id) DO NOTHING`);
    console.log(`  messages for servers ${from.toLocaleString()}–${to.toLocaleString()} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }

  console.log('ANALYZE …');
  await prisma.$executeRawUnsafe('ANALYZE users; ANALYZE servers; ANALYZE server_members; ANALYZE channels; ANALYZE messages;');
  const [{ servers, members, channels, messages }] = await prisma.$queryRawUnsafe<Array<{ servers: number; members: number; channels: number; messages: number }>>(`
    SELECT (SELECT count(*)::int FROM servers WHERE discovery_listed) AS servers,
           (SELECT count(*)::int FROM server_members) AS members,
           (SELECT count(*)::int FROM channels) AS channels,
           (SELECT count(*)::int FROM messages) AS messages`);
  console.log(`Done in ${Math.round((Date.now() - t0) / 1000)}s: ${servers.toLocaleString()} listed servers, ${members.toLocaleString()} memberships, ${channels.toLocaleString()} channels, ${messages.toLocaleString()} messages`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});
