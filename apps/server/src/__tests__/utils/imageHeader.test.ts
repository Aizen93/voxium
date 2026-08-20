import { describe, it, expect } from 'vitest';
import { imageDimensions } from '../../utils/imageHeader';

// ─── Builders: minimal valid container headers ───────────────────────────────

function pngBuffer(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); // IHDR length
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpegBuffer(width: number, height: number, withApp0 = true): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (withApp0) {
    // APP0 segment the scanner must skip over before finding SOF0
    const app0 = Buffer.alloc(2 + 16);
    app0[0] = 0xff; app0[1] = 0xe0;
    app0.writeUInt16BE(16, 2);
    parts.push(app0);
  }
  const sof0 = Buffer.alloc(2 + 10);
  sof0[0] = 0xff; sof0[1] = 0xc0;
  sof0.writeUInt16BE(10, 2);
  sof0[4] = 8; // precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat(parts.concat(sof0));
}

function webpVp8lBuffer(width: number, height: number): Buffer {
  const w = width - 1, h = height - 1;
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8L', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  b[20] = 0x2f;
  b[21] = w & 0xff;
  b[22] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
  b[23] = (h >> 2) & 0xff;
  b[24] = (h >> 10) & 0x0f;
  return b;
}

function webpVp8xBuffer(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

export { webpVp8lBuffer }; // reused by annotationHandler.test.ts

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('imageDimensions', () => {
  it('reads PNG IHDR dimensions', () => {
    expect(imageDimensions(pngBuffer(512, 384))).toEqual({ width: 512, height: 384 });
    expect(imageDimensions(pngBuffer(60_000, 60_000))).toEqual({ width: 60_000, height: 60_000 });
  });

  it('walks JPEG segments to the SOF frame header', () => {
    expect(imageDimensions(jpegBuffer(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(imageDimensions(jpegBuffer(300, 200, false))).toEqual({ width: 300, height: 200 });
  });

  it('reads WebP VP8L (lossless) and VP8X (extended) dimensions', () => {
    expect(imageDimensions(webpVp8lBuffer(512, 512))).toEqual({ width: 512, height: 512 });
    expect(imageDimensions(webpVp8lBuffer(8192, 8192))).toEqual({ width: 8192, height: 8192 });
    expect(imageDimensions(webpVp8xBuffer(4096, 2160))).toEqual({ width: 4096, height: 2160 });
  });

  it('fails CLOSED on malformed or unknown containers', () => {
    expect(imageDimensions(Buffer.from([0x00]))).toBeNull();
    expect(imageDimensions(Buffer.from('GIF89a....', 'latin1'))).toBeNull();
    expect(imageDimensions(Buffer.alloc(0))).toBeNull();
    // PNG signature but no IHDR
    const bad = pngBuffer(10, 10);
    bad.write('XXXX', 12, 'latin1');
    expect(imageDimensions(bad)).toBeNull();
    // JPEG with no SOF before the buffer ends
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]))).toBeNull();
    // RIFF but unknown chunk flavor
    const riff = webpVp8lBuffer(10, 10);
    riff.write('XXXX', 12, 'latin1');
    expect(imageDimensions(riff)).toBeNull();
  });
});
