import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, initDatabase, loadServerSettings } from './db.js';
import { initRedis, subscribeEvent, getRedisStatus } from './redis.js';
import { handleRemoteStreamEvent, getStreamClientCount } from './streaming.js';
import { authenticate } from './auth.js';
import { webfingerRouter } from './routes/webfinger.js';
import { usersRouter } from './routes/users.js';
import { inboxRouter } from './routes/inbox.js';
import { outboxRouter } from './routes/outbox.js';
import { nodeinfoRouter } from './routes/nodeinfo.js';
import { apiRouter } from './routes/api.js';
import { adminRouter } from './routes/admin.js';
import { actorRouter } from './routes/actor.js';
import { discoveryRouter } from './routes/discovery.js';
import { postPermalink, canonicalPostId } from './postLinks.js';
import { rateLimit } from './rateLimit.js';
import { requireAuthorizedFetch } from './inboxAuth.js';
import { startScheduler, startDeliveryQueueWorker, startJobWorker } from './scheduler.js';
import { registerGracefulShutdown } from './shutdown.js';
import { logAutomationSettings, getMaintenanceStats } from './maintenanceService.js';
import { getDeliveryQueueStats } from './deliveryQueue.js';
import { getJobStats } from './jobs.js';
import { getTimelineCacheStats } from './timelineCache.js';
import { recordRequest, formatPrometheus } from './metrics.js';
import {
  mediaProxyMiddleware,
  isImageProxyEnabled,
  verifyProxySignature,
  fetchProxiedImage,
} from './imageProxy.js';

// データベースの初期化
await initDatabase();

// Redis（任意）。REDIS_URL が設定されているときだけ繋ぎ、プロセスをまたぐ仕組みを有効にする。
// 繋がらなくても起動は続く（インメモリ実装のまま＝今までどおり単一プロセス前提で動く）。
await initRedis();

// 他プロセスが配ったリアルタイム更新を、このプロセスのクライアントへ届ける
await subscribeEvent('stream', handleRemoteStreamEvent);

// 他プロセスで設定が変わったら、このプロセスの設定キャッシュを読み直す
await subscribeEvent('settings', () => {
  void loadServerSettings().catch((err) => {
    console.warn('[Redis] 設定の読み直しに失敗しました:', err?.message || err);
  });
});

// 予約投稿バックグラウンドワーカーの起動
startScheduler();

// 配送再送（指数バックオフ）ワーカーの起動
startDeliveryQueueWorker();

// ジョブキュー（リンクプレビュー取得などの背景処理）の起動
startJobWorker();

const app = express();

// Cloudflare Tunnel 等のリバースプロキシ用設定
app.set('trust proxy', true);

// 応答の圧縮（gzip）。クライアントの JS は 1 ファイルで 500KB を超え、API も JSON なので効果が大きい。
//  - 1KB 未満は圧縮しない（オーバーヘッドの方が大きい）
//  - **SSE（text/event-stream）は絶対に圧縮しない** — 圧縮はバッファリングするので配信が止まる
app.use(
  compression({
    threshold: 1024,
    filter: (req: Request, res: Response) => {
      const contentType = String(res.getHeader('Content-Type') || '');
      if (contentType.includes('text/event-stream')) return false;
      // 画像・動画などは元から圧縮されているので既定の判定に任せる
      return compression.filter(req, res);
    },
  }),
);

// CORS設定
app.use(cors({
  origin: true,
  credentials: true,
}));

// ActivityPub および JSON 用の Body パーサー（Raw Body をキャプチャ）
app.use(
  express.json({
    type: [
      'application/json',
      'application/activity+json',
      'application/ld+json',
      'application/jrd+json',
    ],
    verify: (req: any, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(express.urlencoded({ extended: true }));

// 認証トークンのグローバル解決
app.use(authenticate);

// リクエストロギング
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// 応答時間と状態コードを数える（`/metrics` で推移を見るため。URL はラベルにしない）
app.use((req: Request, res: Response, next: NextFunction) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    recordRequest(res.statusCode, Number(process.hrtime.bigint() - startedAt) / 1e6);
  });
  next();
});

// レート制限（ブルートフォース・スパム・flooding 対策）
//  - 認証系は厳しめ、通常 API は緩め、Inbox は連合配送を妨げないよう非常に緩め
if (!config.rateLimitDisabled) {
  app.use('/api/auth', rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    keyPrefix: 'auth',
    message: '認証リクエストが多すぎます。しばらく待ってからお試しください。',
  }));
  app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 600, keyPrefix: 'api' }));
  app.use('/inbox', rateLimit({ windowMs: 60 * 1000, max: 3000, keyPrefix: 'inbox' }));
}

// ActivityPub & Well-Known ルーティング
//  - AUTHORIZED_FETCH=true のときは、AP の取得に署名を必須にする（WebFinger/NodeInfo/API/画面表示は対象外）
app.use(requireAuthorizedFetch);
app.use('/.well-known', webfingerRouter);
app.use('/', nodeinfoRouter);
app.use('/', actorRouter);
app.use('/users', usersRouter);
app.use('/users', outboxRouter);
app.use('/', inboxRouter);
app.use('/', discoveryRouter);


// ==========================================
// ❤️ ヘルスチェック（外形監視用）
//   /health        … 監視ツール向け（最小限の情報）
//   /api/health    … 同内容（API 配下）
//   認証ヘッダー（有効なセッション）を付けると DB・配送キューの詳細も返す
// ==========================================
const healthHandler = async (req: Request, res: Response) => {
  const startedAt = Date.now();
  let dbOk = true;
  try {
    await db.prepare('SELECT 1 AS ok').get();
  } catch {
    dbOk = false;
  }

  const base = {
    status: dbOk ? 'ok' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    db: { ok: dbOk, latencyMs: Date.now() - startedAt },
    // Redis は任意。configured が true で ready が false のときは「設定されているが繋がっていない」
    redis: getRedisStatus(),
    sseClients: getStreamClientCount(),
    timelineCache: getTimelineCacheStats(),
  };

  // 認証済みなら運用の詳細も返す（監視ツールはヘッダーなしで叩ける）
  const hasAuth = Boolean(req.headers['authorization']);
  if (hasAuth && req.user) {
    try {
      const stats = await getMaintenanceStats();
      const queue = await getDeliveryQueueStats();
      const jobs = await getJobStats();
      return res.status(dbOk ? 200 : 503).json({
        ...base,
        db: { ...base.db, sizeBytes: stats.db.sizeBytes, walBytes: stats.db.walBytes },
        posts: stats.posts,
        deliveryQueue: queue,
        jobs,
        automation: stats.automation,
        backups: stats.backups,
      });
    } catch {
      // 詳細が取れなくても最小限は返す
    }
  }
  res.status(dbOk ? 200 : 503).json(base);
};
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

/**
 * `/metrics`（Prometheus 形式）。
 *
 * **`METRICS_TOKEN` を設定したときだけ有効**です（未設定なら 404）。
 * トークンは `Authorization: Bearer <token>` で渡します（Prometheus の `bearer_token`）。
 * 管理者のセッションでも読めます（`/health` の詳細と同じ扱い）。
 * nginx の背後だと接続元 IP では守れないため、**IP 制限では守りません**。
 */
app.get('/metrics', async (req: Request, res: Response) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const tokenOk = Boolean(config.metricsToken) && token === config.metricsToken;
  const adminOk = Boolean(req.user && req.user.role === 'admin');
  if (!tokenOk && !adminOk) {
    // トークン未設定なら「存在しない」、設定済みで不一致なら 401（設定の有無を推測されにくくする）
    if (!config.metricsToken) return res.status(404).json({ error: 'Not Found' });
    return res.status(401).json({ error: '認証が必要です。' });
  }

  const startedAt = Date.now();
  let dbOk = true;
  try {
    await db.prepare('SELECT 1 AS ok').get();
  } catch {
    dbOk = false;
  }

  let deliveryQueue = { pending: 0, delivering: 0, failed: 0 };
  let jobs = { pending: 0, running: 0, failed: 0 };
  try {
    const queue = await getDeliveryQueueStats();
    deliveryQueue = { pending: queue.pending, delivering: queue.delivering, failed: queue.failed };
    const jobStats = await getJobStats();
    jobs = { pending: jobStats.pending, running: jobStats.running, failed: jobStats.failed };
  } catch {
    // 取れなくても他は返す
  }

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(formatPrometheus({
    dbOk,
    dbLatencyMs: Date.now() - startedAt,
    sseClients: getStreamClientCount(),
    redis: getRedisStatus(),
    timelineCache: getTimelineCacheStats(),
    deliveryQueue,
    jobs,
  }));
});

// クライアント用 REST API ルーティング
// 画像プロキシ: タイムライン等の応答に含まれるリモート画像 URL を
// 署名付きプロキシ URL へ置き換える（閲覧者の IP を相手サーバーに渡さない）
app.use(mediaProxyMiddleware());
app.use('/api', apiRouter);
app.use('/api/admin', adminRouter);

/**
 * 画像プロキシ本体。署名付き URL のみ受け付ける（開放プロキシにしない）。
 *   /proxy?url=<encoded>&s=<signature>
 */
app.get('/proxy', async (req: Request, res: Response) => {
  const rawUrl = String(req.query.url || '');
  const signature = String(req.query.s || '');

  if (!isImageProxyEnabled()) {
    return res.status(404).json({ error: '画像プロキシは無効です。' });
  }
  if (!rawUrl) {
    return res.status(400).json({ error: 'url パラメータが必要です。' });
  }
  if (!verifyProxySignature(rawUrl, signature)) {
    return res.status(403).json({ error: '署名が無効です。' });
  }

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: 'URL の形式が不正です。' });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return res.status(400).json({ error: 'http(s) の URL のみ対応しています。' });
  }

  try {
    const image = await fetchProxiedImage(rawUrl);
    const etag = `"${crypto.createHash('sha1').update(rawUrl).digest('hex')}"`;

    res.setHeader('Content-Type', image.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // SVG 等を直接開かれてもスクリプトが動かないようにする
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('ETag', etag);
    res.setHeader('X-Proxy-Cache', image.fromCache ? 'HIT' : 'MISS');

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    res.send(image.body);
  } catch (err: any) {
    const message = err?.message || '取得に失敗しました。';
    console.warn(`[ImageProxy] ${rawUrl} → ${message}`);
    // 失敗を長くキャッシュさせない（相手側の一時障害から回復できるように）
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(502).json({ error: message });
  }
});

// アップロードされたローカル静的メディアの配信
const uploadsDir = path.resolve(process.cwd(), 'data/uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
// アップロードメディアは同一オリジンで配信されるため、SVG 等に埋め込まれた
// スクリプトが実行されないよう CSP で無効化する（nosniff も付与）。
// ファイル名は `<時刻>_<乱数>.<拡張子>` で**中身が変われば名前も変わる**ので、長くキャッシュさせる
// （CDN を前段に置いたときもそのまま効きます）
app.use('/uploads', (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  next();
});
app.use('/uploads', express.static(uploadsDir));

// 本番ビルドされたフロントエンド静的ファイルの配信 (client/dist)
const clientDistPath = path.resolve(process.cwd(), '../client/dist');
const altClientDistPath = path.resolve(process.cwd(), 'client/dist');
const finalDistPath = fs.existsSync(clientDistPath) ? clientDistPath : (fs.existsSync(altClientDistPath) ? altClientDistPath : null);

if (finalDistPath) {
  console.log(`[Static] Serving client UI from ${finalDistPath}`);

  // PWA Service Worker & Manifest 専用ヘッダー
  app.get('/sw.js', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    const swPath = path.join(finalDistPath, 'sw.js');
    if (fs.existsSync(swPath)) {
      return res.sendFile(swPath);
    }
    next();
  });

  app.get(['/manifest.webmanifest', '/manifest.json'], (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    next();
  });

  // 🔗 OGP メタの動的注入（SNS でシェアしたときにカードが表示されるようにする）
  //    express.static は `/` を index.html で返してしまうため、その前に登録する
  //    ⚠️ index.html はハッシュ付きアセットを参照するため、再ビルド後は必ず読み直す
  //       (起動時の内容を固定すると、削除済みアセットを参照する HTML を配信してしまう)
  const indexHtmlPath = path.join(finalDistPath, 'index.html');
  let cachedIndexHtml: string | null = null;
  let cachedIndexMtimeMs = 0;
  const readIndexHtml = (): string | null => {
    try {
      const stat = fs.statSync(indexHtmlPath);
      if (cachedIndexHtml !== null && stat.mtimeMs === cachedIndexMtimeMs) {
        return cachedIndexHtml;
      }
      cachedIndexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
      cachedIndexMtimeMs = stat.mtimeMs;
      return cachedIndexHtml;
    } catch {
      return null;
    }
  };

  const escapeHtml = (value: unknown): string =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const injectMeta = (
    html: string,
    meta: {
      title: string;
      description: string;
      image?: string | null;
      url: string;
      /** og:type（既定 website。プロフィールは profile、投稿は article） */
      type?: string;
      /** 正規 URL。共有 URL が複数あるとき（?post= と /users/x/posts/y）に一本化する */
      canonical?: string;
      /** RSS 自動発見（パス）。既定はサイト全体のフィード */
      feed?: string | null;
      /** oEmbed 自動発見（URL） */
      oembed?: string | null;
      /** 検索エンジンに載せたくないページ（非公開投稿など） */
      noindex?: boolean;
    },
  ): string => {
    const feedPath = meta.feed === undefined ? '/feed.xml' : meta.feed;
    const tags = [
      `<meta name="description" content="${escapeHtml(meta.description)}" />`,
      meta.noindex ? `<meta name="robots" content="noindex, nofollow" />` : '',
      `<meta property="og:type" content="${escapeHtml(meta.type || 'website')}" />`,
      `<meta property="og:site_name" content="${escapeHtml(config.instanceName)}" />`,
      `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
      `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
      `<meta property="og:url" content="${escapeHtml(meta.url)}" />`,
      meta.image ? `<meta property="og:image" content="${escapeHtml(meta.image)}" />` : '',
      `<meta name="twitter:card" content="${meta.image ? 'summary_large_image' : 'summary'}" />`,
      `<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`,
      `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`,
      meta.image ? `<meta name="twitter:image" content="${escapeHtml(meta.image)}" />` : '',
      `<link rel="canonical" href="${escapeHtml(meta.canonical || meta.url)}" />`,
      feedPath
        ? `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(config.instanceName)}" href="${escapeHtml(`${config.origin}${feedPath}`)}" />`
        : '',
      meta.oembed ? `<link rel="alternate" type="application/json+oembed" href="${escapeHtml(meta.oembed)}" />` : '',
      `<title>${escapeHtml(meta.title)}</title>`,
    ]
      .filter(Boolean)
      .join('\n    ');

    return html.replace(/<title>[\s\S]*?<\/title>/i, '').replace(/<\/head>/i, `    ${tags}\n  </head>`);
  };

  /** 投稿の OGP に使う共通の組み立て（ローカル・リモートの両方を扱う） */
  const sendPostMeta = async (
    res: Response,
    html: string,
    post: {
      id: string;
      user_id: string;
      author_name: string;
      author_handle: string;
      author_icon: string | null;
      content: string;
      cw: string | null;
      visibility: string | null;
      is_local: number;
      media_attachments: string;
      published_at: string;
    },
  ): Promise<boolean> => {
    // 公開投稿だけをクローラに渡す（ローカル限定・フォロワー限定は site 既定のメタ + noindex）
    if (post.visibility && post.visibility !== 'public') {
      return false;
    }
    const permalink = postPermalink(post.id);

    let image: string | null = null;
    try {
      const attachments = JSON.parse(post.media_attachments || '[]');
      const firstImage = Array.isArray(attachments)
        ? attachments.find((a: any) => String(a?.mediaType || a?.media_type || '').startsWith('image/'))
        : null;
      image = firstImage?.url ? new URL(firstImage.url, config.origin).toString() : null;
    } catch {}
    if (!image && post.author_icon) {
      image = new URL(post.author_icon, config.origin).toString();
    }

    const text = String(post.content || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    // author_handle は `@user@domain` 形式で入っていることがある（先頭の @ を二重にしない）
    const handle = String(post.author_handle || '');
    const atHandle = handle.startsWith('@') ? handle : `@${handle}`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(
      injectMeta(html, {
        title: `${post.author_name} (${atHandle}) のノート`,
        description: post.cw ? `[${post.cw}] ${text}` : text,
        image,
        url: permalink,
        canonical: permalink,
        type: 'article',
        // ローカル投稿は投稿者のフィード、リモート投稿はサイト全体のフィードを案内する
        feed: post.is_local === 1 && post.user_id ? `/users/${post.user_id}/feed.xml` : '/feed.xml',
        oembed: `${config.origin}/api/oembed?url=${encodeURIComponent(permalink)}`,
      }),
    );
    return true;
  };

  app.get(
    ['/users/:username', '/users/:username/posts/:postPathId', '/tags/:tag', '/'],
    async (req: Request, res: Response, next: NextFunction) => {
      if (!req.headers.accept || !req.headers.accept.includes('text/html')) {
        return next();
      }
      const html = readIndexHtml();
      if (!html) {
        return next();
      }

      try {
        // 1. 投稿のパーマリンク（/users/<user>/posts/<id>）
        const { username: usernameParam, postPathId, tag: tagParam } = req.params as Record<string, string>;
        if (usernameParam && postPathId) {
          const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(canonicalPostId(usernameParam, postPathId)) as
            | Parameters<typeof sendPostMeta>[2]
            | undefined;
          if (!post) {
            return next();
          }
          if (await sendPostMeta(res, html, post)) {
            return;
          }
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.send(injectMeta(html, {
            title: `${post.author_name} のノート`,
            description: `${config.instanceName} の投稿`,
            url: `${config.origin}/users/${usernameParam}/posts/${postPathId}`,
            type: 'article',
            noindex: true,
          }));
        }

        // 2. タグページ（/tags/<tag>）
        if (tagParam) {
          const tag = decodeURIComponent(tagParam);
          const url = `${config.origin}/tags/${encodeURIComponent(tag)}`;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.send(injectMeta(html, {
            title: `#${tag} - ${config.instanceName}`,
            description: `${config.instanceName} の #${tag} の投稿一覧`,
            image: `${config.origin}/logo.jpg`,
            url,
            type: 'website',
            feed: `/tags/${encodeURIComponent(tag)}/feed.xml`,
          }));
        }

        // 3. ユーザープロフィール
        if (usernameParam) {
          const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(usernameParam) as
            | { id: string; name: string; summary: string; icon_url: string }
            | undefined;
          if (!user) {
            return next();
          }
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.send(injectMeta(html, {
            title: `${user.name} (@${user.id}@${config.domain})`,
            description: (user.summary || `${config.instanceName} のユーザー`).slice(0, 200),
            image: user.icon_url ? new URL(user.icon_url, config.origin).toString() : `${config.origin}/logo.jpg`,
            url: `${config.origin}/users/${user.id}`,
            type: 'profile',
            feed: `/users/${user.id}/feed.xml`,
          }));
        }

        // 2. 投稿（/?post=<id> または ?postId=<id>）。リモート投稿も同じ形で共有できる
        const postParam = (req.query.post || req.query.postId) as string | undefined;
        if (postParam) {
          const postId = decodeURIComponent(postParam);
          const post = (await db.prepare(`
            SELECT p.*, COALESCE(NULLIF(p.author_icon, ''), NULLIF(u.icon_url, ''), NULLIF(ra.icon_url, ''), '') AS author_icon
            FROM posts p
            LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
            LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
            WHERE p.id = ?
          `).get(postId)) as Parameters<typeof sendPostMeta>[2] | undefined;

          if (post && (await sendPostMeta(res, html, post))) {
            return;
          }
          if (post) {
            // 公開範囲が限定の投稿: メタは出さず、検索エンジンにも載せない
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(injectMeta(html, {
              title: `${post.author_name} のノート`,
              description: `${config.instanceName} の投稿`,
              url: `${config.origin}/?post=${encodeURIComponent(post.id)}`,
              type: 'article',
              noindex: true,
            }));
          }
        }

      // 3. それ以外はサイト既定のメタ情報
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(injectMeta(html, {
        title: `${config.instanceName} - 分散型ソーシャルネットワーク`,
        description: config.instanceDescription,
        image: `${config.origin}/logo.jpg`,
        url: config.origin,
      }));
    } catch (err) {
      console.warn('[OGP] メタ情報の注入に失敗したため通常のHTMLを返します:', (err as Error).message);
      return next();
    }
  });

  // 🔗 `?post=` の中間ページを作らずに共有していた頃の URL（`/posts/<正規 ID>`）を救済する。
  //    正規 ID は自前でスラッシュを含むため、ワイルドカードで受けて共有 URL へ 301 する。
  app.get(['/posts', '/posts/*'], (req: Request, res: Response, next: NextFunction) => {
    const raw = String((req.params as Record<string, string>)[0] || '');
    if (!raw) {
      return next();
    }
    return res.redirect(301, postPermalink(decodeURIComponent(raw)));
  });

  // ビルド済みフロントエンドの静的配信（index.html は OGP 注入側で扱うため対象外）
  //   Vite は `assets/名前-ハッシュ.js` の形で出すので、**内容が変わらないものは 1 年キャッシュ**してよい。
  //   index.html や sw.js など（名前が固定のもの）は毎回確認させる（キャッシュすると更新が届かない）。
  app.use(
    express.static(finalDistPath, {
      index: false,
      setHeaders: (res, filePath) => {
        if (/(^|[\\/])assets[\\/]/.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  // SPA用のフォールバックルーティング (HTMLリクエストは常にindex.htmlへ)
  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    if (req.headers.accept && req.headers.accept.includes('text/html')) {
      return res.sendFile(path.join(finalDistPath, 'index.html'));
    }
    if (req.originalUrl.startsWith('/api') || req.originalUrl.startsWith('/.well-known') || req.originalUrl.startsWith('/users')) {
      return next();
    }
    res.sendFile(path.join(finalDistPath, 'index.html'));
  });
} else {
  // 開発時用ルート
  app.get('/', (req: Request, res: Response) => {
    res.json({
      name: config.instanceName,
      status: 'online',
      protocol: 'ActivityPub (W3C Recommendation)',
      version: '1.0.0',
      domain: config.domain,
      origin: config.origin,
    });
  });
}

// エラーハンドラー
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('[Unhandled Error]:', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// サーバー起動
const server = app.listen(config.port, config.bindHost, () => {
    console.log(`
=====================================================
✨ Spica is running!
🌐 URL: ${config.origin}
📦 ActivityPub Inbox: ${config.origin}/inbox
🔍 WebFinger: ${config.origin}/.well-known/webfinger
📊 NodeInfo: ${config.origin}/nodeinfo/2.1
🛡️ Admin API: ${config.origin}/api/admin
🔐 Inbox signature mode: ${config.inboxSignatureMode}
=====================================================
  `);

    logAutomationSettings();

    if (config.inboxSignatureMode === 'log') {
      console.warn(`
⚠️  [SECURITY WARNING] INBOX_SIGNATURE_MODE=log
    署名検証に失敗した Activity もそのまま処理されます（なりすまし投稿が可能な状態）。
    本番運用では INBOX_SIGNATURE_MODE=strict（既定値）を使用してください。
`);
    }
});

export default app;

// ==========================================
// 🛑 グレースフルシャットダウン
//   SIGTERM / SIGINT で新規接続を止め、SSE を閉じ、WAL をチェックポイントして終了する
//   （POSIX 環境でのみシグナルが配送される。Windows は強制終了だが WAL なので壊れない）
// ==========================================
registerGracefulShutdown({ server });

