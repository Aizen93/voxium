import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LIMITS } from '@voxium/shared';

const s3 = vi.hoisted(() => ({
  headS3Object: vi.fn(),
  getS3ObjectRange: vi.fn(),
  deleteFromS3: vi.fn(),
  copyS3Object: vi.fn(),
}));
vi.mock('../../utils/s3', () => s3);

const prismaMock = vi.hoisted(() => ({
  messageAttachment: { findFirst: vi.fn() },
}));
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

import { verifyAttachmentUploads, adoptImageAssetUpload, IMAGE_HEADER_PROBE_BYTES } from '../../utils/uploadVerification';
import { BadRequestError } from '../../utils/errors';

/** A VP8X WebP header (30 bytes) declaring width x height. */
function webpHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(1000, 4);
  buf.write('WEBP', 8, 'latin1');
  buf.write('VP8X', 12, 'latin1');
  buf.writeUInt32LE(10, 16);
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

/**
 * A simple lossy WebP ('VP8 ' chunk, 30 bytes): what a canvas encoder writes
 * for an opaque image. Frame tag (keyframe), start code 9D 01 2A at 23..25,
 * then 14-bit width/height at 26/28 whose top two bits are the scale.
 */
function webpLossyHeader(width: number, height: number, startCode = [0x9d, 0x01, 0x2a]): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(1000, 4);
  buf.write('WEBP', 8, 'latin1');
  buf.write('VP8 ', 12, 'latin1');
  buf.writeUInt32LE(980, 16);
  Buffer.from([0x50, 0x2d, 0x00]).copy(buf, 20);
  Buffer.from(startCode).copy(buf, 23);
  buf.writeUInt16LE((width & 0x3fff) | 0x4000, 26); // scale bits set: must be masked off
  buf.writeUInt16LE(height & 0x3fff, 28);
  return buf;
}

/** A lossless WebP ('VP8L' chunk, 25 bytes): signature 0x2F, then 14-bit width-1 and height-1. */
function webpLosslessHeader(width: number, height: number, signature = 0x2f): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(1000, 4);
  buf.write('WEBP', 8, 'latin1');
  buf.write('VP8L', 12, 'latin1');
  buf.writeUInt32LE(980, 16);
  buf[20] = signature;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  buf.writeUInt32LE(bits >>> 0, 21);
  return buf;
}

/**
 * Serve `header` as the start of a 20 KB object, honouring the byte range the
 * code asks for — so a probe smaller than the header a format needs fails.
 */
function serveObject(header: Buffer): void {
  const object = Buffer.concat([header, Buffer.alloc(20_000 - header.length, 0xaa)]);
  s3.headS3Object.mockResolvedValue({ size: object.length, contentType: 'image/webp' });
  s3.getS3ObjectRange.mockImplementation(async (_key: string, start: number, end: number) => object.subarray(start, end + 1));
}

/** A PNG signature + IHDR (24 bytes) declaring width x height. */
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** A JPEG SOF0 header: a real image, but not what the client encodes. */
function jpegHeader(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x01, 0x00, 0x03, 0x01, 0x22, 0x00]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  prismaMock.messageAttachment.findFirst.mockResolvedValue(null);
  s3.deleteFromS3.mockResolvedValue(undefined);
});

describe('verifyAttachmentUploads', () => {
  const item = (key: string, declaredSize: number, maxSize = LIMITS.MAX_ATTACHMENT_SIZE) => ({ key, declaredSize, maxSize });

  it('passes when every stored object has its declared size', async () => {
    s3.headS3Object.mockImplementation(async (key: string) => ({ size: key.endsWith('a.pdf') ? 100 : 200, contentType: null }));

    await expect(verifyAttachmentUploads([
      item('attachments/ch-c1/1-a.pdf', 100),
      item('attachments/ch-c1/2-b.pdf', 200),
    ])).resolves.toBeUndefined();

    expect(s3.headS3Object).toHaveBeenCalledTimes(2);
    expect(s3.deleteFromS3).not.toHaveBeenCalled();
    expect(prismaMock.messageAttachment.findFirst).toHaveBeenCalledWith({
      where: { s3Key: { in: ['attachments/ch-c1/1-a.pdf', 'attachments/ch-c1/2-b.pdf'] } },
      select: { id: true },
    });
  });

  it('is a no-op for an empty list', async () => {
    await verifyAttachmentUploads([]);
    expect(prismaMock.messageAttachment.findFirst).not.toHaveBeenCalled();
    expect(s3.headS3Object).not.toHaveBeenCalled();
  });

  it('refuses and deletes an object larger than declared', async () => {
    s3.headS3Object.mockResolvedValue({ size: 5_000_000_000, contentType: null });

    await expect(verifyAttachmentUploads([item('attachments/ch-c1/1-a.pdf', 100)]))
      .rejects.toThrow(new BadRequestError('Invalid attachment size'));
    expect(s3.deleteFromS3).toHaveBeenCalledWith('attachments/ch-c1/1-a.pdf');
  });

  it('refuses and deletes an object smaller than declared', async () => {
    s3.headS3Object.mockResolvedValue({ size: 99, contentType: null });

    await expect(verifyAttachmentUploads([item('attachments/ch-c1/1-a.pdf', 100)])).rejects.toThrow('Invalid attachment size');
    expect(s3.deleteFromS3).toHaveBeenCalledWith('attachments/ch-c1/1-a.pdf');
  });

  it('refuses and deletes an object over the cap even when it matches the declared size', async () => {
    s3.headS3Object.mockResolvedValue({ size: 500, contentType: null });

    await expect(verifyAttachmentUploads([item('attachments/ch-c1/1-a.pdf', 500, 400)])).rejects.toThrow('Invalid attachment size');
    expect(s3.deleteFromS3).toHaveBeenCalledTimes(1);
  });

  it('deletes only the failing objects of a message', async () => {
    s3.headS3Object.mockImplementation(async (key: string) => ({ size: key.endsWith('a.pdf') ? 100 : 9999, contentType: null }));

    await expect(verifyAttachmentUploads([
      item('attachments/ch-c1/1-a.pdf', 100),
      item('attachments/ch-c1/2-b.pdf', 200),
    ])).rejects.toThrow('Invalid attachment size');
    expect(s3.deleteFromS3).toHaveBeenCalledTimes(1);
    expect(s3.deleteFromS3).toHaveBeenCalledWith('attachments/ch-c1/2-b.pdf');
  });

  it('refuses a key with no stored object, deleting nothing', async () => {
    s3.headS3Object.mockResolvedValue(null);

    await expect(verifyAttachmentUploads([item('attachments/ch-c1/1-a.pdf', 100)])).rejects.toThrow(new BadRequestError('Invalid attachment'));
    expect(s3.deleteFromS3).not.toHaveBeenCalled();
  });

  it('refuses a key already attached to a message without reading or deleting it', async () => {
    prismaMock.messageAttachment.findFirst.mockResolvedValue({ id: 'att-1' });

    await expect(verifyAttachmentUploads([item('attachments/ch-c1/1-a.pdf', 1)])).rejects.toThrow('Invalid attachment');
    expect(s3.headS3Object).not.toHaveBeenCalled();
    expect(s3.deleteFromS3).not.toHaveBeenCalled();
  });

  it('refuses the same key listed twice', async () => {
    await expect(verifyAttachmentUploads([
      item('attachments/ch-c1/1-a.pdf', 100),
      item('attachments/ch-c1/1-a.pdf', 100),
    ])).rejects.toThrow('Invalid attachment');
    expect(s3.headS3Object).not.toHaveBeenCalled();
  });

  it('rethrows a store failure instead of trusting the declared size', async () => {
    s3.headS3Object.mockRejectedValue(new Error('AccessDenied'));

    await expect(verifyAttachmentUploads([item('attachments/ch-c1/1-a.pdf', 100)])).rejects.toThrow('AccessDenied');
    expect(s3.deleteFromS3).not.toHaveBeenCalled();
  });

  it('still refuses when the delete of a bad object fails (logged)', async () => {
    s3.headS3Object.mockResolvedValue({ size: 101, contentType: null });
    s3.deleteFromS3.mockRejectedValue(new Error('delete failed'));

    await expect(verifyAttachmentUploads([item('attachments/ch-c1/1-a.pdf', 100)])).rejects.toThrow('Invalid attachment size');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to delete refused object'), 'delete failed');
  });
});

describe('adoptImageAssetUpload', () => {
  const KEY = 'avatars/user-1-1700000000.webp';
  const PREFIX = 'avatars/user-1-';
  const MAX = LIMITS.MAX_AVATAR_SIZE;
  /** The server-chosen key: owner prefix, timestamp, random suffix, still VALID_S3_KEY_RE */
  const ADOPTED = /^avatars\/user-1-\d+-[0-9a-f]{12}\.webp$/;

  beforeEach(() => {
    s3.copyS3Object.mockResolvedValue(true);
  });

  function adopt(key = KEY, msg = 'Invalid avatar key') {
    return adoptImageAssetUpload(key, PREFIX, MAX, msg);
  }

  /** A refused adoption removes BOTH the upload and the copy. */
  function expectBothDeleted(): void {
    expect(s3.deleteFromS3).toHaveBeenCalledWith(KEY);
    expect(s3.deleteFromS3).toHaveBeenCalledWith(expect.stringMatching(ADOPTED));
  }

  it('copies the upload to a server-chosen key, checks the COPY, deletes the upload, returns the copy', async () => {
    s3.headS3Object.mockResolvedValue({ size: 20_000, contentType: 'image/webp' });
    s3.getS3ObjectRange.mockResolvedValue(webpHeader(256, 256));

    const adopted = await adopt();
    expect(adopted).toMatch(ADOPTED);
    expect(adopted).not.toBe(KEY);
    expect(s3.copyS3Object).toHaveBeenCalledWith(KEY, adopted);
    // Every check reads the copy, which no client holds an upload URL for
    expect(s3.headS3Object).toHaveBeenCalledWith(adopted);
    expect(s3.getS3ObjectRange).toHaveBeenCalledWith(adopted, 0, IMAGE_HEADER_PROBE_BYTES - 1);
    expect(s3.headS3Object).not.toHaveBeenCalledWith(KEY);
    expect(s3.deleteFromS3).toHaveBeenCalledTimes(1);
    expect(s3.deleteFromS3).toHaveBeenCalledWith(KEY);
  });

  it('copies BEFORE reading anything, so bytes swapped into the upload later change nothing', async () => {
    const order: string[] = [];
    s3.copyS3Object.mockImplementation(async () => { order.push('copy'); return true; });
    s3.headS3Object.mockImplementation(async () => { order.push('head'); return { size: 20_000, contentType: 'image/webp' }; });
    s3.getS3ObjectRange.mockImplementation(async () => { order.push('range'); return webpHeader(256, 256); });

    await adopt();
    expect(order).toEqual(['copy', 'head', 'range']);
  });

  it('gives each adoption its own key', async () => {
    s3.headS3Object.mockResolvedValue({ size: 20_000, contentType: 'image/webp' });
    s3.getS3ObjectRange.mockResolvedValue(webpHeader(256, 256));
    const a = await adopt();
    const b = await adopt();
    expect(a).not.toBe(b);
  });

  it.each([
    ['a simple lossy WebP (VP8, the opaque-canvas encoding)', webpLossyHeader(256, 256)],
    ['a lossless WebP (VP8L)', webpLosslessHeader(256, 256)],
    ['an extended WebP (VP8X)', webpHeader(256, 256)],
    ['a PNG (the canvas fallback on a webview without a WebP encoder)', pngHeader(256, 256)],
    ['a VP8 WebP at exactly the largest edge', webpLossyHeader(LIMITS.MAX_IMAGE_ASSET_EDGE, LIMITS.MAX_IMAGE_ASSET_EDGE)],
    ['a VP8L WebP at exactly the largest edge', webpLosslessHeader(LIMITS.MAX_IMAGE_ASSET_EDGE, LIMITS.MAX_IMAGE_ASSET_EDGE)],
  ])('accepts %s read through the real probe range', async (_label, header) => {
    serveObject(header);

    await expect(adopt()).resolves.toMatch(ADOPTED);
    expect(s3.deleteFromS3).toHaveBeenCalledTimes(1);
    expect(s3.deleteFromS3).toHaveBeenCalledWith(KEY);
  });

  it('probes at least the 30 bytes a lossy WebP header needs', () => {
    expect(IMAGE_HEADER_PROBE_BYTES).toBeGreaterThanOrEqual(30);
  });

  it('accepts exactly the cap and the largest edge', async () => {
    s3.headS3Object.mockResolvedValue({ size: MAX, contentType: 'image/webp' });
    s3.getS3ObjectRange.mockResolvedValue(webpHeader(LIMITS.MAX_IMAGE_ASSET_EDGE, LIMITS.MAX_IMAGE_ASSET_EDGE));

    await expect(adopt()).resolves.toMatch(ADOPTED);
  });

  it.each([
    ['a VP8 WebP over the edge cap', webpLossyHeader(LIMITS.MAX_IMAGE_ASSET_EDGE + 1, 256)],
    ['a VP8L WebP over the edge cap', webpLosslessHeader(256, LIMITS.MAX_IMAGE_ASSET_EDGE + 1)],
    ['a VP8 WebP without the keyframe start code', webpLossyHeader(256, 256, [0x00, 0x00, 0x00])],
    ['a VP8L WebP without its signature byte', webpLosslessHeader(256, 256, 0x00)],
    ['a VP8 WebP truncated before its dimensions', webpLossyHeader(256, 256).subarray(0, 28)],
    ['bytes that are not an image', Buffer.from('<html><script>alert(1)</script></html>'.padEnd(64, ' '))],
    ['a JPEG', jpegHeader()],
    ['a truncated WebP header', webpHeader(256, 256).subarray(0, 20)],
    ['an empty range', Buffer.alloc(0)],
    ['a WebP declaring dimensions over the edge cap', webpHeader(LIMITS.MAX_IMAGE_ASSET_EDGE + 1, 256)],
    ['a PNG declaring dimensions over the edge cap', pngHeader(256, 100_000)],
    ['a PNG declaring a zero dimension', pngHeader(0, 256)],
  ])('refuses and deletes %s (upload and copy)', async (_label, header) => {
    s3.headS3Object.mockResolvedValue({ size: 1000, contentType: 'image/webp' });
    s3.getS3ObjectRange.mockResolvedValue(header);

    await expect(adopt()).rejects.toThrow('Invalid avatar key');
    expectBothDeleted();
  });

  it('refuses and deletes an object over the cap without reading its bytes', async () => {
    s3.headS3Object.mockResolvedValue({ size: MAX + 1, contentType: 'image/webp' });

    await expect(adopt()).rejects.toThrow(new BadRequestError('Invalid avatar key'));
    expect(s3.getS3ObjectRange).not.toHaveBeenCalled();
    expectBothDeleted();
  });

  it('refuses and deletes an empty object', async () => {
    s3.headS3Object.mockResolvedValue({ size: 0, contentType: 'image/webp' });

    await expect(adopt()).rejects.toThrow('Invalid avatar key');
    expectBothDeleted();
  });

  it('refuses a key with no stored object, copying and deleting nothing', async () => {
    s3.copyS3Object.mockResolvedValue(false);

    await expect(adopt(KEY, 'Invalid icon key')).rejects.toThrow('Invalid icon key');
    expect(s3.headS3Object).not.toHaveBeenCalled();
    expect(s3.deleteFromS3).not.toHaveBeenCalled();
  });

  it('refuses when the copy cannot be read back', async () => {
    s3.headS3Object.mockResolvedValue({ size: 100, contentType: 'image/webp' });
    s3.getS3ObjectRange.mockResolvedValue(null);

    await expect(adopt()).rejects.toThrow('Invalid avatar key');
    expectBothDeleted();
  });

  it('rethrows a store failure on the copy (fail closed), deleting nothing', async () => {
    s3.copyS3Object.mockRejectedValue(new Error('timeout'));

    await expect(adopt()).rejects.toThrow('timeout');
    expect(s3.deleteFromS3).not.toHaveBeenCalled();
  });

  it('still adopts when deleting the original upload fails (logged)', async () => {
    s3.headS3Object.mockResolvedValue({ size: 20_000, contentType: 'image/webp' });
    s3.getS3ObjectRange.mockResolvedValue(webpHeader(256, 256));
    s3.deleteFromS3.mockRejectedValueOnce(new Error('denied'));

    await expect(adopt()).resolves.toMatch(ADOPTED);
    expect(console.warn).toHaveBeenCalled();
  });
});
