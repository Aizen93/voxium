#!/usr/bin/env tsx
/**
 * Prepare a DEV object-storage bucket so browser uploads work against it.
 *
 *   npx tsx scripts/setup-dev-bucket.ts
 *
 * Attachments and avatars are uploaded straight from the browser to a presigned
 * URL, so the bucket itself must allow the dev origins — without a CORS policy
 * the upload fails as an opaque "TypeError: Failed to fetch" with nothing in the
 * server logs, which is a genuinely horrible thing to debug.
 *
 * The rule is the server's own: the server asks the store at boot whether it
 * accepts the browser's upload preflight from every CORS_ORIGIN origin (and
 * writes the rule with S3_CORS_APPLY=true) through the same code
 * (apps/server/src/utils/bucketCors.ts, reconcileBucketCors in utils/s3.ts),
 * so this script and the server cannot disagree about what the rule is. Like
 * the server, it asks the store first, writes only when a preflight is refused,
 * keeps every other rule of the bucket and changes only the rule named
 * `voxium-uploads`.
 *
 * Refuses to touch anything whose name does not start with `dev-`: this writes
 * a bucket-wide policy, and pointing it at the production bucket by accident
 * would rewrite the rules real clients depend on.
 *
 * NEEDS BUCKET-OWNER CREDENTIALS. Setting CORS is an owner-level operation, so
 * an S3 user with read/write on the objects gets "Access Denied" here — that is
 * the permission boundary working, not a broken script. Run this once with the
 * account that owns the bucket; day-to-day development then uses the scoped
 * user, which never needs to touch bucket configuration again.
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { reconcileBucketCors } from '../apps/server/src/utils/s3';
import { describeCorsRule } from '../apps/server/src/utils/bucketCors';
import { parseCorsOrigins } from '../apps/server/src/utils/corsOrigins';

config({ path: resolve(process.cwd(), 'apps/server/.env'), quiet: true });

const bucket = process.env.S3_ASSETS_BUCKET;
if (!bucket) {
  console.error('S3_ASSETS_BUCKET is not set (expected in apps/server/.env)');
  process.exit(1);
}
if (!bucket.startsWith('dev-')) {
  console.error(`Refusing: S3_ASSETS_BUCKET is "${bucket}", which is not a dev bucket.`);
  console.error('This writes a bucket-wide CORS policy; run it only against dev-*.');
  process.exit(1);
}

/**
 * The origins a developer actually serves the client from, plus whatever
 * CORS_ORIGIN in apps/server/.env allows (the origins the server's boot check
 * looks for). Tauri gets its own origin: http://tauri.localhost on Windows,
 * tauri://localhost on macOS and Linux. https://tauri.localhost is used by no
 * current build and stays listed as a harmless extra, so an installed desktop
 * build can upload on any platform.
 */
const DEV_ORIGINS = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:8082',
  'tauri://localhost',
  'https://tauri.localhost',
  'http://tauri.localhost',
];

async function main() {
  const origins = [...DEV_ORIGINS, ...parseCorsOrigins(process.env.CORS_ORIGIN)];
  const outcome = await reconcileBucketCors({ origins, apply: true });
  console.log(`bucket: ${bucket} @ ${process.env.S3_ASSETS_ENDPOINT}`);
  if (outcome.dropped > 0) {
    console.log(`  ${outcome.dropped} CORS_ORIGIN entr${outcome.dropped === 1 ? 'y' : 'ies'} left out: a wildcard or not a bare origin`);
  }
  switch (outcome.status) {
    case 'accepted':
      console.log(`  the store already accepts uploads from all ${outcome.origins.length} origins; nothing written`);
      return;
    case 'written':
      console.log(`  ${outcome.plan.previous ? 'replaced' : 'added'} the upload rule; ${outcome.plan.kept} other rule(s) kept as they were`);
      for (const rule of outcome.plan.rules) {
        console.log(`  ${rule.ID ?? '(no id)'}: ${describeCorsRule(rule)}`);
      }
      console.log(`  upload rule origins: ${outcome.plan.next.AllowedOrigins?.join(', ')}`);
      if (outcome.stillRefused === null) {
        console.warn(`  the check afterwards could not run (${outcome.probeError})`);
        process.exitCode = 1;
      } else if (outcome.stillRefused.length > 0) {
        console.warn(`  the store still refuses uploads from: ${outcome.stillRefused.join(', ')} (another rule naming the same origin may be answered first)`);
        process.exitCode = 1;
      }
      return;
    case 'unavailable':
      console.error(`FAILED to ask the store for its CORS answer: ${outcome.error}`);
      process.exitCode = 1;
      return;
    case 'rules-unreadable':
      console.error(`FAILED to read the bucket's CORS configuration: ${outcome.error}`);
      process.exitCode = 1;
      return;
    case 'rules-uninterpretable':
      console.error("FAILED: the store's answer about the bucket's CORS rules could not be interpreted (a success with no rule); nothing was written");
      process.exitCode = 1;
      return;
    case 'write-failed':
      console.error(`FAILED to write the bucket's CORS configuration: ${outcome.error}`);
      process.exitCode = 1;
      return;
    case 'refused':
    case 'no-origins':
      // Not reachable with apply: true and a non-empty origin list
      console.error(`Unexpected outcome: ${outcome.status}`);
      process.exitCode = 1;
      return;
  }
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
