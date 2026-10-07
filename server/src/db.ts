import { config } from './config.js';
import { SqliteDatabase } from './db/driver.js';
import { createAsyncDatabase } from './db/asyncDriver.js';
import { missingColumnStatements } from './db/schemaColumns.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sendNotificationToUser } from './streaming.js';
import { publishEvent } from './redis.js';
import { fileURLToPath } from 'node:url';

// データベースディレクトリが存在することを確認（SQLite のときだけ必要）
if (config.dbDriver === 'sqlite') {
  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

/**
 * データベース接続（非同期 API。server/src/db/asyncDriver.ts）。
 *
 * SQLite のときは接続を 1 本だけ開いて渡す。同じファイルに 2 本繋ぐと
 * WAL でも書き込みが競合するため、アプリ全体で共有する。
 * PostgreSQL のときは接続文字列から 1 本のクライアントを作る（遅延接続）。
 */
export const db = createAsyncDatabase({
  driver: config.dbDriver,
  sqlite: config.dbDriver === 'sqlite' ? new SqliteDatabase(new DatabaseSync(config.dbPath)) : undefined,
  connectionString: config.databaseUrl,
  statementTimeoutMs: config.databaseStatementTimeoutMs,
  idleInTransactionTimeoutMs: config.databaseIdleTimeoutMs,
  poolMax: config.databasePoolMax,
});

// テーブル初期化＆マイグレーション
/**
 * PostgreSQL にスキーマを適用する。
 * `npm run db:pg:schema` が生成した server/src/db/schema.pg.sql を読み込んで流す。
 * 生成物は CREATE ... IF NOT EXISTS / CREATE OR REPLACE FUNCTION なので繰り返し実行できる。
 */
async function initPostgresSchema(): Promise<void> {
  // 開発時は src/db/schema.pg.sql、ビルド後は dist/db/schema.pg.sql（build でコピーされる）
  const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'db', 'schema.pg.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(
      `PostgreSQL のスキーマが見つかりません: ${schemaPath}
` +
        '  npm run db:pg:schema で生成してから起動してください。',
    );
  }
  const sql = fs.readFileSync(schemaPath, 'utf8');

  // 大きいテーブルへの索引は、**スキーマを適用する前に** CONCURRENTLY で作る。
  // スキーマ側は `CREATE INDEX IF NOT EXISTS` なので、先に作っておけば素通りする
  // （逆順にすると、起動時に ACCESS EXCLUSIVE で読み書きが止まる）。
  //
  // ※ この処理は助言ロックの**外**で走る（スキーマ適用の前に置く必要があるため）。
  //    同時起動で 2 プロセスが同じ索引を作ろうとすると片方が失敗するが、警告に留めて
  //    起動は続ける（失敗して残った無効な索引は、次回の起動で落として作り直す）。
  await createIndexesConcurrently(await collectDeferredIndexesFromSchema());

  try {
    // **複数プロセスが同時に起動すると、DDL がぶつかってデッドロックすることがある**
    // （実際に 2 ノード同時起動で「デッドロックを検出しました」→ 片方が起動失敗した）。
    // 助言ロックで 1 プロセスずつ流す（待ってから適用するだけなので、起動が少し遅くなるだけ）。
    //
    // 助言ロックは**接続に紐づく**（pg_advisory_unlock は同じ接続から呼ばないと解放されず、
    // プールが別の接続を渡すと取得と解放が食い違う）。区間全体を withSession で固定する。
    const SCHEMA_LOCK_KEY = 8456231;
    await db.withSession(async () => {
      const locked = (await db.prepare('SELECT pg_try_advisory_lock(?) AS ok').get(SCHEMA_LOCK_KEY)) as {
        ok: boolean;
      };
      if (!locked?.ok) {
        console.log('[DB] ⏳ 他のプロセスがスキーマを適用中です。終わるのを待ちます…');
        await db.prepare('SELECT pg_advisory_lock(?) AS ok').get(SCHEMA_LOCK_KEY);
      }
      try {
        // **同じ版が入っていれば丸ごと飛ばす。** スキーマには `CREATE OR REPLACE FUNCTION` と
        // トリガの DROP / CREATE が含まれていて、毎回流すと posts などに
        // ACCESS EXCLUSIVE ロックを取る（＝起動のたびに読み書きが一瞬止まる）。
        // 記録（`pg-schema:<内容のハッシュ>`）と一致するときは何もしない。
        // 列の追加（addMissingColumns）も同じ版なら不要。
        const schemaKey = `pg-schema:${migrationKey(sql)}`;
        // **まっさらな DB では `schema_migrations` 自体がまだ無い**ので、失敗は「未適用」として扱う
        // （ここで例外を投げると、新しい DB でアプリが起動できなくなる）
        let alreadyApplied: { key: string } | undefined;
        try {
          alreadyApplied = (await db.prepare('SELECT key FROM schema_migrations WHERE key = ?').get(schemaKey)) as
            | { key: string }
            | undefined;
        } catch {
          alreadyApplied = undefined;
        }
        if (alreadyApplied) {
          console.log('[DB] 🐘 PostgreSQL スキーマは適用済みです（スキップ）');
        } else {
          // スキーマは `CREATE TABLE IF NOT EXISTS` なので、**既存の DB には列が増えない**。
          // 生成物に書いてあって DB に無い列は、**スキーマを流す前に**足す
          // （スキーマの中の索引が新しい列を参照していても通るようにするため）
          const added = await addMissingColumns(sql);
          await db.exec(sql);
          console.log('[DB] 🐘 PostgreSQL スキーマを適用しました');
          if (added.length > 0) {
            console.log(
              `[DB] 🧩 足りない列を追加しました（${added.length} 件）: ${added.slice(0, 8).join(', ')}${added.length > 8 ? ' …' : ''}`,
            );
          }
          // スキーマの版も記録する（どの版が入っているかを後から DB だけで確認できるように）
          await recordMigration(schemaKey, 'schema');
        }
      } finally {
        await db.prepare('SELECT pg_advisory_unlock(?) AS ok').get(SCHEMA_LOCK_KEY);
      }
    });
  } catch (err: any) {
    throw new Error(`PostgreSQL スキーマの適用に失敗しました: ${err?.message || err}`);
  }

  // 索引に入っていない投稿を同期する（SQLite 側と同じ処理）
  try {
    const ftsCount = Number((await db.prepare('SELECT COUNT(*) as c FROM posts_fts').get() as any).c);
    // 比べる相手は「索引する対象」＝ fts_indexed = 1 の投稿。
    // 全投稿と比べると、索引対象でない投稿がある限り**起動のたびに全件スキャンが走る**
    const indexedCount = Number(
      (await db.prepare('SELECT COUNT(*) as c FROM posts WHERE fts_indexed = 1').get() as any).c,
    );
    if (ftsCount < indexedCount) {
      await db.prepare(`
        INSERT INTO posts_fts(post_id, content)
        SELECT id, content FROM posts
        WHERE fts_indexed = 1 AND NOT EXISTS (SELECT 1 FROM posts_fts f WHERE f.post_id = posts.id)
      `).run();
      console.log(`[FTS] 🔄 posts_fts を同期しました（${ftsCount} → ${indexedCount}）`);
    }
  } catch (ftsSyncErr) {
    console.warn('[FTS Sync Warning]:', ftsSyncErr);
  }
}

/**
 * 生成済みスキーマにあって、実際の DB に無い**列**を足す（追加のみ）。
 *
 * `CREATE TABLE IF NOT EXISTS` は既存テーブルに列を足さないので、これをやらないと
 * **db.ts に列を足しても PostgreSQL には届かない**（実際、受信の墓標と
 * jobs.group_key が PostgreSQL だけ欠けていた）。足した列名を返す。
 */
async function addMissingColumns(schemaSql: string): Promise<string[]> {
  const rows = (await db
    .prepare(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`)
    .all()) as { table_name: string; column_name: string }[];
  const existing = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = existing.get(row.table_name);
    if (set) set.add(row.column_name);
    else existing.set(row.table_name, new Set([row.column_name]));
  }

  const added: string[] = [];
  for (const statement of missingColumnStatements(schemaSql, existing)) {
    try {
      await db.exec(statement);
      const match = /ALTER TABLE "([^"]+)" ADD COLUMN IF NOT EXISTS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/.exec(statement);
      if (match) added.push(`${match[1]}.${match[2]}`);
    } catch (err: any) {
      // 1 列の失敗で起動は止めない（足せなかったことは警告で残す）
      console.warn(`[DB] 列を追加できませんでした: ${statement.slice(0, 120)} (${err?.message || err})`);
    }
  }
  return added;
}

export async function initDatabase(): Promise<void> {
  await initDatabaseSchema();

  // 設定とインスタンス鍵をメモリへ読み込む
  // （どちらも読み取りは同期で行えるようにするため。ドライバ共通の後処理）
  await loadServerSettings();
  // 循環 import を避けるため動的 import（instanceActor 側も db.ts を参照している）
  const { loadInstanceActorKeyPair } = await import('./instanceActor.js');
  await loadInstanceActorKeyPair();
}

// ---------------------------------------------------------------------------
// マイグレーションの記録と、大きいテーブルへの索引（オンライン作成）
// ---------------------------------------------------------------------------

/**
 * 適用したマイグレーションの記録。
 *
 * 鍵は**SQL 文そのもののハッシュ**（連番ではない）。途中に 1 文を足しても、
 * 既存の記録がずれないため。文を書き換えたときはハッシュが変わるので、
 * もう一度実行される（中身は `IF NOT EXISTS` 系なので安全）。
 */
const SCHEMA_MIGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    key TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL,
    note TEXT DEFAULT ''
  );
`;

/** 索引作成のうち、大きいテーブルでは後回しにするもの */
interface DeferredIndex {
  sql: string;
  name: string;
  table: string;
}

/** この行数を超えるテーブルへの索引は、起動時に作らず CONCURRENTLY で作る */
const ONLINE_INDEX_ROW_THRESHOLD = 50_000;

function migrationKey(sql: string): string {
  return crypto.createHash('sha256').update(sql.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 32);
}

/** 「もう望ましい状態になっている」ことを表すエラーか（列・表・索引が既にある） */
function isAlreadyAppliedError(err: any): boolean {
  const code = String(err?.code || '');
  // PostgreSQL: duplicate_table / duplicate_column / duplicate_schema / duplicate_object
  if (['42P07', '42701', '42P06', '42710'].includes(code)) return true;
  return /already exists|duplicate column|duplicate_column|duplicate table|duplicate_table/i.test(String(err?.message || ''));
}

async function loadAppliedMigrations(): Promise<Set<string>> {
  const applied = new Set<string>();
  try {
    await db.exec(SCHEMA_MIGRATIONS_DDL);
    const rows = (await db.prepare('SELECT key FROM schema_migrations').all()) as { key: string }[];
    for (const row of rows) applied.add(row.key);
  } catch {
    // 記録が使えなくても続行する（毎回適用に戻るだけ）
  }
  return applied;
}

async function recordMigration(key: string, note: string): Promise<boolean> {
  try {
    // すでに記録があれば何もしない（PostgreSQL では `ON CONFLICT DO NOTHING` に翻訳される）
    const result = await db
      .prepare('INSERT OR IGNORE INTO schema_migrations (key, applied_at, note) VALUES (?, ?, ?)')
      .run(key, new Date().toISOString(), note);
    return Number(result.changes ?? 0) === 1;
  } catch {
    // 記録できなくても続行（次回また試す）
    return false;
  }
}

/** テーブルの行数をざっくり見積もる（PostgreSQL のみ。索引の作り方を決めるためだけに使う） */
async function estimateTableRows(table: string): Promise<number> {
  try {
    const row = (await db.prepare('SELECT reltuples FROM pg_class WHERE relname = ? AND relkind = ?').get(table, 'r')) as
      | { reltuples: number | string }
      | undefined;
    const estimate = Number(row?.reltuples ?? -1);
    if (estimate > 0) return estimate;
    // ANALYZE されていないテーブルは -1 なので、上限つきで実際に数える（5 万行まで）
    const counted = (await db
      .prepare(`SELECT COUNT(*) AS c FROM (SELECT 1 FROM "${table}" LIMIT ?) AS t`)
      .get(ONLINE_INDEX_ROW_THRESHOLD + 1)) as { c: number } | undefined;
    return Number(counted?.c ?? 0);
  } catch {
    return 0;
  }
}

/**
 * 生成済みスキーマ（PostgreSQL）から、**大きいテーブルに張る索引**を選び出す。
 *
 * 適用前に見つけておいて `CREATE INDEX CONCURRENTLY` で作るために使う。
 * 小さければ（新規の DB や小さいノード）何も返さない＝スキーマ適用時に普通に作られる。
 */
async function collectDeferredIndexesFromSchema(): Promise<DeferredIndex[]> {
  const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'db', 'schema.pg.sql');
  if (!fs.existsSync(schemaPath)) return [];
  try {
    return await pickLargeTableIndexes(fs.readFileSync(schemaPath, 'utf8'));
  } catch {
    return [];
  }
}

/** スキーマの SQL から「大きいテーブルに張る索引」だけを選ぶ（判定の実体） */
async function pickLargeTableIndexes(sql: string): Promise<DeferredIndex[]> {
  const candidates: DeferredIndex[] = [];
  const regex = /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s+ON\s+"?([A-Za-z_][A-Za-z0-9_]*)"?[^;]*;/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sql)) !== null) {
    candidates.push({ sql: match[0], name: match[1], table: match[2] });
  }
  if (candidates.length === 0) return [];

  const deferred: DeferredIndex[] = [];
  const rowsCache = new Map<string, number>();
  for (const candidate of candidates) {
    // 索引が**あって有効**なら何もしない（毎回の起動で行数を数えない）。
    // 「存在する＝出来ている」と見てはいけない: `CREATE INDEX CONCURRENTLY` が途中で失敗すると
    // **無効な索引**が残る。それをスキップしてしまうと、下の作り直し（indisvalid の判定）に
    // 永久に辿り着かない（2026-10-02 に直した）。
    const existing = (await db
      .prepare(
        `SELECT i.indisvalid AS valid
           FROM pg_class c LEFT JOIN pg_index i ON i.indexrelid = c.oid
          WHERE c.relname = ? AND c.relkind = 'i'`,
      )
      .get(candidate.name)) as { valid: boolean } | undefined;
    if (existing && existing.valid !== false) continue;
    if (existing) {
      // 無効な索引は、テーブルの大きさに関わらず作り直す
      deferred.push(candidate);
      continue;
    }

    let rows = rowsCache.get(candidate.table);
    if (rows === undefined) {
      rows = await estimateTableRows(candidate.table);
      rowsCache.set(candidate.table, rows);
    }
    if (rows >= ONLINE_INDEX_ROW_THRESHOLD) deferred.push(candidate);
  }
  return deferred;
}

/**
 * 後回しにした索引を `CREATE INDEX CONCURRENTLY` で作る。
 *
 * - `CONCURRENTLY` はトランザクションの中で実行できないので、1 文ずつ流す（自動コミット）
 * - 途中で失敗すると**無効な索引**が残ることがある。その場合は次回の起動で
 *   落としてから作り直す（`IF NOT EXISTS` があると無効な索引を「出来ている」と誤認するため）
 * - 失敗しても起動は続ける（索引が無いだけ。次回の起動でまた試す）
 *
 * SQLite では呼ばれない（1 プロセス・1 接続なので、起動時に待つだけで済む）。
 */
async function createIndexesConcurrently(deferred: DeferredIndex[]): Promise<void> {
  for (const index of deferred) {
    try {
      const invalid = (await db
        .prepare(
          `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ?`,
        )
        .get(index.name)) as { valid: boolean } | undefined;
      if (invalid && !invalid.valid) {
        console.warn(`[DB] 🐘 無効な索引を作り直します: ${index.name}`);
        await db.exec(`DROP INDEX IF EXISTS "${index.name}";`);
      }

      console.log(
        `[DB] 🐘 大きいテーブル (${index.table}) の索引を、書き込みを止めずに作ります: ${index.name}（数秒〜数分かかることがあります）`,
      );
      const concurrently = index.sql.replace(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/i, 'CREATE INDEX CONCURRENTLY IF NOT EXISTS');
      await db.exec(concurrently);
      console.log(`[DB] 🐘 索引を作成しました: ${index.name}`);
    } catch (err: any) {
      console.warn(
        `[DB] ⚠️ 索引 ${index.name} をオンラインで作れませんでした（次回の起動でもう一度試します）:`,
        String(err?.message || err).split('\n')[0],
      );
    }
  }
}

/** スキーマの適用（SQLite は migrations、PostgreSQL は生成済みスキーマ） */
async function initDatabaseSchema(): Promise<void> {
  if (db.kind === 'sqlite') {
    await db.exec('PRAGMA journal_mode = WAL;');
    await db.exec('PRAGMA foreign_keys = ON;');
    // 書き込みロックが取れないときに待つ時間。`npm run db:maintenance`（保守 CLI）は
    // 同じファイルに長時間の書き込みをかけるので、待たずに諦めると
    // **エラーになった操作が消える**（`SQLITE_BUSY` を握り潰している箇所がある）。
    // 保守 CLI 側と同じ 10 秒に合わせる。
    await db.exec('PRAGMA busy_timeout = 10000;');
  }

  // PostgreSQL では、SQLite の migrations ではなく生成済みスキーマを適用する
  // （スキーマの正は db.ts の migrations 側。npm run db:pg:schema で生成する）
  if (db.kind === 'postgres') {
    await initPostgresSchema();
    return;
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      summary TEXT DEFAULT '',
      icon_url TEXT DEFAULT '',
      banner_url TEXT DEFAULT '',
      master_key_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      is_frozen INTEGER NOT NULL DEFAULT 0,
      public_key_pem TEXT NOT NULL,
      private_key_pem TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_url TEXT NOT NULL,
      author_handle TEXT NOT NULL,
      author_icon TEXT DEFAULT '',
      content TEXT NOT NULL,
      is_local INTEGER NOT NULL DEFAULT 1,
      visibility TEXT NOT NULL DEFAULT 'public',
      emojis TEXT DEFAULT '[]',
      cw TEXT DEFAULT NULL,
      in_reply_to TEXT,
      quote_id TEXT DEFAULT NULL,
      is_sensitive INTEGER NOT NULL DEFAULT 0,
      media_attachments TEXT DEFAULT '[]',
      published_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS follows (
      id TEXT PRIMARY KEY,
      follower_url TEXT NOT NULL,
      following_url TEXT NOT NULL,
      inbox_url TEXT NOT NULL,
      is_local INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'accepted',
      created_at TEXT NOT NULL,
      UNIQUE(follower_url, following_url)
    );

    CREATE TABLE IF NOT EXISTS remote_actors (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      domain TEXT NOT NULL,
      name TEXT,
      summary TEXT,
      icon_url TEXT DEFAULT '',
      banner_url TEXT DEFAULT '',
      inbox_url TEXT NOT NULL,
      shared_inbox_url TEXT,
      public_key_id TEXT NOT NULL,
      public_key_pem TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relays (
      inbox_url TEXT PRIMARY KEY,
      actor_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reactions (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_icon TEXT DEFAULT '',
      reaction TEXT NOT NULL,
      is_local INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE(post_id, user_id, reaction)
    );

    CREATE TABLE IF NOT EXISTS announces (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_handle TEXT NOT NULL,
      user_icon TEXT DEFAULT '',
      is_local INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE(post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS blocked_domains (
      domain TEXT PRIMARY KEY,
      reason TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      actor_handle TEXT NOT NULL,
      actor_icon TEXT DEFAULT '',
      post_id TEXT,
      post_content TEXT DEFAULT '',
      content TEXT DEFAULT '',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS server_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      user_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, post_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_blocks (
      user_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      target_handle TEXT DEFAULT '',
      target_name TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, target_user_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_mutes (
      user_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      target_handle TEXT DEFAULT '',
      target_name TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, target_user_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pinned_posts (
      user_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, post_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS polls (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL UNIQUE,
      multiple INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS poll_choices (
      id TEXT PRIMARY KEY,
      poll_id TEXT NOT NULL,
      choice_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      votes_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(poll_id) REFERENCES polls(id) ON DELETE CASCADE,
      UNIQUE(poll_id, choice_index)
    );

    CREATE TABLE IF NOT EXISTS poll_votes (
      id TEXT PRIMARY KEY,
      poll_id TEXT NOT NULL,
      choice_index INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(poll_id) REFERENCES polls(id) ON DELETE CASCADE,
      UNIQUE(poll_id, user_id, choice_index)
    );

    CREATE TABLE IF NOT EXISTS custom_emojis (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '一般',
      aliases TEXT DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invitation_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT DEFAULT NULL,
      memo TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS antennas (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      src TEXT NOT NULL DEFAULT 'all',
      user_list TEXT DEFAULT '',
      keywords TEXT NOT NULL,
      exclude_keywords TEXT DEFAULT '',
      case_sensitive INTEGER NOT NULL DEFAULT 0,
      with_file INTEGER NOT NULL DEFAULT 0,
      notify INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_antennas_user ON antennas(user_id);

    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      cw TEXT DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'public',
      media_attachments TEXT DEFAULT '[]',
      poll TEXT DEFAULT '',
      in_reply_to TEXT DEFAULT '',
      quote_id TEXT DEFAULT '',
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts(user_id);

    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      cw TEXT DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'public',
      media_attachments TEXT DEFAULT '[]',
      poll TEXT DEFAULT '',
      in_reply_to TEXT DEFAULT '',
      quote_id TEXT DEFAULT '',
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT DEFAULT '',
      published_post_id TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status ON scheduled_posts(status, scheduled_at);

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      banner_url TEXT DEFAULT '',
      color TEXT DEFAULT '#6366f1',
      category TEXT DEFAULT 'general',
      is_archived INTEGER NOT NULL DEFAULT 0,
      posts_count INTEGER NOT NULL DEFAULT 0,
      followers_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id);
    CREATE INDEX IF NOT EXISTS idx_channels_created_at ON channels(created_at DESC);

    CREATE TABLE IF NOT EXISTS channel_follows (
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(channel_id, user_id),
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_channel_follows_user ON channel_follows(user_id);

    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      device_name TEXT NOT NULL DEFAULT '',
      transports TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      last_used_at TEXT DEFAULT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);

    CREATE TABLE IF NOT EXISTS webauthn_challenges (
      challenge TEXT PRIMARY KEY,
      user_id TEXT,
      type TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
      post_id UNINDEXED,
      content,
      tokenize = 'trigram'
    );

    CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
      INSERT INTO posts_fts(post_id, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
      DELETE FROM posts_fts WHERE post_id = old.id;
      INSERT INTO posts_fts(post_id, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
      DELETE FROM posts_fts WHERE post_id = old.id;
    END;

    CREATE INDEX IF NOT EXISTS idx_posts_published_at ON posts(published_at DESC);
    -- ホームタイムラインとプロフィールは author_url で絞ってから published_at 順に並べる
    -- （author_url の索引が無いと、並べ替えの索引を頼りに走査して捨てることになる）
    CREATE INDEX IF NOT EXISTS idx_posts_author_published ON posts(author_url, published_at DESC);
    -- ローカルタイムライン（is_local = 1）。リレーを購読していると大半がリモートなので、
    -- 少数派のローカルを索引で直接拾えるようにしておく
    CREATE INDEX IF NOT EXISTS idx_posts_local_published ON posts(is_local, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_in_reply_to ON posts(in_reply_to);
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_url);
    CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_url);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id);
    CREATE INDEX IF NOT EXISTS idx_reactions_user ON reactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_announces_post ON announces(post_id);
    CREATE INDEX IF NOT EXISTS idx_announces_user ON announces(user_id);
    CREATE INDEX IF NOT EXISTS idx_blocked_domains_domain ON blocked_domains(domain);
    -- ユーザー検索の走査窓（直近に見たリモートアクター N 件）を安く引くための索引
    CREATE INDEX IF NOT EXISTS idx_remote_actors_updated ON remote_actors(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id, created_at DESC);
    -- 保持期間の判定（リモート投稿を消してよいか）が post_id で引くので、単独の索引を張る。
    -- 主キーは (user_id, post_id) なので、post_id だけでは索引が効かない
    -- （無いと候補 1 件ごとに全走査になる。実測で 3.83s → 0.10s）
    CREATE INDEX IF NOT EXISTS idx_bookmarks_post ON bookmarks(post_id);
    CREATE INDEX IF NOT EXISTS idx_pinned_posts_post ON pinned_posts(post_id);
    CREATE INDEX IF NOT EXISTS idx_user_blocks_user ON user_blocks(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_mutes_user ON user_mutes(user_id);
    CREATE INDEX IF NOT EXISTS idx_pinned_posts_user ON pinned_posts(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_polls_post ON polls(post_id);
    CREATE INDEX IF NOT EXISTS idx_poll_choices_poll ON poll_choices(poll_id, choice_index);
    CREATE INDEX IF NOT EXISTS idx_poll_votes_poll_user ON poll_votes(poll_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_custom_emojis_name ON custom_emojis(name);
    CREATE INDEX IF NOT EXISTS idx_invitation_codes_created_by ON invitation_codes(created_by);
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
  `);

  // 既存DBへのマイグレーション: visibility / emojis / icon / banner / media_attachments / cw / quote_id / is_sensitive カラムの追加
  const migrations = [
    "ALTER TABLE posts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';",
    "ALTER TABLE posts ADD COLUMN emojis TEXT DEFAULT '[]';",
    "ALTER TABLE posts ADD COLUMN author_icon TEXT DEFAULT '';",
    "ALTER TABLE posts ADD COLUMN media_attachments TEXT DEFAULT '[]';",
    "ALTER TABLE posts ADD COLUMN cw TEXT DEFAULT NULL;",
    "ALTER TABLE posts ADD COLUMN quote_id TEXT DEFAULT NULL;",
    "ALTER TABLE posts ADD COLUMN is_sensitive INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE users ADD COLUMN icon_url TEXT DEFAULT '';",
    "ALTER TABLE users ADD COLUMN banner_url TEXT DEFAULT '';",
    "ALTER TABLE remote_actors ADD COLUMN icon_url TEXT DEFAULT '';",
    "ALTER TABLE remote_actors ADD COLUMN banner_url TEXT DEFAULT '';",
    "CREATE INDEX IF NOT EXISTS idx_posts_quote_id ON posts(quote_id);",
    `CREATE TABLE IF NOT EXISTS custom_emojis (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '一般',
      aliases TEXT DEFAULT '[]',
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS invitation_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT DEFAULT NULL,
      memo TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );`,
    "CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);",
    "CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(post_id UNINDEXED, content, tokenize='trigram');",
    `CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
      INSERT INTO posts_fts(post_id, content) VALUES (new.id, new.content);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
      DELETE FROM posts_fts WHERE post_id = old.id;
      INSERT INTO posts_fts(post_id, content) VALUES (new.id, new.content);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
      DELETE FROM posts_fts WHERE post_id = old.id;
    END;`,
    "CREATE INDEX IF NOT EXISTS idx_custom_emojis_name ON custom_emojis(name);",
    "CREATE INDEX IF NOT EXISTS idx_invitation_codes_created_by ON invitation_codes(created_by);",
    "ALTER TABLE posts ADD COLUMN channel_id TEXT DEFAULT NULL;",
    "CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel_id, published_at DESC);",
    `CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      banner_url TEXT DEFAULT '',
      color TEXT DEFAULT '#6366f1',
      category TEXT DEFAULT 'general',
      is_archived INTEGER NOT NULL DEFAULT 0,
      posts_count INTEGER NOT NULL DEFAULT 0,
      followers_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );`,
    "ALTER TABLE channels ADD COLUMN color TEXT DEFAULT '#6366f1';",
    "ALTER TABLE channels ADD COLUMN category TEXT DEFAULT 'general';",
    "ALTER TABLE channels ADD COLUMN followers_count INTEGER NOT NULL DEFAULT 1;",
    "CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id);",
    "CREATE INDEX IF NOT EXISTS idx_channels_created_at ON channels(created_at DESC);",
    `CREATE TABLE IF NOT EXISTS channel_follows (
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(channel_id, user_id),
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );`,
    "CREATE INDEX IF NOT EXISTS idx_channel_follows_user ON channel_follows(user_id);",
    `CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      device_name TEXT NOT NULL DEFAULT '',
      transports TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      last_used_at TEXT DEFAULT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );`,
    "CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);",
    `CREATE TABLE IF NOT EXISTS webauthn_challenges (
      challenge TEXT PRIMARY KEY,
      user_id TEXT,
      type TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );`,
    // 通報（モデレーションキュー）
    `CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_actor_url TEXT NOT NULL,
      reporter_user_id TEXT,
      reporter_handle TEXT DEFAULT '',
      target_actor_url TEXT NOT NULL,
      target_user_id TEXT,
      target_handle TEXT DEFAULT '',
      target_post_id TEXT,
      target_post_content TEXT,
      is_remote INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT 'other',
      comment TEXT DEFAULT '',
      forwarded INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      resolved_by TEXT,
      resolved_at TEXT,
      resolution_note TEXT,
      created_at TEXT NOT NULL
    );`,
    "CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_actor_url);",
    // 鍵アカウント（フォロー承認制）
    "ALTER TABLE users ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0;",
    // ワードフィルター（ミュートワード）
    `CREATE TABLE IF NOT EXISTS muted_words (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      case_sensitive INTEGER NOT NULL DEFAULT 0,
      whole_word INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );`,
    "CREATE INDEX IF NOT EXISTS idx_muted_words_user ON muted_words(user_id);",
    // お知らせ（サーバーからの一斉告知）
    `CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
    "CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active, created_at DESC);",
    // リンクプレビュー（OGP/oEmbed）キャッシュ
    `CREATE TABLE IF NOT EXISTS link_previews (
      url TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      image_url TEXT,
      site_name TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      fetched_at TEXT NOT NULL
    );`,
    // リスト（ユーザーを束ねた専用タイムライン）
    `CREATE TABLE IF NOT EXISTS lists (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS list_members (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      member TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(list_id, member)
    );`,
    "CREATE INDEX IF NOT EXISTS idx_lists_user ON lists(user_id);",
    "CREATE INDEX IF NOT EXISTS idx_list_members_list ON list_members(list_id);",
    // ロール（権限）とユーザーへの付与
    `CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#6366f1',
      permissions TEXT NOT NULL DEFAULT '',
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS user_roles (
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, role_id)
    );`,
    "CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);",
    // プロフィール項目（リンク集など）とディレクトリ公開設定
    "ALTER TABLE users ADD COLUMN fields TEXT DEFAULT '[]';",
    "ALTER TABLE users ADD COLUMN discoverable INTEGER NOT NULL DEFAULT 1;",
    // メールアドレス（任意）と確認状態 / パスワード方式用ハッシュ
    "ALTER TABLE users ADD COLUMN email TEXT DEFAULT '';",
    "ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE users ADD COLUMN password_hash TEXT DEFAULT '';",
    // メールアドレス確認・マスターキー復元の確認コード
    `CREATE TABLE IF NOT EXISTS email_verifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      purpose TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );`,
    "CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id, purpose);",
    "CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);",
    // 配送再送キュー（一時的な障害で失敗した ActivityPub 配送を指数バックオフで再送する）
    `CREATE TABLE IF NOT EXISTS outbox_deliveries (
      id TEXT PRIMARY KEY,
      activity_id TEXT DEFAULT '',
      activity_type TEXT DEFAULT '',
      inbox_url TEXT NOT NULL,
      activity TEXT NOT NULL,
      sender_user_id TEXT DEFAULT NULL,
      use_instance_actor INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 1,
      next_attempt_at TEXT NOT NULL,
      last_status INTEGER DEFAULT NULL,
      last_error TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
    "CREATE INDEX IF NOT EXISTS idx_outbox_deliveries_due ON outbox_deliveries(status, next_attempt_at);",
    "CREATE INDEX IF NOT EXISTS idx_outbox_deliveries_target ON outbox_deliveries(activity_id, inbox_url);",
    // 汎用のジョブキュー（予約投稿・配送・メンテナンス以外の背景処理をここにまとめる）
    //   status: pending（待機）→ running（実行中）→ done / failed
    //   取り出しは条件付き UPDATE で宣言するので、複数プロセスでも二重に実行しない
    `CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT DEFAULT '',
      result TEXT DEFAULT '',
      dedupe_key TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
    "ALTER TABLE jobs ADD COLUMN result TEXT DEFAULT '';",
    // 同じ「順序の単位」（受信ならアクター）の中では、古い仕事から順に片付ける。
    // 非同期の受信処理で Create → Delete が入れ替わらないようにするための列
    "ALTER TABLE jobs ADD COLUMN group_key TEXT DEFAULT NULL;",
    "CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(kind, status, next_attempt_at);",
    "CREATE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs(dedupe_key, status);",
    "CREATE INDEX IF NOT EXISTS idx_jobs_group ON jobs(kind, group_key, status, id);",
    // 削除されたリモート投稿の ID（墓標）。連合では Delete の後に同じ投稿が
    // 再送されてくることがある（再送・リレーの折り返し・相手の再起動）ので、
    // 記録が無いと**消したはずの投稿が復活する**。受信の取り込み時に見る
    `CREATE TABLE IF NOT EXISTS deleted_remote_posts (
      id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL
    );`,
    "CREATE INDEX IF NOT EXISTS idx_deleted_remote_posts_at ON deleted_remote_posts(deleted_at);",
    // MiAuth（Misskey 互換のクライアント連携）: クライアントが作ったセッション ID ごとに
    // アプリ名・権限・承認状態を持つ。承認されると通常のセッションと同じトークンを発行する
    `CREATE TABLE IF NOT EXISTS miauth_sessions (
      id TEXT PRIMARY KEY,
      app_name TEXT NOT NULL DEFAULT '',
      callback TEXT NOT NULL DEFAULT '',
      permissions TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      approved_user_id TEXT,
      token TEXT,
      created_at TEXT NOT NULL
    );`,
    "CREATE INDEX IF NOT EXISTS idx_miauth_created ON miauth_sessions(created_at DESC);",
    // 相手（リモート）がこちらをブロックした記録: 配送抑制と表示制御に使う
    `CREATE TABLE IF NOT EXISTS remote_blocks (
      blocker_actor_url TEXT NOT NULL,
      blocked_actor_url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (blocker_actor_url, blocked_actor_url)
    );`,
    "CREATE INDEX IF NOT EXISTS idx_remote_blocks_blocked ON remote_blocks(blocked_actor_url);",
    // 引っ越し（Move）: 移行先 / 移行元アカウントの記録
    "ALTER TABLE remote_actors ADD COLUMN moved_to TEXT DEFAULT '';",
    "ALTER TABLE users ADD COLUMN moved_to TEXT DEFAULT '';",
    "ALTER TABLE users ADD COLUMN also_known_as TEXT DEFAULT '';",
    // ドライブ: アップロードしたメディアの台帳（投稿に紐づかないものも管理できるようにする）
    `CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      key TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      name TEXT DEFAULT '',
      thumbnail_url TEXT DEFAULT '',
      thumbnail_key TEXT DEFAULT '',
      width INTEGER,
      height INTEGER,
      duration REAL,
      post_id TEXT,
      created_at TEXT NOT NULL
    );`,
    "CREATE INDEX IF NOT EXISTS idx_media_user ON media(user_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_media_post ON media(post_id);",
    "CREATE INDEX IF NOT EXISTS idx_media_url ON media(url);",
    // 管理操作の監査ログ（複数人運用で「誰が何をしたか」を追う）
    `CREATE TABLE IF NOT EXISTS admin_actions (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      method TEXT DEFAULT '',
      path TEXT DEFAULT '',
      target_type TEXT DEFAULT '',
      target_id TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      status INTEGER NOT NULL DEFAULT 200,
      created_at TEXT NOT NULL
    );`,
    "CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_admin_actions_actor ON admin_actions(actor_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_admin_actions_target ON admin_actions(target_id);",
    // 画像プロキシのキャッシュ台帳（実体は data/proxy-cache/ に置く）
    `CREATE TABLE IF NOT EXISTS proxy_cache (
      url_hash TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );`,
    "CREATE INDEX IF NOT EXISTS idx_proxy_cache_last_used ON proxy_cache(last_used_at);",
    // 通知の種類別設定（JSON: { reaction: false, ... } 無効にする種類だけ false で保存）
    "ALTER TABLE users ADD COLUMN notification_prefs TEXT DEFAULT '{}';",
    // 表示と投稿の好み（JSON。検証は userPrefs.ts が唯一の正）。端末ごとの localStorage から移した
    "ALTER TABLE users ADD COLUMN prefs TEXT DEFAULT '{}';",
    // ログイン中の端末一覧に出す User-Agent の控え（設定 → セッション）
    "ALTER TABLE sessions ADD COLUMN user_agent TEXT DEFAULT '';",
    // ドメインブロックの強さ（suspend = 完全遮断 / silence = 表示から除外のみ・配送は継続）
    "ALTER TABLE blocked_domains ADD COLUMN severity TEXT NOT NULL DEFAULT 'suspend';",
    // メール通知のオプトイン（既定 OFF。SMTP 未設定なら機能ごと無効）
    "ALTER TABLE users ADD COLUMN email_notifications INTEGER NOT NULL DEFAULT 0;",
    // FTS 索引の方針（リモート投稿を索引するか）を行ごとに持つ。方針は searchPolicy.ts が決める。
    "ALTER TABLE posts ADD COLUMN fts_indexed INTEGER NOT NULL DEFAULT 1;",
    // FTS 同期トリガは fts_indexed = 1 の行だけを索引する（リレー経由の投稿で索引が膨らむのを防ぐ）
    "DROP TRIGGER IF EXISTS posts_ai;",
    "DROP TRIGGER IF EXISTS posts_au;",
    `CREATE TRIGGER posts_ai AFTER INSERT ON posts WHEN new.fts_indexed = 1 BEGIN
      INSERT INTO posts_fts(post_id, content) VALUES (new.id, new.content);
    END;`,
    `CREATE TRIGGER posts_au AFTER UPDATE ON posts WHEN new.fts_indexed = 1 BEGIN
      DELETE FROM posts_fts WHERE post_id = old.id;
      INSERT INTO posts_fts(post_id, content) VALUES (new.id, new.content);
    END;`,
    `CREATE TRIGGER posts_ad AFTER DELETE ON posts BEGIN
      DELETE FROM posts_fts WHERE post_id = old.id;
    END;`,
    // 予約投稿の公開中フラグ（'publishing'）を戻すための時刻。
    // 公開中にプロセスが落ちた行を、一定時間後に待機中へ戻すために使う
    "ALTER TABLE scheduled_posts ADD COLUMN updated_at TEXT DEFAULT '';",
    // 自分の投稿一覧・プロフィールの件数（COUNT(*) WHERE user_id = ?）が全表走査にならないようにする
    "CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id);",
    // 起動時の FTS 同期チェック（索引対象の件数）と、方針適用の走査を安くする部分索引。
    // `COUNT(*) WHERE fts_indexed = 1` が索引だけで数えられる（実測 47 万行で 0.16s → 0.00s）
    "CREATE INDEX IF NOT EXISTS idx_posts_fts_indexed ON posts(id) WHERE fts_indexed = 1;",
    // 期限切れセッションの掃除（DELETE ... WHERE expires_at <= ?）を索引で支える
    "CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);",
    // 読み終わった通知の保持期間による削除（DELETE ... WHERE is_read = 1 AND created_at <= ?）用
    "CREATE INDEX IF NOT EXISTS idx_notifications_read_created ON notifications(is_read, created_at);",
    // 置き去りの一時ファイル・メディアの掃除で「作られてから古いもの」を引く用
    "CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at);",
    // 「相手がこちらをブロックしている」判定（配送のたびに引く）用
    "CREATE INDEX IF NOT EXISTS idx_remote_blocks_blocker ON remote_blocks(blocker_actor_url);",
    // ストリーミングのワンタイムチケット（クエリ文字列にトークンを載せないため）。
    // 発行から 60 秒・1 回だけ有効
    `CREATE TABLE IF NOT EXISTS stream_tickets (
      ticket TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );`,
    "CREATE INDEX IF NOT EXISTS idx_stream_tickets_expires ON stream_tickets(expires_at);",
    // DM（1対1メッセージ）: 宛先の actor URL を JSON 配列で持つ（visibility = 'direct' のときだけ使う）。
    // 専用テーブルは作らず、既存の posts の仕組み（連合・スレッド・メディア・通知・削除）に乗る
    "ALTER TABLE posts ADD COLUMN recipients TEXT DEFAULT '[]';",
    // DM 一覧（visibility = 'direct' を新しい順に引く）用
    "CREATE INDEX IF NOT EXISTS idx_posts_visibility_published ON posts(visibility, published_at DESC);",
    // DM の既読状態。メッセージ本体ではなく「誰がどのメッセージを読んだか」だけを持つ補助表
    `CREATE TABLE IF NOT EXISTS dm_reads (
      user_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      read_at TEXT NOT NULL,
      PRIMARY KEY(user_id, post_id)
    );`,
    "CREATE INDEX IF NOT EXISTS idx_dm_reads_post ON dm_reads(post_id);",
  ];

  // マイグレーションの適用。
  //
  // - **適用済みのものは飛ばす**（`schema_migrations` に記録する）。以前は起動のたびに
  //   全件を流し直していて、大きい DB では毎回の起動が無駄に重かった。
  // - PostgreSQL はここへ来ない（生成済みスキーマを適用する側で、大きいテーブルの索引だけを
  //   `CREATE INDEX CONCURRENTLY` に回している）。
  const applied = await loadAppliedMigrations();

  let appliedNow = 0;
  for (const sql of migrations) {
    const key = migrationKey(sql);
    if (applied.has(key)) continue;

    let note = '';
    try {
      await db.exec(sql);
    } catch (err: any) {
      // 「すでにある」なら望ましい状態なので記録する。それ以外は記録せず次回もう一度試す
      if (!isAlreadyAppliedError(err)) {
        console.warn(
          '[DB] ⚠️ マイグレーションを適用できませんでした（次回の起動でもう一度試します）:',
          String(err?.message || err).split('\n')[0],
        );
        continue;
      }
      note = '既存';
    }
    if (await recordMigration(key, note)) appliedNow++;
  }
  if (appliedNow > 0) {
    console.log(`[DB] 🧱 マイグレーション ${appliedNow} 件を適用しました（記録済み ${applied.size + appliedNow} 件）`);
  }

  // FTS5 既存投稿データの同期（未同期の過去ノートを一括インデックス化）
  try {
    const ftsCount = (await db.prepare('SELECT COUNT(*) as c FROM posts_fts').get() as any).c;
    // 比べる相手は「索引する対象」＝ fts_indexed = 1 の投稿（上と同じ理由）
    const indexedCount = (await db.prepare('SELECT COUNT(*) as c FROM posts WHERE fts_indexed = 1').get() as any).c;
    if (ftsCount < indexedCount) {
      console.log(`[FTS5] 🔄 Syncing existing posts to posts_fts (${ftsCount} -> ${indexedCount})...`);
      await db.prepare(`
        INSERT INTO posts_fts(post_id, content)
        SELECT id, content FROM posts
        WHERE fts_indexed = 1 AND id NOT IN (SELECT post_id FROM posts_fts)
      `).run();
      console.log('[FTS5] ✅ Posts FTS initial sync completed.');
    }
  } catch (ftsSyncErr) {
    console.warn('[FTS5 Sync Warning]:', ftsSyncErr);
  }
}

export interface ChannelRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  banner_url: string;
  color?: string;
  category?: string;
  is_archived: number;
  posts_count: number;
  followers_count: number;
  created_at: string;
}

export interface WebAuthnCredentialRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  device_name: string;
  transports: string;
  created_at: string;
  last_used_at: string | null;
}

export interface PushSubscriptionRow {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

export interface RelayRow {
  inbox_url: string;
  actor_url: string;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: string;
}

export interface UserRow {
  id: string;
  name: string;
  summary: string;
  icon_url?: string;
  banner_url?: string;
  master_key_hash: string;
  role: 'admin' | 'user';
  is_frozen: number;
  /** 鍵アカウント（フォロー承認制）: 1 なら新規フォローを承認制にする */
  is_locked: number;
  /** プロフィール項目（JSON 配列: [{ name, value }]） */
  fields?: string;
  /** メールアドレス（任意・復元用） */
  email?: string;
  /** メールアドレスの確認状態（1 = 確認済み） */
  email_verified?: number;
  /** パスワード方式（auth_mode = password）のハッシュ */
  password_hash?: string;
  /** ユーザーディレクトリへの掲載可否（1 = 掲載） */
  discoverable?: number;
  /** 引っ越し先アカウント（Actor URL）。設定されていれば Actor 文書に movedTo として出る */
  moved_to?: string;
  /** 引っ越し元アカウント（Actor URL）。連合先が Move を検証するために alsoKnownAs として公開する */
  also_known_as?: string;
  public_key_pem: string;
  private_key_pem: string;
  created_at: string;
}

export interface SessionRow {
  token: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

export interface PostRow {
  id: string;
  user_id: string;
  author_name: string;
  author_url: string;
  author_handle: string;
  author_icon?: string;
  content: string;
  is_local: number;
  /** 'direct' は DM（1対1のメッセージ）。宛先は `recipients`（JSON 配列）に持つ（docs/DM.md） */
  visibility: 'public' | 'local' | 'followers' | 'direct';
  emojis?: string;
  cw?: string | null;
  in_reply_to: string | null;
  quote_id?: string | null;
  is_sensitive?: number;
  media_attachments?: string;
  published_at: string;
}

export interface PinnedPostRow {
  user_id: string;
  post_id: string;
  created_at: string;
}

export interface PollRow {
  id: string;
  post_id: string;
  multiple: number;
  expires_at: string | null;
  created_at: string;
}

export interface PollChoiceRow {
  id: string;
  poll_id: string;
  choice_index: number;
  text: string;
  votes_count: number;
}

export interface PollVoteRow {
  id: string;
  poll_id: string;
  choice_index: number;
  user_id: string;
  created_at: string;
}

export interface FollowRow {
  id: string;
  follower_url: string;
  following_url: string;
  inbox_url: string;
  is_local: number;
  status: string;
  created_at: string;
}

export interface RemoteActorRow {
  id: string;
  username: string;
  domain: string;
  name: string | null;
  summary: string | null;
  icon_url?: string | null;
  banner_url?: string | null;
  inbox_url: string;
  shared_inbox_url: string | null;
  public_key_id: string;
  public_key_pem: string;
  updated_at: string;
}

export interface ReactionRow {
  id: string;
  post_id: string;
  user_id: string;
  user_name: string;
  user_icon?: string;
  reaction: string;
  is_local: number;
  created_at: string;
}

export interface AnnounceRow {
  id: string;
  post_id: string;
  user_id: string;
  user_name: string;
  user_handle: string;
  user_icon?: string;
  is_local: number;
  created_at: string;
}

export interface BlockedDomainRow {
  domain: string;
  reason: string;
  created_at: string;
  created_by: string;
}

export interface CustomEmojiRow {
  id: string;
  name: string;
  url: string;
  category: string;
  aliases: string;
  created_at: string;
}

export interface InvitationCodeRow {
  code: string;
  created_by: string;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  memo: string;
  created_at: string;
}

export interface AntennaRow {
  id: string;
  user_id: string;
  name: string;
  src: 'all' | 'home' | 'users';
  user_list: string;
  keywords: string;
  exclude_keywords: string;
  case_sensitive: number;
  with_file: number;
  notify: number;
  created_at: string;
}

export interface DraftRow {
  id: string;
  user_id: string;
  content: string;
  cw: string;
  visibility: string;
  media_attachments: string;
  poll: string;
  in_reply_to: string;
  quote_id: string;
  updated_at: string;
  created_at: string;
}

export interface ScheduledPostRow {
  id: string;
  user_id: string;
  content: string;
  cw: string;
  visibility: string;
  media_attachments: string;
  poll: string;
  in_reply_to: string;
  quote_id: string;
  scheduled_at: string;
  status: 'pending' | 'published' | 'failed';
  error_message: string;
  published_post_id: string;
  created_at: string;
}

/**
 * ホスト名またはURL、ハンドルからドメイン（小文字）を抽出
 */
export function extractDomain(input: string): string {
  if (!input) return '';
  let str = input.trim().toLowerCase();

  // @user@domain.com 形式
  if (str.includes('@')) {
    const parts = str.split('@').filter(Boolean);
    if (parts.length >= 2) {
      str = parts[parts.length - 1];
    }
  }

  // URL 形式
  if (str.startsWith('http://') || str.startsWith('https://')) {
    try {
      return new URL(str).hostname.toLowerCase();
    } catch {}
  }

  // プロトコル prefix、パス、ポートの除去
  str = str.replace(/^[a-z]+:\/\//, '');
  str = str.split('/')[0];
  str = str.split(':')[0];
  return str.trim();
}

/**
 * 指定ドメインまたはURLがブロックリストに登録されているかを判定
 * (完全一致、またはサブドメイン一致: 例 'bad.com' がブロックされていれば 'sub.bad.com' もブロック)
 *
 * severity:
 *   suspend（既定）… 配送・受信・表示のすべてを遮断する（従来の挙動）
 *   silence        … ローカルのタイムライン等からは隠すが、フォロー関係と配送は維持する
 */
export type DomainBlockSeverity = 'suspend' | 'silence';

export interface BlockedDomainRule { domain: string; severity: DomainBlockSeverity }

/**
 * ブロックリストを一括で読み込む。
 * 1 件ずつ問い合わせる findDomainBlock と違い、
 * タイムラインのように多数の投稿をまとめて判定する用途で使う（判定は matchesBlockedDomainRule）。
 *
 * タイムラインの整形と配送のたびに呼ばれるので、**短い TTL のキャッシュを持つ**
 * （毎回全件読み直すのは、リレーで DB が育つほど効いてくる）。変更時は
 * `invalidateBlockedDomainRules()` を呼べばすぐ反映される（他プロセスは TTL ぶん遅れる）。
 */
const BLOCKED_RULES_TTL_MS = 30_000;
let blockedRulesCache: { at: number; rules: BlockedDomainRule[] } | null = null;

export function invalidateBlockedDomainRules(): void {
  blockedRulesCache = null;
}

export async function loadBlockedDomainRules(): Promise<BlockedDomainRule[]> {
  const cached = blockedRulesCache;
  if (cached && Date.now() - cached.at < BLOCKED_RULES_TTL_MS) return cached.rules;

  try {
    const rows = await db.prepare('SELECT domain, severity FROM blocked_domains').all() as { domain: string; severity?: string }[];
    const rules = rows.map((row) => ({
      domain: String(row.domain || '').toLowerCase(),
      severity: row.severity === 'silence' ? 'silence' as const : 'suspend' as const,
    }));
    blockedRulesCache = { at: Date.now(), rules };
    return rules;
  } catch {
    // テーブル未作成時の安全フォールバック
    return [];
  }
}

/**
 * 読み込み済みのルールに対する同期判定（該当なしなら null）。
 * 完全一致、またはサブドメイン一致: 例 'bad.com' がブロックされていれば 'sub.bad.com' も該当
 */
export function matchesBlockedDomainRule(rules: BlockedDomainRule[], domainOrUrl: string | null | undefined): BlockedDomainRule | null {
  if (!domainOrUrl) return null;
  const domain = extractDomain(domainOrUrl);
  if (!domain) return null;
  for (const rule of rules) {
    if (domain === rule.domain || domain.endsWith(`.${rule.domain}`)) return rule;
  }
  return null;
}

async function findDomainBlock(domainOrUrl: string): Promise<BlockedDomainRule | null> {
  return matchesBlockedDomainRule(await loadBlockedDomainRules(), domainOrUrl);
}

/** 完全遮断（suspend）されているか。配送・受信・フォローを止める判定に使う */
export async function isDomainBlocked(domainOrUrl: string): Promise<boolean> {
  return (await findDomainBlock(domainOrUrl))?.severity === 'suspend';
}

/** 表示から除外すべきか（suspend と silence の両方）。タイムライン・検索の絞り込みに使う */
export async function isDomainHidden(domainOrUrl: string): Promise<boolean> {
  return (await findDomainBlock(domainOrUrl)) !== null;
}

/** 指定ドメインの遮断の強さ（未登録なら null） */
export async function getDomainBlockSeverity(domainOrUrl: string): Promise<DomainBlockSeverity | null> {
  return (await findDomainBlock(domainOrUrl))?.severity ?? null;
}

/**
 * 相手（リモート）がローカルアクターをブロックしたことを記録する
 */
export async function addRemoteBlock(blockerActorUrl: string, blockedActorUrl: string): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO remote_blocks (blocker_actor_url, blocked_actor_url, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(blocker_actor_url, blocked_actor_url) DO NOTHING
    `).run(blockerActorUrl, blockedActorUrl, new Date().toISOString());
  } catch (err) {
    console.error('[Remote Block] ❌ 記録に失敗:', err);
  }
}

/** 受信した Block を取り消す（Undo Block） */
export async function removeRemoteBlock(blockerActorUrl: string, blockedActorUrl: string): Promise<boolean> {
  try {
    const res = await db.prepare('DELETE FROM remote_blocks WHERE blocker_actor_url = ? AND blocked_actor_url = ?').run(blockerActorUrl, blockedActorUrl);
    return Number(res.changes ?? 0) > 0;
  } catch (err) {
    console.error('[Remote Block] ❌ 削除に失敗:', err);
    return false;
  }
}

/** 指定のブロッカーがローカルアクターをブロックしているか */
export async function isBlockedByRemoteActor(blockerActorUrl: string, blockedActorUrl: string): Promise<boolean> {
  try {
    return Boolean(
      await db.prepare('SELECT 1 FROM remote_blocks WHERE blocker_actor_url = ? AND blocked_actor_url = ?').get(blockerActorUrl, blockedActorUrl),
    );
  } catch {
    return false;
  }
}

/**
 * 配送先 Inbox の持ち主が senderActorUrl をブロックしているか（配送抑制に使う）
 * ※ remote_blocks のブロッカーは remote_actors.id（= Actor URL）で保持している
 */
export async function isInboxBlockingSender(inboxUrl: string, senderActorUrl: string): Promise<boolean> {
  if (!inboxUrl || !senderActorUrl) return false;
  try {
    const row = await db.prepare(`
      SELECT 1 FROM remote_blocks rb
      JOIN remote_actors ra ON ra.id = rb.blocker_actor_url
      WHERE rb.blocked_actor_url = ? AND (ra.inbox_url = ? OR ra.shared_inbox_url = ?)
      LIMIT 1
    `).get(senderActorUrl, inboxUrl, inboxUrl);
    return Boolean(row);
  } catch {
    return false;
  }
}

/** 受信した Block の一覧（管理・デバッグ用） */
export async function listRemoteBlocks(limit = 100): Promise<{ blocker_actor_url: string; blocked_actor_url: string; created_at: string }[]> {
  try {
    return await db.prepare('SELECT * FROM remote_blocks ORDER BY created_at DESC LIMIT ?').all(limit) as {
      blocker_actor_url: string;
      blocked_actor_url: string;
      created_at: string;
    }[];
  } catch {
    return [];
  }
}

/**
 * ブロックされたドメインに関するリモート投稿、アクターキャッシュ、フォロー関係を一括パージ（消去）
 */
export async function purgeDomainData(domain: string): Promise<{ posts: number; actors: number; follows: number; relays: number }> {
  const cleanDomain = extractDomain(domain);
  if (!cleanDomain) return { posts: 0, actors: 0, follows: 0, relays: 0 };

  const domainPattern = `%${cleanDomain}%`;

  // 1. 該当ドメインの投稿（連合投稿のみ対象。ローカル投稿は絶対に消さない）
  const postsRes = await db.prepare(`
    DELETE FROM posts 
    WHERE is_local = 0 AND (
      author_handle LIKE ? OR 
      author_url LIKE ? OR 
      user_id LIKE ?
    )
  `).run(`%@${cleanDomain}`, domainPattern, domainPattern);

  // 2. リモートアクターキャッシュの削除
  const actorsRes = await db.prepare(`
    DELETE FROM remote_actors 
    WHERE domain = ? OR domain LIKE ? OR id LIKE ?
  `).run(cleanDomain, `%.${cleanDomain}`, domainPattern);

  // 3. フォロー関係の削除
  const followsRes = await db.prepare(`
    DELETE FROM follows 
    WHERE follower_url LIKE ? OR following_url LIKE ?
  `).run(domainPattern, domainPattern);

  // 4. 該当ドメインのリレー削除
  const relaysRes = await db.prepare(`
    DELETE FROM relays 
    WHERE inbox_url LIKE ? OR actor_url LIKE ?
  `).run(domainPattern, domainPattern);

  console.log(`[Domain Block Purge] 🧹 Purged data for "${cleanDomain}": ${postsRes.changes} posts, ${actorsRes.changes} actors, ${followsRes.changes} follows, ${relaysRes.changes} relays`);

  return {
    posts: Number(postsRes.changes),
    actors: Number(actorsRes.changes),
    follows: Number(followsRes.changes),
    relays: Number(relaysRes.changes),
  };
}

export interface NotificationRow {
  id: string;
  user_id: string;
  type: 'reply' | 'follow' | 'renote' | 'announce' | 'reaction' | 'antenna' | 'scheduled_published' | 'mention' | 'move' | 'report' | 'login' | 'dm';
  actor_id: string;
  actor_name: string;
  actor_handle: string;
  actor_icon: string;
  post_id: string | null;
  post_content: string;
  content: string;
  is_read: number;
  created_at: string;
}

/**
 * 通知の種類別設定
 *
 * users.notification_prefs に JSON で保存する（無効にした種類だけ false）。
 * 未設定・不正な JSON は「すべて有効」として扱う。
 * scheduled_published（予約投稿の公開）は自分の操作に対する控えなので常に有効。
 */
export const NOTIFICATION_TYPES = ['follow', 'reply', 'mention', 'reaction', 'renote', 'antenna', 'move', 'report', 'login', 'dm'] as const;
export type NotificationPrefType = (typeof NOTIFICATION_TYPES)[number];

/** UI 表示用のラベル（クライアントと揃える） */
export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  follow: 'フォロー',
  reply: '返信',
  mention: 'メンション',
  reaction: 'リアクション',
  renote: 'リノート / ブースト',
  antenna: 'アンテナ',
  move: '引っ越し（Move）',
  report: '通報（運営向け）',
  login: '新しい端末のログイン',
  dm: 'メッセージ',
};

/**
 * 運営メンバー（admin / moderate 権限を持つローカルユーザー）の ID 一覧。
 * 通報の通知など、管理者向けの配布先として使う。
 */
export async function listStaffUserIds(): Promise<string[]> {
  try {
    const users = await db.prepare('SELECT id, role FROM users').all() as unknown as { id: string; role: string }[];
    const roleRows = await db.prepare(`
      SELECT ur.user_id AS user_id, r.permissions AS permissions
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    `).all() as unknown as { user_id: string; permissions: string }[];

    const staff = new Set<string>();
    for (const user of users) {
      if (user.role === 'admin') staff.add(user.id);
    }
    for (const row of roleRows) {
      const permissions = String(row.permissions || '').split(',').map((p) => p.trim());
      if (permissions.includes('admin') || permissions.includes('moderate')) {
        staff.add(row.user_id);
      }
    }
    return Array.from(staff);
  } catch {
    return [];
  }
}

export async function getNotificationPrefs(userId: string): Promise<Record<string, boolean>> {
  const row = await db.prepare('SELECT notification_prefs FROM users WHERE id = ?').get(userId) as { notification_prefs?: string | null } | undefined;
  const prefs: Record<string, boolean> = {};
  for (const type of NOTIFICATION_TYPES) prefs[type] = true;
  if (!row?.notification_prefs) return prefs;
  try {
    const parsed = JSON.parse(row.notification_prefs);
    if (parsed && typeof parsed === 'object') {
      for (const type of NOTIFICATION_TYPES) {
        if (typeof (parsed as any)[type] === 'boolean') prefs[type] = Boolean((parsed as any)[type]);
      }
    }
  } catch {
    // 壊れた設定は既定（すべて有効）に戻す
  }
  return prefs;
}

export async function saveNotificationPrefs(userId: string, prefs: Record<string, unknown>): Promise<Record<string, boolean>> {
  const clean: Record<string, boolean> = {};
  for (const type of NOTIFICATION_TYPES) {
    if (typeof prefs[type] === 'boolean') clean[type] = prefs[type] as boolean;
  }
  await db.prepare('UPDATE users SET notification_prefs = ? WHERE id = ?').run(JSON.stringify(clean), userId);
  return await getNotificationPrefs(userId);
}

/** 生の JSON 値から、その種類の通知が有効かを判定する（createNotification 用） */
export function isNotificationTypeEnabled(rawPrefs: string | null | undefined, type: string): boolean {
  if (type === 'scheduled_published') return true;
  if (!rawPrefs) return true;
  try {
    const parsed = JSON.parse(rawPrefs);
    if (parsed && typeof parsed === 'object' && typeof (parsed as any)[type] === 'boolean') {
      return Boolean((parsed as any)[type]);
    }
  } catch {
    // 壊れた設定は有効扱い
  }
  return true;
}

/** 無効にされている通知の種類（通知一覧のフィルタ用） */
export async function getDisabledNotificationTypes(userId: string): Promise<string[]> {
  const prefs = await getNotificationPrefs(userId);
  return NOTIFICATION_TYPES.filter((type) => !prefs[type]);
}

/**
 * 通知を作成して DB に保存
 */
export async function createNotification(params: {
  userId: string;
  type: 'reply' | 'follow' | 'renote' | 'announce' | 'reaction' | 'antenna' | 'scheduled_published' | 'mention' | 'move' | 'report' | 'login' | 'dm';
  actorId: string;
  actorName: string;
  actorHandle: string;
  actorIcon?: string;
  postId?: string;
  postContent?: string;
  content?: string;
}): Promise<boolean> {
  // 自分自身に対するアクションは通知しない (予約投稿の自動公開など、システム自己通知は許可)
  if (params.type !== 'scheduled_published' && (params.userId === params.actorId || params.actorHandle.startsWith(`@${params.userId}@`))) {
    return false;
  }

  // 受信者がローカルユーザーとして存在するか
  const user = await db.prepare('SELECT id, notification_prefs FROM users WHERE id = ?').get(params.userId) as
    | { id: string; notification_prefs?: string | null }
    | undefined;
  if (!user) return false;

  // 種類別の通知設定で無効にされている場合は生成しない（SSE / Web Push も同時に止まる）
  if (!isNotificationTypeEnabled(user.notification_prefs, params.type)) {
    return false;
  }

  // 重複防止（フォロー通知は同じ人から未読が既にあれば二重生成しない）
  if (params.type === 'follow') {
    const existing = await db.prepare(`
      SELECT id FROM notifications 
      WHERE user_id = ? AND type = 'follow' AND actor_id = ? AND is_read = 0
    `).get(params.userId, params.actorId);
    if (existing) return false;
  }

  // 同一投稿に対する同一ユーザーからの同一リアクション通知の重複防止
  if (params.type === 'reaction' && params.postId) {
    const existing = await db.prepare(`
      SELECT id FROM notifications 
      WHERE user_id = ? AND type = 'reaction' AND actor_id = ? AND post_id = ? AND content = ?
    `).get(params.userId, params.actorId, params.postId, params.content || '');
    if (existing) return false;
  }

  const id = `notif_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();

  // HTMLタグを除去し、適切な長さにトリム
  const postSnippet = (params.postContent || '').replace(/<[^>]+>/g, '').trim().slice(0, 100);
  const contentSnippet = (params.content || '').replace(/<[^>]+>/g, '').trim().slice(0, 140);

  try {
    await db.prepare(`
      INSERT INTO notifications (id, user_id, type, actor_id, actor_name, actor_handle, actor_icon, post_id, post_content, content, is_read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      id,
      params.userId,
      params.type,
      params.actorId,
      params.actorName,
      params.actorHandle,
      params.actorIcon || '',
      params.postId || null,
      postSnippet,
      contentSnippet,
      now
    );
    console.log(`[Notification] 🔔 Created ${params.type} notification for @${params.userId} from ${params.actorHandle}`);

    // 📡 リアルタイム SSE 通知プッシュ
    sendNotificationToUser(params.userId, {
      id,
      user_id: params.userId,
      type: params.type,
      actor_id: params.actorId,
      actor_name: params.actorName,
      actor_handle: params.actorHandle,
      actor_icon: params.actorIcon || '',
      post_id: params.postId || null,
      post_content: postSnippet,
      content: contentSnippet,
      is_read: 0,
      created_at: now,
    });

    // 🔔 バックグラウンド Web Push 通知の配信
    try {
      let pushTitle = 'Spica';
      let pushBody = '';

      if (params.type === 'reply') {
        pushTitle = `返信: ${params.actorName || params.actorHandle}`;
        pushBody = contentSnippet || '新しい返信が届きました';
      } else if (params.type === 'follow') {
        pushTitle = '新しいフォロワー';
        pushBody = `${params.actorName || params.actorHandle} さんにフォローされました`;
      } else if (params.type === 'renote' || params.type === 'announce') {
        pushTitle = 'リノートされました';
        pushBody = `${params.actorName || params.actorHandle} さんがあなたのノートをリノートしました`;
      } else if (params.type === 'reaction') {
        pushTitle = `リアクション: ${contentSnippet || '❤️'}`;
        pushBody = `${params.actorName || params.actorHandle} さんがリアクションしました`;
      } else if (params.type === 'dm') {
        // 本文は通知に載せない（「○○さんからメッセージ」まで。本文はアプリを開いて読む）
        pushTitle = 'メッセージ';
        pushBody = `${params.actorName || params.actorHandle} さんからメッセージが届きました`;
      }

      import('./pushService.js')
        .then(({ sendPushToUser }) => {
          sendPushToUser(params.userId, {
            title: pushTitle,
            body: pushBody,
            icon: params.actorIcon || '/logo.jpg',
            url: params.postId ? `/?postId=${params.postId}` : '/?view=notifications',
            tag: `spica-${params.type}-${params.userId}`,
          }).catch(() => {});
        })
        .catch(() => {});
    } catch {}

    // ✉️ メール通知（SMTP 設定 + ユーザーがオプトインしている場合のみ）
    //    **DM はメールに載せない**（本文が外部のメール事業者を通らないようにする。docs/DM.md）
    if (params.type !== 'dm') {
      import('./emailNotifier.js')
        .then(({ queueNotificationEmail }) =>
          queueNotificationEmail({
            userId: params.userId,
            type: params.type,
            actorName: params.actorName,
            actorHandle: params.actorHandle,
            postId: params.postId || null,
            postContent: postSnippet,
            content: contentSnippet,
          }),
        )
        .catch(() => {});
    }

    return true;
  } catch (err) {
    console.error('[Notification Error] Failed to create notification:', err);
    return false;
  }
}

/**
 * サーバー設定のキャッシュ。
 *
 * 設定は読み取りが非常に多く（リクエストごとに何度も引く）、しかも同期の呼び出し元が残る
 * （例: 画像プロキシの URL 書き換えは res.json を同期で差し替える）。そこで起動時にメモリへ
 * 読み込み、読み取りは同期で済ませる。書き込みは DB とキャッシュの両方に反映する（write-through）。
 *
 * 別プロセスの CLI（npm run db:maintenance など）が設定を変えた場合、このプロセスのキャッシュは
 * 古いままなので `refreshServerSettings()` を定期的に呼んで追いつかせる。
 */
let settingsCache: Map<string, string> | null = null;

/** 設定をメモリに読み込む（起動時に 1 回。initDatabase から呼ばれる） */
export async function loadServerSettings(): Promise<void> {
  const rows = await db.prepare('SELECT key, value FROM server_settings').all() as { key: string; value: string }[];
  const next = new Map<string, string>();
  for (const row of rows) next.set(row.key, row.value);
  settingsCache = next;
}

/** 設定を読み直す（別プロセスの変更に追いつくため、定期的に呼ぶ） */
export async function refreshServerSettings(): Promise<void> {
  await loadServerSettings();
}

/**
 * サーバー設定の取得（メモリのキャッシュから同期で返す）
 *
 * キャッシュ未ロード（initDatabase 前）は既定値を返す。
 */
export function getServerSetting(key: string, defaultValue?: string): string | undefined {
  if (!settingsCache) return defaultValue;
  const value = settingsCache.get(key);
  return value === undefined ? defaultValue : value;
}

/**
 * サーバー設定の保存（DB へ書き、キャッシュにも反映する）
 */
export async function setServerSetting(key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO server_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now);
  // キャッシュ未ロードでも、この後の読み取りが同じプロセスで見えるようにする
  if (!settingsCache) settingsCache = new Map();
  settingsCache.set(key, value);

  // 他のプロセスにも「変わった」を知らせる（Redis 未設定なら何もしない）。
  // 受け取った側は loadServerSettings() でキャッシュを読み直す（index.ts が購読している）。
  void publishEvent('settings', { key });
}

/**
 * 全サーバー設定の取得（DB）
 */
export async function getAllServerSettings(): Promise<Record<string, string>> {
  try {
    const rows = await db.prepare('SELECT key, value FROM server_settings').all() as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const r of rows) {
      result[r.key] = r.value;
    }
    return result;
  } catch {
    return {};
  }
}

export type RegistrationMode = 'open' | 'invite' | 'closed';

export const DEFAULT_SERVER_RULES: string[] = [
  'お互いを尊重してください',
  '他鯖とのもめごとなどをおこさないでください',
  '個人情報(あなたの本名、住所、学校名、クラス、友達の本名など)を極力書かないこと',
  '利用規約をちゃんと守ること',
];

export interface InstanceInfo {
  name: string;
  description: string;
  icon_url: string;
  banner_url: string;
  registration_mode: RegistrationMode;
  tos_url: string;
  privacy_policy_url: string;
  contact_url: string;
  repository_url: string;
  operator_url: string;
  server_rules: string[];
  require_rules_agreement: boolean;
}

/**
 * サーバー基本設定の取得 (DB優先、フォールバックとしてconfig)
 */
export function getInstanceInfo(): InstanceInfo {
  let rules: string[] = DEFAULT_SERVER_RULES;
  const rawRules = getServerSetting('server_rules');
  if (rawRules) {
    try {
      const parsed = JSON.parse(rawRules);
      if (Array.isArray(parsed)) {
        rules = parsed.filter((r) => typeof r === 'string' && r.trim().length > 0);
      }
    } catch {
      rules = DEFAULT_SERVER_RULES;
    }
  }

  const rawAgreement = getServerSetting('require_rules_agreement');
  const requireRulesAgreement = rawAgreement !== undefined ? rawAgreement === 'true' : true;

  return {
    name: getServerSetting('instance_name', config.instanceName) || config.instanceName,
    description: getServerSetting('instance_description', config.instanceDescription) || config.instanceDescription,
    icon_url: getServerSetting('instance_icon', '/logo.jpg') || '/logo.jpg',
    banner_url: getServerSetting('instance_banner', '') || '',
    registration_mode: (getServerSetting('registration_mode', 'open') as RegistrationMode) || 'open',
    tos_url: getServerSetting('tos_url', '') || '',
    privacy_policy_url: getServerSetting('privacy_policy_url', '') || '',
    contact_url: getServerSetting('contact_url', '') || '',
    repository_url: getServerSetting('repository_url', 'https://github.com/Keychrom/Spica') || '',
    operator_url: getServerSetting('operator_url', '') || '',
    server_rules: rules,
    require_rules_agreement: requireRulesAgreement,
  };
}

/**
 * サーバー基本設定の保存 (DB)
 */
export async function saveInstanceInfo(info: Partial<InstanceInfo>): Promise<void> {
  if (info.name !== undefined) await setServerSetting('instance_name', info.name.trim());
  if (info.description !== undefined) await setServerSetting('instance_description', info.description.trim());
  if (info.icon_url !== undefined) await setServerSetting('instance_icon', info.icon_url.trim());
  if (info.banner_url !== undefined) await setServerSetting('instance_banner', info.banner_url.trim());
  if (info.registration_mode !== undefined) await setServerSetting('registration_mode', info.registration_mode);
  if (info.tos_url !== undefined) await setServerSetting('tos_url', info.tos_url.trim());
  if (info.privacy_policy_url !== undefined) await setServerSetting('privacy_policy_url', info.privacy_policy_url.trim());
  if (info.contact_url !== undefined) await setServerSetting('contact_url', info.contact_url.trim());
  if (info.repository_url !== undefined) await setServerSetting('repository_url', info.repository_url.trim());
  if (info.operator_url !== undefined) await setServerSetting('operator_url', info.operator_url.trim());
  if (info.server_rules !== undefined) {
    const cleanRules = Array.isArray(info.server_rules)
      ? info.server_rules.map((r) => r.trim()).filter((r) => r.length > 0)
      : [];
    await setServerSetting('server_rules', JSON.stringify(cleanRules));
  }
  if (info.require_rules_agreement !== undefined) {
    await setServerSetting('require_rules_agreement', info.require_rules_agreement ? 'true' : 'false');
  }
}
