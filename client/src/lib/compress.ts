/**
 * 添付の画像を、上げる前にブラウザで小さくする（Canvas で長辺 2048px・WebP 85%）。
 * 設定「画像を自動で軽くする」が入っているときだけ使う。
 * GIF（動きが止まる）と SVG（劣化する）と画像以外は触らない。
 */
const MAX_DIMENSION = 2048;
const QUALITY = 0.85;
/** これ以下で、そもそも大きすぎない画像はそのまま上げる */
const SKIP_BELOW_BYTES = 600 * 1024;

export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') {
    return file;
  }
  if (typeof createImageBitmap !== 'function') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, MAX_DIMENSION / longest);
    if (scale === 1 && file.size <= SKIP_BELOW_BYTES) {
      bitmap.close?.();
      return file;
    }
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close?.();
      return file;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', QUALITY));
    // 小さくならなかったら元のまま（画質だけ落ちて損をする）
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, '') + '.webp';
    return new File([blob], name, { type: 'image/webp', lastModified: file.lastModified });
  } catch {
    return file;
  }
}
