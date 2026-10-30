/**
 * Read-back checks for client uploads, run the first time a row references
 * an uploaded object (a message attachment, an avatar, a space icon).
 *
 * The presigned PUT is signed for the declared size (utils/s3.ts), so the
 * store already refuses any other body length; this is the second line: the
 * object the row will point at must exist, have the size the row records and
 * stay under its kind's cap, and an avatar/icon must carry an image header.
 * An object that fails is deleted (it was never referenced) and the request
 * is refused. Every S3 failure other than "no such object" is rethrown: the
 * check fails closed, it never falls back to the declared size.
 */
import { LIMITS } from '@voxium/shared';
import { prisma } from './prisma';
import crypto from 'crypto';
import { headS3Object, getS3ObjectRange, deleteFromS3, copyS3Object } from './s3';
import { imageDimensions } from './imageHeader';
import { BadRequestError } from './errors';

/** Bytes read from the start of an avatar/icon to check its header. */
export const IMAGE_HEADER_PROBE_BYTES = 64;

async function discardUpload(key: string, reason: string): Promise<void> {
  console.warn(`[Uploads] Refusing uploaded object ${key}: ${reason}`);
  await deleteFromS3(key).catch((err) => {
    console.warn(`[Uploads] Failed to delete refused object ${key}:`, err instanceof Error ? err.message : err);
  });
}

export interface AttachmentUploadCheck {
  key: string;
  declaredSize: number;
  maxSize: number;
}

/**
 * Verify every attachment of a new message against the store. Refuses (400
 * `Invalid attachment`) a key already attached to a message or listed twice —
 * such an object is never deleted, it may belong to another row — and a key
 * with no object; refuses (400 `Invalid attachment size`) and deletes an
 * object whose real size differs from the declared one or exceeds `maxSize`.
 */
export async function verifyAttachmentUploads(items: AttachmentUploadCheck[]): Promise<void> {
  if (items.length === 0) return;
  const keys = items.map((i) => i.key);
  if (new Set(keys).size !== keys.length) throw new BadRequestError('Invalid attachment');

  const referenced = await prisma.messageAttachment.findFirst({
    where: { s3Key: { in: keys } },
    select: { id: true },
  });
  if (referenced) throw new BadRequestError('Invalid attachment');

  const outcomes = await Promise.all(items.map(async (item): Promise<'ok' | 'missing' | 'mismatch'> => {
    const head = await headS3Object(item.key);
    if (!head) return 'missing';
    if (head.size !== item.declaredSize || head.size > item.maxSize || head.size <= 0) {
      await discardUpload(item.key, `stored size ${head.size}, declared ${item.declaredSize}, cap ${item.maxSize}`);
      return 'mismatch';
    }
    return 'ok';
  }));

  if (outcomes.includes('mismatch')) throw new BadRequestError('Invalid attachment size');
  if (outcomes.includes('missing')) throw new BadRequestError('Invalid attachment');
}

function isWebp(buf: Buffer): boolean {
  return buf.length >= 16 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
}

function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG'
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
}

/**
 * The size and header checks of an adopted copy: the reason it is refused, or
 * null when it passes. S3 failures other than "no such object" are rethrown.
 */
async function checkAdoptedImage(key: string, maxSize: number): Promise<string | null> {
  const head = await headS3Object(key);
  if (!head || head.size <= 0 || head.size > maxSize) {
    return `stored size ${head?.size ?? 'missing'}, cap ${maxSize}`;
  }

  const header = await getS3ObjectRange(key, 0, IMAGE_HEADER_PROBE_BYTES - 1);
  const dims = header && (isWebp(header) || isPng(header)) ? imageDimensions(header) : null;
  if (
    !dims
    || dims.width < 1 || dims.height < 1
    || dims.width > LIMITS.MAX_IMAGE_ASSET_EDGE || dims.height > LIMITS.MAX_IMAGE_ASSET_EDGE
  ) {
    return dims ? `dimensions ${dims.width}x${dims.height}` : 'not a WebP/PNG image';
  }
  return null;
}

/**
 * Adopt an uploaded avatar or space icon before a profile/space row points at
 * it, and return the key the row must store.
 *
 * The client still holds a presigned PUT for the uploaded key until it expires,
 * and could replace the bytes after any check on that key. So the object is
 * first COPIED to a key derived from `keyPrefix` that no client was ever given
 * an upload URL for, and the check runs on the copy: what passes is what is
 * served. The copy must weigh at most `maxSize` bytes and start with a WebP
 * header (or a PNG one: a webview without a WebP encoder hands the client a PNG
 * for `image/webp`) whose dimensions are at most `LIMITS.MAX_IMAGE_ASSET_EDGE`.
 * The uploaded key is deleted either way; a refused copy too, and so is a copy
 * whose check a store error interrupted (the error is rethrown). Refuses with
 * `errorMessage` (400). A caller whose row write then fails deletes the
 * returned key itself.
 */
export async function adoptImageAssetUpload(
  uploadedKey: string,
  keyPrefix: string,
  maxSize: number,
  errorMessage: string,
): Promise<string> {
  // Same shape as the presign keys (VALID_S3_KEY_RE, the owner prefix check)
  const adoptedKey = `${keyPrefix}${Date.now()}-${crypto.randomBytes(6).toString('hex')}.webp`;
  if (!(await copyS3Object(uploadedKey, adoptedKey))) throw new BadRequestError(errorMessage);
  // From here the uploaded object is never referenced: remove it whatever the verdict
  await deleteFromS3(uploadedKey).catch((err) => {
    console.warn(`[Uploads] Failed to delete the uploaded original ${uploadedKey}:`, err instanceof Error ? err.message : err);
  });

  let refusal: string | null;
  try {
    refusal = await checkAdoptedImage(adoptedKey, maxSize);
  } catch (err) {
    // A store error mid-check: nothing references the copy, so it goes before the error does
    await discardUpload(adoptedKey, 'the check could not complete');
    throw err;
  }
  if (refusal) {
    await discardUpload(adoptedKey, refusal);
    throw new BadRequestError(errorMessage);
  }
  return adoptedKey;
}
