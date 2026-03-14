import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
  endpoint: process.env.S3_ASSETS_ENDPOINT!,
  region: process.env.S3_ASSETS_REGION!,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
  },
  forcePathStyle: true,
});

const BUCKET = process.env.S3_ASSETS_BUCKET!;

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
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  });

  return getSignedUrl(s3, command, {
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
    Bucket: BUCKET,
    Key: key,
    ResponseCacheControl: 'public, max-age=31536000, immutable',
  });

  return getSignedUrl(s3, command, { expiresIn });
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
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });

    const response = await s3.send(command);

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
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return s3.send(command);
}

/**
 * Delete an object from S3. Idempotent (ignores NoSuchKey).
 */
export async function deleteFromS3(key: string): Promise<void> {
  try {
    await s3.send(
      new DeleteObjectCommand({ Bucket: BUCKET, Key: key }),
    );
  } catch (err: unknown) {
    // Rethrow everything except NoSuchKey (idempotent delete)
    const isNoSuchKey = err instanceof Error && err.name === 'NoSuchKey';
    if (!isNoSuchKey) throw err;
  }
}

/**
 * Delete multiple objects from S3 in batches of 1000.
 */
export async function deleteMultipleFromS3(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const response = await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: batch.map((key) => ({ Key: key })) },
      }),
    );
    if (response.Errors && response.Errors.length > 0) {
      console.error(`[S3] Failed to delete ${response.Errors.length} objects:`, response.Errors.map((e) => e.Key));
    }
  }
}
