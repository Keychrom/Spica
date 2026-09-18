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
    openRegistrations: true,
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
    },
  });
});
