import { Router, Request, Response } from 'express';
import { db, UserRow, PostRow } from '../db.js';
import { config } from '../config.js';
import { ACTIVITY_CONTENT_TYPE, ACTIVITYSTREAMS_CONTEXT, buildNote, buildCreateActivity } from '../activitypub.js';

export const outboxRouter = Router();

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
  const posts = db.prepare(`
    SELECT * FROM posts
    WHERE user_id = ? AND is_local = 1 AND (visibility = 'public' OR visibility IS NULL)
    ORDER BY published_at DESC LIMIT 50
  `).all(user.id) as unknown as PostRow[];

  const activities = posts.map((post) => {
    const note = buildNote({
      id: post.id,
      authorUrl: post.author_url,
      content: post.content,
      publishedAt: post.published_at,
      inReplyTo: post.in_reply_to,
    });
    return buildCreateActivity({
      note,
      actorUrl,
    });
  });

  res.setHeader('Content-Type', `${ACTIVITY_CONTENT_TYPE}; charset=utf-8`);

  if (isPage) {
    // OrderedCollectionPage (Misskey / Mastodon が first URL を辿って取得する形式)
    return res.json({
      '@context': ACTIVITYSTREAMS_CONTEXT,
      id: `${outboxUrl}?page=true`,
      type: 'OrderedCollectionPage',
      partOf: outboxUrl,
      totalItems: activities.length,
      orderedItems: activities,
    });
  }

  // OrderedCollection ルート
  const collection = {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: outboxUrl,
    type: 'OrderedCollection',
    totalItems: activities.length,
    first: `${outboxUrl}?page=true`,
    last: `${outboxUrl}?page=true`,
    orderedItems: activities,
  };

  res.json(collection);
});
