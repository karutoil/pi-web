import { IMAGE_MAX_DIM, IMAGE_QUALITY } from "./constants";
export async function compressImage(blob: Blob, maxDim = IMAGE_MAX_DIM, quality = IMAGE_QUALITY): Promise<Blob> {
  const img = new Image();
  const url = URL.createObjectURL(blob);
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
  URL.revokeObjectURL(url);

  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);

  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error('canvas.toBlob returned null')), 'image/jpeg', quality);
  });
}
