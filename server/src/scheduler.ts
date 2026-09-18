import { db, UserRow, ScheduledPostRow, createNotification } from './db.js';
import { executeCreatePost } from './postService.js';

let schedulerTimer: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * 期限に達した予約投稿を処理
 */
export async function processScheduledPosts(): Promise<number> {
  if (isRunning) return 0;
  isRunning = true;

  let processedCount = 0;
  try {
    const nowIso = new Date().toISOString();
    const pendingPosts = db.prepare(`
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
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(item.user_id) as UserRow | undefined;
        if (!user) {
          db.prepare('UPDATE scheduled_posts SET status = "failed", error_message = "ユーザーが見つかりません" WHERE id = ?').run(item.id);
          continue;
        }

        if (user.is_frozen === 1) {
          db.prepare('UPDATE scheduled_posts SET status = "failed", error_message = "アカウントが凍結されているため投稿をキャンセルしました" WHERE id = ?').run(item.id);
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
        db.prepare(`
          UPDATE scheduled_posts 
          SET status = 'published', published_post_id = ?, error_message = ''
          WHERE id = ?
        `).run(result.post.id, item.id);

        processedCount++;
        console.log(`[Scheduler] ✅ Scheduled post published successfully: ${item.id} -> ${result.post.id}`);

        // ユーザーに予約投稿完了通知を送信
        createNotification({
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
        db.prepare(`
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
 * 予約投稿スケジューラの起動 (10秒間隔でポーリング)
 */
export function startScheduler(intervalMs = 10000): void {
  if (schedulerTimer) return;
  console.log(`[Scheduler] ⏱️ Scheduled post background worker started (interval: ${intervalMs}ms)`);
  schedulerTimer = setInterval(() => {
    processScheduledPosts().catch((err) => {
      console.error('[Scheduler Interval Error]:', err);
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
}
