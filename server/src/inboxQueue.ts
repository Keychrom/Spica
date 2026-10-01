import { db } from './db.js';
import { enqueueJob, registerJobHandler, getJobStats } from './jobs.js';
import { broadcastNote, broadcastReaction, broadcastAnnounce, broadcastPoll } from './streaming.js';
import { config } from './config.js';

/**
 * 受信（Inbox）の非同期処理。
 *
 * ## なぜ要るか
 *
 * 受信の処理（DB と FTS への書き込み・アンテナの照合・通知・配信の積み込み）は
 * これまで**リクエストの中で**終わらせていた。リレーの burst が来ると、その処理が
 * Web の応答と同じスレッドを奪い、**画面が 4ms → 190ms まで遅くなる**
 * （docs/SCALE.md の「受信の burst」）。しかもこの遅さは**読みの組み立てではなく
 * イベントループの占有**なので、読み取りキャッシュでは消せない（同・2026-10-01 の再計測）。
 *
 * そこで **署名検証と形式の検査だけリクエスト内で済ませ、中身は worker に任せる**。
 * Web プロセスは 202 を返してすぐ次の要求を捌ける。
 *
 * ## 順序を壊さない仕組み
 *
 * 1. **アクターごとの FIFO**（`group_key`）— 同じアクターの先行ジョブが待機中/実行中なら
 *    後続は掴めない（`claimJobInOrder`）。Create → Delete / Update が入れ替わらない。
 * 2. **墓標**（`deleted_remote_posts`）— Delete を記録し、遅れて処理される Create は捨てる。
 *    FIFO が効かない場面（別プロセスの同時実行・再送・リレーの折り返し）の保険で、
 *    **消したはずの投稿が復活する**のを防ぐ。
 *
 * ## 受け入れの意味
 *
 * 同期のときは処理が終わってから 201 を返していた。非同期では**受理した時点で 202** を返し、
 * 中身は後で処理する（失敗したら指数バックオフで再試行し、それでも駄目なら `failed` に残る）。
 * 署名の検証だけは前段で済ませる（後ろに回すと、悪意ある送信者がキューを埋められる）。
 */

export const INBOX_JOB_KIND = 'inbox_activity';

/** 受信の処理そのもの（inbox.ts が登録する。循環 import を避けるため実行時に関数を渡す） */
export type InboxProcessor = (
  activity: any,
  options: { targetUsername?: string; actorUrl: string; forwardedBy?: string },
) => Promise<number>;

let processor: InboxProcessor | null = null;

/** 受信の処理を登録する（inbox.ts から呼ぶ） */
export function registerInboxProcessor(fn: InboxProcessor): void {
  processor = fn;
}

/** キューに積む（Web プロセス側）。積めたら true */
export async function enqueueInboxActivity(
  activity: any,
  options: { actorUrl: string; targetUsername?: string; forwardedBy?: string },
): Promise<boolean> {
  const id = await enqueueJob(
    INBOX_JOB_KIND,
    {
      activity,
      actorUrl: options.actorUrl,
      targetUsername: options.targetUsername,
      forwardedBy: options.forwardedBy,
    },
    {
      // 同じアクターの活動は順序を守る（Create → Delete の入れ替わりを防ぐ）
      groupKey: options.actorUrl,
      // 一時的な失敗（DB が混んでいる等）は指数バックオフで再試行する。
      // 回数は配送より短めにする（受信は相手が再送もしてくれる）
      maxAttempts: 4,
    },
  );
  return Boolean(id);
}

/** 受信ジョブの処理を jobs に登録する（モジュール読み込み時に 1 回） */
export function registerInboxJobHandler(): void {
  registerJobHandler(INBOX_JOB_KIND, async (payload: any) => {
    if (!processor) throw new Error('受信の処理が登録されていません');
    const activity = payload?.activity;
    const actorUrl = String(payload?.actorUrl || '');
    if (!activity || !actorUrl) {
      console.warn('[Inbox Queue] ⚠️ 中身が欠けたジョブを捨てます');
      return;
    }

    const status = await processor(activity, {
      actorUrl,
      targetUsername: payload?.targetUsername,
      forwardedBy: payload?.forwardedBy,
    });

    // 5xx は「今は処理できない」＝再試行に回す（4xx 相当は捨てる）
    if (status >= 500) {
      throw new Error(`受信の処理に失敗しました (status=${status})`);
    }
    if (config.inboxAsyncVerbose || status >= 400) {
      console.log(`[Inbox Queue] ${activity.type} from ${actorUrl} → ${status}`);
    }
  });
}

/** キューの滞留（`/health` に出す） */
export async function getInboxQueueStats(): Promise<{ pending: number; running: number; failed: number; oldestPendingAt: string | null }> {
  const stats = await getJobStats();
  // 種類ごとの内訳は jobs から直接引く（全体の件数は他種別と混ざるため）
  try {
    const one = async (status: string): Promise<number> =>
      Number(
        (
          (await db
            .prepare('SELECT COUNT(*) AS c FROM jobs WHERE kind = ? AND status = ?')
            .get(INBOX_JOB_KIND, status)) as { c: number }
        ).c,
      );
    const oldest = (await db
      .prepare("SELECT next_attempt_at FROM jobs WHERE kind = ? AND status = 'pending' ORDER BY next_attempt_at ASC LIMIT 1")
      .get(INBOX_JOB_KIND)) as { next_attempt_at: string } | undefined;
    return {
      pending: await one('pending'),
      running: await one('running'),
      failed: await one('failed'),
      oldestPendingAt: oldest?.next_attempt_at ?? null,
    };
  } catch {
    return { pending: 0, running: 0, failed: 0, oldestPendingAt: stats.oldestPendingAt };
  }
}

/**
 * 墓標を立てる（リモート投稿を削除したとき）。
 * 連合では Delete の後に同じ投稿が再送されてくることがあるので、記録が無いと復活する。
 */
export async function addDeletedRemotePost(postId: string): Promise<void> {
  if (!postId) return;
  try {
    await db
      .prepare('INSERT INTO deleted_remote_posts (id, deleted_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING')
      .run(postId, new Date().toISOString());
  } catch (err) {
    console.warn('[Inbox Queue] 墓標の記録に失敗:', (err as any)?.message || err);
  }
}

/** 墓標が立っているか（受信の取り込み時に見る） */
export async function isDeletedRemotePost(postId: string | null | undefined): Promise<boolean> {
  if (!postId) return false;
  try {
    const row = await db.prepare('SELECT id FROM deleted_remote_posts WHERE id = ?').get(postId);
    return Boolean(row);
  } catch {
    return false;
  }
}

/** 古い墓標を掃除する（保持期間より古いものは、もう再送されてこない） */
export async function pruneDeletedRemotePosts(olderThanDays = 90): Promise<number> {
  if (olderThanDays <= 0) return 0;
  try {
    const cutoff = new Date(Date.now() - olderThanDays * 86400_000).toISOString();
    const result = await db.prepare('DELETE FROM deleted_remote_posts WHERE deleted_at < ?').run(cutoff);
    return Number(result.changes ?? 0);
  } catch {
    return 0;
  }
}

// streaming を再輸出しておく（受信の処理を worker から呼ぶときに使う）
export { broadcastNote, broadcastReaction, broadcastAnnounce, broadcastPoll };
