import fs from 'node:fs';
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../asyncHandler.js';
import { db, getInstanceInfo } from '../db.js';
import { config } from '../config.js';

/**
 * サーバーのバージョン。**server/package.json から読む**。
 * ここをハードコードすると、上げるたびに書き換え忘れて FediDB などの表示が古いままになる。
 */
function readServerVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const SERVER_VERSION = readServerVersion();

export const nodeinfoRouter = Router();

nodeinfoRouter.get('/.well-known/nodeinfo', (req: Request, res: Response) => {
  res.json({
    links: [
      {
        rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
        href: `${config.origin}/nodeinfo/2.1`,
      },
    ],
  });
});

nodeinfoRouter.get('/nodeinfo/2.1', asyncHandler(async (req: Request, res: Response) => {
  const userCount = (await db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  const postCount = (await db.prepare('SELECT COUNT(*) as count FROM posts WHERE is_local = 1').get() as { count: number }).count;
  const info = getInstanceInfo();

  res.setHeader('Content-Type', 'application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.1#"');
  res.json({
    version: '2.1',
    software: {
      // NodeInfo の仕様では software.name は**小文字の識別子**（^[a-z0-9-]+$）。
      // 表示用の名前は metadata.nodeName に入れる（FediDB などはそちらを見る）
      name: 'spica',
      version: SERVER_VERSION,
      // ソフトウェアの配布ページ（インスタンスの URL ではない）
      homepage: info.repository_url || 'https://github.com/Keychrom/Spica',
    },
    protocols: ['activitypub'],
    services: {
      inbound: [],
      outbound: [],
    },
    // 新規登録の受付状態を実際の設定から返す（連合先やインスタンス一覧が参照する）
    openRegistrations: info.registration_mode === 'open',
    usage: {
      users: {
        total: userCount,
        activeHalfyear: userCount,
        activeMonth: userCount,
      },
      localPosts: postCount,
    },
    metadata: {
      nodeName: info.name,
      nodeDescription: info.description,
      nodeIcon: info.icon_url,
      // 参考情報（invite = 招待制 / closed = 停止中）
      registrationMode: info.registration_mode,
      staffAccounts: (await db.prepare("SELECT id FROM users WHERE role = 'admin'").all()).map((row: any) => `${config.origin}/users/${row.id}`),
    },
  });
}));
