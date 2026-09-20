import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { initDatabase } from './db.js';
import { authenticate } from './auth.js';
import { webfingerRouter } from './routes/webfinger.js';
import { usersRouter } from './routes/users.js';
import { inboxRouter } from './routes/inbox.js';
import { outboxRouter } from './routes/outbox.js';
import { nodeinfoRouter } from './routes/nodeinfo.js';
import { apiRouter } from './routes/api.js';
import { adminRouter } from './routes/admin.js';
import { actorRouter } from './routes/actor.js';
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

  app.use(express.static(finalDistPath));

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
