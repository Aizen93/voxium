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
 * Production's bucket was configured by hand, so nothing in the repo recorded
 * that this step exists. Now it does.
 *
 * Refuses to touch anything whose name does not start with `dev-`: this applies
 * a bucket-wide policy, and pointing it at the production bucket by accident
 * would rewrite the rules real clients depend on.
 *
 * NEEDS BUCKET-OWNER CREDENTIALS. Setting CORS is an owner-level operation, so
 * an S3 user with read/write on the objects gets "Access Denied" here — that is
 * the permission boundary working, not a broken script. Run this once with the
 * account that owns the bucket; day-to-day development then uses the scoped
 * user, which never needs to touch bucket configuration again.
 */
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), 'apps/server/.env') });

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
 * The origins a developer actually serves the client from. Tauri gets its own
 * scheme, and on Windows it is https://tauri.localhost rather than the
 * tauri://localhost used elsewhere — both are listed so the desktop shell can
 * upload on any platform.
 */
const ALLOWED_ORIGINS = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://192.168.1.15:8080',
  'http://localhost:8082',
  'tauri://localhost',
  'https://tauri.localhost',
];

const s3 = new S3Client({
  endpoint: process.env.S3_ASSETS_ENDPOINT,
  region: process.env.S3_ASSETS_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
  },
  forcePathStyle: true,
});

async function main() {
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: bucket!,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: ALLOWED_ORIGINS,
            // PUT for the presigned upload, GET/HEAD for reading blobs back.
            AllowedMethods: ['PUT', 'GET', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    })
  );

  const applied = await s3.send(new GetBucketCorsCommand({ Bucket: bucket! }));
  console.log(`bucket: ${bucket} @ ${process.env.S3_ASSETS_ENDPOINT}`);
  for (const rule of applied.CORSRules ?? []) {
    console.log(`  methods: ${rule.AllowedMethods?.join(', ')}`);
    console.log(`  origins: ${rule.AllowedOrigins?.join(', ')}`);
  }
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
