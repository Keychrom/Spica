import { Router, Request, Response } from 'express';
import { db, UserRow, PostRow } from '../db.js';
import { config } from '../config.js';
import { getInstanceInfo } from '../db.js';

/**
 * 発見性（ディスカバリー）まわりのエンドポイント
 *
 *   - RSS 2.0 フィード: /users/:username/feed.xml（ユーザー別）, /feed.xml（ローカル公開タイムライン）
 *   - oEmbed: /api/oembed?url=<投稿URL>（他サイトへ Spica の投稿を埋め込むための情報）
 *
 * いずれも公開範囲が 'public' のローカル投稿のみを対象にする。
 */

export const discoveryRouter = Router();

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 本文をプレーンテキストへ（HTMLタグ除去） */
function toPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function postUrl(postId: string): string {
  return `${config.origin}/?post=${encodeURIComponent(postId)}`;
}

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  guid: string;
}

function buildRssXml(params: {
  title: string;
  link: string;
  description: string;
  selfPath: string;
  items: RssItem[];
}): string {
  const items = params.items
    .map(
      (item) => `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="true">${escapeXml(item.guid)}</guid>
      <pubDate>${new Date(item.pubDate).toUTCString()}</pubDate>
      <description>${escapeXml(item.description)}</description>
    </item>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(params.title)}</title>
    <link>${escapeXml(params.link)}</link>
    <description>${escapeXml(params.description)}</description>
    <language>ja</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(`${config.origin}${params.selfPath}`)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;
}

function sendRss(res: Response, xml: string): void {
  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(xml);
}

/** ローカル公開投稿を RSS アイテムに変換する */
function buildItemsFromPosts(posts: PostRow[], authorName: string): RssItem[] {
  return posts.map((post) => {
    const text = toPlainText(post.content || '');
    const firstLine = text.split('\n')[0].slice(0, 120) || (post.cw ? `(${post.cw})` : '(本文なし)');
    return {
      title: firstLine,
      link: postUrl(post.id),
      description: post.cw ? `[${post.cw}] ${text}` : text,
      pubDate: post.published_at,
      guid: post.id,
    };
  });
}

// ユーザー別フィード
discoveryRouter.get('/users/:username/feed.xml', (req: Request, res: Response) => {
  const username = req.params.username as string;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(username) as unknown as UserRow | undefined;
  if (!user) {
    return res.status(404).send('Not Found');
  }

  const posts = db.prepare(`
    SELECT * FROM posts
    WHERE user_id = ? AND is_local = 1 AND (visibility = 'public' OR visibility IS NULL)
    ORDER BY published_at DESC LIMIT 20
  `).all(user.id) as unknown as PostRow[];

  const info = getInstanceInfo();
  const actorUrl = `${config.origin}/users/${user.id}`;
  const xml = buildRssXml({
    title: `${user.name} (@${user.id}@${config.domain})`,
    link: actorUrl,
    description: user.summary || `${config.instanceName} のユーザー @${user.id} の投稿フィード`,
    selfPath: `/users/${user.id}/feed.xml`,
    items: buildItemsFromPosts(posts, user.name),
  });
  void info;

  console.log(`[Feed] 📡 ${actorUrl}/feed.xml を配信 (${posts.length} 件)`);
  sendRss(res, xml);
});

// ローカル公開タイムラインのフィード
discoveryRouter.get('/feed.xml', (_req: Request, res: Response) => {
  const posts = db.prepare(`
    SELECT * FROM posts
    WHERE is_local = 1 AND (visibility = 'public' OR visibility IS NULL)
    ORDER BY published_at DESC LIMIT 30
  `).all() as unknown as PostRow[];

  const info = getInstanceInfo();
  const xml = buildRssXml({
    title: `${config.instanceName} (${config.domain})`,
    link: config.origin,
    description: `${config.instanceName} のローカル公開タイムライン`,
    selfPath: '/feed.xml',
    items: buildItemsFromPosts(posts, config.instanceName),
  });
  void info;

  console.log(`[Feed] 📡 ${config.origin}/feed.xml を配信 (${posts.length} 件)`);
  sendRss(res, xml);
});

// oEmbed（他サイトへ投稿を埋め込むための情報）
discoveryRouter.get('/api/oembed', (req: Request, res: Response) => {
  const rawUrl = String(req.query.url || '');
  if (!rawUrl) {
    return res.status(400).json({ error: 'url パラメータが必要です。' });
  }

  const postId = decodeURIComponent(rawUrl.split('?post=')[1] || '');
  const post = postId
    ? (db.prepare('SELECT * FROM posts WHERE id = ?').get(postId) as unknown as PostRow | undefined)
    : undefined;

  if (!post || post.is_local !== 1 || (post.visibility && post.visibility !== 'public')) {
    return res.status(404).json({ error: '投稿が見つかりません。' });
  }

  const text = toPlainText(post.content || '');
  const width = 550;

  res.json({
    version: '1.0',
    type: 'rich',
    provider_name: config.instanceName,
    provider_url: config.origin,
    title: post.author_name ? `${post.author_name} のノート` : 'ノート',
    author_name: post.author_name,
    author_url: post.author_url,
    html: `<blockquote class="spica-embed"><p>${escapeXml(text.slice(0, 500))}</p>&mdash; ${escapeXml(post.author_name || '')} (@${escapeXml(post.author_handle || '')}) <a href="${escapeXml(postUrl(post.id))}">${escapeXml(postUrl(post.id))}</a></blockquote>`,
    width,
  });
});
