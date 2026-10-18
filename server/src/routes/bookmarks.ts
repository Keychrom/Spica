/**
 * 🔖 ブックマーク (Bookmarks) エンドポイント
 *
 * api.ts から切り出したルーター。マウント位置（api.ts）は元の登録順と同じ。
 */
import { asyncHandler } from '../asyncHandler.js';
import { Router, Request, Response } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { collectVisiblePage, cursorPredicate, parsePageQuery } from '../pagination.js';
import { canViewPost } from '../postVisibility.js';
import { requireAuth } from '../auth.js';
import { enrichAndFilterPosts } from '../postEnrichment.js';

const router = Router();

// ==========================================
// 🔖 ブックマーク (Bookmarks) エンドポイント
// ==========================================

// ブックマークトグルの共通ロジック。投稿の解決と閲覧権限の確認もここで行う
//   - 追加: 閲覧できない投稿（フォロワー限定・他人宛の DM）は 403
//   - 解除: 自分の行を消すだけなので、見えなくなった投稿でも許可する
async function toggleBookmarkPost(
  userId: string,
  targetPostId: string,
  viewerActorUrl: string,
): Promise<
  | { success: true; bookmarked: boolean; postId: string }
  | { success: false; error: 'not_found' | 'forbidden' }
> {
  let cleanPostId = targetPostId.trim();

  // posts テーブルから該当投稿を照合（DM の宛先判定に recipients も必要）
  type TargetRow = { id: string; author_url: string | null; visibility: string | null; recipients: string | null };
  const selectTarget = 'SELECT id, author_url, visibility, recipients FROM posts WHERE id = ?';
  let post = await db.prepare(selectTarget).get(cleanPostId) as TargetRow | undefined;
  if (!post && cleanPostId.includes('%')) {
    try {
      const decoded = decodeURIComponent(cleanPostId);
      post = await db.prepare(selectTarget).get(decoded) as TargetRow | undefined;
      if (post) cleanPostId = decoded;
    } catch {}
  }

  if (!post) {
    return { success: false, error: 'not_found' };
  }

  const existing = await db.prepare('SELECT 1 FROM bookmarks WHERE user_id = ? AND post_id = ?').get(userId, cleanPostId);
  if (existing) {
    await db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND post_id = ?').run(userId, cleanPostId);
    return { success: true, bookmarked: false, postId: cleanPostId };
  }

  // 閲覧できない投稿はブックマークできない。recipients を渡すので、
  // DM は送信者だけでなく**宛先**も通る（以前は recipients を取っておらず宛先が 403 になっていた）
  if (!(await canViewPost(post, viewerActorUrl))) {
    return { success: false, error: 'forbidden' };
  }

  const now = new Date().toISOString();
  await db.prepare('INSERT INTO bookmarks (user_id, post_id, created_at) VALUES (?, ?, ?)').run(userId, cleanPostId, now);
  return { success: true, bookmarked: true, postId: cleanPostId };
}

// 🔖 投稿のブックマーク追加 / 解除 (トグル - 推奨: Request Body)
/** ブックマーク（Misskey の favorite）。Misskey 互換 API からも同じ関数を呼ぶ */
export const handleToggleBookmark = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const postId = String(req.body?.postId || req.query?.postId || '').trim();

  if (!postId) {
    return res.status(400).json({ error: 'postId は必須です。' });
  }

  try {
    const result = await toggleBookmarkPost(user.id, postId, `${config.origin}/users/${user.id}`);
    if (!result.success) {
      if (result.error === 'not_found') {
        return res.status(404).json({ error: '投稿が見つかりません。' });
      }
      return res.status(403).json({ error: 'この投稿はブックマークできません。' });
    }
    res.json(result);
  } catch (err: any) {
    console.error('[Bookmark Error]:', err);
    res.status(500).json({ error: 'ブックマーク処理に失敗しました。' });
  }
});
router.post('/bookmarks/toggle', requireAuth, handleToggleBookmark);

// 🔖 投稿のブックマーク追加 / 解除 (後方互換: パスパラメータ)
//    推奨の /bookmarks/toggle と同じく、閲覧できない投稿は追加できない
router.post('/posts/:id/bookmark', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const rawPostId = req.params.id as string;

  try {
    const result = await toggleBookmarkPost(user.id, rawPostId, `${config.origin}/users/${user.id}`);
    if (!result.success) {
      if (result.error === 'not_found') {
        return res.status(404).json({ error: '投稿が見つかりません。' });
      }
      return res.status(403).json({ error: 'この投稿はブックマークできません。' });
    }
    res.json(result);
  } catch (err: any) {
    console.error('[Bookmark Error]:', err);
    res.status(500).json({ error: 'ブックマーク処理に失敗しました。' });
  }
}));

// ブックマーク一覧取得
export const handleListBookmarks = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const page = parsePageQuery(req, 50);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }
  try {
    const currentActorUrl = `${config.origin}/users/${user.id}`;
    const { items: enriched, nextCursor } = await collectVisiblePage({
      limit: page.limit,
      cursor: page.cursor,
      fetchRows: async (cursor, n) => {
        const cursorCondRun = cursor ? ` AND ${cursorPredicate('b.created_at', 'p.id')}` : '';
        const cursorParamsRun = cursor ? [cursor.at, cursor.at, cursor.id] : [];
        const query = `
          SELECT
            p.*,
            p.id AS post_id,
            COALESCE(NULLIF(p.author_icon, ''), NULLIF(u.icon_url, ''), NULLIF(ra.icon_url, ''), '') AS author_icon,
            b.created_at AS timeline_at
          FROM bookmarks b
          JOIN posts p ON b.post_id = p.id
          LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
          LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
          WHERE b.user_id = ? AND COALESCE(p.visibility, 'public') != 'direct'${cursorCondRun}
          ORDER BY b.created_at DESC, p.id DESC
          LIMIT ?
        `;
        return await db.prepare(query).all(user.id, ...cursorParamsRun, n) as any[];
      },
      filterRows: (rows) => enrichAndFilterPosts(rows, currentActorUrl, user.id),
      sortKey: 'timeline_at',
      idKey: 'post_id',
    });
    if (nextCursor) {
      res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor');
      res.setHeader('X-Next-Cursor', nextCursor);
    }
    res.json(enriched);
  } catch (err: any) {
    console.error('[Get Bookmarks Error]:', err);
    res.status(500).json({ error: 'ブックマーク一覧の取得に失敗しました。' });
  }
});
router.get('/bookmarks', requireAuth, handleListBookmarks);


export default router;
