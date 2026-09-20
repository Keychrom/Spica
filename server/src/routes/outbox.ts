import { Router, Request, Response } from 'express';
import { db, UserRow, PostRow } from '../db.js';
import { config } from '../config.js';
import { ACTIVITY_CONTENT_TYPE, ACTIVITYSTREAMS_CONTEXT, buildNote, buildCreateActivity } from '../activitypub.js';
import { applyPageHeaders, cursorPredicate, encodeCursor, parsePageQuery } from '../pagination.js';

export const outboxRouter = Router();

/**
 * Outbox (OrderedCollection / OrderedCollectionPage)
 *
 * リモートサーバー（Mastodon / Misskey 等）は `first` の URL を取得し、
 * 以降は `next` を辿って過去のノートを遡ります。そのため
 *   - totalItems は「実際の公開ノート総数」
 *   - first は先頭ページの URL
 *   - 続きがある場合は next を返す
 * という形にします（以前は first === last の単一ページで、総数も1ページ分のみでした）。
 */
outboxRouter.get('/:username/outbox', (req: Request, res: Response) => {
  const username = req.params.username as string;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(username) as unknown as UserRow | undefined;

  if (!user) {
    return res.status(404).json({ error: 'ユーザーが見つかりません。' });
  }

  const actorUrl = `${config.origin}/users/${user.id}`;
  const outboxUrl = `${actorUrl}/outbox`;

  const isPage = req.query.page === 'true' || req.query.page === '1';

  // グローバル公開 (public) の自ノード投稿のみを ActivityPub outbox に掲載
  const publicFilter = `user_id = ? AND is_local = 1 AND (visibility = 'public' OR visibility IS NULL)`;

  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM posts WHERE ${publicFilter}`).get(user.id) as { c: number };
  const totalItems = totalRow?.c ?? 0;

  // ルート（コレクション）は常に先頭ページを返し、ページ取得時のみカーソルを尊重する
  const page = parsePageQuery(req, 20, 50);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }
  const cursor = isPage ? page.cursor : null;

  const cursorCond = cursor ? ` AND ${cursorPredicate('published_at', 'id')}` : '';
  const cursorParams = cursor ? [cursor.at, cursor.at, cursor.id] : [];

  const posts = db.prepare(`
    SELECT * FROM posts
    WHERE ${publicFilter}${cursorCond}
    ORDER BY published_at DESC, id DESC
    LIMIT ?
  `).all(user.id, ...cursorParams, page.limit + 1) as unknown as PostRow[];

  const pagePosts = applyPageHeaders(res, posts, page.limit, 'published_at', 'id');
  const hasMore = posts.length > page.limit;
  const lastPost = pagePosts[pagePosts.length - 1];

  const activities = pagePosts.map((post) => {
    const note = buildNote({
      id: post.id,
      authorUrl: post.author_url,
      content: post.content,
      publishedAt: post.published_at,
      inReplyTo: post.in_reply_to,
      summary: post.cw || null,
      sensitive: Number(post.is_sensitive) === 1,
      attachments: (() => {
        try {
          const parsed = typeof post.media_attachments === 'string' ? JSON.parse(post.media_attachments || '[]') : post.media_attachments;
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })(),
    });
    return buildCreateActivity({
      note,
      actorUrl,
    });
  });

  // 次ページ URL はページサイズ（limit）も引き継ぐ。引き継がないと、
  // クローラが指定した件数と実際の件数が食い違う。
  const nextUrl = hasMore && lastPost
    ? `${outboxUrl}?page=true&limit=${page.limit}&cursor=${encodeURIComponent(encodeCursor(lastPost.published_at, lastPost.id))}`
    : null;

  res.setHeader('Content-Type', `${ACTIVITY_CONTENT_TYPE}; charset=utf-8`);

  if (isPage) {
    // OrderedCollectionPage (リモートサーバーが first URL から辿って取得する形式)
    const pageId = cursor
      ? `${outboxUrl}?page=true&cursor=${encodeURIComponent(encodeCursor(cursor.at, cursor.id))}`
      : `${outboxUrl}?page=true`;

    return res.json({
      '@context': ACTIVITYSTREAMS_CONTEXT,
      id: pageId,
      type: 'OrderedCollectionPage',
      partOf: outboxUrl,
      totalItems,
      orderedItems: activities,
      ...(nextUrl ? { next: nextUrl } : {}),
    });
  }

  // OrderedCollection ルート（先頭ページの内容を同梱しつつ、first から辿れるようにする）
  res.json({
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: outboxUrl,
    type: 'OrderedCollection',
    totalItems,
    first: `${outboxUrl}?page=true`,
    orderedItems: activities,
    ...(nextUrl ? { next: nextUrl } : {}),
  });
});
