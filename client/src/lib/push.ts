/**
 * 端末への通知（Web Push）。
 * サーバーに VAPID の鍵が設定されているときだけ使える。
 */
import { api, messageOf } from './api';

export async function pushStatus(): Promise<boolean> {
  const res = await api.get('/api/push/status');
  if (!res.ok || !res.data) return false;
  return Boolean((res.data as { isSubscribed?: boolean }).isSubscribed);
}

/** サーバーの公開鍵（文字列のときだけ使える） */
export async function vapidKey(): Promise<string | null> {
  const res = await api.get('/api/push/vapid-public-key', { auth: false });
  if (!res.ok || !res.data) return null;
  const key = (res.data as { publicKey?: unknown }).publicKey;
  return typeof key === 'string' && key.length > 20 ? key : null;
}

function b64urlToBytes(value: string): ArrayBuffer {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

/** 通知を許可して購読する。失敗したら理由を返す */
export async function subscribePush(): Promise<string | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'このブラウザはプッシュ通知に対応していません。';
  }
  const key = await vapidKey();
  if (!key) return 'このサーバーではプッシュ通知が設定されていません。';

  const registration =
    (await navigator.serviceWorker.getRegistration('/')) ??
    (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return '通知が許可されませんでした（ブラウザの設定から許可してください）。';
  }

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64urlToBytes(key),
      });
    } catch {
      return '購読を作れませんでした。';
    }
  }

  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  const res = await api.post('/api/push/subscribe', {
    subscription: { endpoint: json.endpoint, keys: json.keys },
  });
  return res.ok ? null : messageOf(res.data, '購読を登録できませんでした。');
}

export async function unsubscribePush(): Promise<string | null> {
  const subscription = await currentSubscription();
  if (subscription) {
    await api.post('/api/push/unsubscribe', { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
    return null;
  }
  const res = await api.post('/api/push/unsubscribe', {});
  return res.ok ? null : '解除できませんでした。';
}

export async function testPush(): Promise<string | null> {
  const res = await api.post('/api/push/test');
  return res.ok ? null : messageOf(res.data, 'テスト送信できませんでした。');
}
