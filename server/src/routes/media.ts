/**
 * メディアアップロードとドライブ。
 *
 * api.ts から切り出したルーター。マウント位置（api.ts）は元の登録順と同じ。
 */
import { asyncHandler } from '../asyncHandler.js';
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { applyPageHeaders, parsePageQuery } from '../pagination.js';
import { uploadMediaFile } from '../storage.js';
import {
  checkMediaQuota,
  deleteMedia,
  getMediaStats,
  listMedia,
  recordMedia,
  toClientMedia,
} from '../mediaService.js';
import { MAX_POST_ATTACHMENTS } from '../postService.js';
import { requireAuth } from '../auth.js';

const router = Router();

// メディアアップロード用 multer 設定 (メモリバッファ保存)
//  - 画像: 最大 15MB / 動画・音声: MEDIA_MAX_BYTES (既定 50MB)
//  - 種別ごとの上限と件数制限はハンドラ側で判定する
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const MEDIA_MAX_BYTES = (() => {
  const parsed = parseInt(process.env.MEDIA_MAX_BYTES || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50 * 1024 * 1024;
})();
const ALLOWED_MEDIA_PREFIXES = ['image/', 'video/', 'audio/'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MEDIA_MAX_BYTES,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MEDIA_PREFIXES.some((prefix) => file.mimetype.startsWith(prefix))) {
      cb(null, true);
    } else {
      cb(new Error('対応していないファイル形式です。画像（JPEG/PNG/GIF/WebP/SVG）、動画（MP4/WebM/MOV）、音声（MP3/OGG/WAV/M4A）を選択してください。'));
    }
  },
});

// ==========================================
// メディアアップロード (S3 / Cloudflare R2 / ローカル)
// ==========================================

/**
 * アップロードされたファイルを保存し、ドライブの台帳に記録する（応答は書かない）。
 * 通常の API（`/api/media/upload`）と **Misskey 互換 API（`drive/files/create`）**の
 * 両方から呼ぶ（容量上限・台帳・サムネイルの扱いを二重実装しないため）。
 */
export async function saveUploadedMediaFiles(
  userId: string,
  files: Express.Multer.File[] | undefined,
): Promise<{ ok: true; mediaRows: any[] } | { ok: false; status: number; error: string }> {
  if (!files || files.length === 0) {
    return { ok: false, status: 400, error: 'アップロードするメディアファイルを選択してください。' };
  }
  if (files.length > MAX_POST_ATTACHMENTS) {
    return { ok: false, status: 400, error: `一度にアップロードできるファイルは最大${MAX_POST_ATTACHMENTS}件までです。` };
  }

  // 動画・音声はサイズが大きいため1件までに制限する
  const avFiles = files.filter((f) => f.mimetype.startsWith('video/') || f.mimetype.startsWith('audio/'));
  if (avFiles.length > 1) {
    return { ok: false, status: 400, error: '動画・音声は1件まで添付できます。' };
  }

  // 画像は従来どおり 15MB まで
  const oversizedImage = files.find((f) => f.mimetype.startsWith('image/') && f.size > IMAGE_MAX_BYTES);
  if (oversizedImage) {
    return { ok: false, status: 400, error: '画像サイズが大きすぎます (最大15MBまで)。' };
  }

  try {
    // ドライブの容量上限（MEDIA_QUOTA_MB。0 なら無制限）
    const incomingBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
    const quota = await checkMediaQuota(userId, incomingBytes);
    if (!quota.ok) {
      return { ok: false, status: 413, error: quota.error || 'ドライブの容量上限を超えています。' };
    }

    const uploaded = await Promise.all(
      files.map((file) =>
        uploadMediaFile({
          buffer: file.buffer,
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          userId,
        })
      )
    );

    // ドライブの台帳に記録する（投稿に添付されなくても一覧・削除できるようにする）
    const mediaRows = await Promise.all(
      uploaded.map(async (item) =>
        toClientMedia(await recordMedia({
          userId,
          url: item.url,
          key: item.key,
          mediaType: item.mediaType,
          size: item.size,
          name: item.name,
          thumbnailUrl: item.thumbnailUrl,
          thumbnailKey: item.thumbnailKey,
          width: item.width,
          height: item.height,
          duration: item.duration,
        }))
      )
    );

    return { ok: true, mediaRows };
  } catch (err: any) {
    console.error('[Media Upload Error]:', err);
    return { ok: false, status: 500, error: err.message || 'メディアのアップロードに失敗しました。' };
  }
}

/** multer のミドルウェア（Misskey 互換 API のドライブもこれを使う） */
export const mediaUploadMiddleware = (req: Request, res: Response, next: NextFunction) => {
  upload.any()(req, res, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: `ファイルサイズが大きすぎます (上限 ${Math.floor(MEDIA_MAX_BYTES / (1024 * 1024))}MB)。` });
        }
        return res.status(400).json({ error: `アップロードエラー: ${err.message}` });
      }
      return res.status(400).json({ error: err.message || 'アップロード処理中にエラーが発生しました。' });
    }
    next();
  });
};

// メディアアップロード (画像 最大4枚 / 動画・音声 は1件まで)
router.post(
  '/media/upload',
  requireAuth,
  mediaUploadMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.rawUser!;
    const files = (req.files as Express.Multer.File[]) || (req.file ? [req.file] : []);
    const result = await saveUploadedMediaFiles(user.id, files);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json({
      success: true,
      media: result.mediaRows,
      attachment: result.mediaRows[0], // 1ファイルアップロード時の互換性
    });
  })
);

// ==========================================
// 🗂️ ドライブ（自分のアップロード管理）
// ==========================================

// 自分のメディア一覧（使用量つき・新しい順）
router.get('/drive', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const page = parsePageQuery(req, 40);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }
  try {
    const items = await listMedia({ userId: user.id, limit: page.limit + 1, cursor: page.cursor });
    const pageRows = applyPageHeaders(res, items, page.limit, 'created_at', 'id');
    res.json({
      items: pageRows.map(toClientMedia),
      stats: await getMediaStats(user.id),
    });
  } catch (err: any) {
    console.error('[API Drive Error]:', err);
    res.status(500).json({ error: err.message || 'ドライブの取得に失敗しました。' });
  }
}));

// 使用量のみ（軽量）
router.get('/drive/stats', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  res.json(await getMediaStats(req.rawUser!.id));
}));

// メディアの削除（投稿で使用中のものは拒否）
router.delete('/drive/:id', requireAuth, async (req: Request, res: Response) => {
  const user = req.rawUser!;
  try {
    const mediaId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await deleteMedia(user.id, mediaId);
    if (!result.ok) {
      return res.status(result.inUse ? 409 : 404).json({ error: result.error, inUse: Boolean(result.inUse) });
    }
    console.log(`[Drive] 🗑️ @${user.id} がメディアを削除しました: ${mediaId}`);
    res.json({ success: true, stats: await getMediaStats(user.id) });
  } catch (err: any) {
    console.error('[API Drive Delete Error]:', err);
    res.status(500).json({ error: err.message || 'メディアの削除に失敗しました。' });
  }
});


export default router;
