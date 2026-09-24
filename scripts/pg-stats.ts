/**
 * PostgreSQL の「いまどこが重いか」を見るための集計。
 *
 *   npm run db:pg:stats                  # 上位 20 件
 *   npm run db:pg:stats -- --limit 50    # 件数を増やす
 *   npm run db:pg:stats -- --dsn "$DATABASE_URL"
 *
 * 出るもの:
 *   1. 実行時間の合計が大きいクエリ（`pg_stat_statements` が必要）
 *   2. 1 回あたりが遅いクエリ
 *   3. テーブルと索引のサイズ、索引の使われ具合（`pg_stat_user_indexes`）
 *   4. 滞留しているトランザクション（アイドル・長いもの）
 *
 * `pg_stat_statements` が無い環境でも 3 と 4 は出ます（1 と 2 はスキップして案内を出します）。
 * 有効化はサーバー側の設定が要ります（docs/POSTGRESQL.md の「計測」を参照）:
 *   shared_preload_libraries = 'pg_stat_statements'
 *   CREATE EXTENSION pg_stat_statements;   -- 管理者権限で 1 回
 *
 * 認証情報は環境変数（.env の DATABASE_URL）から読み、psql の引数には載せません。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePgBinary } from '../server/src/pgBackup.js';

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

function readDsnFromEnvFile(): string {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return '';
  const text = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const m = /^DATABASE_URL\s*=\s*(.+)$/.exec(line.trim());
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

function parseArgs(argv: string[]): { dsn: string; limit: number } {
  let dsn = '';
  let limit = 20;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dsn' && argv[i + 1]) dsn = argv[++i];
    else if (argv[i] === '--limit' && argv[i + 1]) limit = Math.max(1, Math.min(200, parseInt(argv[++i], 10) || 20));
  }
  return { dsn: dsn || process.env.DATABASE_URL || readDsnFromEnvFile(), limit };
}

/** DSN を psql 用の環境変数に分解する（argv にパスワードを載せない） */
function envFromDsn(dsn: string): Record<string, string> {
  const url = new URL(dsn);
  const env: Record<string, string> = {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.replace(/^\//, '') || 'postgres',
  };
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

/** pg_stat_statements が使えるか */
const HAS_EXTENSION = `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS ok`;

const BY_TOTAL_TIME = (limit: number) => `
SELECT
  calls,
  round(total_exec_time::numeric, 1) AS total_ms,
  round(mean_exec_time::numeric, 2) AS mean_ms,
  round(100 * total_exec_time / NULLIF(sum(total_exec_time) OVER (), 0), 1) AS pct,
  rows,
  left(regexp_replace(query, '\\s+', ' ', 'g'), 110) AS query
FROM pg_stat_statements
WHERE query NOT ILIKE '%pg_stat_statements%'
ORDER BY total_exec_time DESC
LIMIT ${limit};`;

const BY_MEAN_TIME = (limit: number) => `
SELECT
  calls,
  round(mean_exec_time::numeric, 2) AS mean_ms,
  round(max_exec_time::numeric, 1) AS max_ms,
  rows,
  left(regexp_replace(query, '\\s+', ' ', 'g'), 110) AS query
FROM pg_stat_statements
WHERE calls > 5 AND query NOT ILIKE '%pg_stat_statements%'
ORDER BY mean_exec_time DESC
LIMIT ${limit};`;

const TABLE_SIZES = `
SELECT
  c.relname AS table,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
  pg_size_pretty(pg_relation_size(c.oid)) AS heap,
  pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid)) AS indexes,
  s.n_live_tup AS live_rows,
  s.n_dead_tup AS dead_rows,
  s.last_autovacuum
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 15;`;

const UNUSED_INDEXES = `
SELECT
  s.relname AS table,
  s.indexrelname AS index,
  s.idx_scan AS scans,
  pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE NOT i.indisunique AND s.idx_scan < 50
ORDER BY pg_relation_size(s.indexrelid) DESC
LIMIT 15;`;

const LONG_TRANSACTIONS = `
SELECT
  pid,
  state,
  round(extract(epoch FROM (now() - xact_start))::numeric, 1) AS xact_seconds,
  round(extract(epoch FROM (now() - state_change))::numeric, 1) AS state_seconds,
  left(regexp_replace(coalesce(query, ''), '\\s+', ' ', 'g'), 90) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL
ORDER BY xact_start ASC
LIMIT 10;`;

function runPsql(env: Record<string, string>, sql: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    // pg_dump と同じ解決（PATH → 標準のインストール先 → PG_BIN_DIR）
    const bin = resolvePgBinary('psql') || 'psql';
    const proc = spawn(bin, ['-X', '-q', '-A', '-F', ' | ', '-c', sql], { env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => resolve({ code: 127, out: String((e as any)?.message || e) }));
    proc.on('close', (code) => resolve({ code: code ?? 1, out: code === 0 ? out : `${out}${err}` }));
  });
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

const { dsn, limit } = parseArgs(process.argv.slice(2));
if (!dsn) {
  console.error('❌ DATABASE_URL がありません（環境変数か .env に設定してください。--dsn でも指定できます）');
  process.exit(2);
}

let env: Record<string, string>;
try {
  env = envFromDsn(dsn);
} catch {
  console.error('❌ DATABASE_URL を解釈できませんでした（postgres://user:pass@host:port/db の形を想定しています）');
  process.exit(2);
}

console.log('📊 PostgreSQL の統計');
console.log(`   接続先: ${dsn.replace(/:[^:@/]*@/, ':***@')}`);

const extension = await runPsql(env, HAS_EXTENSION);
if (extension.code !== 0) {
  console.error(`\n❌ 接続できませんでした:\n${extension.out.trim()}`);
  process.exit(1);
}
const hasExtension = extension.out.includes('t');

if (hasExtension) {
  section(`実行時間の合計が大きいクエリ（上位 ${limit} 件）`);
  console.log((await runPsql(env, BY_TOTAL_TIME(limit))).out.trim());
  section(`1 回あたりが遅いクエリ（上位 ${limit} 件・呼び出し 5 回超）`);
  console.log((await runPsql(env, BY_MEAN_TIME(limit))).out.trim());
} else {
  section('クエリの統計');
  console.log('  ⚠️ pg_stat_statements が有効ではありません（この部分はスキップしました）');
  console.log('  有効化するには postgresql.conf に次を入れて再起動し、管理者で 1 回だけ拡張を作ります:');
  console.log("    shared_preload_libraries = 'pg_stat_statements'");
  console.log('    CREATE EXTENSION pg_stat_statements;');
  console.log('  （詳しくは docs/POSTGRESQL.md の「計測」）');
}

section('テーブルと索引のサイズ（上位 15 件）');
console.log('  （live_rows / dead_rows / last_autovacuum は統計がリセットされた直後は 0・空になります）');
console.log((await runPsql(env, TABLE_SIZES)).out.trim());

section('使われていない索引（重複・不要の候補。unique は除く）');
console.log('  （統計がリセットされた直後は全部 0 になります。数日動かしてから見てください）');
console.log((await runPsql(env, UNUSED_INDEXES)).out.trim());

section('長く開いているトランザクション');
console.log((await runPsql(env, LONG_TRANSACTIONS)).out.trim());
console.log('');
