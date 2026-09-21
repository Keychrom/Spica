import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyAnnouncePolicy, applyFtsPolicy, getFtsIndexScope, getRemoteAnnouncePolicy } from './searchPolicy.js';

/**
 * DB メンテナンス（1人運用向け）
 *
 *   ① 古いリモート投稿の保持期間削除（リレー経由で流入した投稿で DB が際限なく増えるのを防ぐ）
 *   ② 孤立メディア（どの投稿からも参照されていないローカル保存のアップロード）の削除
 *   ③ wal_checkpoint + VACUUM（削除で空いたページを実際に解放する）
 *   ④ VACUUM INTO による WAL 安全なバックアップ（削除前スナップショット）
 *
 * 実行は scripts/db-maintenance.ts（npm run db:maintenance）から行う。
 * 既定はドライランで、--apply を付けたときだけ実際に削除する。
 *
 * 設計上の約束:
 *  - 削除の対象は **リモート投稿（is_local = 0）のみ**。ローカル投稿・プロフィール・フォロー関係には触れない。
 *  - ユーザーが意味を持たせた行（ブックマーク・ピン留め・ローカルからのリアクション/ブースト・
 *    ローカル投稿の返信先/引用元・フォロー中アカウントの投稿・ローカル投稿への返信）は残す。
 *  - 削除する投稿を参照する従属行（リアクション/ブースト/通知）と FTS 索引は、投稿と一緒に片付ける。
 */

export interface MaintenanceOptions {
  /** リモート投稿の保持日数。これより古いものが削除対象（0 以下で保持期間削除を行わない） */
  retentionDays: number;
  /** リモート投稿の最大保持件数（0 以下で無効）。件数を超えた分は古い順に削除 */
  maxRemotePosts: number;
  /** フォロー中アクターの投稿を残すか */
  keepFollowed: boolean;
  /** ローカル投稿への返信（リモートからの返信）を残すか */
  keepRepliesToLocal: boolean;
  /** 孤立メディアの削除を行うか */
  pruneMedia: boolean;
  /** 保存・索引の方針（FTS スコープ / リモートブースト）を既存データへ遡及適用するか */
  applyPolicy: boolean;
  /** 孤立とみなす前に必要なファイルの経過時間（ミリ秒）。アップロード直後のファイルを守る */
  mediaMinAgeMs: number;
}

export const DEFAULT_MAINTENANCE_OPTIONS: MaintenanceOptions = {
  retentionDays: 30,
  maxRemotePosts: 0,
  keepFollowed: true,
  keepRepliesToLocal: true,
  pruneMedia: true,
  applyPolicy: true,
  mediaMinAgeMs: 24 * 60 * 60 * 1000,
};

export interface DbSizeInfo {
  dbBytes: number;
  walBytes: number;
  shmBytes: number;
  pageCount: number;
  freelistCount: number;
  pageSize: number;
}

export interface RemotePostTargets {
  /** 削除対象のリモート投稿件数 */
  total: number;
  /** 保持期間を超えている件数（maxRemotePosts 適用前） */
  byAge: number;
  /** 件数上限を超えた分 */
  byCount: number;
  /** 保持ルールで残される件数 */
  kept: number;
  keptByReason: Record<string, number>;
}

export interface RemovalCounts {
  posts: number;
  reactions: number;
  announces: number;
  notifications: number;
  bookmarks: number;
  polls: number;
  fts: number;
}

export interface MediaCleanupResult {
  scannedFiles: number;
  scannedBytes: number;
  referencedFiles: number;
  orphanFiles: number;
  orphanBytes: number;
  skippedYoung: number;
  samples: string[];
  remoteStorageNote: boolean;
}

export interface BackupResult {
  path: string;
  bytes: number;
  removed: string[];
}

/** 投稿 ID をまとめて削除するときの 1 トランザクションあたりの件数 */
const BATCH_SIZE = 5000;

/**
 * FTS 同期トリガの定義（db.ts の posts_ad と同じ）。
 * 万一トリガが無い状態の DB でもメンテナンス後に必ず元へ戻せるようにするための控え。
 */
const FALLBACK_POSTS_AD_TRIGGER = `
  CREATE TRIGGER posts_ad AFTER DELETE ON posts BEGIN
    DELETE FROM posts_fts WHERE post_id = old.id;
  END;
`;

// ---------------------------------------------------------------------------
// 接続とサイズ
// ---------------------------------------------------------------------------

/**
 * メンテナンス用の接続を開く（サーバーと同じ PRAGMA を適用）
 * サーバーが起動中でも読み書きできるよう WAL のまま busy_timeout を長めに取る。
 */
export function openMaintenanceDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 10000;');
  return db;
}

export function getDbSizeInfo(dbPath: string, db?: DatabaseSync): DbSizeInfo {
  const stat = (file: string): number => {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  };
  const pageSize = db ? (db.prepare('PRAGMA page_size').get() as any)?.page_size ?? 0 : 0;
  const pageCount = db ? (db.prepare('PRAGMA page_count').get() as any)?.page_count ?? 0 : 0;
  const freelistCount = db ? (db.prepare('PRAGMA freelist_count').get() as any)?.freelist_count ?? 0 : 0;
  return {
    dbBytes: stat(dbPath),
    walBytes: stat(`${dbPath}-wal`),
    shmBytes: stat(`${dbPath}-shm`),
    pageCount: Number(pageCount),
    freelistCount: Number(freelistCount),
    pageSize: Number(pageSize),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// ---------------------------------------------------------------------------
// ① リモート投稿の削除対象を決める
// ---------------------------------------------------------------------------

/**
 * 保持ルール。「残すべき投稿」の条件を SQL 断片として返す。
 * すべて `p` というエイリアスの posts 行を前提にする。
 */
function keepConditions(opts: MaintenanceOptions): { sql: string; reasons: string[] } {
  const clauses: string[] = [
    'EXISTS (SELECT 1 FROM bookmarks b WHERE b.post_id = p.id)',
    'EXISTS (SELECT 1 FROM pinned_posts pp WHERE pp.post_id = p.id)',
    // ローカル投稿の返信先・引用元になっている投稿（自分の投稿の文脈を壊さない）
    'EXISTS (SELECT 1 FROM posts c WHERE c.is_local = 1 AND (c.in_reply_to = p.id OR c.quote_id = p.id))',
    // ローカルユーザーがリアクション/ブーストした投稿
    'EXISTS (SELECT 1 FROM reactions r WHERE r.post_id = p.id AND r.is_local = 1)',
    'EXISTS (SELECT 1 FROM announces a WHERE a.post_id = p.id AND a.is_local = 1)',
  ];
  const reasons = ['ブックマーク', 'ピン留め', 'ローカル投稿の返信先/引用元', 'ローカルからのリアクション', 'ローカルからのブースト'];
  if (opts.keepRepliesToLocal) {
    clauses.push('EXISTS (SELECT 1 FROM posts lp WHERE lp.is_local = 1 AND lp.id = p.in_reply_to)');
    reasons.push('ローカル投稿への返信');
  }
  if (opts.keepFollowed) {
    clauses.push("EXISTS (SELECT 1 FROM follows f WHERE f.following_url = p.author_url AND f.status = 'accepted')");
    reasons.push('フォロー中アクターの投稿');
  }
  return { sql: clauses.join(' OR '), reasons };
}

/** 削除対象になるリモート投稿 ID を一時テーブルに固定する（件数はここで確定する） */
function materializeTargets(db: DatabaseSync, opts: MaintenanceOptions): number {
  const { sql: keepSql } = keepConditions(opts);
  db.exec('DROP TABLE IF EXISTS temp._maintenance_targets');
  db.exec('CREATE TEMP TABLE _maintenance_targets (id TEXT PRIMARY KEY)');

  let ageSql = '';
  if (opts.retentionDays > 0) {
    const cutoff = new Date(Date.now() - opts.retentionDays * 86400_000).toISOString();
    ageSql = `datetime(p.published_at) < datetime('${cutoff}')`;
  }

  if (ageSql) {
    db.exec(`
      INSERT OR IGNORE INTO _maintenance_targets (id)
        SELECT p.id FROM posts p
        WHERE p.is_local = 0 AND ${ageSql} AND NOT (${keepSql})
    `);
  }

  if (opts.maxRemotePosts > 0) {
    // リモート投稿を新しい順に maxRemotePosts 件残し、あふれた分を対象に加える
    db.exec(`
      INSERT OR IGNORE INTO _maintenance_targets (id)
        SELECT id FROM (
          SELECT p.id AS id, ROW_NUMBER() OVER (ORDER BY datetime(p.published_at) DESC, p.id DESC) AS rn
          FROM posts p
          WHERE p.is_local = 0 AND NOT (${keepSql})
        ) WHERE rn > ${Math.floor(opts.maxRemotePosts)}
    `);
  }

  return Number((db.prepare('SELECT COUNT(*) AS c FROM temp._maintenance_targets').get() as any).c);
}

/** 削除対象の内訳（保持ルールで何がどれだけ残るか）を調べる */
export function planRemotePostRemoval(db: DatabaseSync, opts: MaintenanceOptions): RemotePostTargets {
  const { sql: keepSql, reasons } = keepConditions(opts);
  const one = (sql: string): number => Number((db.prepare(sql).get() as any)?.c ?? 0);

  const remoteTotal = one('SELECT COUNT(*) AS c FROM posts WHERE is_local = 0');
  const keptByReason: Record<string, number> = {};
  for (const reason of reasons) {
    // 理由ごとの件数は目安（重複して数えられる）
    const map: Record<string, string> = {
      ブックマーク: 'EXISTS (SELECT 1 FROM bookmarks b WHERE b.post_id = p.id)',
      ピン留め: 'EXISTS (SELECT 1 FROM pinned_posts pp WHERE pp.post_id = p.id)',
      'ローカル投稿の返信先/引用元': 'EXISTS (SELECT 1 FROM posts c WHERE c.is_local = 1 AND (c.in_reply_to = p.id OR c.quote_id = p.id))',
      ローカルからのリアクション: 'EXISTS (SELECT 1 FROM reactions r WHERE r.post_id = p.id AND r.is_local = 1)',
      ローカルからのブースト: 'EXISTS (SELECT 1 FROM announces a WHERE a.post_id = p.id AND a.is_local = 1)',
      ローカル投稿への返信: 'EXISTS (SELECT 1 FROM posts lp WHERE lp.is_local = 1 AND lp.id = p.in_reply_to)',
      フォロー中アクターの投稿: "EXISTS (SELECT 1 FROM follows f WHERE f.following_url = p.author_url AND f.status = 'accepted')",
    };
    keptByReason[reason] = one(`SELECT COUNT(*) AS c FROM posts p WHERE p.is_local = 0 AND ${map[reason]}`);
  }

  let byAge = 0;
  if (opts.retentionDays > 0) {
    const cutoff = new Date(Date.now() - opts.retentionDays * 86400_000).toISOString();
    byAge = one(`SELECT COUNT(*) AS c FROM posts p WHERE p.is_local = 0 AND datetime(p.published_at) < datetime('${cutoff}') AND NOT (${keepSql})`);
  }

  let byCount = 0;
  if (opts.maxRemotePosts > 0) {
    byCount = one(`
      SELECT COUNT(*) AS c FROM (
        SELECT ROW_NUMBER() OVER (ORDER BY datetime(p.published_at) DESC, p.id DESC) AS rn
        FROM posts p WHERE p.is_local = 0 AND NOT (${keepSql})
      ) WHERE rn > ${Math.floor(opts.maxRemotePosts)}
    `);
  }

  return {
    total: byAge + byCount,
    byAge,
    byCount,
    kept: Math.max(0, remoteTotal - (byAge + byCount)),
    keptByReason,
  };
}

/**
 * 実際に削除する。バッチ単位（BATCH_SIZE 件）でトランザクションを切り、
 * 大量削除でも WAL が膨らみすぎないようにする。
 *
 * 注意: posts の FTS 同期トリガは post_id（UNINDEXED）で 1 件ずつ全走査するため、
 * 数万件の削除では現実的な時間で終わらない。削除の間だけトリガを外し、
 * あとから対象 ID をまとめて FTS から消して整合させる（1 回の走査で済む）。
 */
export function applyRemotePostRemoval(db: DatabaseSync, opts: MaintenanceOptions): RemovalCounts {
  const total = materializeTargets(db, opts);
  const counts: RemovalCounts = { posts: 0, reactions: 0, announces: 0, notifications: 0, bookmarks: 0, polls: 0, fts: 0 };
  if (total === 0) {
    db.exec('DROP TABLE IF EXISTS temp._maintenance_targets');
    return counts;
  }

  db.exec('CREATE TEMP TABLE IF NOT EXISTS _target_batch (id TEXT PRIMARY KEY)');

  const triggerSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'posts_ad'").get() as any)?.sql as string | undefined;

  const selectIds = db.prepare('SELECT id FROM temp._maintenance_targets LIMIT ?');
  const batchDeletes: Array<[keyof RemovalCounts, ReturnType<DatabaseSync['prepare']>]> = [
    ['reactions', db.prepare('DELETE FROM reactions WHERE post_id IN (SELECT id FROM _target_batch)')],
    ['announces', db.prepare('DELETE FROM announces WHERE post_id IN (SELECT id FROM _target_batch)')],
    ['notifications', db.prepare('DELETE FROM notifications WHERE post_id IN (SELECT id FROM _target_batch)')],
    ['bookmarks', db.prepare('DELETE FROM bookmarks WHERE post_id IN (SELECT id FROM _target_batch)')],
    ['polls', db.prepare('DELETE FROM polls WHERE post_id IN (SELECT id FROM _target_batch)')],
  ];
  const insertBatch = db.prepare('INSERT OR IGNORE INTO _target_batch (id) VALUES (?)');
  const clearBatch = db.prepare('DELETE FROM _target_batch');
  const dropTargets = db.prepare('DELETE FROM _maintenance_targets WHERE id IN (SELECT id FROM _target_batch)');
  const deletePosts = db.prepare('DELETE FROM posts WHERE id IN (SELECT id FROM _target_batch)');

  if (triggerSql) db.exec('DROP TRIGGER IF EXISTS posts_ad');
  try {
    let batch = 0;
    for (;;) {
      const ids = (selectIds.all(BATCH_SIZE) as Array<{ id: string }>).map((r) => r.id);
      if (ids.length === 0) break;

      db.exec('BEGIN IMMEDIATE');
      try {
        clearBatch.run();
        for (const id of ids) insertBatch.run(id);
        for (const [key, stmt] of batchDeletes) {
          const res = stmt.run();
          counts[key] += Number(res.changes ?? 0);
        }
        counts.posts += Number(deletePosts.run().changes ?? 0);
        dropTargets.run();
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      batch++;
      if (batch % 10 === 0) process.stdout.write(`  ... ${counts.posts} / ${total} 件削除\n`);
    }

    // FTS 索引から対象をまとめて削除（トリガを外しているのでここで行う）
    counts.fts = Number(db.prepare('DELETE FROM posts_fts WHERE post_id IN (SELECT id FROM temp._maintenance_targets)').run().changes ?? 0);
    // 念のため: 過去の削除などで残っている孤立 FTS 行も掃除する
    counts.fts += Number(db.prepare('DELETE FROM posts_fts WHERE post_id NOT IN (SELECT id FROM posts)').run().changes ?? 0);
  } finally {
    // 途中で失敗しても FTS 同期トリガは必ず戻す（db.ts と同じ定義）
    db.exec('DROP TRIGGER IF EXISTS posts_ad');
    db.exec(triggerSql ?? FALLBACK_POSTS_AD_TRIGGER);
  }

  db.exec('DROP TABLE IF EXISTS temp._target_batch');
  db.exec('DROP TABLE IF EXISTS temp._maintenance_targets');
  return counts;
}

// ---------------------------------------------------------------------------
// ② 孤立メディア
// ---------------------------------------------------------------------------

/** DB に記録されたローカル保存メディアの参照パス（/uploads/... 形式）を集める */
function collectReferencedUploadPaths(db: DatabaseSync): Set<string> {
  const refs = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string' || !value) return;
    // 絶対URL（https://host/uploads/...）でも相対（/uploads/...）でも拾う
    const idx = value.indexOf('/uploads/');
    if (idx === -1) return;
    const rel = value.slice(idx + '/uploads/'.length);
    const clean = rel.split(/[?#]/)[0];
    if (clean) refs.add(decodeURIComponent(clean));
  };
  const scanJson = (raw: unknown): void => {
    if (typeof raw !== 'string' || !raw) return;
    try {
      const parsed = JSON.parse(raw);
      const walk = (node: any): void => {
        if (!node) return;
        if (typeof node === 'string') return add(node);
        if (Array.isArray(node)) return node.forEach(walk);
        if (typeof node === 'object') {
          for (const key of ['url', 'key', 'preview_url', 'remote_url', 'src']) add(node[key]);
          for (const value of Object.values(node)) if (typeof value === 'object') walk(value);
        }
      };
      walk(parsed);
    } catch {
      add(raw);
    }
  };

  for (const row of db.prepare('SELECT media_attachments FROM posts').all() as any[]) {
    scanJson(row.media_attachments);
  }
  // ドライブ（投稿に添付されていないアップロードも保護する）
  try {
    for (const row of db.prepare("SELECT url, thumbnail_url FROM media").all() as any[]) {
      add(row.url);
      add(row.thumbnail_url);
    }
  } catch {
    // media テーブルが無い環境でも動くようにする
  }
  for (const row of db.prepare('SELECT icon_url, banner_url FROM users').all() as any[]) {
    add(row.icon_url);
    add(row.banner_url);
  }
  for (const row of db.prepare('SELECT value FROM server_settings').all() as any[]) scanJson(row.value);
  for (const table of ['announcements', 'channels', 'custom_emojis', 'drafts', 'scheduled_posts']) {
    try {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
      if (columns.length === 0) continue;
      const interesting = columns.filter((c) => /url|icon|banner|media|image|attachment/i.test(c));
      if (interesting.length === 0) continue;
      for (const row of db.prepare(`SELECT ${interesting.join(', ')} FROM ${table}`).all() as any[]) {
        for (const value of Object.values(row)) scanJson(value);
      }
    } catch {
      // テーブルが無い環境でも動くようにする
    }
  }
  return refs;
}

/**
 * uploads ディレクトリの孤立ファイルを調べる（apply=false なら調査のみ）
 * どの投稿・プロフィールからも参照されていないファイルだけを対象にする。
 */
export function cleanupOrphanMedia(
  db: DatabaseSync,
  uploadsDir: string,
  opts: MaintenanceOptions,
  apply: boolean,
  remoteStorageConfigured = false,
): MediaCleanupResult {
  const result: MediaCleanupResult = {
    scannedFiles: 0,
    scannedBytes: 0,
    referencedFiles: 0,
    orphanFiles: 0,
    orphanBytes: 0,
    skippedYoung: 0,
    samples: [],
    remoteStorageNote: false,
  };
  if (!fs.existsSync(uploadsDir)) return result;

  const referenced = collectReferencedUploadPaths(db);
  const now = Date.now();

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      result.scannedFiles++;
      const size = fs.statSync(full).size;
      result.scannedBytes += size;

      const rel = path.relative(uploadsDir, full).split(path.sep).join('/');
      if (referenced.has(rel) || referenced.has(entry.name)) {
        result.referencedFiles++;
        continue;
      }

      const ageMs = now - fs.statSync(full).mtimeMs;
      if (ageMs < opts.mediaMinAgeMs) {
        result.skippedYoung++;
        continue;
      }

      result.orphanFiles++;
      result.orphanBytes += size;
      if (result.samples.length < 10) result.samples.push(rel);
      if (apply) {
        try {
          fs.unlinkSync(full);
        } catch (err: any) {
          console.error(`  ⚠️ 削除できませんでした: ${rel} (${err?.message || err})`);
          result.orphanFiles--;
          result.orphanBytes -= size;
        }
      }
    }
  };
  walk(uploadsDir);
  result.remoteStorageNote = remoteStorageConfigured;
  return result;
}

// ---------------------------------------------------------------------------
// ③ checkpoint / VACUUM
// ---------------------------------------------------------------------------

export interface OptimizeResult {
  checkpointed: boolean;
  vacuumed: boolean;
  /** FTS5 のセグメントをマージできたか（これを行わないと削除しても容量が戻らない） */
  ftsOptimized: boolean;
  error?: string;
  lockedHint?: boolean;
}

/**
 * FTS5 の内部セグメントをマージし、WAL を本体へ書き戻してから VACUUM で空きページを解放する。
 *
 * 投稿を消しただけでは FTS5 の内部セグメント（削除済みエントリを含む塊）が残り、
 * ファイルサイズがほとんど減らない。先に 'optimize' でマージしてから VACUUM するのが要点。
 */
export function optimizeDatabase(db: DatabaseSync): OptimizeResult {
  const result: OptimizeResult = { checkpointed: false, vacuumed: false, ftsOptimized: false };

  // ① FTS5 セグメントのマージ（trigram 索引は削除だけでは縮まない）
  try {
    db.exec("INSERT INTO posts_fts(posts_fts) VALUES('optimize');");
    result.ftsOptimized = true;
  } catch (err: any) {
    // FTS テーブルが無い構成でも残りの処理は続ける
    result.error = err?.message || String(err);
  }

  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    result.checkpointed = true;
  } catch (err: any) {
    result.error = err?.message || String(err);
  }

  try {
    db.exec('VACUUM;');
    result.vacuumed = true;
  } catch (err: any) {
    const message: string = err?.message || String(err);
    result.error = message;
    // サーバー稼働中は排他ロックが取れず VACUUM だけが失敗する
    result.lockedHint = /locked|busy/i.test(message);
    return result;
  }

  // WAL モードでは VACUUM の結果が WAL に載るため、本体ファイルの縮小には
  // VACUUM 後のチェックポイントが必要（小さい DB では自動チェックポイントが走らない）
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.exec('PRAGMA optimize;');
  } catch (err: any) {
    result.error = err?.message || String(err);
  }
  return result;
}

// ---------------------------------------------------------------------------
// ④ バックアップ（VACUUM INTO）
// ---------------------------------------------------------------------------

/** WAL の内容も含めた一貫性のあるスナップショットを 1 ファイルに書き出す */
export function backupDatabase(db: DatabaseSync, dbPath: string, backupDir: string): BackupResult {
  fs.mkdirSync(backupDir, { recursive: true });
  // 同じ秒に連続実行しても衝突しないようミリ秒まで含める
  const d = new Date();
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
  const base = path.basename(dbPath).replace(/\.sqlite$/, '');
  const target = path.join(backupDir, `${base}-${stamp}.sqlite`);
  if (fs.existsSync(target)) fs.unlinkSync(target);

  const escaped = target.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}';`);
  return { path: target, bytes: fs.statSync(target).size, removed: [] };
}

/** 古いバックアップを残しつつ削除する（既定 3 世代） */
export function rotateBackups(backupDir: string, keep: number): string[] {
  if (!fs.existsSync(backupDir)) return [];
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => ({ f, full: path.join(backupDir, f), mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const removed: string[] = [];
  for (const entry of files.slice(Math.max(0, keep))) {
    try {
      fs.unlinkSync(entry.full);
      removed.push(entry.f);
    } catch {
      // 消せなくても致命的ではない
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// まとめ
// ---------------------------------------------------------------------------

export interface PolicyApplyResult {
  /** FTS 索引から外した件数 / 索引に入れ直した件数 / 適用後の索引行数 */
  fts: { toUnindex: number; toIndex: number; ftsRowsAfter: number; scope: string };
  /** 方針に反して保存されていたリモートブーストの削除件数 / 残件数 */
  announces: { toRemove: number; remaining: number; policy: string };
}

export interface MaintenanceReport {
  before: DbSizeInfo;
  after: DbSizeInfo;
  targets: RemotePostTargets;
  removed: RemovalCounts;
  media: MediaCleanupResult;
  policy?: PolicyApplyResult;
  backup?: BackupResult;
  optimize?: OptimizeResult;
  applied: boolean;
  elapsedMs: number;
}

/** ドライラン/実行をまとめて行う（CLI から呼ぶ） */
export function runMaintenance(params: {
  dbPath: string;
  uploadsDir: string;
  backupDir: string;
  options: MaintenanceOptions;
  apply: boolean;
  backup: boolean;
  vacuum: boolean;
  backupsKeep: number;
  remoteStorageConfigured?: boolean;
  log?: (line: string) => void;
}): MaintenanceReport {
  const log = params.log ?? (() => {});
  const started = Date.now();
  const db = openMaintenanceDb(params.dbPath);
  try {
    const before = getDbSizeInfo(params.dbPath, db);
    const targets = planRemotePostRemoval(db, params.options);
    let removed: RemovalCounts = { posts: 0, reactions: 0, announces: 0, notifications: 0, bookmarks: 0, polls: 0, fts: 0 };
    let media: MediaCleanupResult = {
      scannedFiles: 0,
      scannedBytes: 0,
      referencedFiles: 0,
      orphanFiles: 0,
      orphanBytes: 0,
      skippedYoung: 0,
      samples: [],
      remoteStorageNote: false,
    };
    let backupResult: BackupResult | undefined;
    let optimize: OptimizeResult | undefined;
    let policyResult: PolicyApplyResult | undefined;

    if (params.apply) {
      if (params.backup) {
        log('④ VACUUM INTO でバックアップを作成しています...');
        backupResult = backupDatabase(db, params.dbPath, params.backupDir);
        backupResult.removed = rotateBackups(params.backupDir, params.backupsKeep);
        log(`   バックアップ: ${backupResult.path} (${formatBytes(backupResult.bytes)})`);
      }
      if (targets.total > 0) {
        log(`① 古いリモート投稿を削除しています... (${targets.total} 件)`);
        removed = applyRemotePostRemoval(db, params.options);
      }
      if (params.options.pruneMedia) {
        log('② 孤立メディアを確認しています...');
        media = cleanupOrphanMedia(db, params.uploadsDir, params.options, true, params.remoteStorageConfigured);
      }
      if (params.options.applyPolicy) {
        log('⑤ 保存・索引の方針を既存データへ適用しています...');
        const ftsResult = applyFtsPolicy(db);
        const announceResult = applyAnnouncePolicy(db);
        policyResult = {
          fts: { ...ftsResult, scope: getFtsIndexScope(db) },
          announces: { ...announceResult, policy: getRemoteAnnouncePolicy(db) },
        };
        log(`   索引: ${ftsResult.toUnindex} 件を索引から外し、${ftsResult.toIndex} 件を入れ直しました（残り ${ftsResult.ftsRowsAfter} 行）`);
        log(`   ブースト: ${announceResult.toRemove} 件を削除しました（残り ${announceResult.remaining} 件）`);
      }
      if (params.vacuum) {
        log('③ wal_checkpoint + VACUUM を実行しています（サーバー停止推奨）...');
        optimize = optimizeDatabase(db);
      }
    } else {
      // ドライラン: 削除はせず、孤立メディアの調査だけ行う
      media = cleanupOrphanMedia(db, params.uploadsDir, params.options, false, params.remoteStorageConfigured);
    }

    const after = getDbSizeInfo(params.dbPath, db);
    return {
      before,
      after,
      targets,
      removed,
      media,
      policy: policyResult,
      backup: backupResult,
      optimize,
      applied: params.apply,
      elapsedMs: Date.now() - started,
    };
  } finally {
    db.close();
  }
}
