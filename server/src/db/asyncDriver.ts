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
import { Client, types } from 'pg';
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
   * 現在の接続。**切断されたら捨てて作り直す**（下の dropConnection を参照）。
   * pg の Client は接続が異常終了すると再利用できないため、差し替えられるようにしている。
   */
  private client: Client;
  /** 接続は最初のクエリまで遅らせる（import しただけで接続を開かないため） */
  private connecting: Promise<void> | null = null;
  /** 直前のクエリの完了を待たせて順序を守る（1 接続なので直列が前提） */
  private queue: Promise<unknown> = Promise.resolve();
  /** トランザクション中かどうか（中はキューを握っているので直接実行する） */
  private readonly inTransaction = new AsyncLocalStorage<true>();
  /** テーブルごとの主キー列（INSERT OR REPLACE の ON CONFLICT に使う） */
  private readonly primaryKeys = new Map<string, string[]>();
  private primaryKeysLoaded = false;
  private closed = false;
  /** 一度でも接続に成功したか（close でソケットを閉じるべきかの判断に使う） */
  private everConnected = false;
  /** 接続が切れた回数（ログと異常時の切り分け用） */
  private disconnects = 0;

  constructor(
    private readonly connectionString: string,
    /** 1 クエリの上限（ミリ秒。0 で無効）。PostgreSQL 側の statement_timeout に渡す */
    private readonly statementTimeoutMs = 0,
    /** アイドル状態のトランザクションを切るまでの時間（ミリ秒。0 で無効） */
    private readonly idleInTransactionTimeoutMs = 0,
  ) {
    this.client = this.createClient();
  }

  /**
   * 接続を作る。**error リスナーを必ず付ける**のがこの関数の役目:
   * pg は接続が異常終了すると `emit('error')` するが、受け手がいないと
   * Node は未処理のエラーとしてプロセスごと落とす（管理者が PG を再起動した、
   * ネットワークが瞬断した、といっただけで落ちないようにする）。
   */
  private createClient(): Client {
    const client = new Client({
      connectionString: this.connectionString,
      // pg_stat_activity でどのプロセスか分かるようにしておく
      application_name: 'spica',
    });
    client.on('error', (err) => {
      // 実行中のクエリは pg 側が reject する（呼び出し元はエラーを受け取る）。
      // ここでは「次に問い合わせが来たら張り直す」準備だけをする。
      this.dropConnection(client, err);
    });
    return client;
  }

  /**
   * 壊れた接続を捨てて、次のクエリで張り直せる状態にする。
   *
   * 「捨てる（新しい Client に差し替える）」のは、pg の Client が異常終了後に再利用できないため
   * （同じインスタンスで connect() すると "Client has already been connected" になる）。
   * **既に差し替え済みの古い接続からの通知は無視する**のが要点:
   * 切断時は「実行中クエリの失敗」と「ソケットの end による error」が別々に届くので、
   * 後から来た古い通知で新しい接続を捨ててしまうと、復帰した直後にまた切れてしまう。
   */
  private dropConnection(client: Client, reason?: unknown): void {
    if (this.closed || this.client !== client) return;
    this.disconnects++;
    const message = String((reason as any)?.message || reason || '');
    console.error(
      `[DB] PostgreSQL との接続が切れました（${this.disconnects} 回目）。次のクエリで再接続します:${message ? ` ${message.split('\n')[0]}` : ''}`,
    );
    this.client = this.createClient();
    this.connecting = null;
    this.primaryKeysLoaded = false;
  }

  /** 接続側の問題で失敗したか（接続を捨てて、次のクエリで復帰させる対象） */
  private static isConnectionError(err: any): boolean {
    const code = String(err?.code || '');
    // 08xxx: 接続の異常 / 57Pxx: サーバーの停止・再起動
    if (/^08[0-9A-Z]{3}$/.test(code) || /^57P0[123]$/.test(code)) return true;
    if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND'].includes(code)) return true;
    return /Connection terminated|Connection closed|not queryable|Client has already been connected/i.test(
      String(err?.message || ''),
    );
  }

  private ensureConnected(): Promise<void> {
    if (!this.connecting) {
      const client = this.client;
      this.connecting = client
        .connect()
        .then(() => this.applySessionSettings(client))
        .then(() => {
          this.everConnected = true;
        })
        .catch((err) => {
          // 失敗したら次回また試せるようにする（張りっぱなしにしない）。
          // 接続に失敗した Client も再利用できないので作り直す。
          this.connecting = null;
          if (!this.closed) {
            this.client = this.createClient();
            this.primaryKeysLoaded = false;
          }
          throw err;
        });
      // 失敗は呼び出し時に投げ直す（ここで unhandled rejection にしない）
      this.connecting.catch(() => {});
    }
    return this.connecting;
  }

  /**
   * セッション単位の設定。`SET` は接続ごとなので、張り直すたびに流す。
   * 直列化した 1 接続なので、1 本の重いクエリやロック待ちが全体を止めないよう上限を入れる。
   */
  private async applySessionSettings(client: Client): Promise<void> {
    try {
      if (this.statementTimeoutMs > 0) {
        await client.query(`SET statement_timeout = ${Math.floor(this.statementTimeoutMs)}`);
      }
      if (this.idleInTransactionTimeoutMs > 0) {
        await client.query(`SET idle_in_transaction_session_timeout = ${Math.floor(this.idleInTransactionTimeoutMs)}`);
      }
    } catch (err: any) {
      // 設定できなくても動作は続けられる（権限やサーバー設定で拒否されることがある）
      console.warn('[DB] セッション設定を適用できませんでした:', err?.message || err);
    }
  }

  async ready(): Promise<void> {
    await this.ensureConnected();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => task());
    // 失敗しても後続は流す（キュー自体は常に成功で閉じる）
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** トランザクション内は既にキューを握っているので、そのまま実行する（待つと固まる） */
  private execute<T>(task: () => Promise<T>): Promise<T> {
    if (this.inTransaction.getStore()) return task();
    return this.enqueue(task);
  }

  private async run(sql: string, params: unknown[]): Promise<PgQueryResult> {
    if (this.closed) throw new Error('データベースは閉じられています');
    await this.ensureConnected();
    // 接続が切れて張り直された直後でも、いま繋がっているクライアントを使う
    const client = this.client;
    try {
      const result = await client.query(sql, params as any[]);
      return { rows: result.rows, rowCount: result.rowCount };
    } catch (err: any) {
      // 接続側の失敗はここで捨てておく。こうしないと、ソケットの end が届く前に次のクエリが
      // 来たときに死んだ接続へ投げてしまい、復帰が 1 クエリ分遅れる。
      // （クエリ自体は再実行しない。書き込みが二重になる可能性があるため）
      if (AsyncPostgresDatabase.isConnectionError(err)) this.dropConnection(client);
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
    const result = await this.enqueue(() =>
      this.run(
        `SELECT c.relname AS table_name, a.attname AS column_name
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indrelid
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indisprimary AND c.relnamespace = 'public'::regnamespace
          ORDER BY c.relname, array_position(i.indkey, a.attnum)`,
        [],
      ),
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
      return this.execute(() => this.run(TABLE_INFO_SQL, [tableInfo[1]]));
    }
    if (PRAGMA_NOOP_RE.test(trimmed)) {
      return { rows: [], rowCount: 0 };
    }

    const translated = await this.translate(trimmed, params);
    return this.execute(() => this.run(translated.sql, translated.params));
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
    await this.execute(() => this.run(translated.map((statement) => `${statement};`).join('\n'), []));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // 一度も接続していなければ閉じるものは無い（import しただけのプロセスを終わらせる）
    if (!this.everConnected) return;
    // 実行中のクエリの完了を待ってから閉じる
    try {
      await this.queue;
      await this.client.end();
    } catch {
      // 終了時は握る
    }
  }

  /** PostgreSQL には WAL が無いので何もしない（接続は close が閉じる） */
  async checkpoint(): Promise<void> {}

  /**
   * トランザクション。`fn` の中のクエリは他のリクエストに割り込まれない
   * （キューを 1 枠占有したまま実行するため）。
   * 入れ子には対応しない（SQLite / PostgreSQL どちらも暗黙の入れ子は危険なため）。
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTransaction.getStore()) throw new Error('トランザクションは入れ子にできません');
    return this.enqueue(async () => {
      await this.ensureConnected();
      await this.client.query('BEGIN');
      try {
        const result = await this.inTransaction.run(true, fn);
        await this.client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await this.client.query('ROLLBACK');
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
