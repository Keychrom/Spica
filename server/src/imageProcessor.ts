/**
 * アップロードされた画像のメタデータ除去と WebP 変換
 *
 * - JPEG / PNG / WebP / AVIF など: EXIF（撮影日時・位置情報などの個人情報）を除去し、
 *   長辺を上限内に収めて WebP に変換する（回線とディスク容量の節約）
 * - GIF / SVG: アニメーション・ベクター形式のため変換せずそのまま保存する
 * - アニメーション WebP: コマ全体が失われるため変換しない
 * - sharp が読み込めない環境や変換失敗時: 元のデータをそのまま保存する（アップロードを止めない）
 */
const SKIP_MIMETYPES = new Set(['image/gif', 'image/svg+xml']);

// 長辺の上限（これより大きい画像のみ縮小し、小さい画像は拡大しない）
const MAX_DIMENSION = 2560;
const WEBP_QUALITY = 82;

type SharpModule = typeof import('sharp').default;

let sharpRef: SharpModule | null | undefined;
let sharpLoadAttempted = false;

async function loadSharp(): Promise<SharpModule | null> {
  if (!sharpLoadAttempted) {
    sharpLoadAttempted = true;
    try {
      const mod = await import('sharp');
      sharpRef = mod.default;
    } catch (err) {
      console.warn(
        '[Image] sharp を読み込めなかったため、画像は変換せず保存します:',
        (err as Error).message,
      );
      sharpRef = null;
    }
  }
  return sharpRef ?? null;
}

/**
 * 画像を WebP に変換する。変換しない場合は null を返す（呼び出し側は元データを使う）
 */
export async function convertImageToWebp(
  buffer: Buffer,
  mimetype: string,
): Promise<{ buffer: Buffer; size: number } | null> {
  if (SKIP_MIMETYPES.has(mimetype)) {
    return null;
  }

  const sharp = await loadSharp();
  if (!sharp) {
    return null;
  }

  try {
    // アニメーション画像は1コマ目だけになるため対象外
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    if (meta.pages && meta.pages > 1) {
      return null;
    }

    // rotate(): EXIF の向きを画素に反映する。出力にメタデータを引き継がない限り
    // EXIF（位置情報などを含む）は保存されない
    const converted = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();

    console.log(
      `[Image] 🖼️ メタデータ除去 + WebP 変換: ${buffer.length} -> ${converted.length} bytes (${mimetype}${meta.width}x${meta.height})`,
    );
    return { buffer: converted, size: converted.length };
  } catch (err) {
    console.warn('[Image] 画像変換に失敗したため元のデータを保存します:', (err as Error).message);
    return null;
  }
}
