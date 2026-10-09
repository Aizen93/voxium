#!/usr/bin/env tsx
/**
 * Measure every query shape the directory serves against a seeded throwaway
 * database (docs/local/server-discovery-plan.html, "Measurement, part of step
 * 2"): 20 runs each, p50/p95, plus EXPLAIN (ANALYZE, BUFFERS) for one run of
 * each shape. FAILS if any plan contains a sequential scan of servers,
 * server_members or messages.
 *
 *   DATABASE_URL=postgresql://.../voxium_discovery_load DISCOVERY_LOAD_DB=1 \
 *     npx tsx scripts/measure-discovery.ts [report.md]
 *
 * The Prisma queries are the ROUTE's queries (same where/orderBy/cursor/take),
 * captured through the client's query log so the plans are for the SQL Prisma
 * actually emits; the raw statements are the stats job's own.
 */
import { PrismaClient, Prisma } from '../apps/server/src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { writeFileSync } from 'node:fs';
import { DISCOVERY_PAGE_SIZE, DISCOVERY_TAGS, DISCOVERY_TOTAL_CAP, DISCOVERY_SCORE_WEIGHTS } from '../packages/shared/src/constants';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL not set');
if (process.env.DISCOVERY_LOAD_DB !== '1' || !/load/i.test(new URL(connectionString).pathname)) {
  throw new Error('Refusing: point DATABASE_URL at a throwaway database whose name contains "load" and set DISCOVERY_LOAD_DB=1');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
  log: [{ level: 'query', emit: 'event' }],
});

// Capture the last SQL + params Prisma emitted so it can be EXPLAINed verbatim
let lastQuery: { query: string; params: string } | null = null;
(prisma as unknown as { $on: (e: 'query', cb: (e: { query: string; params: string }) => void) => void })
  .$on('query', (e) => { lastQuery = { query: e.query, params: e.params }; });

const RUNS = 20;
const TARGETS = { firstPageMs: 20, searchTagP95Ms: 150, statsBatchMs: 2000 };
const SORTS = ['active', 'members', 'newest', 'name'] as const;

const cardSelect = {
  id: true, name: true, iconUrl: true, description: true, tags: true,
  memberCount: true, onlineCount: true, weeklyMessages: true, joinMode: true,
  featuredAt: true, createdAt: true, statsRefreshedAt: true,
} as const;

function orderFor(sort: (typeof SORTS)[number]): Prisma.ServerOrderByWithRelationInput[] {
  switch (sort) {
    case 'members': return [{ memberCount: 'desc' }, { id: 'desc' }];
    case 'newest': return [{ createdAt: 'desc' }, { id: 'desc' }];
    case 'name': return [{ name: 'asc' }, { id: 'asc' }];
    default: return [{ activityScore: 'desc' }, { id: 'desc' }];
  }
}

function pct(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Replace $1.. placeholders with SQL literals so the captured statement can be EXPLAINed. */
function inlineParams(query: string, params: string): string {
  const values = JSON.parse(params) as unknown[];
  return query.replace(/\$(\d+)/g, (_m, n) => {
    const v = values[Number(n) - 1];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) return `ARRAY[${v.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',')}]`;
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

const SCANNED = ['servers', 'server_members', 'messages'];
function seqScans(plan: string): string[] {
  return SCANNED.filter((t) => new RegExp(`Seq Scan on ${t}\\b`).test(plan));
}

interface Shape { name: string; run: () => Promise<unknown>; target: number }
interface Result { name: string; p50: number; p95: number; target: number; plan: string; seq: string[] }

async function explainLast(): Promise<string> {
  if (!lastQuery) return '(no query captured)';
  const sql = inlineParams(lastQuery.query, lastQuery.params);
  const rows = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

async function measure(shape: Shape): Promise<Result> {
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = process.hrtime.bigint();
    await shape.run();
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  await shape.run();
  const plan = await explainLast();
  return { name: shape.name, p50: pct(samples, 50), p95: pct(samples, 95), target: shape.target, plan, seq: seqScans(plan) };
}

async function main() {
  const total = await prisma.server.count({ where: { discoveryListed: true } });
  console.log(`Listed servers: ${total.toLocaleString()} (${RUNS} runs per shape)`);
  const results: Result[] = [];

  // First page per sort
  for (const sort of SORTS) {
    results.push(await measure({
      name: `first page · sort=${sort}`,
      target: TARGETS.firstPageMs,
      run: () => prisma.server.findMany({ where: { discoveryListed: true }, orderBy: orderFor(sort), take: DISCOVERY_PAGE_SIZE + 1, select: cardSelect }),
    }));
  }

  // Page 40 per sort: the keyset cursor from the last row of page 39 (found
  // ONCE here with an offset the app never uses)
  for (const sort of SORTS) {
    const anchor = await prisma.server.findMany({ where: { discoveryListed: true }, orderBy: orderFor(sort), skip: 39 * DISCOVERY_PAGE_SIZE - 1, take: 1, select: { id: true } });
    const cursorId = anchor[0]?.id;
    if (!cursorId) continue;
    results.push(await measure({
      name: `page 40 · sort=${sort}`,
      target: TARGETS.firstPageMs,
      run: () => prisma.server.findMany({ where: { discoveryListed: true }, orderBy: orderFor(sort), cursor: { id: cursorId }, skip: 1, take: DISCOVERY_PAGE_SIZE + 1, select: cardSelect }),
    }));
  }

  // The capped count, every shape the route uses (routes/discovery.ts countCapped)
  results.push(await measure({
    name: 'capped count · no filter (sort index order)',
    target: TARGETS.firstPageMs,
    run: () => prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM servers WHERE discovery_listed = true ORDER BY discovery_activity_score DESC, id DESC LIMIT ${DISCOVERY_TOTAL_CAP + 1}) t`,
  }));
  results.push(await measure({
    name: 'capped count · tag=music (sort index order)',
    target: TARGETS.searchTagP95Ms,
    run: () => prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM servers WHERE discovery_listed = true AND ${'music'} = ANY(tags) ORDER BY discovery_activity_score DESC, id DESC LIMIT ${DISCOVERY_TOTAL_CAP + 1}) t`,
  }));

  // Search: a rare word and a common one, rows + capped count (name index order)
  for (const q of ['Zebra', 'Gaming']) {
    results.push(await measure({
      name: `search "${q}" · rows`,
      target: TARGETS.searchTagP95Ms,
      run: () => prisma.server.findMany({ where: { discoveryListed: true, name: { contains: q, mode: 'insensitive' } }, orderBy: orderFor('active'), take: DISCOVERY_PAGE_SIZE + 1, select: cardSelect }),
    }));
    results.push(await measure({
      name: `search "${q}" · capped count`,
      target: TARGETS.searchTagP95Ms,
      run: () => prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM servers WHERE discovery_listed = true AND name ILIKE ${`%${q}%`} ORDER BY name ASC, id ASC LIMIT ${DISCOVERY_TOTAL_CAP + 1}) t`,
    }));
  }
  // Search + tag: rows through the sort index, the count plain (trigram bitmap, capped in code)
  results.push(await measure({
    name: 'search "Gaming" + tag=music · rows',
    target: TARGETS.searchTagP95Ms,
    run: () => prisma.server.findMany({ where: { discoveryListed: true, name: { contains: 'Gaming', mode: 'insensitive' }, tags: { has: 'music' } }, orderBy: orderFor('active'), take: DISCOVERY_PAGE_SIZE + 1, select: cardSelect }),
  }));
  results.push(await measure({
    name: 'search "Gaming" + tag=music · plain count',
    target: TARGETS.searchTagP95Ms,
    run: () => prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM servers WHERE discovery_listed = true AND name ILIKE ${'%Gaming%'} AND ${'music'} = ANY(tags)`,
  }));

  // Every tag with the Active sort
  for (const tag of DISCOVERY_TAGS) {
    results.push(await measure({
      name: `tag=${tag} · active`,
      target: TARGETS.searchTagP95Ms,
      run: () => prisma.server.findMany({ where: { discoveryListed: true, tags: { has: tag } }, orderBy: orderFor('active'), take: DISCOVERY_PAGE_SIZE + 1, select: cardSelect }),
    }));
  }

  // Per-user flag lookups over one page of ids
  const pageIds = (await prisma.server.findMany({ where: { discoveryListed: true }, orderBy: orderFor('active'), take: DISCOVERY_PAGE_SIZE, select: { id: true } })).map((s) => s.id);
  results.push(await measure({
    name: 'per-user flags · memberships IN (24 ids)',
    target: TARGETS.firstPageMs,
    run: () => prisma.serverMember.findMany({ where: { userId: 'lu_0', serverId: { in: pageIds } }, select: { serverId: true } }),
  }));
  results.push(await measure({
    name: 'per-user flags · pending requests IN (24 ids)',
    target: TARGETS.firstPageMs,
    run: () => prisma.serverJoinRequest.findMany({ where: { userId: 'lu_0', serverId: { in: pageIds }, status: 'pending' }, select: { serverId: true } }),
  }));

  // One stats batch of 500 from the 1% slice (the servers with channels)
  const sliceIds = Array.from({ length: 500 }, (_, i) => `ls_${i * 100}`);
  const W = DISCOVERY_SCORE_WEIGHTS;
  const statsPlans: string[] = [];
  results.push(await measure({
    name: 'stats batch of 500 · three statements',
    target: TARGETS.statsBatchMs,
    run: async () => {
      const [weeklyRows, onlineRows] = await Promise.all([
        prisma.$queryRaw<Array<{ serverId: string; n: number }>>`
          SELECT c.server_id AS "serverId", COUNT(*)::int AS n
          FROM channels c JOIN messages m ON m.channel_id = c.id
          WHERE c.server_id = ANY(${sliceIds}::text[]) AND m.created_at >= now() - interval '7 days'
          GROUP BY c.server_id`,
        prisma.$queryRaw<Array<{ serverId: string; n: number }>>`
          SELECT sm.server_id AS "serverId", COUNT(*)::int AS n
          FROM server_members sm JOIN users u ON u.id = sm.user_id
          WHERE sm.server_id = ANY(${sliceIds}::text[]) AND u.status = 'online'
          GROUP BY sm.server_id`,
      ]);
      const weeklyBy = new Map(weeklyRows.map((r) => [r.serverId, r.n]));
      const onlineBy = new Map(onlineRows.map((r) => [r.serverId, r.n]));
      const weekly = sliceIds.map((id) => weeklyBy.get(id) ?? 0);
      const online = sliceIds.map((id) => onlineBy.get(id) ?? 0);
      await prisma.$executeRaw`
        UPDATE servers s SET
          discovery_weekly_messages = v.weekly,
          discovery_online_count    = v.online,
          discovery_activity_score  = v.online * ${W.online}::int + v.weekly * ${W.messages}::int + s.member_count * ${W.members}::int,
          discovery_stats_at        = now()
        FROM unnest(${sliceIds}::text[], ${weekly}::int[], ${online}::int[]) AS v(id, weekly, online)
        WHERE s.id = v.id`;
    },
  }));
  // The stats batch's own three plans (the measure() above only captured the last statement)
  const idList = sliceIds.map((id) => `'${id}'`).join(',');
  for (const [label, sql] of [
    ['weekly messages', `SELECT c.server_id, COUNT(*)::int AS n FROM channels c JOIN messages m ON m.channel_id = c.id WHERE c.server_id = ANY(ARRAY[${idList}]::text[]) AND m.created_at >= now() - interval '7 days' GROUP BY c.server_id`],
    ['online members', `SELECT sm.server_id, COUNT(*)::int AS n FROM server_members sm JOIN users u ON u.id = sm.user_id WHERE sm.server_id = ANY(ARRAY[${idList}]::text[]) AND u.status = 'online' GROUP BY sm.server_id`],
    ['stale pick (NULL first)', `SELECT id FROM servers WHERE discovery_listed = true AND discovery_stats_at IS NULL ORDER BY discovery_stats_at ASC LIMIT 500`],
    ['stale pick (oldest)', `SELECT id FROM servers WHERE discovery_listed = true AND discovery_stats_at < now() - interval '24 hours' ORDER BY discovery_stats_at ASC LIMIT 500`],
  ] as const) {
    const rows = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    statsPlans.push(`### stats · ${label}\n\n\`\`\`\n${plan}\n\`\`\``);
    const seq = seqScans(plan);
    if (seq.length) results.push({ name: `stats · ${label}`, p50: 0, p95: 0, target: 0, plan, seq });
  }

  // Report
  const lines: string[] = [];
  lines.push(`# Server discovery — scale measurement`, '', `Listed servers: **${total.toLocaleString()}** · ${RUNS} runs per shape · ${new Date().toISOString()}`, '');
  lines.push('| Shape | p50 ms | p95 ms | target ms | seq scan |', '|---|---:|---:|---:|---|');
  let failed = false;
  for (const r of results) {
    const over = r.target > 0 && r.p95 > r.target;
    const bad = r.seq.length > 0;
    if (over || bad) failed = true;
    lines.push(`| ${r.name} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.target || '-'} | ${bad ? '**' + r.seq.join(', ') + '**' : 'none'} |${over ? ' ⚠ over target' : ''}`);
  }
  lines.push('', '## Plans (EXPLAIN ANALYZE, BUFFERS)', '');
  for (const r of results) {
    if (r.target === 0) continue;
    lines.push(`### ${r.name}`, '', '```', r.plan, '```', '');
  }
  lines.push(...statsPlans, '');
  const report = lines.join('\n');
  console.log(report);
  const out = process.argv[2];
  if (out) {
    writeFileSync(out, report, 'utf8');
    console.log(`\nReport written to ${out}`);
  }
  await prisma.$disconnect();
  if (failed) {
    console.error('\nFAILED: a plan contains a sequential scan of servers/server_members/messages, or a p95 is over target');
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error('FAILED:', err instanceof Error ? err.stack ?? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});
