import crypto from 'node:crypto';
import { db } from './db.js';

/**
 * 📮 配送再送キュー
 *
 * ActivityPub の配送は相手サーバーの一時的な停止・タイムアウト・5xx などで普通に失敗する。
 * 失敗した配送をここに積んでおき、指数バックオフで再送する。
 *
 *  - 再送するのは「一時的な失敗」のみ（ネットワークエラー / 408 / 429 / 5xx）
 *  - 4xx（401・403・404・410 など）は恒久的な失敗とみなして再送しない
 *  - RETRY_DELAYS_MS を使い切ったら status = 'failed' で確定（それ以上は再送しない）
 */

/** 再送間隔（失敗回数に応じた指数バックオフ） */
export const RETRY_DELAYS_MS: number[] = [
  60 * 1000, // 1分
  5 * 60 * 1000, // 5分
  15 * 60 * 1000, // 15分
  60 * 60 * 1000, // 1時間
  3 * 60 * 60 * 1000, // 3時間
  12 * 60 * 60 * 1000, // 12時間
  24 * 60 * 60 * 1000, // 24時間
  24 * 60 * 60 * 1000, // 24時間（最終）
];

/** 再送を含めた最大試行回数（初回 + 再送 8 回） */
export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** 再送キューに残す期間（配信済み / 失敗確定した行の削除基準） */
const DELIVERED_RETENTION_MS = 24 * 60 * 60 * 1000; // 1日
const FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7日

export interface OutboxDeliveryRow {
  id: string;
  activity_id: string;
  activity_type: string;
  inbox_url: string;
  activity: string;
  sender_user_id: string | null;
  use_instance_actor: number;
  attempts: number;
  next_attempt_at: string;
  last_status: number | null;
  last_error: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/** attempts 回失敗したあと、次に再送するまでの待ち時間 */
export function nextRetryDelayMs(attempts: number): number {
  const index = Math.max(0, attempts - 1);
  if (index >= RETRY_DELAYS_MS.length) {
    return RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  }
  return RETRY_DELAYS_MS[index];
}

/**
 * 配送失敗を再送キューに登録する。
 * 同じ Activity + 配送先がすでに待機中なら二重登録しない（false を返す）。
 */
export async function enqueueDelivery(params: {
  inboxUrl: string;
  activity: any;
  senderUserId?: string | null;
  useInstanceActor?: boolean;
  status?: number | null;
  error?: string;
}): Promise<boolean> {
  try {
    const activityId = String(params.activity?.id || '');
    if (activityId) {
      const existing = await db.prepare(
        "SELECT id FROM outbox_deliveries WHERE status = 'pending' AND activity_id = ? AND inbox_url = ?",
      ).get(activityId, params.inboxUrl) as { id: string } | undefined;
      if (existing) {
        return false;
      }
    }

    const now = new Date();
    await db.prepare(`
      INSERT INTO outbox_deliveries (
        id, activity_id, activity_type, inbox_url, activity, sender_user_id,
        use_instance_actor, attempts, next_attempt_at, last_status, last_error, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'pending', ?, ?)
    `).run(
      crypto.randomUUID(),
      activityId,
      String(params.activity?.type || ''),
      params.inboxUrl,
      JSON.stringify(params.activity),
      params.senderUserId || null,
      params.useInstanceActor ? 1 : 0,
      new Date(now.getTime() + nextRetryDelayMs(1)).toISOString(),
      params.status ?? null,
      String(params.error || '').slice(0, 500),
      now.toISOString(),
      now.toISOString(),
    );
    return true;
  } catch (err) {
    console.error('[Delivery Queue] ❌ 再送キューへの登録に失敗:', err);
    return false;
  }
}

/** 再送の期限が来ている行を取得（古い順） */
export async function listDueDeliveries(limit = 50): Promise<OutboxDeliveryRow[]> {
  try {
    const nowIso = new Date().toISOString();
    return await db.prepare(`
      SELECT * FROM outbox_deliveries
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC
      LIMIT ?
    `).all(nowIso, limit) as unknown as OutboxDeliveryRow[];
  } catch (err) {
    console.error('[Delivery Queue] ❌ 再送対象の取得に失敗:', err);
    return [];
  }
}

/** 再送に成功した行を配信済みにする */
export async function markDeliveryDelivered(id: string): Promise<void> {
  try {
    await db.prepare(
      "UPDATE outbox_deliveries SET status = 'delivered', last_error = '', updated_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), id);
  } catch (err) {
    console.error('[Delivery Queue] ❌ 配信済みマークに失敗:', err);
  }
}

/**
 * 再送に失敗した行を更新する。
 * まだ試行回数に余裕があれば次回予定を入れ、使い切ったら 'failed' で確定する。
 */
export async function markDeliveryFailed(
  row: OutboxDeliveryRow,
  params: { status?: number | null; error?: string },
): Promise<{ dead: boolean; nextAttemptAt: string | null }> {
  try {
    const attempts = row.attempts + 1;
    const now = new Date();
    const message = String(params.error || '').slice(0, 500);

    if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      await db.prepare(`
        UPDATE outbox_deliveries
        SET attempts = ?, status = 'failed', last_status = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(attempts, params.status ?? null, message, now.toISOString(), row.id);
      return { dead: true, nextAttemptAt: null };
    }

    const nextAttemptAt = new Date(now.getTime() + nextRetryDelayMs(attempts)).toISOString();
    await db.prepare(`
      UPDATE outbox_deliveries
      SET attempts = ?, next_attempt_at = ?, last_status = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(attempts, nextAttemptAt, params.status ?? null, message, now.toISOString(), row.id);
    return { dead: false, nextAttemptAt };
  } catch (err) {
    console.error('[Delivery Queue] ❌ 再送状態の更新に失敗:', err);
    return { dead: false, nextAttemptAt: null };
  }
}

/** 恒久的な失敗（4xx など）として確定させる */
export async function markDeliveryDead(row: OutboxDeliveryRow, params: { status?: number | null; error?: string }): Promise<void> {
  try {
    await db.prepare(`
      UPDATE outbox_deliveries
      SET status = 'failed', last_status = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(params.status ?? null, String(params.error || '').slice(0, 500), new Date().toISOString(), row.id);
  } catch (err) {
    console.error('[Delivery Queue] ❌ 失敗確定の更新に失敗:', err);
  }
}

/** 古い行を削除する（配信済み: 1日 / 失敗確定: 7日） */
export async function pruneDeliveries(): Promise<number> {
  try {
    const now = Date.now();
    const deliveredBefore = new Date(now - DELIVERED_RETENTION_MS).toISOString();
    const failedBefore = new Date(now - FAILED_RETENTION_MS).toISOString();
    await db.prepare("DELETE FROM outbox_deliveries WHERE status = 'delivered' AND updated_at < ?").run(deliveredBefore);
    await db.prepare("DELETE FROM outbox_deliveries WHERE status = 'failed' AND updated_at < ?").run(failedBefore);
    return 1;
  } catch (err) {
    console.error('[Delivery Queue] ❌ 古い行の削除に失敗:', err);
    return 0;
  }
}

export interface DeliveryQueueStats {
  pending: number;
  delivered: number;
  failed: number;
  nextAttemptAt: string | null;
}

/** 管理画面向けの集計 */
export async function getDeliveryQueueStats(): Promise<DeliveryQueueStats> {
  try {
    const count = async (status: string): Promise<number> =>
      (await db.prepare('SELECT COUNT(*) as c FROM outbox_deliveries WHERE status = ?').get(status) as { c: number }).c;
    const next = await db.prepare(
      "SELECT next_attempt_at FROM outbox_deliveries WHERE status = 'pending' ORDER BY next_attempt_at ASC LIMIT 1",
    ).get() as { next_attempt_at: string } | undefined;
    return {
      pending: await count('pending'),
      delivered: await count('delivered'),
      failed: await count('failed'),
      nextAttemptAt: next?.next_attempt_at ?? null,
    };
  } catch {
    return { pending: 0, delivered: 0, failed: 0, nextAttemptAt: null };
  }
}

/** 待機中の再送をすべて「今すぐ」に前倒しする（管理画面の手動再送） */
export async function releasePendingDeliveries(): Promise<number> {
  try {
    const nowIso = new Date().toISOString();
    const result = await db.prepare(
      "UPDATE outbox_deliveries SET next_attempt_at = ?, updated_at = ? WHERE status = 'pending'",
    ).run(nowIso, nowIso);
    return Number(result.changes ?? 0);
  } catch (err) {
    console.error('[Delivery Queue] ❌ 手動再送の更新に失敗:', err);
    return 0;
  }
}

/** 失敗確定した行をまとめて削除する（管理画面からの掃除用） */
export async function clearFailedDeliveries(): Promise<number> {
  try {
    const result = await db.prepare("DELETE FROM outbox_deliveries WHERE status = 'failed'").run();
    return Number(result.changes ?? 0);
  } catch (err) {
    console.error('[Delivery Queue] ❌ 失敗行の削除に失敗:', err);
    return 0;
  }
}
