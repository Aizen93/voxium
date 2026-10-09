import { normalizeIp } from '../middleware/rateLimiter';

interface IpBanRow { id: string; ip: string }

export interface IpBanStore {
  ipBan: {
    findMany: (args: { select: { id: true; ip: true } }) => Promise<IpBanRow[]>;
    update: (args: { where: { id: string }; data: { ip: string } }) => Promise<unknown>;
    delete: (args: { where: { id: string } }) => Promise<unknown>;
  };
}

/**
 * Rewrite any IpBan row whose `ip` is not in the canonical form every reader
 * queries. Before the write side normalized, an operator could store
 * `2001:DB8::1` or `::ffff:cb00:7107` — rows that `findUnique` on the
 * normalized caller address never matched, i.e. bans that never applied.
 * Where the canonical spelling already has its own row the duplicate is
 * dropped (the surviving row is the one that actually works).
 *
 * Runs once at boot; the table is operator-sized. Returns what it changed so
 * the caller can log it.
 */
export async function repairIpBanSpellings(db: IpBanStore): Promise<{ rewritten: number; merged: number }> {
  const rows = await db.ipBan.findMany({ select: { id: true, ip: true } });
  const canonicalIds = new Map<string, string>();
  for (const row of rows) {
    if (normalizeIp(row.ip) === row.ip) canonicalIds.set(row.ip, row.id);
  }

  let rewritten = 0;
  let merged = 0;
  for (const row of rows) {
    const canonical = normalizeIp(row.ip);
    if (canonical === row.ip) continue;
    if (canonicalIds.has(canonical)) {
      await db.ipBan.delete({ where: { id: row.id } });
      merged++;
    } else {
      await db.ipBan.update({ where: { id: row.id }, data: { ip: canonical } });
      canonicalIds.set(canonical, row.id);
      rewritten++;
    }
  }
  return { rewritten, merged };
}
