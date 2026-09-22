import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/**
 * データベースの driver 層。
 *
 * 既定は SQLite（node:sqlite の同期 API をそのまま使う）。
 * `DB_DRIVER=postgres` のときは、PostgreSQL を**同期 API のまま**使えるようにする
 * ファサード（worker thread + SharedArrayBuffer + Atomics.wait）に差し替える。
 *
 * なぜ同期のままか:
 *   Spica は同期 API を 573 箇所で使っている。非同期化は数週間規模のリファクタになるため、
 *   まず「PostgreSQL でも動く」状態を作ることを優先し、既存コードには触らない。
 *   `Atomics.wait` でメインスレッドが待つのは、いまの SQLite と同じ性質（1 クエリごとに
 *   ブロックする）で、構造的な劣化ではない。恒久的には非同期化（docs/POSTGRESQL.md の案A）へ
 *   移す前提の足場という位置づけ。
 *
 * SQL の方言差はここで吸収する（プレースホルダ・FTS・INSERT OR 系・datetime()・PRAGMA）。
 */

export interface SpicaRunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface SpicaStatement {
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
  run(...params: unknown[]): SpicaRunResult;
}

export interface SpicaDatabase {
  /** 実装の種類（'sqlite' | 'postgres'）。分岐が必要な箇所だけが使う */
  readonly kind: 'sqlite' | 'postgres';
  prepare(sql: string): SpicaStatement;
  exec(sql: string): void;
  close(): void;
}

/** 1 クエリの結果を受け取るバッファの初期サイズ */
const INITIAL_RESULT_BYTES = 16 * 1024 * 1024;
/** 結果が大きすぎたときに再試行する上限 */
const MAX_RESULT_BYTES = 256 * 1024 * 1024;
/** 1 クエリの待ち時間（ミリ秒）。0 で無制限 */
const DEFAULT_QUERY_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// SQLite（既定）
// ---------------------------------------------------------------------------

export class SqliteDatabase implements SpicaDatabase {
  readonly kind = 'sqlite' as const;

  /**
   * 生の SQLite 接続。非同期層（server/src/db/asyncDriver.ts）が同じ接続を共有するために公開している。
   * 同じファイルに 2 本繋ぐと WAL でも書き込みが競合するので、接続は 1 本に保つ。
   */
  constructor(readonly inner: DatabaseSync) {}

  prepare(sql: string): SpicaStatement {
    return this.inner.prepare(sql) as unknown as SpicaStatement;
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  close(): void {
    this.inner.close();
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL（同期ファサード）
// ---------------------------------------------------------------------------

interface WorkerResponse {
  /** 0 = 未完了 / 1 = 成功 / 2 = エラー */
  state: number;
  length: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class PostgresStatement implements SpicaStatement {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly sql: string,
  ) {}

  get(...params: unknown[]): any {
    const rows = this.database.query(this.sql, params, 'all');
    return rows.length > 0 ? rows[0] : undefined;
  }

  all(...params: unknown[]): any[] {
    return this.database.query(this.sql, params, 'all');
  }

  run(...params: unknown[]): SpicaRunResult {
    return this.database.query(this.sql, params, 'run') as SpicaRunResult;
  }
}

/** worker に渡してよい node オプションだけを抜き出す（ローダー指定のみ） */
function workerExecArgv(): string[] {
  const out: string[] = [];
  const argv = process.execArgv;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--import' || arg === '--loader' || arg === '--require') {
      out.push(arg, argv[i + 1]);
      i++;
      continue;
    }
    if (arg.startsWith('--import=') || arg.startsWith('--loader=') || arg.startsWith('--require=')) {
      out.push(arg);
    }
  }
  return out;
}

/** `PRAGMA <設定>` は PostgreSQL では何もしない（呼び出し側で無視してよい） */
export const PRAGMA_NOOP_RE = /^\s*PRAGMA\s+(?:journal_mode|foreign_keys|busy_timeout|synchronous|wal_checkpoint|optimize|page_size|page_count|freelist_count|temp_store|mmap_size|cache_size)\b/i;
/** `PRAGMA table_info(x)` は information_schema で代替する */
export const PRAGMA_TABLE_INFO_RE = /^\s*PRAGMA\s+table_info\(\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\)/i;
/** `PRAGMA table_info(x)` の代わりに流すクエリ（$1 にテーブル名） */
export const TABLE_INFO_SQL = `SELECT column_name AS name, data_type AS type, is_nullable AS notnull, column_default AS dflt_value
                FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = $1
               ORDER BY ordinal_position`;

/**
 * `exec()` 用: 複文を 1 文ずつに分けて翻訳する（パラメータは無い前提）。
 * exec は DDL や BEGIN / COMMIT を流すため、prepare と違って 1 文ずつ翻訳する必要がある。
 */
export function splitExecStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .filter((statement) => !/^PRAGMA\b/i.test(statement));
}

/** `INSERT OR REPLACE INTO t (...) ...` を分解する（1=テーブル名 / 2=列リスト）。g フラグ無しなので exec は状態を持たない */
export const INSERT_OR_REPLACE_RE = /^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(([^)]*)\)/i;

/**
 * `INSERT OR REPLACE INTO t (...)` の対象テーブル名を返す（該当しなければ null）。
 * ON CONFLICT を組み立てるには主キーが要るので、先にテーブル名だけ取り出す。
 */
export function insertOrReplaceTarget(sql: string): string | null {
  const match = INSERT_OR_REPLACE_RE.exec(sql);
  return match ? match[1] : null;
}

class PostgresDatabase implements SpicaDatabase {
  readonly kind = 'postgres' as const;

  private worker: Worker | null = null;
  private workerFailures = 0;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  /** テーブルごとの主キー列（INSERT OR REPLACE の ON CONFLICT に使う） */
  private readonly primaryKeys = new Map<string, string[]>();
  private closed = false;

  constructor(private readonly connectionString: string) {
    this.ensureWorker();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (this.workerFailures >= 3) {
      throw new Error(
        `PostgreSQL ワーカーを起動できません（${this.workerFailures} 回失敗）。DATABASE_URL とネットワークを確認してください。`,
      );
    }

    // 開発時（tsx で .ts を実行）は pgWorker.ts、ビルド後（dist）は pgWorker.js を読む
    const selfPath = fileURLToPath(import.meta.url);
    const extension = selfPath.endsWith('.ts') ? '.ts' : '.js';
    const workerPath = fileURLToPath(new URL(`./pgWorker${extension}`, import.meta.url));

    const worker = new Worker(workerPath, {
      workerData: { connectionString: this.connectionString },
      // tsx などの読み込みオプションだけを引き継ぐ。
      // --max-old-space-size や --inspect は worker では無効で、渡すと起動に失敗する。
      execArgv: workerExecArgv(),
    });
    worker.on('message', (message: { id: number } & WorkerResponse & { payload: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.state === 1) {
        try {
          pending.resolve(message.payload ? JSON.parse(message.payload) : null);
        } catch (err) {
          pending.reject(err as Error);
        }
      } else {
        pending.reject(new Error(message.payload || 'PostgreSQL クエリに失敗しました'));
      }
    });
    worker.on('error', (err) => {
      this.workerFailures++;
      console.error(`[DB] PostgreSQL ワーカーのエラー（${this.workerFailures} 回目）:`, err?.message || err);
      for (const [, pending] of this.pending) pending.reject(err instanceof Error ? err : new Error(String(err)));
      this.pending.clear();
      this.worker = null;
    });
    worker.on('exit', (code) => {
      this.worker = null;
      if (!this.closed && code !== 0) {
        const error = new Error(`PostgreSQL ワーカーが終了しました (code=${code})`);
        for (const [, pending] of this.pending) pending.reject(error);
        this.pending.clear();
      }
    });
    this.worker = worker;
    return worker;
  }

  /**
   * 1 クエリを同期的に実行する。
   * worker に投げて SharedArrayBuffer 経由で結果を受け取り、`Atomics.wait` で待つ。
   */
  private call(payload: Record<string, unknown>, capacity = INITIAL_RESULT_BYTES): unknown {
    if (this.closed) throw new Error('データベースは閉じられています');
    const worker = this.ensureWorker();
    const id = this.nextId++;

    // 共有バッファ: [state, length] + データ本体
    const buffer = new SharedArrayBuffer(8 + capacity);
    const header = new Int32Array(buffer, 0, 2);

    if (process.env.PG_DEBUG) {
      console.error(`[PG→] ${String(payload.kind)} ${String(payload.sql ?? '').replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    worker.postMessage({ ...payload, id, buffer });

    const timeout = Number(process.env.PG_QUERY_TIMEOUT_MS ?? DEFAULT_QUERY_TIMEOUT_MS);
    const waited = Atomics.wait(header, 0, 0, timeout > 0 ? timeout : undefined);
    if (waited === 'timed-out') {
      // 待ち続けても結果は来ない。ワーカーごと捨てて作り直す（接続状態が不明になるため）
      try { worker.terminate(); } catch {}
      this.worker = null;
      throw new Error(`PostgreSQL クエリがタイムアウトしました (${timeout}ms): ${String(payload.sql ?? '').slice(0, 120)}`);
    }

    const state = Atomics.load(header, 0);
    const length = Atomics.load(header, 1);
    if (process.env.PG_DEBUG) {
      console.error(`[PG] ${String(payload.kind)} ${String(payload.sql ?? '').replace(/\s+/g, ' ').slice(0, 90)} → ${length}B`);
    }
    const bytes = Buffer.from(new Uint8Array(buffer, 8, length));
    const text = bytes.toString('utf8');

    if (state === 2) {
      // 結果が大きすぎた場合は、必要なサイズで再試行する
      const tooLarge = /^RESULT_TOO_LARGE:(\d+)$/.exec(text);
      if (tooLarge) {
        const needed = Number(tooLarge[1]);
        if (needed <= MAX_RESULT_BYTES) return this.call(payload, needed + 4096);
        throw new Error(`クエリ結果が大きすぎます（${(needed / 1024 / 1024).toFixed(1)}MB）`);
      }
      throw new Error(text);
    }
    return text ? JSON.parse(text) : null;
  }

  /** テーブルの主キー列を調べる（結果はキャッシュ） */
  private primaryKeyOf(table: string): string[] {
    const cached = this.primaryKeys.get(table);
    if (cached) return cached;
    const rows = this.call({
      kind: 'query',
      sql: `SELECT a.attname AS name FROM pg_index i
              JOIN pg_class c ON c.oid = i.indrelid
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
             WHERE c.relname = $1 AND i.indisprimary
             ORDER BY array_position(i.indkey, a.attnum)`,
      params: [table],
    }) as { name: string }[];
    const keys = rows.map((row) => row.name);
    this.primaryKeys.set(table, keys);
    return keys;
  }

  /** INSERT OR REPLACE を ON CONFLICT ... DO UPDATE に変換する */
  private translateInsertOrReplace(sql: string): string {
    const match = INSERT_OR_REPLACE_RE.exec(sql);
    if (!match) return sql.replace(/INSERT\s+OR\s+REPLACE/i, 'INSERT');
    const table = match[1];
    const columnsRaw = match[2];
    const columns = columnsRaw.split(',').map((c) => c.trim().replace(/"/g, '')).filter(Boolean);
    const keys = this.primaryKeyOf(table);
    if (keys.length === 0) {
      // 主キーが分からない場合は何もしない（重複時はエラーになる）
      return sql.replace(/INSERT\s+OR\s+REPLACE/i, 'INSERT') + ' ON CONFLICT DO NOTHING';
    }
    const updates = columns
      .filter((column) => !keys.includes(column))
      .map((column) => `"${column}" = EXCLUDED."${column}"`)
      .join(', ');
    const conflict = `ON CONFLICT (${keys.map((k) => `"${k}"`).join(', ')}) DO ${updates ? `UPDATE SET ${updates}` : 'NOTHING'}`;
    return sql.replace(/INSERT\s+OR\s+REPLACE/i, 'INSERT').replace(/\s*$/, '') + ' ' + conflict;
  }

  /**
   * SQLite 方言を PostgreSQL に翻訳しつつ、パラメータを組み直す。
   * 実体は純関数 translateSqlForPostgres（テストできるように分離してある）。
   */
  private translate(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
    return translateSqlForPostgres(sql, params, (table) => this.primaryKeyOf(table));
  }


  query(sql: string, params: unknown[], mode: 'all' | 'run'): any {
    const trimmed = sql.trim();

    // PRAGMA table_info(x) は information_schema で代替する
    const tableInfo = PRAGMA_TABLE_INFO_RE.exec(trimmed);
    if (tableInfo) {
      return this.call({ kind: 'query', sql: TABLE_INFO_SQL, params: [tableInfo[1]] });
    }
    if (PRAGMA_NOOP_RE.test(trimmed)) {
      return mode === 'run' ? { changes: 0, lastInsertRowid: 0 } : [];
    }

    const translated = this.translate(sql, params);
    if (mode === 'run') {
      const result = this.call({ kind: 'run', sql: translated.sql, params: translated.params }) as { changes: number };
      return { changes: Number(result?.changes ?? 0), lastInsertRowid: 0 };
    }
    return this.call({ kind: 'query', sql: translated.sql, params: translated.params });
  }

  prepare(sql: string): SpicaStatement {
    return new PostgresStatement(this, sql);
  }

  exec(sql: string): void {
    // exec も翻訳する（BEGIN IMMEDIATE や temp. は PostgreSQL では通らない）
    const statements = splitExecStatements(sql);
    if (statements.length === 0) return;
    const translated = statements.map((statement) => translateSqlForPostgres(statement, []).sql);
    this.call({ kind: 'exec', sql: translated.map((statement) => `${statement};`).join('\n'), params: [] });
  }

  close(): void {
    this.closed = true;
    try {
      this.call({ kind: 'close', sql: '', params: [] });
    } catch {
      // 終了時は握る
    }
    try { this.worker?.terminate(); } catch {}
    this.worker = null;
  }
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

/** 生の SQLite 接続を共通インターフェースで包む（CLI などが使う） */
export function wrapSqliteDatabase(inner: DatabaseSync): SpicaDatabase {
  return new SqliteDatabase(inner);
}

export interface CreateDatabaseOptions {
  /** 'sqlite'（既定）または 'postgres' */
  driver?: string;
  /** SQLite のファイルパス */
  dbPath?: string;
  /** PostgreSQL の接続文字列 */
  connectionString?: string;
}

/**
 * 設定に応じたデータベースを返す。
 * `DB_DRIVER=postgres` のときは DATABASE_URL が必須。
 */
export function createDatabase(options: CreateDatabaseOptions = {}): SpicaDatabase {
  const driver = String(options.driver ?? process.env.DB_DRIVER ?? 'sqlite').toLowerCase();

  if (driver === 'postgres' || driver === 'postgresql' || driver === 'pg') {
    const connectionString = options.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DB_DRIVER=postgres には DATABASE_URL が必要です（例: postgres://spica:pass@127.0.0.1:5432/spica）');
    }
    return new PostgresDatabase(connectionString);
  }

  const dbPath = options.dbPath ?? process.env.DB_PATH ?? path.resolve(process.cwd(), 'data_astrabit.sqlite');
  const inner = new DatabaseSync(dbPath);
  return new SqliteDatabase(inner);
}

// ---------------------------------------------------------------------------
// SQL 翻訳（SQLite → PostgreSQL）
// ---------------------------------------------------------------------------

/**
 * SQLite 方言の SQL を PostgreSQL に翻訳し、パラメータを組み直す。
 *
 * - プレースホルダ `?` を左から `$1, $2, ...` に置き換える
 *   （文字列リテラルと `--` コメントの中は触らない）
 * - `temp.x` → `pg_temp.x`
 * - `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`
 * - `INSERT OR REPLACE` → `ON CONFLICT (主キー) DO UPDATE SET ...`
 * - `datetime(x)` → `x`（ISO 8601 の TEXT 比較で等価）
 * - `posts_fts MATCH ?` → `f.content ILIKE $n`（語ごとの AND。FTS5 の trigram 相当）
 * - `bm25(posts_fts)` → `p.published_at`（順位は公開時刻で代替）
 *
 * 純関数にしてあるので、PostgreSQL が無くてもテストできる。
 */
/** 改行文字（エスケープを避けて定数にする） */
const NEWLINE = String.fromCharCode(10);

export function translateSqlForPostgres(
  sql: string,
  params: unknown[],
  primaryKeyOf: (table: string) => string[] = () => [],
): { sql: string; params: unknown[] } {
  let text = sql;
  // PRAGMA は呼び出し側で処理されるため、ここに来たら無効化する
  if (/^\s*PRAGMA/i.test(text)) {
    return { sql: 'SELECT 1 AS noop', params: [] };
  }

  // SQLite の temp.<table> は PostgreSQL では pg_temp.<table>
  text = text.replace(/\btemp\./gi, 'pg_temp.');

  // SQLite の BEGIN IMMEDIATE / EXCLUSIVE / DEFERRED は PostgreSQL に無い（ロックは必要時に取る）
  text = text.replace(/\bBEGIN\s+(?:IMMEDIATE|EXCLUSIVE|DEFERRED)\b/gi, 'BEGIN');

  // INSERT OR IGNORE / REPLACE
  if (/INSERT\s+OR\s+REPLACE/i.test(text)) {
    const match = /^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(([^)]*)\)/i.exec(text);
    if (match) {
      const [, table, columnsRaw] = match;
      const columns = columnsRaw.split(',').map((column) => column.trim().replace(/"/g, '')).filter(Boolean);
      const keys = primaryKeyOf(table);
      const updates = columns
        .filter((column) => !keys.includes(column))
        .map((column) => `"${column}" = EXCLUDED."${column}"`)
        .join(', ');
      const conflict = keys.length === 0
        ? 'ON CONFLICT DO NOTHING'
        : `ON CONFLICT (${keys.map((key) => `"${key}"`).join(', ')}) DO ${updates ? `UPDATE SET ${updates}` : 'NOTHING'}`;
      text = text.replace(/INSERT\s+OR\s+REPLACE/i, 'INSERT').replace(/;?\s*$/, '') + ' ' + conflict;
    } else {
      text = text.replace(/INSERT\s+OR\s+REPLACE/i, 'INSERT');
    }
  } else if (/INSERT\s+OR\s+IGNORE/i.test(text)) {
    text = text.replace(/INSERT\s+OR\s+IGNORE/i, 'INSERT').replace(/;?\s*$/, '') + ' ON CONFLICT DO NOTHING';
  } else if (/^\s*INSERT\s+INTO/i.test(text) && !/ON\s+CONFLICT/i.test(text)) {
    // 素の INSERT は重複でエラーになる。SQLite 側の想定（IGNORE 相当）に合わせて
    // 競合時は何もしないようにしておく（アプリは重複挿入を前提にしていない）
    text = text.replace(/;?\s*$/, '') + ' ON CONFLICT DO NOTHING';
  }

  // datetime(x) は不要（TEXT の ISO 8601 をそのまま比較できる）
  text = text.replace(/datetime\(\s*('(?:[^']|'')*')\s*\)/gi, '$1');
  text = text.replace(/datetime\(\s*([A-Za-z_"][A-Za-z0-9_."]*)\s*\)/gi, '$1');
  text = text.replace(/bm25\(\s*"?posts_fts"?\s*\)/gi, 'p.published_at');

  // IFNULL は PostgreSQL に無い（COALESCE が同じ）
  text = text.replace(/\bifnull\s*\(/gi, 'COALESCE(');

  // SQLite の LIKE は ASCII について大文字小文字を区別しない。
  // PostgreSQL の LIKE は区別するので、挙動を合わせて ILIKE にする
  // （既に ILIKE と書かれているものはそのまま）
  text = text.replace(/(?<![Ii])\bLIKE\b/gi, 'ILIKE');

  // FTS: `posts_fts MATCH ?` の「何番目のプレースホルダか」を先に数えてから、
  // MATCH というキーワードを消す（PostgreSQL に MATCH は無い）。
  // 消したあとは ordinal で判定するので、前方を見る必要はない。
  let ftsParamOrdinal = -1;
  const ftsMatch = /"?posts_fts"?\s+MATCH\s+(\?)/i.exec(text);
  if (ftsMatch && ftsMatch.index >= 0) {
    ftsParamOrdinal = (text.slice(0, ftsMatch.index).match(/\?/g) ?? []).length;
    // 「posts_fts MATCH 」を消して、プレースホルダだけを残す
    text = text.slice(0, ftsMatch.index) + '?' + text.slice(ftsMatch.index + ftsMatch[0].length);
  }

  const out: string[] = [];
  const finalParams: unknown[] = [];
  let paramIndex = 0;
  let i = 0;
  while (i < text.length) {
    const char = text[i];

    // 文字列リテラル（シングル/ダブルクォート）はまるごと写す
    if (char === "'" || char === '"') {
      const quote = char;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === quote) {
          if (text[j + 1] === quote) { j += 2; continue; }
          break;
        }
        j++;
      }
      out.push(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }

    // `--` コメントは行末まで
    if (char === '-' && text[i + 1] === '-') {
      const end = text.indexOf(NEWLINE, i);
      out.push(end >= 0 ? text.slice(i, end) : text.slice(i));
      i = end >= 0 ? end : text.length;
      continue;
    }

    // プレースホルダ
    if (char === '?') {
      const value = params[paramIndex];

      if (paramIndex === ftsParamOrdinal) {
        paramIndex++;
        const terms = splitFtsTerms(value);
        if (terms.length === 0) {
          out.push('TRUE');
          i++;
          continue;
        }
        const clauses: string[] = [];
        for (const term of terms) {
          finalParams.push(`%${term}%`);
          clauses.push(`f.content ILIKE $${finalParams.length}`);
        }
        out.push(clauses.join(' AND '));
        i++;
        continue;
      }

      paramIndex++;
      finalParams.push(value);
      out.push(`$${finalParams.length}`);
      i++; // ← ここを忘れると無限ループになる
      continue;
    }

    out.push(char);
    i++;
  }

  return { sql: out.join(''), params: finalParams };
}

/** FTS5 のクエリ文字列（`"a" "b"`）を部分一致の語に分解する */
export function splitFtsTerms(query: unknown): string[] {
  const raw = String(query ?? '');
  const terms: string[] = [];
  // 引用符で囲まれたフレーズを優先し、裸の語も拾う（FTS5 の `"a" "b"` 形式が基本）
  const pattern = /"((?:[^"]|"")*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const value = (match[1] ?? match[2] ?? '').replace(/""/g, '"').trim();
    if (value.length > 0) terms.push(value);
  }
  return terms;
}
