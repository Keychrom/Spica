import crypto from 'node:crypto';
import { db } from './db.js';

/**
 * 🔧 汎用のジョブキュー
 *
 * これまで「予約投稿」「配送の再送」「自動メンテナンス」がそれぞれタイマーを持っていた。
 * 同じ形のものを毎回作り直さないよう、**汎用のテーブル 1 つ + ワーカー**にまとめる。
 *
 * 設計の要点:
 *   - **取り出しは条件付き UPDATE で宣言する**（`claimJob`）。取れるのは 1 つだけなので、
 *     複数プロセス・複数ワーカーで動かしても同じ仕事を二重に実行しない
 *     （`FOR UPDATE SKIP LOCKED` は PostgreSQL 専用なので使わない。SQLite でも同じコードで動く）
 *   - 失敗したら**指数バックオフで再試行**し、上限に達したら `failed` で確定する
 *   - 処理中（`running`）のまま残った行は**古くなったら待機中に戻す**（プロセスが落ちたときのため）
 *   - 同じ仕事を何度も積まないように `dedupeKey` を付けられる（`dedupeKey` は完了時に外す）
 *   - Redis は要らない。DB があるところで動く（複数プロセスの並列化も DB の条件付き UPDATE で足りる）
 */

/** 再試行の待ち時間（失敗回数に応じた指数バックオフ） */
export const JOB_BACKOFF_MS: number[] = [
  30 * 1000, // 30秒
  2 * 60 * 1000, // 2分
  10 * 60 * 1000, // 10分
  30 * 60 * 1000, // 30分
];

/** 既定の試行回数（初回 + 再試行） */
export const DEFAULT_JOB_MAX_ATTEMPTS = JOB_BACKOFF_MS.length + 1;

/** 処理中のまま残った行を戻すまでの時間 */
const STALE_JOB_MS = 10 * 60 * 1000;

export interface JobRow {
  id: string;
  kind: string;
  payload: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string;
  dedupe_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobStats {
  pending: number;
  running: number;
  done: number;
  failed: number;
  /** 一番古い待機中の予定時刻（滞留の目安） */
  oldestPendingAt: string | null;
}

/** ジョブの種類ごとの処理。モジュールの読み込み時に登録する */
const handlers = new Map<string, (payload: any) => Promise<void>>();

export function registerJobHandler(kind: string, handler: (payload: any) => Promise<void>): void {
  handlers.set(kind, handler);
}

/** 登録済みの種類（検査と運用の確認用） */
export function getJobKinds(): string[] {
  return [...handlers.keys()];
}

export interface EnqueueOptions {
  /** 同じキーの仕事が動いている間は積まない（完了時に外れる） */
  dedupeKey?: string;
  /** 実行を遅らせる（ミリ秒） */
  delayMs?: number;
  maxAttempts?: number;
}

/** 仕事を積む。既に同じ `dedupeKey` が動いていれば積まずに null を返す */
export async function enqueueJob(kind: string, payload: unknown, options: EnqueueOptions = {}): Promise<string | null> {
  if (!handlers.has(kind)) {
    console.warn(`[Jobs] ⚠️ 未登録のジョブ種別です: ${kind}`);
    return null;
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const id = `job_${now.getTime()}_${crypto.randomBytes(4).toString('hex')}`;

  try {
    if (options.dedupeKey) {
      // 動いている（または待っている）同じ仕事があれば積まない。
      // 厳密な排他ではないが、二重に積んでも害が無い仕事（プレビュー取得など）を想定している
      const existing = (await db
        .prepare("SELECT id FROM jobs WHERE dedupe_key = ? AND status IN ('pending', 'running') LIMIT 1")
        .get(options.dedupeKey)) as { id: string } | undefined;
      if (existing) return null;
    }

    await db.prepare(`
      INSERT INTO jobs (id, kind, payload, status, attempts, max_attempts, next_attempt_at, last_error, dedupe_key, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?, ?, '', ?, ?, ?)
    `).run(
      id,
      kind,
      JSON.stringify(payload ?? null),
      Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS)),
      new Date(now.getTime() + Math.max(0, options.delayMs ?? 0)).toISOString(),
      options.dedupeKey ?? null,
      nowIso,
      nowIso,
    );
    return id;
  } catch (err) {
    console.error('[Jobs] ❌ ジョブの登録に失敗:', err);
    return null;
  }
}

/** 実行の期限が来ているジョブ（古い順） */
export async function listDueJobs(kind: string, limit = 20): Promise<JobRow[]> {
  try {
    return (await db
      .prepare(`
        SELECT * FROM jobs
        WHERE kind = ? AND status = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC
        LIMIT ?
      `)
      .all(kind, new Date().toISOString(), limit)) as unknown as JobRow[];
  } catch (err) {
    console.error('[Jobs] ❌ 実行対象の取得に失敗:', err);
    return [];
  }
}

/**
 * 1 件を「自分が実行する」と宣言する（取れるのは 1 つだけ）。
 * 戻り値の `attempts` は**加算後**の値（取り出し時の値を使うと、上限の判定が 1 回ずれる）。
 */
export async function claimJob(id: string): Promise<{ claimed: boolean; attempts: number }> {
  try {
    const result = await db.prepare(
      "UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'",
    ).run(new Date().toISOString(), id);
    if (Number(result.changes ?? 0) !== 1) return { claimed: false, attempts: 0 };
    const fresh = (await db.prepare('SELECT attempts FROM jobs WHERE id = ?').get(id)) as { attempts: number } | undefined;
    return { claimed: true, attempts: Number(fresh?.attempts ?? 1) };
  } catch (err) {
    console.error('[Jobs] ❌ ジョブの割り当てに失敗:', err);
    return { claimed: false, attempts: 0 };
  }
}

/** 成功として確定する（`dedupeKey` を外して、次に同じ仕事を積めるようにする） */
export async function finishJob(id: string): Promise<void> {
  try {
    await db.prepare("UPDATE jobs SET status = 'done', last_error = '', dedupe_key = NULL, updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
  } catch (err) {
    console.error('[Jobs] ❌ 完了の記録に失敗:', err);
  }
}

/** 失敗を記録する（残りがあればバックオフして再試行、尽きたら確定） */
export async function failJob(row: JobRow, error: unknown): Promise<{ dead: boolean; nextAttemptAt: string | null }> {
  const message = String((error as any)?.message || error || '').slice(0, 500);
  const attempts = Number(row.attempts);
  try {
    if (attempts >= Number(row.max_attempts)) {
      await db.prepare("UPDATE jobs SET status = 'failed', last_error = ?, dedupe_key = NULL, updated_at = ? WHERE id = ?").run(
        message,
        new Date().toISOString(),
        row.id,
      );
      return { dead: true, nextAttemptAt: null };
    }
    const delay = JOB_BACKOFF_MS[Math.min(attempts - 1, JOB_BACKOFF_MS.length - 1)];
    const next = new Date(Date.now() + delay).toISOString();
    await db.prepare("UPDATE jobs SET status = 'pending', last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?").run(
      message,
      next,
      new Date().toISOString(),
      row.id,
    );
    return { dead: false, nextAttemptAt: next };
  } catch (err) {
    console.error('[Jobs] ❌ 失敗の記録に失敗:', err);
    return { dead: false, nextAttemptAt: null };
  }
}

/** 処理中（`running`）のまま残ったジョブを待機中に戻す */
export async function reclaimStaleJobs(olderThanMs = STALE_JOB_MS): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const result = await db.prepare(
      "UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'running' AND updated_at < ?",
    ).run(new Date().toISOString(), cutoff);
    return Number(result.changes ?? 0);
  } catch (err) {
    console.error('[Jobs] ❌ 滞留したジョブの復帰に失敗:', err);
    return 0;
  }
}

/** 件数の集計（`/health` と管理画面で使う） */
export async function getJobStats(): Promise<JobStats> {
  try {
    const count = async (status: string): Promise<number> =>
      Number(((await db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE status = ?').get(status)) as { c: number }).c);
    const oldest = (await db
      .prepare("SELECT next_attempt_at FROM jobs WHERE status = 'pending' ORDER BY next_attempt_at ASC LIMIT 1")
      .get()) as { next_attempt_at: string } | undefined;
    return {
      pending: await count('pending'),
      running: await count('running'),
      done: await count('done'),
      failed: await count('failed'),
      oldestPendingAt: oldest?.next_attempt_at ?? null,
    };
  } catch {
    return { pending: 0, running: 0, done: 0, failed: 0, oldestPendingAt: null };
  }
}

/** 配列を上限つきの並列で処理する（順番は保たれる） */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
  let next = 0;

  const runners = Array.from({ length: width }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

export interface RunJobsResult {
  processed: number;
  ok: number;
  failed: number;
}

/**
 * 期限が来ているジョブを 1 回分実行する。
 * `concurrency` で同時に走らせる数、`limit` で 1 回に取り出す数を決める。
 */
export async function runJobsOnce(
  kind: string,
  options: { limit?: number; concurrency?: number } = {},
): Promise<RunJobsResult> {
  const handler = handlers.get(kind);
  if (!handler) throw new Error(`未登録のジョブ種別です: ${kind}`);

  await reclaimStaleJobs();
  const due = await listDueJobs(kind, options.limit ?? 20);
  const outcomes = await runWithConcurrency(due, options.concurrency ?? 3, async (row) => {
    const claim = await claimJob(row.id);
    if (!claim.claimed) return null; // 他のワーカーが取った
    // 試行回数はclaimで加算されているので、判定にはその値を使う
    const current: JobRow = { ...row, attempts: claim.attempts };
    try {
      const payload = JSON.parse(row.payload || 'null');
      await handler(payload);
      await finishJob(row.id);
      return true;
    } catch (err) {
      const outcome = await failJob(current, err);
      console.warn(
        `[Jobs] ⚠️ ${kind} の実行に失敗 (${row.id}, ${current.attempts}/${current.max_attempts}): ${(err as any)?.message || err}` +
          (outcome.dead ? '（再試行しません）' : `（次回 ${outcome.nextAttemptAt}）`),
      );
      return false;
    }
  });

  const ran = outcomes.filter((o) => o !== null);
  return {
    processed: ran.length,
    ok: ran.filter((o) => o === true).length,
    failed: ran.filter((o) => o === false).length,
  };
}
