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
app.use('/uploads', express.static(uploadsDir));

// 本番ビルドされたフロントエンド静的ファイルの配信 (client/dist)
const clientDistPath = path.resolve(process.cwd(), '../client/dist');
const altClientDistPath = path.resolve(process.cwd(), 'client/dist');
const finalDistPath = fs.existsSync(clientDistPath) ? clientDistPath : (fs.existsSync(altClientDistPath) ? altClientDistPath : null);

if (finalDistPath) {
  console.log(`[Static] Serving client UI from ${finalDistPath}`);
  app.use(express.static(finalDistPath));
  // SPA用のフォールバックルーティング
  app.get('*', (req: Request, res: Response, next: NextFunction) => {
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
=====================================================
  `);
});

export default app;
