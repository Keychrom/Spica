import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { initDatabase, db } from './db.js';
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
import { rateLimit } from './rateLimit.js';
import { startScheduler } from './scheduler.js';

// データベースの初期化
initDatabase();

// 予約投稿バックグラウンドワーカーの起動
startScheduler();

const app = express();

// Cloudflare Tunnel 等のリバースプロキシ用設定
app.set('trust proxy', true);

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
app.use('/.well-known', webfingerRouter);
app.use('/', nodeinfoRouter);
app.use('/', actorRouter);
app.use('/users', usersRouter);
app.use('/users', outboxRouter);
app.use('/', inboxRouter);
app.use('/', discoveryRouter);

// クライアント用 REST API ルーティング
app.use('/api', apiRouter);
app.use('/api/admin', adminRouter);

// アップロードされたローカル静的メディアの配信
const uploadsDir = path.resolve(process.cwd(), 'data/uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
// アップロードメディアは同一オリジンで配信されるため、SVG 等に埋め込まれた
// スクリプトが実行されないよう CSP で無効化する（nosniff も付与）
app.use('/uploads', (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
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
  let cachedIndexHtml: string | null = null;
  const readIndexHtml = (): string | null => {
    if (cachedIndexHtml) {
      return cachedIndexHtml;
    }
    try {
      cachedIndexHtml = fs.readFileSync(path.join(finalDistPath as string, 'index.html'), 'utf8');
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

  const injectMeta = (html: string, meta: { title: string; description: string; image?: string | null; url: string }): string => {
    const tags = [
      `<meta property="og:type" content="website" />`,
      `<meta property="og:site_name" content="${escapeHtml(config.instanceName)}" />`,
      `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
      `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
      `<meta property="og:url" content="${escapeHtml(meta.url)}" />`,
      meta.image ? `<meta property="og:image" content="${escapeHtml(meta.image)}" />` : '',
      `<meta name="twitter:card" content="${meta.image ? 'summary_large_image' : 'summary'}" />`,
      `<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`,
      `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`,
      meta.image ? `<meta name="twitter:image" content="${escapeHtml(meta.image)}" />` : '',
      `<title>${escapeHtml(meta.title)}</title>`,
    ]
      .filter(Boolean)
      .join('\n    ');

    return html.replace(/<title>[\s\S]*?<\/title>/i, '').replace(/<\/head>/i, `    ${tags}\n  </head>`);
  };

  app.get(['/users/:username', '/'], (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers.accept || !req.headers.accept.includes('text/html')) {
      return next();
    }
    const html = readIndexHtml();
    if (!html) {
      return next();
    }

    try {
      // 1. ユーザープロフィール
      const usernameParam = (req.params as Record<string, string>).username;
      if (usernameParam) {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(usernameParam) as
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
        }));
      }

      // 2. 投稿（/?post=<id> または ?postId=<id>）
      const postParam = (req.query.post || req.query.postId) as string | undefined;
      if (postParam) {
        const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(decodeURIComponent(postParam)) as
          | { id: string; author_name: string; author_handle: string; content: string; cw: string | null; visibility: string | null; is_local: number; media_attachments: string }
          | undefined;

        if (post && post.is_local === 1 && (!post.visibility || post.visibility === 'public')) {
          let image: string | null = null;
          try {
            const attachments = JSON.parse(post.media_attachments || '[]');
            const firstImage = Array.isArray(attachments)
              ? attachments.find((a: any) => String(a?.mediaType || '').startsWith('image/'))
              : null;
            image = firstImage?.url ? new URL(firstImage.url, config.origin).toString() : null;
          } catch {}

          const text = String(post.content || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.send(injectMeta(html, {
            title: `${post.author_name} のノート`,
            description: post.cw ? `[${post.cw}] ${text}` : text,
            image,
            url: `${config.origin}/?post=${encodeURIComponent(post.id)}`,
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

  // ビルド済みフロントエンドの静的配信（index.html は OGP 注入側で扱うため対象外）
  app.use(express.static(finalDistPath, { index: false }));

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

    if (config.inboxSignatureMode === 'log') {
      console.warn(`
⚠️  [SECURITY WARNING] INBOX_SIGNATURE_MODE=log
    署名検証に失敗した Activity もそのまま処理されます（なりすまし投稿が可能な状態）。
    本番運用では INBOX_SIGNATURE_MODE=strict（既定値）を使用してください。
`);
    }
});

export default app;
