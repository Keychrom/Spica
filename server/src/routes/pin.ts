/**
 * 📌 プロフィールピン留め (Pinned Posts) エンドポイント
 *
 * api.ts から切り出したルーター。マウント位置（api.ts）は元の登録順と同じ。
 */
import { asyncHandler } from '../asyncHandler.js';
import { Router, Request, Response } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();

// ==========================================
// 📌 プロフィールピン留め (Pinned Posts) エンドポイント
// ==========================================

/** ピン留めを**指定した状態に**する（Misskey 互換の `i/pin` / `i/unpin` から呼ぶ） */
export async function setPinnedPost(
  userId: string,
  targetPostId: string,
  pinned: boolean,
): Promise<{ success: boolean; pinned?: boolean; error?: string; status?: number }> {
  const cleanPostId = targetPostId.trim();
  if (!cleanPostId) {
    return { success: false, status: 400, error: 'postId は必須です。' };
  }
  const post = await db.prepare('SELECT id, user_id, is_local FROM posts WHERE id = ?').get(cleanPostId) as
    | { id: string; user_id: string; is_local: number }
    | undefined;
  if (!post) {
    return { success: false, status: 404, error: '投稿が見つかりません。' };
  }
  if (post.is_local !== 1 || post.user_id !== userId) {
    return { success: false, status: 403, error: '自分の投稿のみプロフィールにピン留めできます。' };
  }

  const existing = await db.prepare('SELECT 1 FROM pinned_posts WHERE user_id = ? AND post_id = ?').get(userId, cleanPostId);
  // SQLite では行が `{ '1': 1 }` で返るので、真偽に直してから比べる
  if (Boolean(existing) === pinned) {
    // 既にその状態（Misskey の i/pin は二重に押されても増やさない）
    return { success: true, pinned };
  }
  if (pinned) {
    const count = (await db.prepare('SELECT COUNT(*) as c FROM pinned_posts WHERE user_id = ?').get(userId) as any).c;
    if (count >= 5) {
      return { success: false, status: 400, error: 'ピン留めできるノートは最大5件までです。' };
    }
    await db.prepare('INSERT INTO pinned_posts (user_id, post_id, created_at) VALUES (?, ?, ?)')
      .run(userId, cleanPostId, new Date().toISOString());
  } else {
    await db.prepare('DELETE FROM pinned_posts WHERE user_id = ? AND post_id = ?').run(userId, cleanPostId);
  }
  return { success: true, pinned };
}

// ピン留めトグルの共通ロジック (最大5件、本人の投稿のみ)
async function togglePinPost(userId: string, targetPostId: string): Promise<{ success: boolean; pinned?: boolean; postId?: string; notFound?: boolean; notAllowed?: boolean; limitReached?: boolean; error?: string }> {
  let cleanPostId = targetPostId.trim();

  // posts テーブルから該当投稿を照合
  let post = await db.prepare('SELECT id, user_id, is_local FROM posts WHERE id = ?').get(cleanPostId) as { id: string; user_id: string; is_local: number } | undefined;
  if (!post && cleanPostId.includes('%')) {
    try {
      const decoded = decodeURIComponent(cleanPostId);
      post = await db.prepare('SELECT id, user_id, is_local FROM posts WHERE id = ?').get(decoded) as { id: string; user_id: string; is_local: number } | undefined;
      if (post) cleanPostId = decoded;
    } catch {}
  }

  if (!post) {
    return { success: false, notFound: true, error: '投稿が見つかりません。' };
  }

  // 自分の投稿のみピン留め可能
  if (post.is_local !== 1 || post.user_id !== userId) {
    return { success: false, notAllowed: true, error: '自分の投稿のみプロフィールにピン留めできます。' };
  }

  const existing = await db.prepare('SELECT 1 FROM pinned_posts WHERE user_id = ? AND post_id = ?').get(userId, cleanPostId);
  if (existing) {
    await db.prepare('DELETE FROM pinned_posts WHERE user_id = ? AND post_id = ?').run(userId, cleanPostId);
    return { success: true, pinned: false, postId: cleanPostId };
  } else {
    // 上限5件チェック
    const count = (await db.prepare('SELECT COUNT(*) as c FROM pinned_posts WHERE user_id = ?').get(userId) as any).c;
    if (count >= 5) {
      return { success: false, limitReached: true, error: 'ピン留めできるノートは最大5件までです。' };
    }
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO pinned_posts (user_id, post_id, created_at) VALUES (?, ?, ?)').run(userId, cleanPostId, now);
    return { success: true, pinned: true, postId: cleanPostId };
  }
}

// 📌 投稿のピン留め追加 / 解除 (トグル - 推奨: Request Body)
router.post('/posts/pin/toggle', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const postId = String(req.body?.postId || req.query?.postId || '').trim();

  if (!postId) {
    return res.status(400).json({ error: 'postId は必須です。' });
  }

  try {
    const result = await togglePinPost(user.id, postId);
    if (result.notFound) {
      return res.status(404).json({ error: result.error });
    }
    if (result.notAllowed) {
      return res.status(403).json({ error: result.error });
    }
    if (result.limitReached) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result);
  } catch (err: any) {
    console.error('[Pin Post Error]:', err);
    res.status(500).json({ error: 'ピン留め処理に失敗しました。' });
  }
}));

// 📌 投稿のピン留め追加 / 解除 (後方互換: パスパラメータ)
router.post('/posts/:id/pin', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const rawPostId = req.params.id as string;
  const postId = decodeURIComponent(rawPostId);

  try {
    const result = await togglePinPost(user.id, postId);
    if (result.notFound) {
      return res.status(404).json({ error: result.error });
    }
    if (result.notAllowed) {
      return res.status(403).json({ error: result.error });
    }
    if (result.limitReached) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result);
  } catch (err: any) {
    console.error('[Pin Post Error]:', err);
    res.status(500).json({ error: 'ピン留め処理に失敗しました。' });
  }
}));


export default router;
