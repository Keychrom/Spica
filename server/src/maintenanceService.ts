import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { adb, db, getServerSetting, setServerSetting } from './db.js';
import { config } from './config.js';
import {
  DEFAULT_MAINTENANCE_OPTIONS,
  applyRemotePostRemoval,
  backupDatabase,
  getDbSizeInfo,
  planRemotePostRemoval,
  rotateBackups,
} from './dbMaintenance.js';
import { getMediaQuotaBytes } from './mediaService.js';
import { getProxyStats, pruneProxyCache } from './imageProxy.js';
import { applyAnnouncePolicy, applyFtsPolicy, getFtsIndexScope, getRemoteAnnouncePolicy } from './searchPolicy.js';

/**
 * 運用の自動化（サーバー常駐プロセス側）
 *
 *   ・毎日 1 回、保持期間を超えたリモート投稿を削除する（VACUUM は手動のまま）
 *   ・削除の前に VACUUM INTO でバックアップを取る（既定 3 世代）
 *   ・保存・索引の方針（searchPolicy）を適用する
 *
 * VACUUM（領域の解放）は DB の排他ロックが要るため自動では行わない。
 * サーバーを停止して `npm run db:maintenance -- --apply` を実行する。
 */

export interface MaintenanceStats {
  db: {
    sizeBytes: number;
    walBytes: number;
    pageCount: number;
    freelistCount: number;
  };
  posts: {
    total: number;
    local: number;
    remote: number;
    /** 保持期間を超えていて次回の自動整理で削除される件数 */
    prunableRemote: number;
    ftsRows: number;
  };
  announces: number;
  media: {
    count: number;
    bytes: number;
    quotaBytes: number;
  };
  /** 画像プロキシのキャッシュ（リモート画像の直リンク解消） */
  imageProxy: {
    enabled: boolean;
    files: number;
    bytes: number;
    maxBytes: number;
    ttlDays: number;
  };
  policy: {
    ftsIndexScope: string;
    remoteAnnouncePolicy: string;
    retentionDays: number;
  };
  automation: {
    enabled: boolean;
    hour: number;
    lastRunAt: string | null;
    backupEnabled: boolean;
  };
  backups: {
    count: number;
    latestAt: string | null;
  };
}

const LAST_RUN_KEY = 'last_auto_maintenance';
const isRunningFlag = { value: false };

function backupDir(): string {
  return path.resolve(path.dirname(config.dbPath), 'data/backups');
}

function readBackups(): { count: number; latestAt: string | null } {
  const dir = backupDir();
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sqlite'))
      .map((f) => fs.statSync(path.join(dir, f)).mtimeMs)
      .sort((a, b) => b - a);
    return { count: files.length, latestAt: files.length > 0 ? new Date(files[0]).toISOString() : null };
  } catch {
    return { count: 0, latestAt: null };
  }
}

/** 自動整理が有効か（既定 true） */
export function isAutoMaintenanceEnabled(): boolean {
  const stored = getServerSetting('auto_maintenance', '');
  if (stored) return stored === 'true';
  return config.autoMaintenance !== false;
}

export function getAutoMaintenanceHour(): number {
  const stored = getServerSetting('auto_maintenance_hour', '');
  const parsed = parseInt(stored || String(config.autoMaintenanceHour), 10);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 23 ? parsed : 4;
}

export function getLastAutoMaintenanceAt(): string | null {
  return getServerSetting(LAST_RUN_KEY, '') || null;
}

export function setAutoMaintenanceEnabled(enabled: boolean): boolean {
  setServerSetting('auto_maintenance', enabled ? 'true' : 'false');
  return enabled;
}

/**
 * 予定時刻（既定 4 時）を過ぎていて、まだ今日実行していなければ実行する。
 * scheduler から毎回呼ばれる想定（実行可否は自分で判断する）。
 */
export async function maybeRunScheduledMaintenance(now = new Date()): Promise<boolean> {
  if (!isAutoMaintenanceEnabled()) return false;
  if (isRunningFlag.value) return false;

  const hour = getAutoMaintenanceHour();
  if (now.getHours() < hour) return false;

  const lastRun = getLastAutoMaintenanceAt();
  if (lastRun) {
    const last = new Date(lastRun);
    if (last.toDateString() === now.toDateString()) return false; // 今日は実行済み
  }

  isRunningFlag.value = true;
  try {
    await runScheduledMaintenance();
    setServerSetting(LAST_RUN_KEY, new Date().toISOString());
    return true;
  } finally {
    isRunningFlag.value = false;
  }
}

/** 予約された整理処理を今すぐ実行する（テスト・手動実行用） */
export async function runScheduledMaintenance(): Promise<{
  backup: { path: string; bytes: number } | null;
  removedPosts: number;
  fts: { toUnindex: number; toIndex: number };
  announces: { toRemove: number };
  proxyCache: { removed: number; freedBytes: number };
}> {
  const started = Date.now();
  const options = { ...DEFAULT_MAINTENANCE_OPTIONS, retentionDays: config.remotePostRetentionDays, applyPolicy: true };
  console.log('[Auto Maintenance] 🧹 定期メンテナンスを開始します...');

  // ① バックアップ（既定で有効）
  let backup: { path: string; bytes: number } | null = null;
  // バックアップは SQLite 専用（PostgreSQL は pg_dump を使う。docs/POSTGRESQL.md）
  if (config.autoBackup !== false && db.kind === 'sqlite') {
    try {
      const result = backupDatabase(db as unknown as DatabaseSync, config.dbPath, backupDir());
      const removed = rotateBackups(backupDir(), config.backupsKeep);
      backup = { path: result.path, bytes: result.bytes };
      console.log(
        `[Auto Maintenance] 💾 バックアップ: ${path.basename(result.path)} (${(result.bytes / 1024 / 1024).toFixed(1)}MB)` +
          (removed.length > 0 ? ` / 古い世代を削除: ${removed.length} 件` : ''),
      );
    } catch (err: any) {
      console.error('[Auto Maintenance] バックアップに失敗しました:', err?.message || err);
    }
  }

  // ② 保存・索引の方針を適用（設定変更やアップデート後の追いつき）
  let fts = { toUnindex: 0, toIndex: 0 };
  let announces = { toRemove: 0 };
  try {
    const ftsResult = applyFtsPolicy(db);
    const announceResult = applyAnnouncePolicy(db);
    fts = { toUnindex: ftsResult.toUnindex, toIndex: ftsResult.toIndex };
    announces = { toRemove: announceResult.toRemove };
    if (ftsResult.toUnindex + ftsResult.toIndex > 0 || announceResult.toRemove > 0) {
      console.log(
        `[Auto Maintenance] 🔎 方針適用: 索引 -${ftsResult.toUnindex} / +${ftsResult.toIndex} 件, ブースト -${announceResult.toRemove} 件`,
      );
    }
  } catch (err: any) {
    console.error('[Auto Maintenance] 方針の適用に失敗しました:', err?.message || err);
  }

  // ③ 保持期間を超えたリモート投稿の削除（VACUUM はしない）
  let removedPosts = 0;
  try {
    const plan = planRemotePostRemoval(db, options);
    if (plan.total > 0) {
      const counts = applyRemotePostRemoval(db, options);
      removedPosts = counts.posts;
      console.log(`[Auto Maintenance] 🗑️ 古いリモート投稿を削除: ${counts.posts} 件（従属行 ${counts.reactions + counts.announces + counts.notifications} 件）`);
    } else {
      console.log('[Auto Maintenance] 削除対象のリモート投稿はありませんでした');
    }
  } catch (err: any) {
    console.error('[Auto Maintenance] リモート投稿の削除に失敗しました:', err?.message || err);
  }

  // ④ 画像プロキシのキャッシュ整理（期限切れ + 容量超過分）
  let proxyCache = { removed: 0, freedBytes: 0 };
  try {
    proxyCache = await pruneProxyCache();
    if (proxyCache.removed > 0) {
      console.log(`[Auto Maintenance] 🖼️ 画像プロキシのキャッシュを削除: ${proxyCache.removed} 件（${(proxyCache.freedBytes / 1024 / 1024).toFixed(1)}MB）`);
    }
  } catch (err: any) {
    console.error('[Auto Maintenance] 画像プロキシの整理に失敗しました:', err?.message || err);
  }

  const size = getDbSizeInfo(config.dbPath, db);
  console.log(
    `[Auto Maintenance] ✅ 完了 (${((Date.now() - started) / 1000).toFixed(1)}s) / DB ${(size.dbBytes / 1024 / 1024).toFixed(1)}MB + WAL ${(size.walBytes / 1024 / 1024).toFixed(1)}MB` +
      ' / ※ 領域の解放（VACUUM）はサーバー停止時に npm run db:maintenance -- --apply で',
  );
  return { backup, removedPosts, fts, announces, proxyCache };
}

/** 管理画面向け: 容量・件数・メンテナンス状況をまとめて返す */
export async function getMaintenanceStats(): Promise<MaintenanceStats> {
  const size = getDbSizeInfo(config.dbPath, db);
  const one = async (sql: string): Promise<number> => Number((await adb.prepare(sql).get() as any)?.c ?? 0);
  const cutoff = new Date(Date.now() - config.remotePostRetentionDays * 86400_000).toISOString();

  const local = await one('SELECT COUNT(*) AS c FROM posts WHERE is_local = 1');
  const remote = await one('SELECT COUNT(*) AS c FROM posts WHERE is_local = 0');
  const prunable = await one(
    `SELECT COUNT(*) AS c FROM posts p WHERE p.is_local = 0 AND datetime(p.published_at) < datetime('${cutoff}')
       AND NOT EXISTS (SELECT 1 FROM bookmarks b WHERE b.post_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM pinned_posts pp WHERE pp.post_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM posts c WHERE c.is_local = 1 AND (c.in_reply_to = p.id OR c.quote_id = p.id))
       AND NOT EXISTS (SELECT 1 FROM reactions r WHERE r.post_id = p.id AND r.is_local = 1)
       AND NOT EXISTS (SELECT 1 FROM announces a WHERE a.post_id = p.id AND a.is_local = 1)
       AND NOT EXISTS (SELECT 1 FROM posts lp WHERE lp.is_local = 1 AND lp.id = p.in_reply_to)
       AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.following_url = p.author_url AND f.status = 'accepted')`,
  );
  const mediaRow = await adb.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS b FROM media').get() as any;
  const proxyStats = await getProxyStats();

  return {
    db: { sizeBytes: size.dbBytes, walBytes: size.walBytes, pageCount: size.pageCount, freelistCount: size.freelistCount },
    posts: {
      total: local + remote,
      local,
      remote,
      prunableRemote: prunable,
      ftsRows: await one('SELECT COUNT(*) AS c FROM posts_fts'),
    },
    announces: await one('SELECT COUNT(*) AS c FROM announces'),
    media: { count: Number(mediaRow?.c ?? 0), bytes: Number(mediaRow?.b ?? 0), quotaBytes: getMediaQuotaBytes() },
    imageProxy: (() => {
      // 統計は下で 1 度だけ取る（同期版・非同期版が混ざらないよう同じ値を使う）
      const stats = proxyStats;
      return { enabled: stats.enabled, files: stats.files, bytes: stats.bytes, maxBytes: stats.maxBytes, ttlDays: stats.ttlDays };
    })(),
    policy: {
      ftsIndexScope: getFtsIndexScope(),
      remoteAnnouncePolicy: getRemoteAnnouncePolicy(),
      retentionDays: config.remotePostRetentionDays,
    },
    automation: {
      enabled: isAutoMaintenanceEnabled(),
      hour: getAutoMaintenanceHour(),
      lastRunAt: getLastAutoMaintenanceAt(),
      backupEnabled: config.autoBackup !== false,
    },
    backups: readBackups(),
  };
}

/** 起動時に自動運用の設定をログに出す */
export function logAutomationSettings(): void {
  const enabled = isAutoMaintenanceEnabled();
  const hour = getAutoMaintenanceHour();
  const last = getLastAutoMaintenanceAt();
  const schedule = enabled ? `有効（毎日 ${String(hour).padStart(2, '0')}:00 以降にリモート投稿を整理）` : '無効（AUTO_MAINTENANCE=false）';
  const backupState = config.autoBackup !== false ? `有効（${config.backupsKeep} 世代）` : '無効';
  console.log(
    `[Auto Maintenance] ${schedule} / バックアップ ${backupState} / 保持期間 ${config.remotePostRetentionDays} 日` +
      (last ? ` / 前回 ${last}` : ''),
  );
}
