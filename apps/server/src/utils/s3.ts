import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { Readable } from 'stream';

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

/**
 * Upload a buffer to S3 and return the object key.
 * Key format: `{folder}/{entityId}-{timestamp}.webp`
 */
export async function uploadToS3(folder: string, entityId: string, buffer: Buffer): Promise<string> {
  const key = `${folder}/${entityId}-${Date.now()}.webp`;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'image/webp',
    }),
  );

  return key;
}

/**
 * Stream an object from S3. Returns the readable stream and metadata.
 */
export async function streamFromS3(key: string): Promise<{
  stream: Readable;
  contentType: string;
  contentLength: number | undefined;
}> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );

  return {
    stream: res.Body as Readable,
    contentType: res.ContentType || 'application/octet-stream',
    contentLength: res.ContentLength,
  };
}

/**
 * Delete an object from S3. Idempotent (ignores NoSuchKey).
 */
export async function deleteFromS3(key: string): Promise<void> {
  try {
    await s3.send(
      new DeleteObjectCommand({ Bucket: BUCKET, Key: key }),
    );
  } catch (err: any) {
    if (err.name !== 'NoSuchKey') throw err;
  }
}
