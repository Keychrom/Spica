import { DatabaseSync } from 'node:sqlite';

/**
 * データベースの driver 層。
 *
 * アプリ本体は非同期 API（server/src/db/asyncDriver.ts）だけを使う。
 * ここに残っているのは次の 2 つ:
 *
 *   1. SQL の方言差の吸収（`translateSqlForPostgres`）。SQLite 方言で書かれた SQL を
 *      PostgreSQL 用に翻訳する純関数で、PostgreSQL が無くてもテストできる
 *   2. 同期 API の SQLite ラッパー（`SqliteDatabase` / `wrapSqliteDatabase`）。
 *      SQLite 専用の手動メンテナンス CLI（server/src/dbMaintenance.ts）が自分で開いた
 *      接続を包むために使う
 *
 * 以前は PostgreSQL を同期 API のまま使うファサード（worker thread + Atomics.wait）も
 * ここにあったが、案A（データ層の非同期化）の完了で不要になったため削除した
 * （docs/POSTGRESQL.md 参照）。
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

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

/** 生の SQLite 接続を共通インターフェースで包む（SQLite 専用の CLI が使う） */
export function wrapSqliteDatabase(inner: DatabaseSync): SpicaDatabase {
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

  // datetime() は SQLite の関数なので PostgreSQL の式に置き換える。
  // 先に 'now' と修飾子付きを処理する（後段の「文字列リテラルをそのまま使う」規則より前）。
  // 書式はアプリが書き込む ISO 8601（toISOString 相当・UTC）に合わせる。
  const isoUtc = (expr: string) => `TO_CHAR(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  text = text.replace(
    /datetime\(\s*'now'\s*,\s*'([+-]?\d+)\s+(day|days|hour|hours|minute|minutes|month|months|year|years)'\s*\)/gi,
    (_m, amount: string, unit: string) => isoUtc(`(CURRENT_TIMESTAMP + INTERVAL '${amount} ${unit}')`),
  );
  text = text.replace(/datetime\(\s*'now'\s*\)/gi, () => isoUtc('CURRENT_TIMESTAMP'));
  // datetime(x) は不要（TEXT の ISO 8601 をそのまま比較できる）
  text = text.replace(/datetime\(\s*('(?:[^']|'')*')\s*\)/gi, '$1');
  text = text.replace(/datetime\(\s*([A-Za-z_"][A-Za-z0-9_."]*)\s*\)/gi, '$1');
  text = text.replace(/bm25\(\s*"?posts_fts"?\s*\)/gi, 'p.published_at');

  // IFNULL は PostgreSQL に無い（COALESCE が同じ）
  text = text.replace(/\bifnull\s*\(/gi, 'COALESCE(');

  // SQLite の 2 引数 MAX/MIN はスカラー関数（PostgreSQL の GREATEST/LEAST が同じ）。
  // 集約の MAX/MIN は引数が 1 つなので、トップレベルのカンマがあるものだけを対象にする
  // （例: MAX(0, followers_count - 1) → GREATEST(0, followers_count - 1)）
  text = text.replace(/\bMAX\(\s*([^(),]+?)\s*,\s*([^(),]+?)\s*\)/gi, 'GREATEST($1, $2)');
  text = text.replace(/\bMIN\(\s*([^(),]+?)\s*,\s*([^(),]+?)\s*\)/gi, 'LEAST($1, $2)');

  // SQLite の LIKE は ASCII について大文字小文字を区別しない。
  // PostgreSQL の LIKE は区別するので、挙動を合わせて ILIKE にする
  // （既に ILIKE と書かれているものはそのまま）
  text = text.replace(/(?<![Ii])\bLIKE\b/gi, 'ILIKE');

  // FTS: `posts_fts MATCH ?` の「何番目のプレースホルダか」を先に数えてから、
  // MATCH というキーワードを消す（PostgreSQL に MATCH は無い）。
  // 消したあとは ordinal で判定するので、前方を見る必要はない。
  // リテラルで書かれた `posts_fts MATCH '"語"'` は、その場で ILIKE に展開する。
  const ftsLiteral = /"?posts_fts"?\s+MATCH\s+'((?:[^']|'')*)'/i.exec(text);
  if (ftsLiteral && ftsLiteral.index >= 0) {
    const terms = splitFtsTerms(ftsLiteral[1].replace(/''/g, "'"));
    const clauses = terms.map((term) => `f.content ILIKE '%${term.replace(/'/g, "''")}%'`);
    text =
      text.slice(0, ftsLiteral.index) +
      (clauses.length > 0 ? clauses.join(' AND ') : 'TRUE') +
      text.slice(ftsLiteral.index + ftsLiteral[0].length);
  }
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
