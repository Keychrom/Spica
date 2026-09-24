/**
 * 非同期データベース層（案A の中核）
 *
 * 既存コードは `node:sqlite` の同期 API をそのまま使っている（`db.prepare(...).get()`）。
 * PostgreSQL のクライアントは非同期なので、移行は「データ層を await 化する」ことで進める。
 * このファイルはその受け皿で、SQLite と PostgreSQL の**同じ形の非同期インターフェース**を提供する。
 *
 * - SQLite: 既存の同期接続をそのまま包む（別接続を開かない）。実体は同期なので即座に解決する。
 * - PostgreSQL: `pg` のクライアント 1 本に直列化して投げる。順序が保たれるので
 *   BEGIN / COMMIT がそのまま効き、`withTransaction` の間は他のクエリが割り込まない。
 *
 * 移行中は同期版（server/src/db/driver.ts の同期ファサード）と同居する。
 * **1 つのトランザクションを同期版と非同期版にまたがらせないこと**（接続が違うため、
 * 書き込み前のデータが非同期側から見えない）。トランザクションのある範囲はまとめて変換する。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Pool, type PoolClient, types } from 'pg';
import {
  PRAGMA_NOOP_RE,
  PRAGMA_TABLE_INFO_RE,
  TABLE_INFO_SQL,
  SqliteDatabase,
  splitExecStatements,
  insertOrReplaceTarget,
  translateSqlForPostgres,
  type SpicaRunResult,
} from './driver.js';

// BIGINT(int8) / NUMERIC は既定で文字列で返る。Spica の値は 2^53 に収まるので数値に寄せる
export function configurePgTypes(): void {
  types.setTypeParser(20, (value: string | null) => (value === null ? null : Number(value)));
  types.setTypeParser(1700, (value: string | null) => (value === null ? null : Number(value)));
}
configurePgTypes();

export interface AsyncSpicaStatement {
  get(...params: unknown[]): Promise<any>;
  all(...params: unknown[]): Promise<any[]>;
  run(...params: unknown[]): Promise<SpicaRunResult>;
}

export interface AsyncSpicaDatabase {
  /** 実装の種類（'sqlite' | 'postgres'）。分岐が必要な箇所だけが使う */
  readonly kind: 'sqlite' | 'postgres';
  prepare(sql: string): AsyncSpicaStatement;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  /** 終了前の後始末（SQLite は WAL チェックポイント、PostgreSQL は何もしない） */
  checkpoint(): Promise<void>;
  /** 接続できることを確認する（起動時に 1 回呼ぶ） */
  ready(): Promise<void>;
  /**
   * 同じ接続（セッション）を使って `fn` を実行する。
   *
   * PostgreSQL はプールから 1 本を借りて固定するので、**セッションに紐づく状態**
   * （一時テーブル・SET・トランザクション）が `fn` の中で一貫する。
   * SQLite は元から 1 接続なので、そのまま実行する。
   */
  withSession<T>(fn: () => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * 同期接続を非同期インターフェースで包む。
 * 実体が同期なので待ちは発生しないが、呼び出し側は SQLite / PostgreSQL を区別せずに書ける。
 */
class AsyncSqliteDatabase implements AsyncSpicaDatabase {
  readonly kind = 'sqlite' as const;

  constructor(private readonly inner: DatabaseSync) {}

  prepare(sql: string): AsyncSpicaStatement {
    const statement = this.inner.prepare(sql) as unknown as {
      get(...params: unknown[]): any;
      all(...params: unknown[]): any[];
      run(...params: unknown[]): SpicaRunResult;
    };
    return {
      get: (...params: unknown[]) => Promise.resolve(statement.get(...params)),
      all: (...params: unknown[]) => Promise.resolve(statement.all(...params)),
      run: (...params: unknown[]) => Promise.resolve(statement.run(...params)),
    };
  }

  exec(sql: string): Promise<void> {
    this.inner.exec(sql);
    return Promise.resolve();
  }

  close(): Promise<void> {
    try {
      this.inner.close();
    } catch {
      // 同期版が先に閉じている場合がある（同じ接続を共有しているため）
    }
    return Promise.resolve();
  }

  /** SQLite は元から 1 接続なので、固定するものは何もない */
  withSession<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  /** WAL をチェックポイントする（終了時にファイルを綺麗に畳む） */
  checkpoint(): Promise<void> {
    try {
      this.inner.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (err: any) {
      console.warn('[DB] チェックポイントに失敗:', err?.message || err);
    }
    return Promise.resolve();
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

interface PgQueryResult {
  rows: any[];
  rowCount: number | null;
}

class AsyncPostgresDatabase implements AsyncSpicaDatabase {
  readonly kind = 'postgres' as const;

  /**
   * 接続プール。1 本の接続に直列化していたのをやめ、**独立したクエリは並行に走らせる**
   * （SQLite は元から 1 接続だが、PostgreSQL はここが同時実行数の上限になる）。
   * 接続は最初のクエリまで開かない（import しただけで接続を張らない）。
   */
  private readonly pool: Pool;
  /**
   * セッション（接続）を固定している間のクライアント。
   * 一時テーブル・SET・トランザクションのように**接続に紐づく状態**を使う処理は、
   * `withSession()` でこのコンテキストに入れてから実行する。
   */
  private readonly pinned = new AsyncLocalStorage<{ client: PoolClient; release: (err?: Error) => void }>();
  /** テーブルごとの主キー列（INSERT OR REPLACE の ON CONFLICT に使う） */
  private readonly primaryKeys = new Map<string, string[]>();
  private primaryKeysLoaded = false;
  private closed = false;
  /** 接続が切れた回数（ログと異常時の切り分け用） */
  private disconnects = 0;

  constructor(
    private readonly connectionString: string,
    /** 1 クエリの上限（ミリ秒。0 で無効） */
    private readonly statementTimeoutMs = 0,
    /** アイドル状態のトランザクションを切るまでの時間（ミリ秒。0 で無効） */
    private readonly idleInTransactionTimeoutMs = 0,
    /** 同時に張る接続の上限（既定 5） */
    poolMax = 5,
  ) {
    // タイムアウトは接続時のパラメータ（options）で入れる。
    // 接続後に SET すると、借りた直後の 1 文が設定前になる余地があるため
    const startupOptions = [
      this.statementTimeoutMs > 0 ? `-c statement_timeout=${Math.floor(this.statementTimeoutMs)}` : '',
      this.idleInTransactionTimeoutMs > 0
        ? `-c idle_in_transaction_session_timeout=${Math.floor(this.idleInTransactionTimeoutMs)}`
        : '',
    ]
      .filter(Boolean)
      .join(' ');

    this.pool = new Pool({
      connectionString,
      // pg_stat_activity でどのプロセスか分かるようにしておく
      application_name: 'spica',
      max: Math.max(1, Math.floor(poolMax)),
      ...(startupOptions ? { options: startupOptions } : {}),
    });

    // アイドル中の接続が切れたとき（PostgreSQL の再起動・ネットワーク瞬断など）。
    // 受け手がいないと Node は未処理のエラーとしてプロセスごと落とす
    this.pool.on('error', (err) => {
      this.disconnects++;
      console.error(
        `[DB] PostgreSQL の接続が切れました（${this.disconnects} 回目）。プールが張り直します: ${err?.message || err}`,
      );
    });
  }

  /** 接続側の問題で失敗したか（壊れた接続を捨てる対象） */
  private static isConnectionError(err: any): boolean {
    const code = String(err?.code || '');
    // 08xxx: 接続の異常 / 57Pxx: サーバーの停止・再起動
    if (/^08[0-9A-Z]{3}$/.test(code) || /^57P0[123]$/.test(code)) return true;
    if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND'].includes(code)) return true;
    return /Connection terminated|Connection closed|not queryable|Client has already been connected/i.test(
      String(err?.message || ''),
    );
  }

  async ready(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  /**
   * プールから 1 本借りて固定する。`fn` の中のクエリはすべて同じ接続で実行される。
   * 入れ子で呼ばれた場合は、外側の固定をそのまま使う。
   */
  async withSession<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.pinned.getStore();
    if (current) return fn();
    if (this.closed) throw new Error('データベースは閉じられています');

    const client = await this.pool.connect();
    let released = false;
    const release = (err?: Error): void => {
      if (released) return;
      released = true;
      client.release(err);
    };
    try {
      return await this.pinned.run({ client, release }, fn);
    } finally {
      release();
    }
  }

  /** 接続に紐づく状態を使わない 1 文は、プールに任せて並行に流す */
  private async run(sql: string, params: unknown[]): Promise<PgQueryResult> {
    if (this.closed) throw new Error('データベースは閉じられています');
    const session = this.pinned.getStore();
    try {
      const result = session
        ? await session.client.query(sql, params as any[])
        : await this.pool.query(sql, params as any[]);
      return { rows: result.rows, rowCount: result.rowCount };
    } catch (err: any) {
      // 接続側の失敗はここで捨てる。固定している接続を使い回すと、次のクエリも同じ失敗を繰り返す
      // （クエリ自体は再実行しない。書き込みが二重になる可能性があるため）
      if (AsyncPostgresDatabase.isConnectionError(err)) {
        this.disconnects++;
        console.error(
          `[DB] PostgreSQL との接続が切れました（${this.disconnects} 回目）: ${String(err?.message || err).split('\n')[0]}`,
        );
        if (session) session.release(err);
      }
      // 方言の取りこぼしを追いやすいように、失敗した SQL を付けて投げ直す
      const oneLine = sql.replace(/\s+/g, ' ').trim();
      const shown = oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
      err.message = `${err.message}\n  SQL: ${shown}`;
      throw err;
    }
  }

  /**
   * INSERT OR REPLACE の ON CONFLICT を組み立てるには主キーが要る。
   * スキーマは起動後に作られることもあるので、キャッシュに無ければ読み直す。
   */
  private async ensurePrimaryKeys(table: string | null): Promise<void> {
    if (!this.primaryKeysLoaded) {
      await this.loadPrimaryKeys();
      this.primaryKeysLoaded = true;
      return;
    }
    if (table && !this.primaryKeys.has(table)) {
      const before = this.primaryKeys.size;
      await this.loadPrimaryKeys();
      // テーブルが増えていなければ読み直しは 1 回で十分
      if (this.primaryKeys.size === before && !this.primaryKeys.has(table)) this.primaryKeys.set(table, []);
    }
  }

  private async loadPrimaryKeys(): Promise<void> {
    const result = await this.run(
      `SELECT c.relname AS table_name, a.attname AS column_name
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indisprimary AND c.relnamespace = 'public'::regnamespace
        ORDER BY c.relname, array_position(i.indkey, a.attnum)`,
      [],
    );
    this.primaryKeys.clear();
    for (const row of result.rows as { table_name: string; column_name: string }[]) {
      const keys = this.primaryKeys.get(row.table_name);
      if (keys) keys.push(row.column_name);
      else this.primaryKeys.set(row.table_name, [row.column_name]);
    }
  }

  /** SQLite 方言を PostgreSQL に翻訳する（主キーは先に解決しておく） */
  private async translate(sql: string, params: unknown[]): Promise<{ sql: string; params: unknown[] }> {
    await this.ensurePrimaryKeys(insertOrReplaceTarget(sql));
    return translateSqlForPostgres(sql, params, (table) => this.primaryKeys.get(table) ?? []);
  }

  prepare(sql: string): AsyncSpicaStatement {
    return {
      get: (...params: unknown[]) => this.query(sql, params, 'get'),
      all: (...params: unknown[]) => this.query(sql, params, 'all'),
      run: async (...params: unknown[]) => {
        const result = await this.queryResult(sql, params);
        return { changes: Number(result.rowCount ?? 0), lastInsertRowid: 0 };
      },
    };
  }

  private async queryResult(sql: string, params: unknown[]): Promise<PgQueryResult> {
    const trimmed = sql.trim();

    // PRAGMA table_info(x) は information_schema で代替する
    const tableInfo = PRAGMA_TABLE_INFO_RE.exec(trimmed);
    if (tableInfo) {
      return this.run(TABLE_INFO_SQL, [tableInfo[1]]);
    }
    if (PRAGMA_NOOP_RE.test(trimmed)) {
      return { rows: [], rowCount: 0 };
    }

    const translated = await this.translate(trimmed, params);
    return this.run(translated.sql, translated.params);
  }

  private async query(sql: string, params: unknown[], mode: 'get' | 'all'): Promise<any> {
    const result = await this.queryResult(sql, params);
    if (mode === 'all') return result.rows;
    return result.rows.length > 0 ? result.rows[0] : undefined;
  }

  async exec(sql: string): Promise<void> {
    // exec も翻訳する（BEGIN IMMEDIATE や temp. は PostgreSQL では通らない）
    const statements = splitExecStatements(sql);
    if (statements.length === 0) return;
    const translated = statements.map((statement) => translateSqlForPostgres(statement, []).sql);
    await this.run(translated.map((statement) => `${statement};`).join('\n'), []);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // 借りている接続が返るのを待ってから閉じる（プールが面倒を見る）
    try {
      await this.pool.end();
    } catch {
      // 終了時は握る
    }
  }

  /** PostgreSQL には WAL が無いので何もしない（接続は close が閉じる） */
  async checkpoint(): Promise<void> {}

  /**
   * トランザクション。`fn` の中のクエリは 1 本の接続に固定され、
   * 他のリクエストのクエリが混ざらない。
   * 入れ子には対応しない（SQLite / PostgreSQL どちらも暗黙の入れ子は危険なため）。
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pinned.getStore()) throw new Error('トランザクションは入れ子にできません');
    return this.withSession(async () => {
      await this.exec('BEGIN');
      try {
        const result = await fn();
        await this.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          await this.exec('ROLLBACK');
        } catch {
          // ロールバックに失敗しても元のエラーを優先する
        }
        throw err;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

export interface CreateAsyncDatabaseOptions {
  /** 'sqlite'（既定）または 'postgres' */
  driver?: string;
  /**
   * SQLite のとき: 既存の同期接続を渡す。
   * 同期版と非同期版で同じ接続を共有する（ファイルに 2 本繋がない）。
   */
  sqlite?: DatabaseSync | SqliteDatabase;
  /** SQLite のファイルパス（sqlite を渡さない場合に開く） */
  dbPath?: string;
  /** PostgreSQL の接続文字列 */
  connectionString?: string;
  /**
   * PostgreSQL の 1 クエリの上限（ミリ秒。0 で無効）。
   * 直列化した 1 接続なので、重いクエリやロック待ちが全体を止めないための保険。
   */
  statementTimeoutMs?: number;
  /** アイドル状態のトランザクションを切るまでの時間（ミリ秒。0 で無効） */
  idleInTransactionTimeoutMs?: number;
  /** 同時に張る接続の上限（PostgreSQL のみ。既定 5） */
  poolMax?: number;
}

export function createAsyncDatabase(options: CreateAsyncDatabaseOptions = {}): AsyncSpicaDatabase {
  const driver = String(options.driver ?? process.env.DB_DRIVER ?? 'sqlite').toLowerCase();

  if (driver === 'postgres' || driver === 'postgresql' || driver === 'pg') {
    const connectionString = options.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DB_DRIVER=postgres には DATABASE_URL が必要です（例: postgres://spica:pass@127.0.0.1:5432/spica）');
    }
    return new AsyncPostgresDatabase(
      connectionString,
      options.statementTimeoutMs ?? Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? 0),
      options.idleInTransactionTimeoutMs ?? Number(process.env.DATABASE_IDLE_TIMEOUT_MS ?? 0),
      options.poolMax ?? Number(process.env.DATABASE_POOL_MAX ?? 5),
    );
  }

  const provided = options.sqlite;
  if (provided) {
    return new AsyncSqliteDatabase(provided instanceof SqliteDatabase ? provided.inner : provided);
  }

  // 同期版を経由せずに単体で使う場合（CLI・テストなど）
  const dbPath = options.dbPath ?? process.env.DB_PATH ?? 'data_astrabit.sqlite';
  return new AsyncSqliteDatabase(new DatabaseSync(dbPath));
}

/**
 * トランザクション付きで実行する。
 *
 * PostgreSQL では 1 接続に直列化しているので、`fn` の実行中は他のクエリが割り込まない。
 * SQLite も同じ接続を共有しているので、`fn` の中の await の間に他のクエリが割り込む余地は無い
 * （`node:sqlite` は同期 API なので、そもそも実行中に他の処理が走らない）。
 */
export function withTransaction<T>(database: AsyncSpicaDatabase, fn: () => Promise<T>): Promise<T> {
  if (database instanceof AsyncPostgresDatabase) return database.transaction(fn);
  return (async () => {
    await database.exec('BEGIN');
    try {
      const result = await fn();
      await database.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        await database.exec('ROLLBACK');
      } catch {
        // ロールバックに失敗しても元のエラーを優先する
      }
      throw err;
    }
  })();
}
