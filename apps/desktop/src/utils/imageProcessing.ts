import { ANNOTATION_IMAGE_MAX_EDGE, ANNOTATION_IMAGE_DATAURL_MAX } from '@voxium/shared';

const TARGET_SIZE = 256;
const WEBP_QUALITY = 0.85;

/**
 * Resize and convert an image file to 256x256 WebP using the Canvas API.
 * Replicates server-side sharp behavior: cover fit, center crop.
 */
export async function processImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);

  const { width, height } = bitmap;

  // Cover-fit center crop: scale so the smaller dimension fills TARGET_SIZE,
  // then crop the excess from the larger dimension.
  const scale = Math.max(TARGET_SIZE / width, TARGET_SIZE / height);
  const scaledW = width * scale;
  const scaledH = height * scale;
  const offsetX = (TARGET_SIZE - scaledW) / 2;
  const offsetY = (TARGET_SIZE - scaledH) / 2;

  const canvas = new OffscreenCanvas(TARGET_SIZE, TARGET_SIZE);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, offsetX, offsetY, scaledW, scaledH);
  bitmap.close();

  return canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY });
}

/**
 * Prepare a screen-share overlay image (logo/promo): contain-fit resize to
 * ANNOTATION_IMAGE_MAX_EDGE (no crop), webp, returned as a data URL that fits
 * the annotation wire cap. Returns null when the encoded image is still too
 * large (caller toasts) — never throws for size, only for decode failures.
 */
export async function processOverlayImage(file: File): Promise<{ dataUrl: string; width: number; height: number } | null> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, ANNOTATION_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY });
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('overlay image read failed'));
    reader.readAsDataURL(blob);
  });

  if (dataUrl.length > ANNOTATION_IMAGE_DATAURL_MAX) return null;
  return { dataUrl, width: w, height: h };
}
