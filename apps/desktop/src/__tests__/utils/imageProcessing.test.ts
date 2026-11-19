import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ANNOTATION_IMAGE_DATAURL_MAX } from '@voxium/shared';
import {
  encodeCanvasImage,
  processImage,
  processOverlayImage,
  ImageEncodeError,
  ASSET_UPLOAD_CONTENT_TYPE,
} from '../../utils/imageProcessing';

// jsdom has no canvas: each engine shape is faked with the minimum the code
// touches. What no fake can show (real WebKit's encoder answers, real pixels)
// is listed in the pull request.

type Encoder = (type: string, quality?: number) => Promise<Blob | null> | Blob | null;

const ctx = () => ({ drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '' });
let contexts: ReturnType<typeof ctx>[];
let asked: { type: string; quality?: number }[];
let sizes: [number, number][];

/** OffscreenCanvas present; `encode` answers each convertToBlob. */
function stubOffscreen(encode: Encoder, hasContext = true, hasConvert = true) {
  class FakeOffscreen {
    convertToBlob?: (opts: { type: string; quality?: number }) => Promise<Blob | null>;
    constructor(public width: number, public height: number) {
      sizes.push([width, height]);
      if (hasConvert) {
        this.convertToBlob = async (opts) => {
          asked.push(opts);
          return encode(opts.type, opts.quality);
        };
      }
    }
    getContext() {
      if (!hasContext) return null;
      const c = ctx();
      contexts.push(c);
      return c;
    }
  }
  vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
}

/** OffscreenCanvas absent; an HTMLCanvasElement encodes through toBlob. */
function stubHtmlCanvas(encode: Encoder, hasContext = true) {
  vi.stubGlobal('OffscreenCanvas', undefined);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => {
    if (!hasContext) return null;
    const c = ctx();
    contexts.push(c);
    return c;
  }) as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(((cb: BlobCallback, type?: string, quality?: number) => {
    asked.push({ type: type as string, quality });
    Promise.resolve(encode(type as string, quality)).then(cb, () => cb(null));
  }) as never);
}

const blobOf = (type: string, size = 100) => new Blob([new Uint8Array(size)], { type });
const webp = () => blobOf('image/webp');
const png = () => blobOf('image/png');

const bitmapClose = vi.fn();
function stubBitmap(width = 800, height = 400) {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width, height, close: bitmapClose })));
}
const file = new File([new Uint8Array(10)], 'x.png', { type: 'image/png' });

beforeEach(() => {
  contexts = [];
  asked = [];
  sizes = [];
  bitmapClose.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('encodeCanvasImage — the engine shapes', () => {
  it('uses OffscreenCanvas when present and returns a WebP as is', async () => {
    stubOffscreen(webp);
    const blob = await encodeCanvasImage(10, 10, (c) => c.drawImage(null as never, 0, 0), 'image/webp', 0.5);
    expect(blob.type).toBe('image/webp');
    expect(asked).toEqual([{ type: 'image/webp', quality: 0.5 }]);
    expect(contexts[0].drawImage).toHaveBeenCalled();
  });

  it('returns the PNG an OffscreenCanvas answers instead of WebP, with its real type', async () => {
    stubOffscreen(png);
    const blob = await encodeCanvasImage(10, 10, () => {}, 'image/webp');
    expect(blob.type).toBe('image/png');
  });

  it('falls back to an HTMLCanvasElement when OffscreenCanvas is absent', async () => {
    stubHtmlCanvas(webp);
    const blob = await encodeCanvasImage(32, 16, (c) => c.drawImage(null as never, 0, 0), 'image/webp', 0.7);
    expect(blob.type).toBe('image/webp');
    expect(asked).toEqual([{ type: 'image/webp', quality: 0.7 }]);
    expect(contexts[0].drawImage).toHaveBeenCalled();
  });

  it('returns the PNG an HTMLCanvasElement answers instead of WebP', async () => {
    stubHtmlCanvas(png);
    expect((await encodeCanvasImage(10, 10, () => {}, 'image/webp')).type).toBe('image/png');
  });

  it('sizes the HTML canvas it creates', async () => {
    stubHtmlCanvas(webp);
    const create = vi.spyOn(document, 'createElement');
    await encodeCanvasImage(32, 16, () => {}, 'image/webp');
    const canvas = create.mock.results.map((r) => r.value).find((el) => el instanceof HTMLCanvasElement) as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([32, 16]);
  });

  it.each([
    ['OffscreenCanvas has no 2D context and neither has the HTML canvas', () => { stubHtmlCanvas(webp, false); stubOffscreen(webp, false); }],
    ['OffscreenCanvas has no convertToBlob and the HTML canvas has no 2D context', () => { stubHtmlCanvas(webp, false); stubOffscreen(webp, true, false); }],
    ['the HTML canvas has no 2D context', () => stubHtmlCanvas(webp, false)],
    ['convertToBlob answers null', () => stubOffscreen(() => null)],
    ['toBlob answers null', () => stubHtmlCanvas(() => null)],
    ['convertToBlob throws', () => stubOffscreen(() => { throw new Error('encoder exploded'); })],
    ['toBlob throws', () => {
      stubHtmlCanvas(webp);
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((() => { throw new Error('encoder exploded'); }) as never);
    }],
  ])('fails with an ImageEncodeError, logged, when %s', async (_name, setup) => {
    setup();
    await expect(encodeCanvasImage(10, 10, () => {}, 'image/webp')).rejects.toBeInstanceOf(ImageEncodeError);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[ImageProcessing]'), expect.anything());
  });

  it('falls back to the HTML canvas when OffscreenCanvas has no 2D context', async () => {
    stubHtmlCanvas(webp);
    stubOffscreen(png, false);
    const blob = await encodeCanvasImage(10, 10, (c) => c.drawImage(null as never, 0, 0), 'image/webp');
    expect(blob.type).toBe('image/webp');
    expect(contexts).toHaveLength(1);
    expect(contexts[0].drawImage).toHaveBeenCalled();
  });

  it('falls back to the HTML canvas when OffscreenCanvas has no convertToBlob', async () => {
    stubHtmlCanvas(webp);
    stubOffscreen(png, true, false);
    const blob = await encodeCanvasImage(10, 10, () => {}, 'image/webp');
    expect(blob.type).toBe('image/webp');
    expect(asked).toEqual([{ type: 'image/webp', quality: undefined }]);
  });

  it('does not fall back when the Offscreen encoder itself answers null', async () => {
    stubHtmlCanvas(webp);
    stubOffscreen(() => null);
    await expect(encodeCanvasImage(10, 10, () => {}, 'image/webp')).rejects.toBeInstanceOf(ImageEncodeError);
  });

  it('does not draw when there is no context', async () => {
    stubHtmlCanvas(webp, false);
    stubOffscreen(webp, false);
    const draw = vi.fn();
    await expect(encodeCanvasImage(10, 10, draw, 'image/webp')).rejects.toBeInstanceOf(ImageEncodeError);
    expect(draw).not.toHaveBeenCalled();
  });
});

describe('processImage', () => {
  it('draws a cover-fit 256x256 and returns the WebP', async () => {
    stubBitmap(800, 400);
    stubOffscreen(webp);
    const blob = await processImage(file);
    expect(blob.type).toBe('image/webp');
    // scale 256/400 = 0.64: 512x256 drawn at x = -128
    expect(contexts[0].drawImage).toHaveBeenCalledWith(expect.anything(), -128, 0, 512, 256);
    expect(asked[0].type).toBe('image/webp');
    expect(bitmapClose).toHaveBeenCalled();
  });

  it('returns the PNG as it is when the engine cannot encode WebP', async () => {
    stubBitmap();
    stubOffscreen(png);
    expect((await processImage(file)).type).toBe('image/png');
  });

  it('works without OffscreenCanvas', async () => {
    stubBitmap();
    stubHtmlCanvas(webp);
    expect((await processImage(file)).type).toBe('image/webp');
  });

  it('refuses a type that is neither WebP nor PNG', async () => {
    stubBitmap();
    stubOffscreen(() => blobOf('image/gif'));
    await expect(processImage(file)).rejects.toBeInstanceOf(ImageEncodeError);
  });

  it('refuses a blob with no type', async () => {
    stubBitmap();
    stubOffscreen(() => blobOf(''));
    await expect(processImage(file)).rejects.toBeInstanceOf(ImageEncodeError);
  });

  it('closes the bitmap when encoding fails', async () => {
    stubBitmap();
    stubOffscreen(() => null);
    await expect(processImage(file)).rejects.toBeInstanceOf(ImageEncodeError);
    expect(bitmapClose).toHaveBeenCalled();
  });

  it('labels presigned PUTs with the type the presign signs', () => {
    expect(ASSET_UPLOAD_CONTENT_TYPE).toBe('image/webp');
  });
});

describe('processOverlayImage', () => {
  it('returns a WebP data URL that fits', async () => {
    stubBitmap(1024, 512);
    stubOffscreen(webp);
    const out = await processOverlayImage(file);
    expect(out?.dataUrl.startsWith('data:image/webp;base64,')).toBe(true);
    expect([out?.width, out?.height]).toEqual([512, 256]);
  });

  it('returns a PNG data URL carrying the PNG type when it fits', async () => {
    stubBitmap();
    stubOffscreen(png);
    const out = await processOverlayImage(file);
    expect(out?.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('works without OffscreenCanvas', async () => {
    stubBitmap();
    stubHtmlCanvas(webp);
    expect((await processOverlayImage(file))?.dataUrl.startsWith('data:image/webp')).toBe(true);
  });

  it('returns null for a WebP over the cap and tries nothing else', async () => {
    stubBitmap();
    stubOffscreen(() => blobOf('image/webp', ANNOTATION_IMAGE_DATAURL_MAX));
    expect(await processOverlayImage(file)).toBeNull();
    expect(asked.map((a) => a.type)).toEqual(['image/webp']);
  });

  it('re-encodes a PNG over the cap as JPEG on white and returns it when it fits', async () => {
    stubBitmap();
    stubOffscreen((type) => (type === 'image/jpeg' ? blobOf('image/jpeg', 1000) : blobOf('image/png', ANNOTATION_IMAGE_DATAURL_MAX)));
    const out = await processOverlayImage(file);
    expect(out?.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(asked.map((a) => a.type)).toEqual(['image/webp', 'image/jpeg']);
    expect(contexts[1].fillRect).toHaveBeenCalledWith(0, 0, 512, 256);
    // Same size and same placement as the first attempt
    expect(sizes).toEqual([[512, 256], [512, 256]]);
    expect(contexts[0].drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 512, 256);
    expect(contexts[1].drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 512, 256);
  });

  it('returns null when the JPEG is over the cap too', async () => {
    stubBitmap();
    stubOffscreen((type) => blobOf(type === 'image/jpeg' ? 'image/jpeg' : 'image/png', ANNOTATION_IMAGE_DATAURL_MAX));
    expect(await processOverlayImage(file)).toBeNull();
  });

  it('returns null when the engine answers a non-JPEG for the JPEG request', async () => {
    stubBitmap();
    stubOffscreen((type) => blobOf('image/png', type === 'image/jpeg' ? 1000 : ANNOTATION_IMAGE_DATAURL_MAX));
    expect(await processOverlayImage(file)).toBeNull();
  });

  it('throws on a type the server does not accept', async () => {
    stubBitmap();
    stubOffscreen(() => blobOf('image/gif'));
    await expect(processOverlayImage(file)).rejects.toBeInstanceOf(ImageEncodeError);
  });

  it('throws when no canvas can encode', async () => {
    stubBitmap();
    stubHtmlCanvas(() => null);
    await expect(processOverlayImage(file)).rejects.toBeInstanceOf(ImageEncodeError);
    expect(bitmapClose).toHaveBeenCalled();
  });
});
