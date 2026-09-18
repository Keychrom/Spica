import { Router, Request, Response } from 'express';
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

// Actor (Person) エンドポイント
usersRouter.get('/:username', (req: Request, res: Response) => {
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

  // ローカル限定投稿の場合は外部 ActivityPub 解決を拒絶
  if (post.visibility === 'local') {
    return res.status(403).json({ error: 'この投稿はローカル限定のため外部には公開されていません。' });
  }

  const note = buildNote({
    id: post.id,
    authorUrl: post.author_url,
    content: post.content,
    publishedAt: post.published_at,
    inReplyTo: post.in_reply_to,
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

  if (post.visibility === 'local') {
    return res.status(403).json({ error: 'この投稿はローカル限定です。' });
  }

  const actorUrl = `${config.origin}/users/${username}`;
  const note = buildNote({
    id: post.id,
    authorUrl: post.author_url,
    content: post.content,
    publishedAt: post.published_at,
    inReplyTo: post.in_reply_to,
  });

  const createActivity = buildCreateActivity({
    note,
    actorUrl,
  });

  res.setHeader('Content-Type', `${ACTIVITY_CONTENT_TYPE}; charset=utf-8`);
  res.json(createActivity);
});
