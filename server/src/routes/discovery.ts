import { Router, Request, Response } from 'express';
import { asyncHandler } from '../asyncHandler.js';
import { db, UserRow, PostRow, getInstanceInfo } from '../db.js';
import { config } from '../config.js';
import { postPermalink } from '../postLinks.js';

/**
 * 発見性（ディスカバリー）まわりのエンドポイント
 *
 *   - RSS 2.0 フィード: /users/:username/feed.xml（ユーザー別）, /feed.xml（ローカル公開タイムライン）,
 *     /tags/:tag/feed.xml（タグ別）
 *   - oEmbed: /api/oembed?url=<投稿URL>（他サイトへ Spica の投稿を埋め込むための情報）
 *   - robots.txt / sitemap.xml（クローラ向け。SPA のフォールバックが 200 を返すため明示的に捌く）
 *   - /.well-known/security.txt（連絡先。`contact_url` 未設定なら 404）
 *
 *   RSS と oEmbed は公開範囲が 'public' のローカル投稿のみを対象にする。
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
  return postPermalink(postId);
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
discoveryRouter.get('/users/:username/feed.xml', asyncHandler(async (req: Request, res: Response) => {
  const username = req.params.username as string;
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(username) as unknown as UserRow | undefined;
  if (!user) {
    return res.status(404).send('Not Found');
  }

  const posts = await db.prepare(`
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
}));

// ローカル公開タイムラインのフィード
discoveryRouter.get('/feed.xml', asyncHandler(async (_req: Request, res: Response) => {
  const posts = await db.prepare(`
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
}));

// oEmbed（他サイトへ投稿を埋め込むための情報）
discoveryRouter.get('/api/oembed', asyncHandler(async (req: Request, res: Response) => {
  const rawUrl = String(req.query.url || '');
  if (!rawUrl) {
    return res.status(400).json({ error: 'url パラメータが必要です。' });
  }

  const post = await findPublicPostFromUrl(rawUrl);
  if (!post) {
    return res.status(404).json({ error: '投稿が見つかりません。' });
  }

  const text = toPlainText(post.content || '');
  const width = 550;
  const link = postPermalink(post.id);

  res.json({
    version: '1.0',
    type: 'rich',
    provider_name: config.instanceName,
    provider_url: config.origin,
    title: post.author_name ? `${post.author_name} のノート` : 'ノート',
    author_name: post.author_name,
    author_url: post.author_url,
    html: `<blockquote class="spica-embed"><p>${escapeXml(text.slice(0, 500))}</p>&mdash; ${escapeXml(post.author_name || '')} (@${escapeXml(post.author_handle || '')}) <a href="${escapeXml(link)}">${escapeXml(link)}</a></blockquote>`,
    width,
  });
}));

/**
 * 投稿 URL（共有 URL）から公開投稿を解決する。
 *
 * 受け付ける形は 3 つ:
 *   - `/users/<user>/posts/<id>` … ローカル投稿の正規 URL（＝共有 URL）
 *   - `/?post=<正規 ID>`        … リモート投稿を含む汎用の形
 *   - 正規 ID そのもの（ActivityPub の id）
 * いずれも **ローカルかつ public** のものだけを返す（ローカル限定・フォロワー限定は出さない）。
 */
async function findPublicPostFromUrl(rawUrl: string): Promise<PostRow | undefined> {
  const decoded = decodeURIComponent(rawUrl.trim());
  const candidates: string[] = [];

  const postParam = decoded.match(/[?&]post=([^&]+)/);
  if (postParam) {
    candidates.push(decodeURIComponent(postParam[1]));
  }
  const pretty = decoded.match(/\/users\/([^/?#]+)\/posts\/([^/?#]+)/);
  if (pretty) {
    candidates.push(`${config.origin}/users/${pretty[1]}/posts/${pretty[2]}`);
  }
  candidates.push(decoded);

  for (const id of candidates) {
    const post = (await db.prepare('SELECT * FROM posts WHERE id = ?').get(id)) as unknown as PostRow | undefined;
    if (post) {
      if (post.is_local !== 1 || (post.visibility && post.visibility !== 'public')) {
        return undefined;
      }
      return post;
    }
  }
  return undefined;
}

// ==========================================
// クローラ・フィードリーダー向け
// ==========================================

/**
 * robots.txt。
 *
 * SPA のフォールバック（`app.get('*')`）が**どんなパスにも 200 で index.html を返す**ため、
 * 明示的にここで捌かないと「存在しない URL も全部同じ内容」に見えてしまう。
 */
discoveryRouter.get('/robots.txt', (_req: Request, res: Response) => {
  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /admin',
    'Disallow: /settings',
    `Sitemap: ${config.origin}/sitemap.xml`,
    '',
  ].join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(body);
});

/**
 * sitemap.xml。ローカル公開の「入口」になりうる URL だけを列挙する。
 * 投稿は直近の公開投稿（最大 5,000 件）、ユーザーはローカルの全員（最大 5,000 人）。
 */
discoveryRouter.get('/sitemap.xml', asyncHandler(async (_req: Request, res: Response) => {
  const [users, posts, channels, tags] = await Promise.all([
    db.prepare('SELECT id FROM users WHERE is_frozen = 0 ORDER BY created_at DESC LIMIT 5000').all() as Promise<{ id: string }[]>,
    db.prepare(`
      SELECT id, published_at FROM posts
      WHERE is_local = 1 AND (visibility = 'public' OR visibility IS NULL)
      ORDER BY published_at DESC LIMIT 5000
    `).all() as Promise<{ id: string; published_at: string }[]>,
    db.prepare('SELECT id, created_at FROM channels WHERE is_archived = 0 LIMIT 1000').all() as Promise<{ id: string; created_at: string }[]>,
    listTrendingTags(),
  ]);

  const entries: string[] = [
    `<url><loc>${escapeXml(config.origin)}/</loc></url>`,
    `<url><loc>${escapeXml(config.origin)}/feed.xml</loc></url>`,
  ];
  for (const user of users) {
    entries.push(`<url><loc>${escapeXml(`${config.origin}/users/${user.id}`)}</loc></url>`);
  }
  for (const post of posts) {
    const lastmod = post.published_at ? `<lastmod>${escapeXml(new Date(post.published_at).toISOString())}</lastmod>` : '';
    entries.push(`<url><loc>${escapeXml(postPermalink(post.id))}</loc>${lastmod}</url>`);
  }
  for (const channel of channels) {
    entries.push(`<url><loc>${escapeXml(`${config.origin}/channels/${channel.id}`)}</loc></url>`);
  }
  for (const tag of tags) {
    entries.push(`<url><loc>${escapeXml(`${config.origin}/tags/${encodeURIComponent(tag)}`)}</loc></url>`);
  }

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>
`);
}));

/** 人気タグ（`/api/tags/popular` と同じ数え方・件数だけ多め） */
async function listTrendingTags(limit = 100): Promise<string[]> {
  try {
    const recent = (await db.prepare(
      "SELECT content FROM posts WHERE visibility IS NULL OR visibility != 'followers' ORDER BY published_at DESC LIMIT 200",
    ).all()) as { content: string }[];
    const counts = new Map<string, number>();
    const tagRegex = /#([a-zA-Z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)/gu;
    for (const post of recent) {
      const clean = String(post.content || '').replace(/<[^>]*>/g, ' ');
      const seen = new Set<string>();
      for (const match of clean.matchAll(tagRegex)) {
        const tag = match[1].toLowerCase();
        if (tag.length >= 2 && !seen.has(tag)) {
          seen.add(tag);
          counts.set(tag, (counts.get(tag) || 0) + 1);
        }
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([tag]) => tag);
  } catch {
    return [];
  }
}

/**
 * タグ別 RSS。タグタイムラインと同じ照合（`#tag` または `/tags/tag` を含む）で、
 * 同じく直近 `RECENT_SCAN_POSTS` 件に限って走査する（`/api/timeline?mode=tag` と揃える）。
 */
discoveryRouter.get('/tags/:tag/feed.xml', asyncHandler(async (req: Request, res: Response) => {
  const tag = String(req.params.tag || '').replace(/^#/, '').trim();
  if (!tag) {
    return res.status(404).send('Not Found');
  }

  const conds = [
    'is_local = 1',
    "(visibility = 'public' OR visibility IS NULL)",
    '(content LIKE ? OR content LIKE ?)',
  ];
  const params: (string | number)[] = [`%#${tag}%`, `%/tags/${tag}%`];
  if (config.recentScanPosts > 0) {
    conds.push(`published_at >= (
      SELECT COALESCE(MIN(published_at), '') FROM (SELECT published_at FROM posts ORDER BY published_at DESC LIMIT ?)
    )`);
    params.push(config.recentScanPosts);
  }

  const posts = (await db.prepare(`
    SELECT * FROM posts WHERE ${conds.join(' AND ')} ORDER BY published_at DESC LIMIT 30
  `).all(...params)) as unknown as PostRow[];

  const xml = buildRssXml({
    title: `#${tag} - ${config.instanceName}`,
    link: `${config.origin}/tags/${encodeURIComponent(tag)}`,
    description: `${config.instanceName} の #${tag} の投稿`,
    selfPath: `/tags/${encodeURIComponent(tag)}/feed.xml`,
    items: buildItemsFromPosts(posts, `#${tag}`),
  });

  sendRss(res, xml);
}));

/**
 * security.txt（RFC 9116）。`contact_url`（管理画面の「連絡先 URL」）が未設定なら 404。
 * 空の Contact を配るほうが有害なので、設定されているときだけ返す。
 */
discoveryRouter.get('/.well-known/security.txt', (_req: Request, res: Response) => {
  const info = getInstanceInfo();
  const contact = (info.contact_url || info.operator_url || '').trim();
  if (!contact) {
    return res.status(404).type('text/plain').send('Not Found');
  }
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const body = [
    `Contact: ${contact}`,
    `Expires: ${expires}`,
    'Preferred-Languages: ja, en',
    `Canonical: ${config.origin}/.well-known/security.txt`,
    ...(info.repository_url ? [`Policy: ${info.repository_url}/security/policy`] : []),
    '',
  ].join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(body);
});
