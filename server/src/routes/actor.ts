import { Router, Request, Response } from 'express';
import { getInstanceActorJson } from '../instanceActor.js';
import { ACTIVITY_CONTENT_TYPE } from '../activitypub.js';

export const actorRouter = Router();

// GET /actor (Mastodon / Misskey 互換のインスタンス Actor)
actorRouter.get('/actor', (req: Request, res: Response) => {
  const actorJson = getInstanceActorJson();
  res.setHeader('Content-Type', `${ACTIVITY_CONTENT_TYPE}; charset=utf-8`);
  res.json(actorJson);
});
