import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  GetBucketEncryptionCommand,
  PutBucketEncryptionCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Lazy-initialized to avoid reading env vars at module load time
// (ES import hoisting means this file executes before dotenv.config())
let _s3: S3Client | null = null;
function getS3Client(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      endpoint: process.env.S3_ASSETS_ENDPOINT!,
      region: process.env.S3_ASSETS_REGION!,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY!,
        secretAccessKey: process.env.S3_SECRET_KEY!,
      },
      forcePathStyle: true,
    });
  }
  return _s3;
}

function getBucket(): string {
  return process.env.S3_ASSETS_BUCKET!;
}

// Optional server-side encryption at rest (S3_SSE=AES256 or aws:kms), applied
// as BUCKET-DEFAULT encryption at startup — never as a per-request param on
// presigned PUTs. SSE headers cannot ride a presigned URL: the AWS presigner
// deliberately marks x-amz-server-side-encryption unhoistable, so it lands in
// SignedHeaders and clients (who don't send it) would 403 on every upload.
// Bucket-default encryption covers all uploads with zero client changes.
let _sse: 'AES256' | 'aws:kms' | undefined | null = null;
function getSSE(): 'AES256' | 'aws:kms' | undefined {
  if (_sse === null) {
    const v = process.env.S3_SSE;
    if (!v) {
      _sse = undefined;
    } else if (v === 'AES256' || v === 'aws:kms') {
      _sse = v;
    } else {
      console.warn(`[S3] Ignoring unsupported S3_SSE value "${v}" (expected AES256 or aws:kms)`);
      _sse = undefined;
    }
  }
  return _sse;
}

/**
 * Ensure the assets bucket has default encryption matching S3_SSE.
 * Called once at startup; no-op when S3_SSE is unset. Never throws — a
 * provider without bucket-encryption support (or a key lacking the
 * permission) must not block boot; uploads keep working and the operator
 * gets a loud log telling them to enable it provider-side.
 */
export async function ensureBucketEncryption(): Promise<void> {
  const sse = getSSE();
  if (!sse) return;
  const bucket = getBucket();
  try {
    const current = await getS3Client().send(
      new GetBucketEncryptionCommand({ Bucket: bucket }),
    ).catch(() => null); // missing config surfaces as an error on most providers
    const currentAlgo = current?.ServerSideEncryptionConfiguration?.Rules?.[0]
      ?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm;
    if (currentAlgo === sse) {
      console.log(`[S3] Bucket "${bucket}" already has default encryption (${sse})`);
      return;
    }
    await getS3Client().send(
      new PutBucketEncryptionCommand({
        Bucket: bucket,
        ServerSideEncryptionConfiguration: {
          Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: sse } }],
        },
      }),
    );
    console.log(`[S3] Enabled default encryption (${sse}) on bucket "${bucket}"`);
  } catch (err) {
    console.error(
      `[S3] Could not enable default encryption on bucket "${bucket}" — uploads will be stored per the provider's current settings. ` +
      'Enable default encryption in the provider console, or unset S3_SSE to silence this. ' +
      `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Regex matching valid S3 asset keys (e.g. avatars/userId-timestamp.webp) */
export const VALID_S3_KEY_RE = /^(avatars|server-icons)\/[\w-]+\.webp$/;

/** Regex matching valid attachment keys (e.g. attachments/ch-abc123/clxyz-report.pdf) */
export const VALID_ATTACHMENT_KEY_RE = /^attachments\/(ch|dm)-[\w-]+\/[\w]+-[\w][\w.-]*$/;

/**
 * Generate a presigned PUT URL for direct client upload to S3.
 * Sets ContentType and CacheControl as object metadata.
 */
export async function generatePresignedPutUrl(
  key: string,
  contentType: string,
  expiresIn = 300,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
    // NO ServerSideEncryption here — see ensureBucketEncryption() above.
  });

  return getSignedUrl(getS3Client(), command, {
    expiresIn,
    signableHeaders: new Set(['content-type']),
  });
}

/**
 * Generate a presigned GET URL for direct client download from S3.
 * Sets ResponseCacheControl so S3 returns cache headers.
 */
export async function generatePresignedGetUrl(
  key: string,
  expiresIn = 3600,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: key,
    ResponseCacheControl: 'public, max-age=31536000, immutable',
  });

  return getSignedUrl(getS3Client(), command, { expiresIn });
}

export interface S3ObjectInfo {
  key: string;
  size: number;
  lastModified: string | null;
}

/**
 * List all objects in the S3 bucket, optionally filtered by prefix.
 * Handles pagination via ContinuationToken.
 */
export async function listAllS3Objects(prefix?: string): Promise<S3ObjectInfo[]> {
  const objects: S3ObjectInfo[] = [];
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: getBucket(),
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });

    const response = await getS3Client().send(command);

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key && obj.Size !== undefined) {
          objects.push({
            key: obj.Key,
            size: obj.Size,
            lastModified: obj.LastModified?.toISOString() ?? null,
          });
        }
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

/**
 * Fetch an object from S3 for proxy streaming. Returns metadata + body stream.
 */
export async function getS3Object(key: string) {
  const command = new GetObjectCommand({ Bucket: getBucket(), Key: key });
  return getS3Client().send(command);
}

/**
 * Delete an object from S3. Idempotent (ignores NoSuchKey).
 */
export async function deleteFromS3(key: string): Promise<void> {
  try {
    await getS3Client().send(
      new DeleteObjectCommand({ Bucket: getBucket(), Key: key }),
    );
  } catch (err: unknown) {
    // Rethrow everything except NoSuchKey (idempotent delete)
    const isNoSuchKey = err instanceof Error && err.name === 'NoSuchKey';
    if (!isNoSuchKey) throw err;
  }
}

/**
 * Delete multiple objects from S3 in batches of 1000. Returns how many keys S3
 * actually ACCEPTED — DeleteObjects answers 200 with a populated `Errors[]`
 * when, say, the credentials lack s3:DeleteObject, so a caller that reads "no
 * throw" as "all gone" reports success while nothing moved.
 */
export async function deleteMultipleFromS3(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  let failed = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const response = await getS3Client().send(
      new DeleteObjectsCommand({
        Bucket: getBucket(),
        Delete: { Objects: batch.map((key) => ({ Key: key })) },
      }),
    );
    if (response.Errors && response.Errors.length > 0) {
      failed += response.Errors.length;
      console.error(`[S3] Failed to delete ${response.Errors.length} objects:`, response.Errors.map((e) => e.Key));
    }
  }
  return keys.length - failed;
}
