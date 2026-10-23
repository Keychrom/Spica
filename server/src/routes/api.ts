/**
 * API のルーター束ね役。
 *
 * 実装は機能ごとのモジュールにあり、ここは**元の登録順**でマウントするだけ
 * （Express は登録順にマッチするため、順序を変えない）。
 */
import { Router } from 'express';
import authRouter from './auth.js';
import apiKeysRouter from './apiKeys.js';
import timelineRouter from './timeline.js';
import mediaRouter from './media.js';
import postsRouter from './posts.js';
import profilesRouter from './profiles.js';
import instanceRouter from './instance.js';
import notificationsRouter from './notifications.js';
import bookmarksRouter from './bookmarks.js';
import clipsRouter from './clips.js';
import pinRouter from './pin.js';
import blocksRouter from './blocks.js';
import listsRouter from './lists.js';
import antennasRouter from './antennas.js';
import draftsRouter from './drafts.js';
import webauthnRouter from './webauthn.js';
import channelsRouter from './channels.js';
import dmRouter from './dm.js';

export const apiRouter = Router();

apiRouter.use(authRouter);
apiRouter.use(apiKeysRouter);
apiRouter.use(timelineRouter);
apiRouter.use(mediaRouter);
apiRouter.use(postsRouter);
apiRouter.use(profilesRouter);
apiRouter.use(instanceRouter);
apiRouter.use(notificationsRouter);
apiRouter.use(bookmarksRouter);
apiRouter.use(clipsRouter);
apiRouter.use(pinRouter);
apiRouter.use(blocksRouter);
apiRouter.use(listsRouter);
apiRouter.use(antennasRouter);
apiRouter.use(draftsRouter);
apiRouter.use(webauthnRouter);
apiRouter.use(channelsRouter);
apiRouter.use('/dm', dmRouter);
