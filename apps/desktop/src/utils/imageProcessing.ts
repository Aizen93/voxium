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
