/**
 * サーバー情報・カスタム絵文字・お知らせ・Web Push。
 *
 * api.ts から切り出したルーター。マウント位置（api.ts）は元の登録順と同じ。
 */
import { asyncHandler } from '../asyncHandler.js';
import { Router, Request, Response } from 'express';
import { db, getInstanceInfo, CustomEmojiRow } from '../db.js';
import { config } from '../config.js';
import { assertFetchableRemoteUrl } from '../remoteFetchGuard.js';
import { requireAuth } from '../auth.js';
import { dmFeatureFlags } from '../dm.js';
import {
  getVapidPublicKey,
  savePushSubscription,
  removePushSubscription,
  isUserSubscribed,
  sendPushToUser,
} from '../pushService.js';

const router = Router();

// サーバー公開情報
/**
 * インスタンスの件数（`/api/server-info` の stats）。
 *
 * `COUNT(*) FROM posts WHERE is_local = 0` はリモート投稿の全件走査になる。実測で SQLite 12ms、
 * PostgreSQL 242ms（並列 seq scan）かかり、画面を開くたびに踏むには重すぎる。公開統計なので
 * 60 秒だけ覚えておく（負荷試験では読みの 3 分の 1 がこのエンドポイントだった）。
 */
const SERVER_INFO_COUNTS_TTL_MS = 60_000;
let serverInfoCountsCache: { at: number; users: number; localPosts: number; federatedPosts: number } | null = null;

async function getServerInfoCounts(): Promise<{ users: number; localPosts: number; federatedPosts: number }> {
  const now = Date.now();
  if (serverInfoCountsCache && now - serverInfoCountsCache.at < SERVER_INFO_COUNTS_TTL_MS) {
    return serverInfoCountsCache;
  }
  // 3 本は互いに独立なので並行に投げる（PostgreSQL ではプールから別々の接続で走る）
  const [users, localPosts, federatedPosts] = await Promise.all([
    db.prepare("SELECT COUNT(*) as c FROM users WHERE approval_status = 'approved'").get() as Promise<{ c: number }>,
    db.prepare('SELECT COUNT(*) as c FROM posts WHERE is_local = 1').get() as Promise<{ c: number }>,
    db.prepare('SELECT COUNT(*) as c FROM posts WHERE is_local = 0').get() as Promise<{ c: number }>,
  ]);
  serverInfoCountsCache = { at: now, users: Number(users.c), localPosts: Number(localPosts.c), federatedPosts: Number(federatedPosts.c) };
  return serverInfoCountsCache;
}

router.get('/server-info', asyncHandler(async (req: Request, res: Response) => {
  const counts = await getServerInfoCounts();
  const instanceInfo = getInstanceInfo();

  res.json({
    name: instanceInfo.name,
    description: instanceInfo.description,
    icon_url: instanceInfo.icon_url,
    banner_url: instanceInfo.banner_url,
    registration_mode: instanceInfo.registration_mode,
    tos_url: instanceInfo.tos_url,
    privacy_policy_url: instanceInfo.privacy_policy_url,
    contact_url: instanceInfo.contact_url,
    repository_url: instanceInfo.repository_url,
    operator_url: instanceInfo.operator_url,
    server_rules: instanceInfo.server_rules,
    require_rules_agreement: instanceInfo.require_rules_agreement,
    origin: config.origin,
    domain: config.domain,
    port: config.port,
    // 機能フラグ（クライアントは起動時に見て導線の出し分けを決める。既存の形は壊さず追加だけする）
    features: dmFeatureFlags(),
    stats: {
      users: counts.users,
      totalPosts: counts.localPosts,
      federatedPosts: counts.federatedPosts,
    },
  });
}));

// 公開カスタム絵文字一覧（投稿・リアクションのピッカー用）
router.get('/emojis', asyncHandler(async (req: Request, res: Response) => {
  try {
    const emojis = await db.prepare(`
      SELECT id, name, url, category, aliases FROM custom_emojis ORDER BY category ASC, name ASC
    `).all() as unknown as CustomEmojiRow[];
    res.json(emojis);
  } catch (err: any) {
    console.error('[API Emojis Error]:', err);
    res.status(500).json({ error: 'カスタム絵文字の取得に失敗しました。' });
  }
}));


// ==========================================
// 🔔 Web Push 通知 API (PWA / VAPID)
// ==========================================

// VAPID 公開鍵取得
router.get('/push/vapid-public-key', (req: Request, res: Response) => {
  try {
    const publicKey = getVapidPublicKey();
    res.json({ publicKey });
  } catch (err: any) {
    console.error('[WebPush Error] Failed to get VAPID public key:', err);
    res.status(500).json({ error: 'VAPID 公開鍵の取得に失敗しました。' });
  }
});

// 📢 お知らせ（サーバーからの一斉告知）: 有効なもののみ公開
router.get('/announcements', asyncHandler(async (_req: Request, res: Response) => {
  try {
    const rows = await db.prepare(`
      SELECT id, title, content, created_at, updated_at FROM announcements
      WHERE is_active = 1
      ORDER BY created_at DESC LIMIT 20
    `).all();
    res.json(rows);
  } catch (err: any) {
    console.error('[Announcements Error]:', err);
    res.status(500).json({ error: 'お知らせの取得に失敗しました。' });
  }
}));

// 👥 ユーザーディレクトリ（公開プロフィールの一覧）

// 端末の PushSubscription 登録
router.post('/push/subscribe', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return res.status(400).json({ error: '無効な PushSubscription 形式です。' });
  }

  // SSRF 対策: 内部アドレス等を送信先として登録させない（購読時に検証）
  const endpointSafety = await assertFetchableRemoteUrl(subscription.endpoint);
  if (!endpointSafety.safe) {
    return res.status(400).json({ error: `プッシュ通知の送信先 URL は許可されていません (${endpointSafety.reason})` });
  }

  try {
    await savePushSubscription({
      userId: req.user!.id,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    });

    res.json({ success: true, message: 'Web Push 通知の受信端末を登録しました。' });
  } catch (err: any) {
    console.error('[WebPush Error] Subscribe failed:', err);
    res.status(500).json({ error: 'プッシュ通知の購読登録に失敗しました。' });
  }
}));

// 端末の PushSubscription 解除
router.post('/push/unsubscribe', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { endpoint } = req.body;
  if (endpoint && typeof endpoint === 'string') {
    await removePushSubscription(endpoint);
  }
  res.json({ success: true, message: 'Web Push 通知の登録を解除しました。' });
}));

// プッシュ通知登録状況の確認
router.get('/push/status', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const isSubscribed = await isUserSubscribed(req.user!.id);
  res.json({ isSubscribed });
}));

// テスト用プッシュ通知送信
router.post('/push/test', requireAuth, async (req: Request, res: Response) => {
  try {
    await sendPushToUser(req.user!.id, {
      title: 'Spica テスト通知 ✦',
      body: 'おめでとうございます！Web Push 通知が正常に接続されました。',
      icon: '/logo.jpg',
      url: '/?view=notifications',
    });
    res.json({ success: true, message: 'テスト通知を送信しました。端末をご確認ください。' });
  } catch (err: any) {
    console.error('[WebPush Test Error]:', err);
    res.status(500).json({ error: 'テスト通知の送信に失敗しました。' });
  }
});


export default router;
