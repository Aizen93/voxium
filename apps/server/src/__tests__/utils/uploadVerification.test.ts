import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LIMITS } from '@voxium/shared';

const s3 = vi.hoisted(() => ({
  headS3Object: vi.fn(),
  getS3ObjectRange: vi.fn(),
  deleteFromS3: vi.fn(),
}));
vi.mock('../../utils/s3', () => s3);

const prismaMock = vi.hoisted(() => ({
  messageAttachment: { findFirst: vi.fn() },
}));
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

import { verifyAttachmentUploads, verifyImageAssetUpload, IMAGE_HEADER_PROBE_BYTES } from '../../utils/uploadVerification';
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

describe('verifyImageAssetUpload', () => {
  const KEY = 'avatars/user-1-1700000000.webp';
  const MAX = LIMITS.MAX_AVATAR_SIZE;

  it('accepts a small WebP and reads only the header range', async () => {
    s3.headS3Object.mockResolvedValue({ size: 20_000, contentType: 'image/webp' });
    s3.getS3ObjectRange.mockResolvedValue(webpHeader(256, 256));

    await expect(verifyImageAssetUpload(KEY, MAX, 'Invalid avatar key')).resolves.toBeUndefined();
    expect(s3.getS3ObjectRange).toHaveBeenCalledWith(KEY, 0, IMAGE_HEADER_PROBE_BYTES - 1);
    expect(s3.deleteFromS3).not.toHaveBeenCalled();
  });

  it('accepts a PNG (the canvas fallback on a webview without a WebP encoder)', async () => {
    s3.headS3Object.mockResolvedValue({ size: 200_000, contentType: 'image/webp' });
    s3.getS3ObjectRange.mockResolvedValue(pngHeader(256, 256));

    await expect(verifyImageAssetUpload(KEY, MAX, 'Invalid avatar key')).resolves.toBeUndefined();
  });

  it('accepts exactly the cap and the largest edge', async () => {
    s3.headS3Object.mockResolvedValue({ size: MAX, contentType: 'image/webp' });
    s3.getS3ObjectRange.mockResolvedValue(webpHeader(LIMITS.MAX_IMAGE_ASSET_EDGE, LIMITS.MAX_IMAGE_ASSET_EDGE));

    await expect(verifyImageAssetUpload(KEY, MAX, 'Invalid avatar key')).resolves.toBeUndefined();
  });

  it('refuses and deletes an object over the cap without reading its bytes', async () => {
    s3.headS3Object.mockResolvedValue({ size: MAX + 1, contentType: 'image/webp' });

    await expect(verifyImageAssetUpload(KEY, MAX, 'Invalid avatar key')).rejects.toThrow(new BadRequestError('Invalid avatar key'));
    expect(s3.getS3ObjectRange).not.toHaveBeenCalled();
    expect(s3.deleteFromS3).toHaveBeenCalledWith(KEY);
  });

  it('refuses and deletes an empty object', async () => {
    s3.headS3Object.mockResolvedValue({ size: 0, contentType: 'image/webp' });

    await expect(verifyImageAssetUpload(KEY, MAX, 'Invalid avatar key')).rejects.toThrow('Invalid avatar key');
    expect(s3.deleteFromS3).toHaveBeenCalledWith(KEY);
  });

  it('refuses a key with no stored object, deleting nothing', async () => {
    s3.headS3Object.mockResolvedValue(null);

    await expect(verifyImageAssetUpload(KEY, MAX, 'Invalid icon key')).rejects.toThrow('Invalid icon key');
    expect(s3.deleteFromS3).not.toHaveBeenCalled();
  });

  it('refuses when the object vanishes between the head and the range read', async () => {
    s3.headS3Object.mockResolvedValue({ size: 100, contentType: 'image/webp' });
    s3.getS3ObjectRange.mockResolvedValue(null);

    await expect(verifyImageAssetUpload(KEY, MAX, 'Invalid avatar key')).rejects.toThrow('Invalid avatar key');
    expect(s3.deleteFromS3).not.toHaveBeenCalled();
  });

  it.each([
    ['bytes that are not an image', Buffer.from('<html><script>alert(1)</script></html>'.padEnd(64, ' '))],
    ['a JPEG', jpegHeader()],
    ['a truncated WebP header', webpHeader(256, 256).subarray(0, 20)],
    ['an empty range', Buffer.alloc(0)],
  ])('refuses and deletes %s', async (_label, header) => {
    s3.headS3Object.mockResolvedValue({ size: 1000, contentType: 'image/webp' });
    s3.getS3ObjectRange.mockResolvedValue(header);

    await expect(verifyImageAssetUpload(KEY, MAX, 'Invalid avatar key')).rejects.toThrow('Invalid avatar key');
    expect(s3.deleteFromS3).toHaveBeenCalledWith(KEY);
  });

  it.each([
    ['WebP', webpHeader(LIMITS.MAX_IMAGE_ASSET_EDGE + 1, 256)],
    ['PNG', pngHeader(256, 100_000)],
  ])('refuses and deletes a %s declaring dimensions over the edge cap', async (_label, header) => {
    s3.headS3Object.mockResolvedValue({ size: 1000, contentType: 'image/webp' });
    s3.getS3ObjectRange.mockResolvedValue(header);

    await expect(verifyImageAssetUpload(KEY, MAX, 'Invalid avatar key')).rejects.toThrow('Invalid avatar key');
    expect(s3.deleteFromS3).toHaveBeenCalledWith(KEY);
  });

  it('refuses a PNG declaring a zero dimension', async () => {
    s3.headS3Object.mockResolvedValue({ size: 1000, contentType: 'image/webp' });
    s3.getS3ObjectRange.mockResolvedValue(pngHeader(0, 256));

    await expect(verifyImageAssetUpload(KEY, MAX, 'Invalid avatar key')).rejects.toThrow('Invalid avatar key');
  });

  it('rethrows a store failure (fail closed), deleting nothing', async () => {
    s3.headS3Object.mockRejectedValue(new Error('timeout'));

    await expect(verifyImageAssetUpload(KEY, MAX, 'Invalid avatar key')).rejects.toThrow('timeout');
    expect(s3.deleteFromS3).not.toHaveBeenCalled();
  });
});
