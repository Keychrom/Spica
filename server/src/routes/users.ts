import { Router, Request, Response, NextFunction } from 'express';
import { db, UserRow, FollowRow, PostRow } from '../db.js';
import { config } from '../config.js';
import {
  buildPerson,
  buildNote,
  buildCreateActivity,
  ACTIVITY_CONTENT_TYPE,
  ACTIVITYSTREAMS_CONTEXT,
} from '../activitypub.js';

export const usersRouter = Router();

/** 投稿の media_attachments（JSON文字列）を ActivityPub 用の配列に変換する */
function parseMediaAttachments(raw: unknown): { url: string; mediaType?: string; name?: string }[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Actor (Person) エンドポイント
usersRouter.get('/:username', (req: Request, res: Response, next: NextFunction) => {
  // ブラウザからのHTML要求（text/html）は SPA / OGP ハンドラに委ねる
  // （Mastodon 等と同様に、Accept で HTML と ActivityPub JSON を切り替える）
  const accept = String(req.headers.accept || '');
  if (accept.includes('text/html')) {
    return next();
  }

  const username = req.params.username as string;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(username) as unknown as UserRow | undefined;

  if (!user) {
    return res.status(404).json({ error: 'ユーザーが見つかりません。' });
  }

  const person = buildPerson(user);
  res.setHeader('Content-Type', `${ACTIVITY_CONTENT_TYPE}; charset=utf-8`);
  res.json(person);
});

// Followers Collection エンドポイント
usersRouter.get('/:username/followers', (req: Request, res: Response) => {
  const username = req.params.username as string;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(username) as unknown as UserRow | undefined;

  if (!user) {
    return res.status(404).json({ error: 'ユーザーが見つかりません。' });
  }

  const myActorUrl = `${config.origin}/users/${user.id}`;
  const followers = db.prepare(`
    SELECT follower_url FROM follows WHERE following_url = ? AND status = 'accepted'
  `).all(myActorUrl) as unknown as { follower_url: string }[];

  const collection = {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: `${myActorUrl}/followers`,
    type: 'OrderedCollection',
    totalItems: followers.length,
    orderedItems: followers.map((f) => f.follower_url),
  };

  res.setHeader('Content-Type', `${ACTIVITY_CONTENT_TYPE}; charset=utf-8`);
  res.json(collection);
});

// Following Collection エンドポイント
usersRouter.get('/:username/following', (req: Request, res: Response) => {
  const username = req.params.username as string;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(username) as unknown as UserRow | undefined;

  if (!user) {
    return res.status(404).json({ error: 'ユーザーが見つかりません。' });
  }

  const myActorUrl = `${config.origin}/users/${user.id}`;
  const following = db.prepare(`
    SELECT following_url FROM follows WHERE follower_url = ? AND status = 'accepted'
  `).all(myActorUrl) as unknown as { following_url: string }[];

  const collection = {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: `${myActorUrl}/following`,
    type: 'OrderedCollection',
    totalItems: following.length,
    orderedItems: following.map((f) => f.following_url),
  };

  res.setHeader('Content-Type', `${ACTIVITY_CONTENT_TYPE}; charset=utf-8`);
  res.json(collection);
});

// Note (投稿) エンドポイント - Misskey / Mastodon からの個別ノート解決用
usersRouter.get('/:username/posts/:postId', (req: Request, res: Response) => {
  const { username, postId } = req.params;
  const canonicalPostId = `${config.origin}/users/${username}/posts/${postId}`;

  // ブラウザからの通常アクセスかつHTML要求の場合はSPAのルーティング等に任せることも可能だが、
  // ActivityPub / API クライアントは application/activity+json や application/ld+json を要求
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(canonicalPostId) as unknown as PostRow | undefined;
  if (!post) {
    return res.status(404).json({ error: '投稿が見つかりません。' });
  }

  // ローカル限定・フォロワー限定投稿の場合は外部 ActivityPub 解決を拒絶
  // （フォロワー限定は配信時にフォロワーへ直接届くため、未認証の解決は許可しない）
  if (post.visibility === 'local' || post.visibility === 'followers') {
    return res.status(403).json({ error: 'この投稿は限定公開のため外部には公開されていません。' });
  }

  const note = buildNote({
    id: post.id,
    authorUrl: post.author_url,
    content: post.content,
    publishedAt: post.published_at,
    inReplyTo: post.in_reply_to,
    summary: post.cw || null,
    sensitive: Number(post.is_sensitive) === 1,
    attachments: parseMediaAttachments(post.media_attachments),
  });

  res.setHeader('Content-Type', `${ACTIVITY_CONTENT_TYPE}; charset=utf-8`);
  res.json(note);
});

// Create Activity エンドポイント
usersRouter.get('/:username/posts/:postId/activity', (req: Request, res: Response) => {
  const { username, postId } = req.params;
  const canonicalPostId = `${config.origin}/users/${username}/posts/${postId}`;

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(canonicalPostId) as unknown as PostRow | undefined;
  if (!post) {
    return res.status(404).json({ error: '投稿が見つかりません。' });
  }

  if (post.visibility === 'local' || post.visibility === 'followers') {
    return res.status(403).json({ error: 'この投稿は限定公開です。' });
  }

  const actorUrl = `${config.origin}/users/${username}`;
  const note = buildNote({
    id: post.id,
    authorUrl: post.author_url,
    content: post.content,
    publishedAt: post.published_at,
    inReplyTo: post.in_reply_to,
    summary: post.cw || null,
    sensitive: Number(post.is_sensitive) === 1,
    attachments: parseMediaAttachments(post.media_attachments),
  });

  const createActivity = buildCreateActivity({
    note,
    actorUrl,
  });

  res.setHeader('Content-Type', `${ACTIVITY_CONTENT_TYPE}; charset=utf-8`);
  res.json(createActivity);
});
