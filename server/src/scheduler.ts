import { db, UserRow, ScheduledPostRow, createNotification } from './db.js';
import { executeCreatePost } from './postService.js';
import { attemptDelivery } from './activitypub.js';
import { maybeRunScheduledMaintenance } from './maintenanceService.js';
import {
  listDueDeliveries,
  markDeliveryDelivered,
  markDeliveryFailed,
  markDeliveryDead,
  pruneDeliveries,
} from './deliveryQueue.js';

let schedulerTimer: NodeJS.Timeout | null = null;
let isRunning = false;

let deliveryTimer: NodeJS.Timeout | null = null;
let isDeliveryRunning = false;
let lastPruneAt = 0;

/** 1回の再送処理で扱う最大件数 */
const DELIVERY_BATCH_LIMIT = 50;
/** 古いキュー行を掃除する間隔 */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 期限に達した予約投稿を処理
 */
export async function processScheduledPosts(): Promise<number> {
  if (isRunning) return 0;
  isRunning = true;

  let processedCount = 0;
  try {
    const nowIso = new Date().toISOString();
    const pendingPosts = await db.prepare(`
      SELECT * FROM scheduled_posts
      WHERE status = 'pending' AND scheduled_at <= ?
      ORDER BY scheduled_at ASC
      LIMIT 20
    `).all(nowIso) as unknown as ScheduledPostRow[];

    if (!pendingPosts || pendingPosts.length === 0) {
      isRunning = false;
      return 0;
    }

    console.log(`[Scheduler] ⏰ Found ${pendingPosts.length} scheduled posts ready to publish...`);

    for (const item of pendingPosts) {
      try {
        const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(item.user_id) as UserRow | undefined;
        if (!user) {
          await db.prepare('UPDATE scheduled_posts SET status = "failed", error_message = "ユーザーが見つかりません" WHERE id = ?').run(item.id);
          continue;
        }

        if (user.is_frozen === 1) {
          await db.prepare('UPDATE scheduled_posts SET status = "failed", error_message = "アカウントが凍結されているため投稿をキャンセルしました" WHERE id = ?').run(item.id);
          continue;
        }

        let parsedAttachments: any[] = [];
        try {
          if (item.media_attachments) {
            parsedAttachments = JSON.parse(item.media_attachments);
          }
        } catch {}

        let parsedPoll: any = null;
        try {
          if (item.poll) {
            parsedPoll = JSON.parse(item.poll);
          }
        } catch {}

        const result = await executeCreatePost({
          user,
          content: item.content,
          cw: item.cw || null,
          visibility: (item.visibility as 'public' | 'local') || 'public',
          attachments: parsedAttachments,
          poll: parsedPoll,
          in_reply_to: item.in_reply_to || null,
          quote_id: item.quote_id || null,
        });

        // 成功ステータスに更新
        await db.prepare(`
          UPDATE scheduled_posts 
          SET status = 'published', published_post_id = ?, error_message = ''
          WHERE id = ?
        `).run(result.post.id, item.id);

        processedCount++;
        console.log(`[Scheduler] ✅ Scheduled post published successfully: ${item.id} -> ${result.post.id}`);

        // ユーザーに予約投稿完了通知を送信
        await createNotification({
          userId: user.id,
          type: 'scheduled_published',
          actorId: user.id,
          actorName: user.name,
          actorHandle: `@${user.id}`,
          actorIcon: user.icon_url || '',
          postId: result.post.id,
          postContent: item.content,
          content: '予約されていたノートが予定時刻に自動公開されました。',
        });
      } catch (err: any) {
        console.error(`[Scheduler Error] Failed to publish scheduled post ${item.id}:`, err);
        await db.prepare(`
          UPDATE scheduled_posts 
          SET status = 'failed', error_message = ?
          WHERE id = ?
        `).run(err.message || '投稿処理中にエラーが発生しました', item.id);
      }
    }
  } catch (err) {
    console.error('[Scheduler Error] Error in processScheduledPosts:', err);
  } finally {
    isRunning = false;
  }

  return processedCount;
}

/**
 * 📮 配送再送キューを処理する
 *
 * 一時的な失敗（ネットワークエラー / 5xx / 429 など）で溜まった配送を
 * 指数バックオフの予定に従って再送する。成功したら配信済み、恒久的な失敗や
 * 試行回数の上限に達したものは失敗として確定させる。
 */
export async function processDeliveryQueue(): Promise<number> {
  if (isDeliveryRunning) return 0;
  isDeliveryRunning = true;

  let deliveredCount = 0;
  try {
    // 1時間に1回、古い行（配信済み・失敗確定）を掃除する
    if (Date.now() - lastPruneAt > PRUNE_INTERVAL_MS) {
      lastPruneAt = Date.now();
      await pruneDeliveries();
    }

    const due = await listDueDeliveries(DELIVERY_BATCH_LIMIT);
    if (due.length === 0) {
      return 0;
    }

    console.log(`[Delivery Queue] 🔁 再送の期限が来た配送を処理します (${due.length}件)...`);

    for (const row of due) {
      try {
        let activity: any;
        try {
          activity = JSON.parse(row.activity);
        } catch {
          await markDeliveryDead(row, { error: '保存された Activity を解析できませんでした' });
          continue;
        }

        // 送信元ユーザー（署名鍵）を解決する。インスタンスアクターなら不要
        let senderUser: UserRow | undefined;
        if (!row.use_instance_actor && row.sender_user_id) {
          senderUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(row.sender_user_id) as UserRow | undefined;
          if (!senderUser) {
            await markDeliveryDead(row, { error: '送信元ユーザーが存在しません' });
            continue;
          }
        }

        const result = await attemptDelivery({
          inboxUrl: row.inbox_url,
          activity,
          senderUser,
          useInstanceActor: Boolean(row.use_instance_actor),
        });

        if (result.ok) {
          await markDeliveryDelivered(row.id);
          deliveredCount++;
          console.log(`[Delivery Queue] ✅ 再送に成功: ${row.activity_type || 'Activity'} -> ${row.inbox_url}`);
          continue;
        }

        if (!result.retryable) {
          await markDeliveryDead(row, { status: result.status, error: result.error });
          console.warn(`[Delivery Queue] ⛔ 再送を断念（恒久的な失敗）: ${row.inbox_url} (${result.error})`);
          continue;
        }

        const outcome = await markDeliveryFailed(row, { status: result.status, error: result.error });
        if (outcome.dead) {
          console.warn(`[Delivery Queue] 💀 試行回数の上限に達したため断念: ${row.inbox_url} (${row.attempts + 1}回失敗)`);
        } else {
          console.log(
            `[Delivery Queue] ⏳ 再送を予約: ${row.inbox_url} (${row.attempts + 1}回目の失敗 / 次回 ${outcome.nextAttemptAt})`,
          );
        }
      } catch (err) {
        console.error(`[Delivery Queue] 再送処理でエラー (${row.inbox_url}):`, err);
      }
    }
  } catch (err) {
    console.error('[Delivery Queue] Error in processDeliveryQueue:', err);
  } finally {
    isDeliveryRunning = false;
  }

  return deliveredCount;
}

/**
 * 予約投稿スケジューラの起動 (10秒間隔でポーリング)
 */
export function startScheduler(intervalMs = 10000): void {
  if (schedulerTimer) return;
  console.log(`[Scheduler] ⏱️ Scheduled post background worker started (interval: ${intervalMs}ms)`);
  schedulerTimer = setInterval(() => {
    processScheduledPosts().catch((err) => {
      console.error('[Scheduler Interval Error]:', err);
    });
    // 予約時刻を過ぎていれば 1 日 1 回だけ自動整理を実行する（実行可否は内部で判定）
    maybeRunScheduledMaintenance().catch((err) => {
      console.error('[Auto Maintenance Error]:', err);
    });
  }, intervalMs);
}

/**
 * 配送再送ワーカーの起動 (既定 60秒間隔でポーリング)
 */
export function startDeliveryQueueWorker(intervalMs = 60000): void {
  if (deliveryTimer) return;
  console.log(`[Delivery Queue] ⏱️ 配送再送ワーカーを開始しました (interval: ${intervalMs}ms)`);
  deliveryTimer = setInterval(() => {
    processDeliveryQueue().catch((err) => {
      console.error('[Delivery Queue Interval Error]:', err);
    });
  }, intervalMs);
}

/**
 * スケジューラの停止
 */
export function stopScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log('[Scheduler] ⏹️ Scheduler stopped');
  }
  if (deliveryTimer) {
    clearInterval(deliveryTimer);
    deliveryTimer = null;
    console.log('[Delivery Queue] ⏹️ 配送再送ワーカーを停止しました');
  }
}
