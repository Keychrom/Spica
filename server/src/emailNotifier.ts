import { db, getServerSetting } from './db.js';
import { config } from './config.js';
import { isMailConfigured, sendMail } from './mailService.js';

/**
 * メール通知（SMTP が設定されているときだけ動く）
 *
 * 設計方針:
 *   ・SMTP 未設定なら完全に無効。登録・ログインはメール無しでも動く（従来どおり）
 *   ・受け取るかどうかはユーザーごとのオプトイン（既定 OFF）
 *   ・種類別の通知設定（notification_prefs）で切った種類は、そもそも通知自体が
 *     作られないのでメールも飛ばない（createNotification が false を返す）
 *   ・宛先は「本人が設定して確認済みのメールアドレス」のみ
 *   ・まとめ送り: 短時間に複数の通知が来たら 1 通にまとめる（既定 60 秒待つ）
 *   ・連投防止: 同じユーザーへは最短でも一定間隔（既定 5 分）しか送らない
 *
 * 送信は失敗してもアプリの動作に影響させない（ログのみ）。
 */

const NOTIFICATION_LABELS: Record<string, string> = {
  reply: '返信',
  follow: 'フォロー',
  renote: 'リノート',
  announce: 'ブースト',
  reaction: 'リアクション',
  mention: 'メンション',
  antenna: 'アンテナ',
  scheduled_published: '予約投稿の公開',
  move: '引っ越し',
};

export interface QueuedNotification {
  type: string;
  actorName: string;
  actorHandle: string;
  postId?: string | null;
  postContent?: string;
  content?: string;
  createdAt: string;
}

interface PendingBatch {
  items: QueuedNotification[];
  timer: NodeJS.Timeout | null;
  /** この時刻より前に送ってはいけない（連投防止） */
  notBefore: number;
}

const pending = new Map<string, PendingBatch>();

/** まとめ送りまでの待ち時間（ミリ秒） */
function batchDelayMs(): number {
  const stored = parseInt(getServerSetting('email_batch_seconds') || '', 10);
  const seconds = Number.isFinite(stored) && stored >= 0 ? stored : config.emailBatchSeconds;
  return Math.max(0, seconds) * 1000;
}

/** 同じユーザーへ送る最短間隔（ミリ秒） */
function throttleMs(): number {
  const stored = parseInt(getServerSetting('email_throttle_minutes') || '', 10);
  const minutes = Number.isFinite(stored) && stored > 0 ? stored : config.emailThrottleMinutes;
  return Math.max(0, minutes) * 60 * 1000;
}

/** メール通知が使える状態か（SMTP 設定済み + 機能が有効） */
export function isEmailNotificationAvailable(): boolean {
  if (getServerSetting('email_notifications') === 'false') return false;
  return config.emailNotifications !== false && isMailConfigured();
}

interface Recipient {
  id: string;
  email: string;
  verified: boolean;
  enabled: boolean;
}

function getRecipient(userId: string): Recipient | null {
  const row = db.prepare(
    'SELECT id, email, email_verified, email_notifications FROM users WHERE id = ?',
  ).get(userId) as { id: string; email?: string | null; email_verified?: number | null; email_notifications?: number | null } | undefined;
  if (!row || !row.email) return null;
  return {
    id: row.id,
    email: row.email,
    verified: Number(row.email_verified) === 1,
    enabled: Number(row.email_notifications) === 1,
  };
}

/** ユーザー側の設定状態（UI 表示用） */
export function getEmailNotificationStatus(userId: string): {
  available: boolean;
  enabled: boolean;
  email: string;
  verified: boolean;
} {
  const recipient = getRecipient(userId);
  return {
    available: isEmailNotificationAvailable(),
    enabled: Boolean(recipient?.enabled),
    email: recipient?.email || '',
    verified: Boolean(recipient?.verified),
  };
}

/** ユーザー側の ON/OFF 保存 */
export function setEmailNotificationEnabled(userId: string, enabled: boolean): void {
  db.prepare('UPDATE users SET email_notifications = ? WHERE id = ?').run(enabled ? 1 : 0, userId);
}

/**
 * 通知が作られたときに呼ぶ（createNotification から動的 import される）。
 * ここでは送信せず、まとめ送りのキューに積むだけ。
 */
export function queueNotificationEmail(params: {
  userId: string;
  type: string;
  actorName: string;
  actorHandle: string;
  postId?: string | null;
  postContent?: string;
  content?: string;
}): void {
  if (!isEmailNotificationAvailable()) return;
  const recipient = getRecipient(params.userId);
  // オプトイン・メール設定・確認済みのすべてが揃っている場合だけ
  if (!recipient || !recipient.enabled || !recipient.verified) return;

  const item: QueuedNotification = {
    type: params.type,
    actorName: params.actorName,
    actorHandle: params.actorHandle,
    postId: params.postId || null,
    postContent: params.postContent || '',
    content: params.content || '',
    createdAt: new Date().toISOString(),
  };

  let batch = pending.get(params.userId);
  if (!batch) {
    batch = { items: [], timer: null, notBefore: 0 };
    pending.set(params.userId, batch);
  }
  batch.items.push(item);

  if (batch.timer) return; // すでに送信予約済み

  const delay = Math.max(batchDelayMs(), Math.max(0, batch.notBefore - Date.now()));
  batch.timer = setTimeout(() => {
    const current = pending.get(params.userId);
    if (current) current.timer = null;
    void flushUser(params.userId);
  }, delay);
  // プロセスの終了を妨げない
  batch.timer.unref?.();
}

/** たまっている通知を 1 通にまとめて送る */
async function flushUser(userId: string): Promise<void> {
  const batch = pending.get(userId);
  if (!batch || batch.items.length === 0) {
    pending.delete(userId);
    return;
  }

  const items = batch.items;
  batch.items = [];
  pending.delete(userId);

  const recipient = getRecipient(userId);
  if (!recipient || !recipient.enabled || !recipient.verified) return;

  // 連投防止: 前回の送信から間隔が空いていなければ、残り時間だけ待ってから再キュー
  const lastSent = Number(getServerSetting(`email_notify_last_${userId}`) || '0');
  const wait = lastSent + throttleMs() - Date.now();
  if (wait > 0 && Number.isFinite(wait)) {
    const requeued = pending.get(userId) || { items: [], timer: null, notBefore: 0 };
    requeued.items = [...items, ...requeued.items];
    requeued.notBefore = lastSent + throttleMs();
    pending.set(userId, requeued);
    if (!requeued.timer) {
      requeued.timer = setTimeout(() => {
        const current = pending.get(userId);
        if (current) current.timer = null;
        void flushUser(userId);
      }, wait);
      requeued.timer.unref?.();
    }
    return;
  }

  const subject = items.length === 1
    ? `Spica: ${NOTIFICATION_LABELS[items[0].type] || items[0].type}の通知`
    : `Spica: 新しい通知が ${items.length} 件`;

  const lines = items.map((item) => {
    const label = NOTIFICATION_LABELS[item.type] || item.type;
    const who = item.actorName ? `${item.actorName} (${item.actorHandle})` : item.actorHandle;
    const detail = item.content || item.postContent || '';
    return `・[${label}] ${who}${detail ? `\n  ${detail}` : ''}`;
  });

  const text = [
    `${config.instanceName} の通知をお知らせします。`,
    '',
    ...lines,
    '',
    `通知一覧: ${config.origin}/?view=notifications`,
    '（メール通知を止めるには、設定 → 通知 → メール通知をオフにしてください）',
  ].join('\n');

  try {
    const result = await sendMail({ to: recipient.email, subject, text });
    if (result.ok) {
      db.prepare(`
        INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(`email_notify_last_${userId}`, String(Date.now()), new Date().toISOString());
      console.log(`[EmailNotify] ✉️ ${recipient.email} へ通知メールを送信（${items.length} 件）`);
    } else {
      console.warn(`[EmailNotify] 送信に失敗: ${result.error || '不明なエラー'}`);
    }
  } catch (err: any) {
    console.warn('[EmailNotify] 送信に失敗:', err?.message || err);
  }
}

/** テスト・管理用: たまっているメールを今すぐ送る */
export async function flushPendingEmails(userId?: string): Promise<void> {
  const targets = userId ? [userId] : Array.from(pending.keys());
  for (const id of targets) {
    const batch = pending.get(id);
    if (batch?.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }
    await flushUser(id);
  }
}
