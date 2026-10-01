/**
 * 生成済みスキーマ（server/src/db/schema.pg.sql）と実際の DB の**列の差分**を埋める。
 *
 * ## なぜ要るか
 *
 * PostgreSQL 側の DDL は `npm run db:pg:schema` の生成物で、すべて
 * `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` になっている。
 * つまり **既存の DB には新しい列が増えない**（テーブルは増えるが、列は増えない）。
 * SQLite 側は `ALTER TABLE ... ADD COLUMN` のマイグレーションで列を足しているので、
 * 同じ変更を PostgreSQL にも届ける仕組みがここ。
 *
 * 生成物が正なので、**スキーマに書いてあって DB に無い列だけ**を足す（追加のみ・削除しない）。
 * 既存行に影響しうる定義（NOT NULL で DEFAULT が無いもの）は足さない（失敗するため）。
 */
import { isAddableColumn, splitTopLevel } from './schemaSql.js';

/** `CREATE TABLE IF NOT EXISTS <name> ( ... )` を、テーブル名 → 列定義の配列にする */
export function parseSchemaColumns(schemaSql: string): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  const createRe = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(([\s\S]*?)\)\s*;/gi;
  for (const match of schemaSql.matchAll(createRe)) {
    const table = match[1];
    const columns: string[] = [];
    for (const entry of splitTopLevel(match[2])) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      // 表レベルの制約は列ではない
      if (/^(?:PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT|EXCLUDE)\b/i.test(trimmed)) continue;
      columns.push(trimmed);
    }
    tables.set(table, columns);
  }
  return tables;
}

/** 列定義から列名を取り出す（`"order" TEXT ...` → `order`） */
export function columnNameOf(definition: string): string | null {
  const match = /^\s*"?([A-Za-z_][A-Za-z0-9_]*)"?/.exec(definition);
  return match ? match[1] : null;
}

/**
 * 足りない列の `ALTER TABLE` 文を組み立てる（純粋関数）。
 * `existing` は テーブル名 → 既存の列名の集合。
 */
export function missingColumnStatements(
  schemaSql: string,
  existing: Map<string, Set<string>>,
): string[] {
  const statements: string[] = [];
  for (const [table, columns] of parseSchemaColumns(schemaSql)) {
    const have = existing.get(table);
    // テーブル自体が無い場合はスキーマ適用（CREATE TABLE）が作るので、ここでは触らない
    if (!have) continue;
    for (const definition of columns) {
      const name = columnNameOf(definition);
      if (!name || have.has(name)) continue;
      if (!isAddableColumn(definition)) continue;
      statements.push(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS ${definition};`);
    }
  }
  return statements;
}
