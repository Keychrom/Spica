/**
 * 📢 チャンネル (Channels) エンドポイント
 *
 * api.ts から切り出したルーター。マウント位置（api.ts）は元の登録順と同じ。
 */
import { asyncHandler } from '../asyncHandler.js';
import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { db, ChannelRow } from '../db.js';
import { config } from '../config.js';
import { collectVisiblePage, cursorPredicate, parsePageQuery } from '../pagination.js';
import { requireAuth } from '../auth.js';
import { enrichAndFilterPosts } from '../postEnrichment.js';

const router = Router();

// ==========================================
// 📢 チャンネル (Channels) エンドポイント
// ==========================================

// チャンネル一覧取得
router.get('/channels', asyncHandler(async (req: Request, res: Response) => {
  const category = (req.query.category as string || '').trim();
  const sort = req.query.sort === 'newest' ? 'newest' : 'popular';
  const myUserId = req.user?.id || null;

  let whereClause = 'WHERE is_archived = 0';
  const params: any[] = [];
  if (category) {
    whereClause += ' AND category = ?';
    params.push(category);
  }

  const orderBy = sort === 'newest' ? 'created_at DESC' : 'followers_count DESC, posts_count DESC, created_at DESC';

  const rows = await db.prepare(`
    SELECT c.*,
      CASE WHEN CAST(? AS TEXT) IS NOT NULL AND EXISTS(
        SELECT 1 FROM channel_follows cf WHERE cf.channel_id = c.id AND cf.user_id = ?
      ) THEN 1 ELSE 0 END AS is_following
    FROM channels c
    ${whereClause}
    ORDER BY ${orderBy}
  `).all(myUserId, myUserId, ...params) as unknown as (ChannelRow & { is_following: number })[];

  const channels = rows.map((c) => ({
    ...c,
    is_following: Boolean(c.is_following),
    is_archived: Boolean(c.is_archived),
  }));

  res.json(channels);
}));

// チャンネル新規作成 (要認証)
router.post('/channels', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const { name, description, banner_url, color, category } = req.body;

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName || trimmedName.length > 50) {
    return res.status(400).json({ error: 'チャンネル名は1〜50文字で入力してください。' });
  }

  const channelId = crypto.randomUUID();
  const now = new Date().toISOString();
  const desc = typeof description === 'string' ? description.trim() : '';
  const banner = typeof banner_url === 'string' ? banner_url.trim() : '';
  const col = typeof color === 'string' && color.trim() ? color.trim() : '#6366f1';
  const cat = typeof category === 'string' && category.trim() ? category.trim() : 'general';

  await db.prepare(`
    INSERT INTO channels (id, user_id, name, description, banner_url, color, category, posts_count, followers_count, is_archived, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 0, ?)
  `).run(channelId, user.id, trimmedName, desc, banner, col, cat, now);

  // 作成者を初期フォロワーとして登録
  await db.prepare(`
    INSERT OR IGNORE INTO channel_follows (channel_id, user_id, created_at)
    VALUES (?, ?, ?)
  `).run(channelId, user.id, now);

  res.status(201).json({
    id: channelId,
    user_id: user.id,
    name: trimmedName,
    description: desc,
    banner_url: banner,
    color: col,
    category: cat,
    posts_count: 0,
    followers_count: 1,
    is_archived: false,
    is_following: true,
    created_at: now,
  });
}));

// チャンネル詳細取得
router.get('/channels/:id', asyncHandler(async (req: Request, res: Response) => {
  const chId = String(req.params.id);
  const myUserId = req.user?.id || null;

  const row = await db.prepare(`
    SELECT c.*,
      CASE WHEN CAST(? AS TEXT) IS NOT NULL AND EXISTS(
        SELECT 1 FROM channel_follows cf WHERE cf.channel_id = c.id AND cf.user_id = ?
      ) THEN 1 ELSE 0 END AS is_following
    FROM channels c
    WHERE c.id = ?
  `).get(myUserId, myUserId, chId) as unknown as (ChannelRow & { is_following: number }) | undefined;

  if (!row) {
    return res.status(404).json({ error: 'チャンネルが見つかりません。' });
  }

  res.json({
    ...row,
    is_following: Boolean(row.is_following),
    is_archived: Boolean(row.is_archived),
  });
}));

// チャンネル編集 (要認証・作成者または管理者)
router.put('/channels/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const chId = String(req.params.id);

  const existing = await db.prepare('SELECT * FROM channels WHERE id = ?').get(chId) as ChannelRow | undefined;
  if (!existing) {
    return res.status(404).json({ error: 'チャンネルが見つかりません。' });
  }

  if (existing.user_id !== user.id && user.role !== 'admin') {
    return res.status(403).json({ error: 'このチャンネルを編集する権限がありません。' });
  }

  const { name, description, banner_url, color, category, is_archived } = req.body;
  const newName = typeof name === 'string' && name.trim() ? name.trim() : existing.name;
  const newDesc = typeof description === 'string' ? description.trim() : existing.description;
  const newBanner = typeof banner_url === 'string' ? banner_url.trim() : existing.banner_url;
  const newColor = typeof color === 'string' && color.trim() ? color.trim() : (existing.color || '#6366f1');
  const newCat = typeof category === 'string' && category.trim() ? category.trim() : (existing.category || 'general');
  const newArchived = typeof is_archived === 'boolean' ? (is_archived ? 1 : 0) : existing.is_archived;

  await db.prepare(`
    UPDATE channels
    SET name = ?, description = ?, banner_url = ?, color = ?, category = ?, is_archived = ?
    WHERE id = ?
  `).run(newName, newDesc, newBanner, newColor, newCat, newArchived, chId);

  res.json({
    ...existing,
    name: newName,
    description: newDesc,
    banner_url: newBanner,
    color: newColor,
    category: newCat,
    is_archived: Boolean(newArchived),
  });
}));

// チャンネル参加 / 解除トグル (要認証)
router.post('/channels/:id/follow', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const chId = String(req.params.id);

  const channel = await db.prepare('SELECT * FROM channels WHERE id = ?').get(chId) as ChannelRow | undefined;
  if (!channel) {
    return res.status(404).json({ error: 'チャンネルが見つかりません。' });
  }

  const existingFollow = await db.prepare('SELECT 1 FROM channel_follows WHERE channel_id = ? AND user_id = ?').get(chId, user.id);

  if (existingFollow) {
    // 解除
    await db.prepare('DELETE FROM channel_follows WHERE channel_id = ? AND user_id = ?').run(chId, user.id);
    await db.prepare('UPDATE channels SET followers_count = MAX(0, followers_count - 1) WHERE id = ?').run(chId);
    return res.json({ following: false, message: 'チャンネルの参加を解除しました。' });
  } else {
    // 参加
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO channel_follows (channel_id, user_id, created_at) VALUES (?, ?, ?)').run(chId, user.id, now);
    await db.prepare('UPDATE channels SET followers_count = followers_count + 1 WHERE id = ?').run(chId);
    return res.json({ following: true, message: 'チャンネルに参加しました！' });
  }
}));

// チャンネル内タイムライン取得
router.get('/channels/:id/timeline', asyncHandler(async (req: Request, res: Response) => {
  const chId = String(req.params.id);
  const page = parsePageQuery(req, 50);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }
  const channel = await db.prepare('SELECT * FROM channels WHERE id = ?').get(chId) as ChannelRow | undefined;
  if (!channel) {
    return res.status(404).json({ error: 'チャンネルが見つかりません。' });
  }

  const currentActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;
  const { items: enriched, nextCursor } = await collectVisiblePage({
    limit: page.limit,
    cursor: page.cursor,
    fetchRows: async (cursor, n) => {
      const cursorCondRun = cursor ? ` AND ${cursorPredicate('p.published_at', 'p.id')}` : '';
      const cursorParamsRun = cursor ? [cursor.at, cursor.at, cursor.id] : [];
      return await db.prepare(`
        SELECT 
          p.id AS post_id,
          p.user_id,
          p.author_name,
          p.author_url,
          p.author_handle,
          p.content,
          p.cw,
          p.is_local,
          p.visibility,
          p.emojis,p.in_reply_to,
          p.quote_id,
          p.is_sensitive,
          p.media_attachments,
          p.published_at,
          p.edited_at,
          p.channel_id,
          COALESCE(
            NULLIF(p.author_icon, ''),
            NULLIF(u.icon_url, ''),
            NULLIF(ra.icon_url, ''),
            ''
          ) AS author_icon,
          NULL AS announce_id,
          NULL AS renoted_by_name,
          NULL AS renoted_by_handle,
          NULL AS renoted_by_icon,
          NULL AS renoted_by_url,
          p.published_at AS timeline_at
        FROM posts p
        LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
        LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
        WHERE p.channel_id = ? AND COALESCE(p.visibility, 'public') != 'direct'${cursorCondRun}
        ORDER BY p.published_at DESC, p.id DESC
        LIMIT ?
      `).all(chId, ...cursorParamsRun, n) as any[];
    },
    filterRows: (rows) => enrichAndFilterPosts(rows, currentActorUrl, req.user?.id),
    sortKey: 'timeline_at',
    idKey: 'post_id',
  });
  if (nextCursor) {
    res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor');
    res.setHeader('X-Next-Cursor', nextCursor);
  }

  res.json({
    channel: {
      ...channel,
      is_archived: Boolean(channel.is_archived),
    },
    posts: enriched,
  });
}));



export default router;
