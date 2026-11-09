'use strict';
/**
 * Runtime guard for the e2e run: records every pg `client.query()` issued
 * while the SAME client already has a query active or queued, i.e. two
 * queries at once on one connection.
 *
 * Why: Prisma used to load the relations of one query as concurrent queries,
 * and inside a transaction they all shared its single connection. pg 8 queues
 * them and deprecates it ("Calling client.query() when the client is already
 * executing a query is deprecated and will be removed in pg@9.0"), but only
 * warns once per process and only from the THIRD query; two at once are
 * silent. This sees both. The source guard is
 * apps/server/src/__tests__/utils/transactionRelationLoads.test.ts.
 *
 * Use: NODE_OPTIONS="--require <abs path>/scripts/lib/pg-overlap-guard.cjs"
 * and PG_OVERLAP_REPORT=<file>. Every node process NODE_OPTIONS reaches loads
 * it; without PG_OVERLAP_REPORT it does nothing, and it never throws into the
 * process it is loaded in. One JSON line per overlap is appended to the file;
 * CI fails the job when the file is not empty.
 */
const report = process.env.PG_OVERLAP_REPORT;

function flat(text) {
  return String(text).replace(/\s+/g, ' ').slice(0, 300);
}

function arm() {
  const path = require('node:path');
  const fs = require('node:fs');
  // The pg that @prisma/adapter-pg loads, resolved from the server package:
  // the adapter's exports map has no ./package.json, so go up from its entry
  const serverDir = path.resolve(__dirname, '../../apps/server');
  let pgEntry;
  try {
    const adapterEntry = require.resolve('@prisma/adapter-pg', { paths: [serverDir] });
    pgEntry = require.resolve('pg', { paths: [path.dirname(path.dirname(adapterEntry))] });
  } catch {
    return; // no adapter here: nothing to watch
  }
  const { Client } = require(pgEntry);
  if (Client.prototype.query.__pgOverlapGuard) return;
  const original = Client.prototype.query;
  const guarded = function query(config, ...rest) {
    try {
      const queued = this._queryQueue ? this._queryQueue.length : 0;
      if (this._activeQuery || queued > 0) {
        const text = typeof config === 'string' ? config : config && config.text;
        const active = this._activeQuery && this._activeQuery.text;
        fs.appendFileSync(report, `${JSON.stringify({
          pid: process.pid,
          process: path.basename(process.argv[1] || process.argv0),
          queued,
          query: flat(text),
          active: flat(active),
          stack: (new Error().stack || '').split('\n').slice(2, 10).map((s) => s.trim()),
        })}\n`);
      }
    } catch (err) {
      try {
        process.stderr.write(`[pg-overlap-guard] could not record an overlap: ${err && err.message}\n`);
      } catch {
        // stderr itself is gone: nothing left to report to
      }
    }
    return original.call(this, config, ...rest);
  };
  guarded.__pgOverlapGuard = true;
  Client.prototype.query = guarded;
}

if (report) {
  try {
    arm();
  } catch (err) {
    try {
      process.stderr.write(`[pg-overlap-guard] not armed: ${err && err.message}\n`);
    } catch {
      // stderr itself is gone: nothing left to report to
    }
  }
}
