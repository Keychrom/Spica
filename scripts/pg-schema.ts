/**
 * SQLite のスキーマから PostgreSQL の DDL を生成する (`npm run db:pg:schema`)
 *
 * Spica のスキーマの正は `server/src/db.ts` の migrations（SQLite）。
 * 二重管理を避けるため、PostgreSQL 側の DDL はここで**生成**する。
 * 生成物: server/src/db/schema.pg.sql（手で編集しない。db.ts を変えたら再生成）
 *
 * 変換の方針:
 *   ・型は TEXT / INTEGER / REAL / BLOB のみ。INTEGER はそのまま INTEGER にする
 *     （真偽値を 0/1 のまま保つことで、アプリ側の `= 1` 比較を書き換えずに済む）
 *   ・UNIQUE(...) / FOREIGN KEY ... ON DELETE CASCADE / DEFAULT はそのまま使える
 *   ・FTS5 の仮想テーブル posts_fts は「普通のテーブル + pg_trgm の GIN 索引」に置き換える
 *     （影テーブル posts_fts_* は作らない）
 *   ・トリガーは plpgsql の関数 + トリガーに置き換え、new./old. を NEW./OLD. にする
 *   ・予約語の列名だけ引用符で囲む
 *
 * 使い方:
 *   npm run db:pg:schema                 … 一時 DB を作ってスキーマを取り、生成
 *   npm run db:pg:schema -- --from PATH  … 既存の SQLite DB から生成
 *   npm run db:pg:schema -- --check      … 生成せず、現状のファイルと一致するか確認
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSqliteObjects, orderTablesByFk, isFtsShadowTable, isFtsVirtualTable, SqliteObject } from './pg-shared.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT_DIR, 'server', 'src', 'db', 'schema.pg.sql');

/** PostgreSQL の予約語（この一覧に載る列名は引用符で囲む） */
const PG_RESERVED = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'both', 'case', 'cast',
  'check', 'collate', 'column', 'constraint', 'create', 'current_catalog', 'current_date', 'current_role',
  'current_time', 'current_timestamp', 'current_user', 'default', 'deferrable', 'desc', 'distinct', 'do',
  'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign', 'from', 'grant', 'group', 'having', 'in',
  'initially', 'intersect', 'into', 'lateral', 'leading', 'limit', 'localtime', 'localtimestamp', 'not',
  'null', 'offset', 'on', 'only', 'or', 'order', 'placing', 'primary', 'references', 'returning', 'select',
  'session_user', 'some', 'symmetric', 'table', 'then', 'to', 'trailing', 'true', 'union', 'unique', 'user',
  'using', 'variadic', 'when', 'where', 'window', 'with',
]);

const TYPE_MAP: Record<string, string> = {
  TEXT: 'TEXT',
  // SQLite の INTEGER は 64bit。ミリ秒タイムスタンプ（1.79e12 など）が入る列があるため BIGINT にする。
  // 真偽値は 0/1 のまま入れているので、アプリ側の `= 1` 比較はそのまま動く。
  INTEGER: 'BIGINT',
  REAL: 'DOUBLE PRECISION',
  BLOB: 'BYTEA',
  NUMERIC: 'NUMERIC',
  BOOLEAN: 'INTEGER', // SQLite 側は 0/1 で持っている
};

function quoteIfReserved(name: string): string {
  return PG_RESERVED.has(name.toLowerCase()) ? `"${name}"` : name;
}

/** 列定義の並びを変換する（型の置換と予約語の引用） */
function convertTableBody(sql: string): string {
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  if (open < 0 || close < 0) return sql;
  const head = sql.slice(0, open);
  const body = sql.slice(open + 1, close);
  const tail = sql.slice(close + 1);

  // 括弧の深さを見て列定義を分割する（UNIQUE(...) / FOREIGN KEY(...) を壊さない）
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  const converted = parts.map((part) => {
    if (/^(UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|CONSTRAINT|CHECK)\b/i.test(part)) {
      return '  ' + part.replace(/\s+/g, ' ');
    }
    // 列定義: 名前 型 [制約...]
    const match = /^"?([A-Za-z_][A-Za-z0-9_]*)"?\s+([A-Za-z]+)(.*)$/.exec(part);
    if (!match) return '  ' + part.replace(/\s+/g, ' ');
    const [, column, type, rest] = match;
    const pgType = TYPE_MAP[type.toUpperCase()] ?? type.toUpperCase();
    const cleanedRest = rest
      .replace(/\s+/g, ' ')
      .replace(/\bNULL\b/g, 'NULL')
      .trimEnd();
    return `  ${quoteIfReserved(column)} ${pgType}${cleanedRest}`;
  });

  return `${head} (\n${converted.join(',\n')}\n)${tail}`;
}

/** SQLite のトリガーを plpgsql 関数 + トリガーに変換する */
function convertTrigger(object: SqliteObject): string {
  const sql = object.sql.replace(/\s+/g, ' ').trim();
  const match = /^CREATE TRIGGER\s+(?:IF NOT EXISTS\s+)?(\w+)\s+(BEFORE|AFTER|INSTEAD OF)\s+(INSERT|UPDATE|DELETE)\s+ON\s+(\w+)\s*(?:WHEN\s+(.+?))?\s*BEGIN\s+(.+?)\s*END$/i.exec(sql);
  if (!match) {
    throw new Error(`トリガーを解釈できませんでした: ${object.name}`);
  }
  const [, name, timing, event, table, when, body] = match;
  const fnName = `spica_${name}`;
  const returnRow = event.toUpperCase() === 'DELETE' ? 'OLD' : 'NEW';

  // 本体の new./old. を PostgreSQL の NEW./OLD. にし、FTS への INSERT は upsert にする
  const statements = body
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((statement) => {
      let out = statement
        .replace(/\bnew\./gi, 'NEW.')
        .replace(/\bold\./gi, 'OLD.');
      if (/^INSERT\s+INTO\s+posts_fts/i.test(out) && !/ON CONFLICT/i.test(out)) {
        out += ' ON CONFLICT (post_id) DO UPDATE SET content = EXCLUDED.content';
      }
      return `    ${out};`;
    });

  const whenClause = when
    ? `\n  WHEN (${when.replace(/\bnew\./gi, 'NEW.').replace(/\bold\./gi, 'OLD.')})`
    : '';

  return [
    `CREATE OR REPLACE FUNCTION ${fnName}() RETURNS trigger LANGUAGE plpgsql AS $$`,
    'BEGIN',
    ...statements,
    `    RETURN ${returnRow};`,
    'END $$;',
    `DROP TRIGGER IF EXISTS ${name} ON ${table};`,
    `CREATE TRIGGER ${name} ${timing.toUpperCase()} ${event.toUpperCase()} ON ${table} FOR EACH ROW${whenClause} EXECUTE FUNCTION ${fnName}();`,
  ].join('\n');
}

function generate(objects: SqliteObject[]): string {
  const lines: string[] = [];
  lines.push('-- Spica: PostgreSQL スキーマ');
  lines.push('--');
  lines.push('-- このファイルは `npm run db:pg:schema` が server/src/db.ts の migrations（SQLite）から生成します。');
  lines.push('-- 手で編集しないでください。スキーマを変えるときは db.ts を直して再生成します。');
  lines.push('--');
  lines.push('-- 適用: npm run db:pg:init -- --dsn "$DATABASE_URL"');
  lines.push('');
  lines.push('-- pg_trgm: 日本語を含む部分一致検索（FTS5 の trigram 相当）に使う');
  lines.push('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
  lines.push('');

  // 参照される側を先に作る（PostgreSQL は外部キーの参照先が先に必要）
  const { ordered, cycles } = orderTablesByFk(objects);
  const tables = ordered;
  const indexes = objects.filter((o) => o.type === 'index');
  const triggers = objects.filter((o) => o.type === 'trigger');
  if (cycles.length > 0) {
    console.warn(`⚠️  外部キーが循環しているテーブルがあります（名前順で末尾に配置）: ${cycles.join(', ')}`);
  }

  lines.push('-- ==== テーブル ====');
  for (const table of tables) {
    if (isFtsVirtualTable(table.sql)) {
      // FTS5 の仮想テーブル → 普通のテーブル + GIN(trigram) 索引
      lines.push(`-- ${table.name}: FTS5 仮想テーブルを通常テーブル + pg_trgm 索引に置き換え`);
      lines.push(`CREATE TABLE IF NOT EXISTS ${table.name} (\n  post_id TEXT PRIMARY KEY,\n  content TEXT\n);`);
      lines.push(`CREATE INDEX IF NOT EXISTS idx_${table.name}_trgm ON ${table.name} USING gin (content gin_trgm_ops);`);
      lines.push('');
      continue;
    }
    const ddl = convertTableBody(table.sql)
      .replace(/^CREATE TABLE\s+(?!IF NOT EXISTS)/i, 'CREATE TABLE IF NOT EXISTS ');
    lines.push(`${ddl};`);
  }
  lines.push('');

  lines.push('-- ==== 索引 ====');
  for (const index of indexes) {
    const ddl = index.sql
      .replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/i, (_m, unique) => `CREATE ${unique ?? ''}INDEX IF NOT EXISTS `)
      .replace(/\s+/g, ' ')
      .trim();
    lines.push(`${ddl};`);
  }
  lines.push('');

  lines.push('-- ==== トリガー（plpgsql 関数 + トリガー）====');
  for (const trigger of triggers) {
    lines.push(convertTrigger(trigger));
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const fromIndex = args.indexOf('--from');
  const fromPath = fromIndex >= 0 ? path.resolve(args[fromIndex + 1] ?? '') : null;

  let tempDb: string | null = null;
  let dbPath = fromPath;

  if (!dbPath) {
    // db.ts の migrations から canonical なスキーマを作る
    tempDb = path.join(ROOT_DIR, 'server', 'data_pg_schema_probe.sqlite');
    for (const f of [tempDb, `${tempDb}-wal`, `${tempDb}-shm`]) {
      try { fs.unlinkSync(f); } catch {}
    }
    process.env.DB_PATH = tempDb;
    const dbModule: any = await import('../server/src/db.js');
    dbModule.initDatabase();
    dbPath = tempDb;
  }

  try {
    const objects = loadSqliteObjects(dbPath);
    const sql = generate(objects);
    const counts = {
      table: objects.filter((o) => o.type === 'table' && !/VIRTUAL/i.test(o.sql)).length,
      fts: objects.filter((o) => o.type === 'table' && /VIRTUAL/i.test(o.sql)).length,
      index: objects.filter((o) => o.type === 'index').length,
      trigger: objects.filter((o) => o.type === 'trigger').length,
    };

    if (check) {
      const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
      if (current === sql) {
        console.log('✅ schema.pg.sql は最新です');
        return 0;
      }
      console.error('❌ schema.pg.sql が古いか存在しません。npm run db:pg:schema で再生成してください。');
      return 1;
    }

    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, sql, 'utf8');
    console.log('PostgreSQL スキーマを生成しました');
    console.log(`  出力: ${path.relative(ROOT_DIR, OUT_FILE).replace(/\\/g, '/')}`);
    console.log(`  テーブル ${counts.table}（+ FTS ${counts.fts}）/ 索引 ${counts.index} / トリガー ${counts.trigger}`);
    // 生成物に SQLite 固有の構文が残っていないか自己点検する
    // コメント行は点検の対象から外す（説明に FTS5 などが出てくるため）
    const codeOnly = sql.split(String.fromCharCode(10)).filter((line) => !line.trim().startsWith('--')).join(String.fromCharCode(10));
    const leftovers = [
      ['AUTOINCREMENT', /\bAUTOINCREMENT\b/i],
      ['PRAGMA', /\bPRAGMA\b/i],
      ['WITHOUT ROWID', /WITHOUT\s+ROWID/i],
      ['fts5', /\bfts5\b/i],
      ['INSERT OR', /INSERT\s+OR\s+(IGNORE|REPLACE)/i],
      ['datetime(', /\bdatetime\s*\(/i],
    ].filter(([, pattern]) => (pattern as RegExp).test(codeOnly)).map(([label]) => label);
    if (leftovers.length > 0) {
      console.error(`❌ 生成物に SQLite 固有の構文が残っています: ${leftovers.join(', ')}`);
      return 1;
    }
    console.log('  SQLite 固有の構文は残っていません（自己点検）');
    return 0;
  } finally {
    if (tempDb) {
      for (const f of [tempDb, `${tempDb}-wal`, `${tempDb}-shm`]) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('スキーマ生成に失敗しました:', err);
  process.exit(1);
});
