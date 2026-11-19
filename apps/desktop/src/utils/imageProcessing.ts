import { ANNOTATION_IMAGE_MAX_EDGE, ANNOTATION_IMAGE_DATAURL_MAX } from '@voxium/shared';

const TARGET_SIZE = 256;
const WEBP_QUALITY = 0.85;
const JPEG_QUALITY = 0.85;

/**
 * The content type an avatar / space-icon PUT must carry, whatever the bytes
 * are: the presigned URL is signed for `image/webp` (the server's presign
 * routes sign the content-type header), so another value is refused by the
 * store with a signature error. The server reads the real format from the
 * bytes (a WebP or PNG header, `adoptImageAssetUpload`), never from this.
 */
export const ASSET_UPLOAD_CONTENT_TYPE = 'image/webp';

/** A canvas could not produce an image; the reason is in the message (and was logged). */
export class ImageEncodeError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = 'ImageEncodeError';
  }
}

type DrawContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function fail(reason: string, cause?: unknown): never {
  console.error(`[ImageProcessing] ${reason}`, cause ?? '');
  throw new ImageEncodeError(reason, cause === undefined ? undefined : { cause });
}

/**
 * Draw an image at `width` x `height` and encode it: the ONE place that
 * creates a canvas for image processing. Uses `OffscreenCanvas` when the
 * engine has it and an `HTMLCanvasElement` otherwise, asks for `type`, and
 * returns the blob the engine produced. The caller MUST read `blob.type`:
 * an engine that cannot encode `type` answers PNG (canvas spec) and the bytes
 * are not what was asked for. Throws `ImageEncodeError` (logged) when there
 * is no 2D context or the encoder answers null or throws. An OffscreenCanvas
 * with no 2D context, or without `convertToBlob`, falls back to the HTML canvas.
 */
export async function encodeCanvasImage(
  width: number,
  height: number,
  draw: (ctx: DrawContext) => void,
  type: string,
  quality?: number,
): Promise<Blob> {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    // An engine can ship the constructor without a usable 2D surface (older
    // WebKit: WebGL only) or without convertToBlob: the HTML canvas below
    // is then tried, and the action fails only when that fails too.
    if (ctx && typeof canvas.convertToBlob === 'function') {
      draw(ctx);
      let blob: Blob | null;
      try {
        blob = await canvas.convertToBlob({ type, quality });
      } catch (err) {
        fail('OffscreenCanvas.convertToBlob failed', err);
      }
      if (!blob) fail('OffscreenCanvas.convertToBlob answered no image');
      return blob;
    }
    console.warn('[ImageProcessing] OffscreenCanvas cannot draw or encode here, using an HTML canvas');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) fail('The canvas has no 2D context');
  draw(ctx);
  let blob: Blob | null;
  try {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  } catch (err) {
    fail('canvas.toBlob failed', err);
  }
  if (!blob) fail('canvas.toBlob answered no image');
  return blob;
}

/**
 * Resize an image file to 256x256 using the Canvas API (cover fit, center
 * crop; replicates the server-side sharp behavior). WebP is asked for; an
 * engine without a WebP encoder answers PNG, and the PNG is returned as it
 * is: the caller sends `blob.size` bytes (the server accepts a WebP or PNG
 * header under the `.webp` key). Any other type is refused. An animated
 * source is drawn as its first frame only (createImageBitmap), as before.
 */
export async function processImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = bitmap;

    // Cover-fit center crop: scale so the smaller dimension fills TARGET_SIZE,
    // then crop the excess from the larger dimension.
    const scale = Math.max(TARGET_SIZE / width, TARGET_SIZE / height);
    const scaledW = width * scale;
    const scaledH = height * scale;
    const offsetX = (TARGET_SIZE - scaledW) / 2;
    const offsetY = (TARGET_SIZE - scaledH) / 2;

    const blob = await encodeCanvasImage(
      TARGET_SIZE,
      TARGET_SIZE,
      (ctx) => ctx.drawImage(bitmap, offsetX, offsetY, scaledW, scaledH),
      'image/webp',
      WEBP_QUALITY,
    );
    if (blob.type !== 'image/webp' && blob.type !== 'image/png') {
      fail(`The encoder answered ${blob.type || 'no type'}, not WebP or PNG`);
    }
    return blob;
  } finally {
    bitmap.close();
  }
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('overlay image read failed'));
    reader.readAsDataURL(blob);
  });
}

/** Types the server accepts in an overlay data URL (IMAGE_DATAURL_RE). */
const OVERLAY_TYPES = new Set(['image/webp', 'image/png', 'image/jpeg']);

/**
 * Prepare a screen-share overlay image (logo/promo): contain-fit resize to
 * ANNOTATION_IMAGE_MAX_EDGE (no crop), returned as a data URL that fits the
 * annotation wire cap. The data URL carries the type the engine really
 * produced. When the engine could not encode WebP and its PNG is over the
 * cap, the image is encoded once more as JPEG (accepted by the server,
 * transparency becomes white) before giving up. Returns null when no
 * accepted format fits (caller toasts); throws for decode and encode failures.
 */
export async function processOverlayImage(file: File): Promise<{ dataUrl: string; width: number; height: number } | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, ANNOTATION_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const blob = await encodeCanvasImage(w, h, (ctx) => ctx.drawImage(bitmap, 0, 0, w, h), 'image/webp', WEBP_QUALITY);
    if (!OVERLAY_TYPES.has(blob.type)) fail(`The encoder answered ${blob.type || 'no type'}, not WebP, PNG or JPEG`);
    const dataUrl = await readAsDataUrl(blob);
    if (dataUrl.length <= ANNOTATION_IMAGE_DATAURL_MAX) return { dataUrl, width: w, height: h };

    // WebP over the cap is a genuinely big image; only a fallback format
    // (PNG) can fit in another one.
    if (blob.type === 'image/webp') return null;

    const jpeg = await encodeCanvasImage(
      w,
      h,
      (ctx) => {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bitmap, 0, 0, w, h);
      },
      'image/jpeg',
      JPEG_QUALITY,
    );
    if (jpeg.type !== 'image/jpeg') return null;
    const jpegUrl = await readAsDataUrl(jpeg);
    return jpegUrl.length <= ANNOTATION_IMAGE_DATAURL_MAX ? { dataUrl: jpegUrl, width: w, height: h } : null;
  } finally {
    bitmap.close();
  }
}
