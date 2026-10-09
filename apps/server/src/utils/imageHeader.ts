/**
 * Header-only image dimension extraction for PNG / JPEG / WebP buffers.
 *
 * Annotation overlay images arrive as byte-length-capped data URLs, but byte
 * size says nothing about DECODED size: a few-KB "image bomb" can declare a
 * gigantic pixel grid and hang or crash every viewer that decodes it. The
 * dimensions live in the container header, so we read them WITHOUT decoding
 * and reject oversized (or unparseable — fail closed) images before fan-out.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

function pngDimensions(buf: Buffer): ImageDimensions | null {
  // 8-byte signature, then IHDR must be the first chunk: 4 len + 'IHDR' + w + h
  if (buf.length < 24) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegDimensions(buf: Buffer): ImageDimensions | null {
  // Walk marker segments until a Start-Of-Frame; every segment is
  // length-prefixed, so the scan is linear and strictly bounded.
  let i = 2;
  for (let guard = 0; guard < 256 && i + 9 < buf.length; guard++) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; } // fill byte
    // Standalone markers with no length field
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
    // SOF0-15 except DHT(C4)/JPG(C8)/DAC(CC) carry the frame dimensions
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen < 2) return null;
    i += 2 + segLen;
  }
  return null;
}

function webpDimensions(buf: Buffer): ImageDimensions | null {
  // RIFF <size> WEBP, then the first chunk decides the flavor
  if (buf.length < 30) return null;
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // Lossy: keyframe start code 9D 01 2A, then 14-bit dimensions
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (chunk === 'VP8X') {
    return {
      width: 1 + buf.readUIntLE(24, 3),
      height: 1 + buf.readUIntLE(27, 3),
    };
  }
  return null;
}

/**
 * Parse the pixel dimensions out of a PNG/JPEG/WebP buffer's header.
 * Returns null for anything malformed or unrecognized — callers must treat
 * null as a REJECTION (fail closed), never as "probably fine".
 */
export function imageDimensions(buf: Buffer): ImageDimensions | null {
  try {
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return pngDimensions(buf);
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      return jpegDimensions(buf);
    }
    if (buf.length >= 16 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
      return webpDimensions(buf);
    }
    return null;
  } catch (err) {
    console.warn('[ImageHeader] Dimension parse failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
