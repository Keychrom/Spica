import { Router, Request, Response } from 'express';
import { db, getInstanceInfo } from '../db.js';
import { config } from '../config.js';

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

nodeinfoRouter.get('/nodeinfo/2.1', (req: Request, res: Response) => {
  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  const postCount = (db.prepare('SELECT COUNT(*) as count FROM posts WHERE is_local = 1').get() as { count: number }).count;
  const info = getInstanceInfo();

  res.setHeader('Content-Type', 'application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.1#"');
  res.json({
    version: '2.1',
    software: {
      name: 'Spica',
      version: '1.0.0',
      homepage: config.origin,
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
      staffAccounts: db.prepare("SELECT id FROM users WHERE role = 'admin'").all().map((row: any) => `${config.origin}/users/${row.id}`),
    },
  });
});
