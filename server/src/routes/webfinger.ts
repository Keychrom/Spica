import { Router, Request, Response } from 'express';
import { db, UserRow } from '../db.js';
import { config } from '../config.js';

export const webfingerRouter = Router();

webfingerRouter.get('/webfinger', (req: Request, res: Response) => {
  const resource = req.query.resource as string;
  if (!resource) {
    return res.status(400).json({ error: 'クエリパラメータ resource が必要です。例: acct:user@domain' });
  }

  // acct:username@domain または username@domain をパース
  const match = resource.match(/^(?:acct:)?([^@]+)(?:@(.+))?$/);
  if (!match) {
    return res.status(400).json({ error: '無効な resource 形式です。' });
  }

  const [, username, domain] = match;

  // ドメインが指定されていて自ノードと一致しない場合は 404
  if (domain && domain.toLowerCase() !== config.domain.toLowerCase()) {
    return res.status(404).json({ error: '指定されたドメインはこのサーバーではありません。' });
  }

  // インスタンス Actor の解決 (acct:actor@domain または acct:domain@domain)
  if (username.toLowerCase() === 'actor' || username.toLowerCase() === config.domain.toLowerCase()) {
    const actorUrl = `${config.origin}/actor`;
    res.setHeader('Content-Type', 'application/jrd+json; charset=utf-8');
    return res.json({
      subject: `acct:${config.domain}@${config.domain}`,
      aliases: [actorUrl],
      links: [
        {
          rel: 'self',
          type: 'application/activity+json',
          href: actorUrl,
        },
      ],
    });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(username) as UserRow | undefined;
  if (!user) {
    return res.status(404).json({ error: 'ユーザーが見つかりません。' });
  }

  const actorUrl = `${config.origin}/users/${user.id}`;

  res.setHeader('Content-Type', 'application/jrd+json; charset=utf-8');
  res.json({
    subject: `acct:${user.id}@${config.domain}`,
    aliases: [actorUrl],
    links: [
      {
        rel: 'http://webfinger.net/rel/profile-page',
        type: 'text/html',
        href: actorUrl,
      },
      {
        rel: 'self',
        type: 'application/activity+json',
        href: actorUrl,
      },
    ],
  });
});
