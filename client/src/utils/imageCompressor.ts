/**
 * Misskey-like client-side image compression utility
 * ブラウザの Canvas API を使用して、アップロード前に画像を自動リサイズ・WebP圧縮します。
 */

export interface CompressOptions {
  maxDimension?: number; // 最大寸法 (長辺のピクセル数, デフォルト: 2048)
  quality?: number;      // 圧縮品質 (0.0 〜 1.0, デフォルト: 0.85)
  format?: 'image/webp' | 'image/jpeg'; // 出力形式 (デフォルト: 'image/webp')
}

export interface CompressResult {
  file: File;
  compressed: boolean;
  originalSize: number;
  compressedSize: number;
}

/**
 * 画像ファイルを自動リサイズ＆圧縮
 */
export async function compressImage(
  file: File,
  options: CompressOptions = {}
): Promise<CompressResult> {
  const {
    maxDimension = 2048,
    quality = 0.85,
    format = 'image/webp',
  } = options;

  const originalSize = file.size;

  // GIFアニメーション、SVG、非画像ファイルは劣化・アニメ停止を防ぐため圧縮スキップ
  if (
    file.type === 'image/gif' ||
    file.type === 'image/svg+xml' ||
    !file.type.startsWith('image/')
  ) {
    return {
      file,
      compressed: false,
      originalSize,
      compressedSize: originalSize,
    };
  }

  try {
    const bitmap = await loadImage(file);
    let { width, height } = bitmap;

    // 長辺が maxDimension を超える場合はアスペクト比を維持して縮小
    let needResize = false;
    if (width > maxDimension || height > maxDimension) {
      needResize = true;
      if (width > height) {
        height = Math.round((height * maxDimension) / width);
        width = maxDimension;
      } else {
        width = Math.round((width * maxDimension) / height);
        height = maxDimension;
      }
    }

    // オフスクリーンキャンバスまたはDOMキャンバスを生成
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      return { file, compressed: false, originalSize, compressedSize: originalSize };
    }

    // 高品質リサイズのためのスムージング設定
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.drawImage(bitmap, 0, 0, width, height);

    // Blob へ変換 (WebP 優先)
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(
        (b) => resolve(b),
        format,
        quality
      );
    });

    if (!blob) {
      return { file, compressed: false, originalSize, compressedSize: originalSize };
    }

    // 圧縮後のサイズが元画像以上で、かつ解像度縮小も行われていない場合は元ファイルを採用
    if (blob.size >= originalSize && !needResize) {
      return {
        file,
        compressed: false,
        originalSize,
        compressedSize: originalSize,
      };
    }

    // 新しいファイル名・拡張子の設定
    const ext = format === 'image/webp' ? '.webp' : '.jpg';
    const baseName = file.name.replace(/\.[^/.]+$/, '');
    const newFileName = `${baseName}${ext}`;

    const compressedFile = new File([blob], newFileName, {
      type: blob.type || format,
      lastModified: Date.now(),
    });

    return {
      file: compressedFile,
      compressed: true,
      originalSize,
      compressedSize: compressedFile.size,
    };
  } catch (err) {
    console.warn('[ImageCompressor] 圧縮処理をスキップしました (元ファイルを使用):', err);
    return {
      file,
      compressed: false,
      originalSize,
      compressedSize: originalSize,
    };
  }
}

/**
 * File から画像（ImageBitmap または HTMLImageElement）を取得
 */
async function loadImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  // createImageBitmap がサポートされているブラウザでは高速デコード
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // フォールバックへ
    }
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };

    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };

    img.src = url;
  });
}
