/**
 * PostgreSQL 対応スクリプトの共通処理
 *
 * ・SQLite のスキーマを読む
 * ・外部キーの依存順にテーブルを並べる（PostgreSQL は参照先が先に必要）
 * ・FTS5 の影テーブルなど、PostgreSQL 側で扱わないものを除外する
 */
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

/**
 * node-postgres は BIGINT(int8) を文字列で返す。
 * Spica の値は 2^53 に収まる（ミリ秒タイムスタンプや件数）ので数値に寄せ、
 * SQLite 側と突き合わせやすくする。
 */
export function configurePgTypes(): void {
  pg.types.setTypeParser(20, (value: string) => (value === null ? null : Number(value)));
}

export interface SqliteObject {
  type: 'table' | 'index' | 'trigger';
  name: string;
  sql: string;
}

/** FTS5 の影テーブル（posts_fts_config など）は PostgreSQL 側では作らない */
export function isFtsShadowTable(name: string): boolean {
  return /^posts_fts_/.test(name);
}

/** FTS5 の仮想テーブル本体（posts_fts）か */
export function isFtsVirtualTable(sql: string): boolean {
  return /VIRTUAL\s+TABLE/i.test(sql);
}

export function loadSqliteObjects(dbPath: string): SqliteObject[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare(`
      SELECT type, name, sql FROM sqlite_master
      WHERE sql IS NOT NULL AND type IN ('table', 'index', 'trigger')
      ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name
    `).all() as unknown as { type: string; name: string; sql: string }[];
    return rows
      .filter((row) => !row.name.startsWith('sqlite_'))
      .filter((row) => !isFtsShadowTable(row.name))
      .map((row) => ({ type: row.type as SqliteObject['type'], name: row.name, sql: row.sql }));
  } finally {
    db.close();
  }
}

/** テーブルが参照しているテーブル名（REFERENCES のターゲット）を取り出す */
function referencedTables(sql: string): string[] {
  const out = new Set<string>();
  const re = /REFERENCES\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    out.add(match[1]);
  }
  return Array.from(out);
}

/**
 * 外部キーの依存順に並べる（参照される側が先）。
 * 循環がある場合は、残りを名前順で末尾に付ける（自己参照は循環ではない）。
 */
export function orderTablesByFk(objects: SqliteObject[]): { ordered: SqliteObject[]; cycles: string[] } {
  const tables = objects.filter((o) => o.type === 'table');
  const byName = new Map(tables.map((t) => [t.name, t]));
  const deps = new Map<string, string[]>();
  for (const table of tables) {
    deps.set(
      table.name,
      referencedTables(table.sql).filter((name) => name !== table.name && byName.has(name)),
    );
  }

  const ordered: SqliteObject[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (name: string): void => {
    if (visited.has(name) || visiting.has(name)) return; // 循環は打ち切る
    visiting.add(name);
    for (const dep of deps.get(name) ?? []) {
      if (byName.has(dep)) visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
    const table = byName.get(name);
    if (table) ordered.push(table);
  };

  // 名前順で安定させる（生成物の差分を小さくする）
  for (const table of [...tables].sort((a, b) => a.name.localeCompare(b.name))) {
    visit(table.name);
  }

  const cycles = tables.filter((t) => !visited.has(t.name)).map((t) => t.name);
  return { ordered, cycles };
}

/**
 * SQLite の値を PostgreSQL の列型に合わせて整える。
 * SQLite は動的型付けなので、宣言と違う型の値が入っていることがある
 * （例: INTEGER 列に文字列）。そのまま渡すと INSERT が失敗するため、
 * 変換できるものは変換し、できないものはそのまま返して呼び出し側で報告させる。
 */
export function coerceValue(pgType: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const type = pgType.toUpperCase();

  if (type === 'BYTEA') {
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === 'string') return Buffer.from(value, 'utf8');
    return Buffer.from(String(value), 'utf8');
  }

  if (type.includes('INT') || type === 'NUMERIC' || type.includes('DOUBLE') || type.includes('REAL')) {
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed);
      // 数値にできない値は TEXT へ逃がす（スキーマ側を直すべきだが、移送は止めない）
      return null;
    }
    return value;
  }

  if (type === 'TEXT' || type.startsWith('CHAR') || type.startsWith('VARCHAR')) {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    return String(value);
  }

  return value;
}

/** 行を md5 で要約する（順序に依存しない検証に使う） */
export function digestRow(columns: string[], row: Record<string, unknown>, crypto: typeof import('node:crypto')): string {
  const parts: string[] = [];
  for (const column of columns) {
    const value = row[column];
    if (value === null || value === undefined) parts.push('∅');
    else if (Buffer.isBuffer(value)) parts.push(`b:${crypto.createHash('md5').update(value).digest('hex')}`);
    else if (typeof value === 'number') parts.push(`n:${value}`);
    else if (typeof value === 'bigint') parts.push(`n:${value.toString()}`);
    else if (typeof value === 'boolean') parts.push(`n:${value ? 1 : 0}`);
    else if (value instanceof Date) parts.push(`t:${value.toISOString()}`);
    else parts.push(`s:${String(value)}`);
  }
  return crypto.createHash('md5').update(parts.join('\u0001')).digest('hex');
}
