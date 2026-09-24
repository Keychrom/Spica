import { db, UserRow, ScheduledPostRow, createNotification } from './db.js';
import { config } from './config.js';
import { executeCreatePost } from './postService.js';
import { attemptDelivery } from './activitypub.js';
import { maybeRunScheduledMaintenance } from './maintenanceService.js';
import { runExclusively } from './redis.js';
import { runWithConcurrency, runJobsOnce, getJobKinds } from './jobs.js';
import {
  listDueDeliveries,
  markDeliveryDelivered,
  markDeliveryFailed,
  markDeliveryDead,
  pruneDeliveries,
  claimDelivery,
  reclaimStaleDeliveries,
  type OutboxDeliveryRow,
} from './deliveryQueue.js';

let schedulerTimer: NodeJS.Timeout | null = null;
let isRunning = false;

let deliveryTimer: NodeJS.Timeout | null = null;
let jobTimer: NodeJS.Timeout | null = null;
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
/**
 * 1 件の配送を処理する。**先に「自分がやる」と宣言**してから送る
 * （宣言に失敗した行は、他のプロセス・他のワーカーが担当している）。
 */
async function deliverOne(row: OutboxDeliveryRow): Promise<boolean> {
  if (!(await claimDelivery(row.id))) return false;

  try {
    let activity: any;
    try {
      activity = JSON.parse(row.activity);
    } catch {
      await markDeliveryDead(row, { error: '保存された Activity を解析できませんでした' });
      return false;
    }

    // 送信元ユーザー（署名鍵）を解決する。インスタンスアクターなら不要
    let senderUser: UserRow | undefined;
    if (!row.use_instance_actor && row.sender_user_id) {
      senderUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(row.sender_user_id) as UserRow | undefined;
      if (!senderUser) {
        await markDeliveryDead(row, { error: '送信元ユーザーが存在しません' });
        return false;
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
      console.log(`[Delivery Queue] ✅ 再送に成功: ${row.activity_type || 'Activity'} -> ${row.inbox_url}`);
      return true;
    }

    if (!result.retryable) {
      await markDeliveryDead(row, { status: result.status, error: result.error });
      console.warn(`[Delivery Queue] ⛔ 再送を断念（恒久的な失敗）: ${row.inbox_url} (${result.error})`);
      return false;
    }

    const outcome = await markDeliveryFailed(row, { status: result.status, error: result.error });
    if (outcome.dead) {
      console.warn(`[Delivery Queue] 💀 試行回数の上限に達したため断念: ${row.inbox_url} (${row.attempts + 1}回失敗)`);
    } else {
      console.log(
        `[Delivery Queue] ⏳ 再送を予約: ${row.inbox_url} (${row.attempts + 1}回目の失敗 / 次回 ${outcome.nextAttemptAt})`,
      );
    }
    return false;
  } catch (err) {
    console.error(`[Delivery Queue] 再送処理でエラー (${row.inbox_url}):`, err);
    return false;
  }
}

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

    // 落ちたプロセスが掴んだままの行を戻す（`delivering` のまま残ったもの）
    const reclaimed = await reclaimStaleDeliveries();
    if (reclaimed > 0) console.warn(`[Delivery Queue] ♻️ 滞留していた配送を待機中に戻しました: ${reclaimed}件`);

    const due = await listDueDeliveries(DELIVERY_BATCH_LIMIT);
    if (due.length === 0) {
      return 0;
    }

    console.log(`[Delivery Queue] 🔁 再送の期限が来た配送を処理します (${due.length}件)...`);

    // 配送はネットワーク待ちが主なので、同時に複数送る（相手サーバーごとに遅い速いが違う）。
    // 同じ行を二重に送らないことは claimDelivery が保証する
    const results = await runWithConcurrency(due, config.deliveryConcurrency, deliverOne);
    deliveredCount = results.filter(Boolean).length;
  } catch (err) {
    console.error('[Delivery Queue] Error in processDeliveryQueue:', err);
  } finally {
    isDeliveryRunning = false;
  }

  return deliveredCount;
}

/**
 * 予約投稿スケジューラの起動 (10秒間隔でポーリング)
 *
 * 複数プロセスで動かすとき（Redis あり）は、**1 プロセスだけ**が 1 回分を実行する。
 * そうしないと同じ予約投稿を二重に公開してしまう。
 */
export function startScheduler(intervalMs = 10000): void {
  if (schedulerTimer) return;
  console.log(`[Scheduler] ⏱️ Scheduled post background worker started (interval: ${intervalMs}ms)`);
  schedulerTimer = setInterval(() => {
    void runExclusively('scheduler', 60_000, async () => {
      await processScheduledPosts();
      // 予約時刻を過ぎていれば 1 日 1 回だけ自動整理を実行する（実行可否は内部で判定）
      await maybeRunScheduledMaintenance();
    }).catch((err) => {
      console.error('[Scheduler Interval Error]:', err);
    });
  }, intervalMs);
}

/**
 * 配送再送ワーカーの起動 (既定 60秒間隔でポーリング)
 *
 * 複数プロセスで動かしても**二重送信にはならない**。1 件ずつ `claimDelivery` で
 * 「自分が送る」と宣言してから送るため（Redis のロックは要らない＝並列に送れる）。
 */
export function startDeliveryQueueWorker(intervalMs = 60000): void {
  if (deliveryTimer) return;
  console.log(`[Delivery Queue] ⏱️ 配送再送ワーカーを開始しました (interval: ${intervalMs}ms, 同時実行: ${config.deliveryConcurrency})`);
  deliveryTimer = setInterval(() => {
    void processDeliveryQueue().catch((err) => {
      console.error('[Delivery Queue Interval Error]:', err);
    });
  }, intervalMs);
}

/**
 * ジョブキュー（汎用の背景処理）の起動 (既定 15秒間隔でポーリング)
 *
 * 登録されている種類ごとに 1 回分を実行する。複数プロセスで動かしても
 * `claimJob` が 1 つしか取らないので二重実行にはならない。
 */
export function startJobWorker(intervalMs = 15000): void {
  if (jobTimer) return;
  const kinds = getJobKinds();
  if (kinds.length === 0) return;
  console.log(`[Jobs] ⏱️ ジョブワーカーを開始しました (interval: ${intervalMs}ms, 種類: ${kinds.join(', ')})`);
  jobTimer = setInterval(() => {
    void (async () => {
      for (const kind of getJobKinds()) {
        try {
          const result = await runJobsOnce(kind, { limit: 20, concurrency: 3 });
          if (result.processed > 0) {
            console.log(`[Jobs] 🧰 ${kind}: 実行 ${result.processed} 件（成功 ${result.ok} / 失敗 ${result.failed}）`);
          }
        } catch (err) {
          console.error(`[Jobs] ジョブの実行でエラー (${kind}):`, err);
        }
      }
    })();
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
  if (jobTimer) {
    clearInterval(jobTimer);
    jobTimer = null;
    console.log('[Jobs] ⏹️ ジョブワーカーを停止しました');
  }
}
