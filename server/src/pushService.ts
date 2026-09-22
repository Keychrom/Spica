import webpush from 'web-push';
import { adb, getServerSetting, setServerSetting, PushSubscriptionRow } from './db.js';
import { config } from './config.js';
import { assertFetchableRemoteUrl } from './remoteFetchGuard.js';

/**
 * VAPIDキーの初期化と取得
 * DBに未保存の場合は自動生成して永続化
 */
export function getOrCreateVapidKeys(): { publicKey: string; privateKey: string } {
  let publicKey = getServerSetting('vapid_public_key');
  let privateKey = getServerSetting('vapid_private_key');

  if (!publicKey || !privateKey) {
    console.log('[WebPush] 🔑 Generating new VAPID keys...');
    const keys = webpush.generateVAPIDKeys();
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    setServerSetting('vapid_public_key', publicKey);
    setServerSetting('vapid_private_key', privateKey);
    console.log('[WebPush] ✅ VAPID keys generated and stored in database.');
  }

  // web-push のデフォルト詳細設定
  const contact = `mailto:admin@${config.domain}`;
  webpush.setVapidDetails(contact, publicKey, privateKey);

  return { publicKey, privateKey };
}

/**
 * クライアント提供用の VAPID 公開鍵
 */
export function getVapidPublicKey(): string {
  const { publicKey } = getOrCreateVapidKeys();
  return publicKey;
}

/**
 * 端末の PushSubscription を登録/更新
 */
export async function savePushSubscription(params: {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await adb.prepare(`
    INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      created_at = excluded.created_at
  `).run(params.endpoint, params.userId, params.p256dh, params.auth, now);

  console.log(`[WebPush] 📱 Saved push subscription for @${params.userId} (${params.endpoint.slice(0, 35)}...)`);
}

/**
 * 端末の PushSubscription を解除
 */
export async function removePushSubscription(endpoint: string): Promise<void> {
  await adb.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  console.log(`[WebPush] 🔌 Removed push subscription (${endpoint.slice(0, 35)}...)`);
}

/**
 * ユーザーが有効な PushSubscription を持っているか
 */
export async function isUserSubscribed(userId: string): Promise<boolean> {
  const row = await adb.prepare('SELECT COUNT(*) as c FROM push_subscriptions WHERE user_id = ?').get(userId) as any;
  return row ? row.c > 0 : false;
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  url?: string;
  tag?: string;
}

/**
 * 特定ユーザー宛てに Web Push 通知を配信
 * ユーザーが登録している全端末へ並行配信し、失効したエンドポイントは自動クリーンアップ
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  try {
    getOrCreateVapidKeys(); // VAPID詳細の初期化を確実に実行

    const cleanUserId = userId.toLowerCase();
    const subs = await adb.prepare('SELECT * FROM push_subscriptions WHERE LOWER(user_id) = ?').all(cleanUserId) as unknown as PushSubscriptionRow[];

    if (subs.length === 0) {
      return;
    }

    const notificationPayload = JSON.stringify({
      title: payload.title || 'Spica',
      body: payload.body || '',
      icon: payload.icon || '/logo.jpg',
      url: payload.url || '/',
      tag: payload.tag || 'spica-notification',
    });

    console.log(`[WebPush] 🚀 Sending push notification to @${userId} (${subs.length} device(s)): "${payload.title}"`);

    await Promise.allSettled(
      subs.map(async (sub) => {
        // SSRF 対策: 送信先は端末が登録した URL（利用者入力）のため、内部アドレス等へは送信しない
        const endpointSafety = await assertFetchableRemoteUrl(sub.endpoint);
        if (!endpointSafety.safe) {
          console.warn(`[WebPush Warning] 安全でない送信先のためスキップ (${endpointSafety.reason})`);
          return;
        }

        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        };

        try {
          await webpush.sendNotification(pushSubscription, notificationPayload, {
            TTL: 60 * 60 * 24, // 24時間
            urgency: 'high',
          });
        } catch (err: any) {
          // 410 (Gone) または 404 (Not Found) の場合は端末側でアンインストールまたは権限拒否されたため削除
          if (err.statusCode === 410 || err.statusCode === 404) {
            console.log(`[WebPush] 🧹 Expired subscription removed: ${sub.endpoint.slice(0, 35)}...`);
            void removePushSubscription(sub.endpoint);
          } else {
            console.warn(`[WebPush Warning] Failed to push to ${sub.endpoint.slice(0, 35)}:`, err.message);
          }
        }
      })
    );
  } catch (err: any) {
    console.error('[WebPush Error] sendPushToUser failed:', err.message);
  }
}
