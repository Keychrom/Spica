/**
 * データ層の移行状態 (`npm run db:async:status`)
 *
 *   npx tsx scripts/db-async-status.ts
 *
 * 案A（データ層の非同期化）は完了したので、このスクリプトは
 * 「アプリのコードが非同期ハンドル（db）だけを使っているか」を確認する役割に変わった。
 * 見ているもの:
 *   1. `new DatabaseSync` / `wrapSqliteDatabase` — 自前で同期接続を開いている箇所
 *      （SQLite 専用のメンテナンス CLI だけが許される）
 *   2. `db.prepare` / `db.exec` の呼び出し箇所（非同期ハンドル。参考値）
 *
 * 移行の経緯と手順は docs/POSTGRESQL.md を参照。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT_DIR, 'server', 'src');

/** 非同期ハンドルの呼び出し（`db.prepare(` / `db.exec(`） */
const ASYNC_RE = /(?<![A-Za-z0-9_$.])db\.(?:prepare|exec)\s*\(/g;
/** 自前で開く同期接続 */
const OWN_CONNECTION_RE = /new DatabaseSync\s*\(|wrapSqliteDatabase\s*\(/g;
/** トランザクション制御（BEGIN / COMMIT / ROLLBACK） */
const TRANSACTION_RE = /(?:exec|run)\s*\(\s*['"`]\s*(?:BEGIN|COMMIT|ROLLBACK)/g;

/**
 * 自前の同期接続を開いてよいファイル（それ以外で見つかったら知らせる）。
 * dbMaintenance は SQLite 専用の手動メンテナンス CLI で、VACUUM / page_count /
 * VACUUM INTO のように PostgreSQL に無い操作を扱うため、生の接続を使う。
 * db.ts は SQLite の接続を 1 本だけ開いて非同期ハンドルに渡す役割。
 * db/driver.ts は同期 SQLite ラッパー本体（CLI に提供する側）。
 */
const ALLOWED_OWN_CONNECTION = new Set([
  'server/src/db.ts',
  'server/src/dbMaintenance.ts',
  'server/src/db/driver.ts',
  'server/src/db/asyncDriver.ts',
]);

interface FileStats {
  file: string;
  async: number;
  ownConnection: number;
  transactions: number;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  let count = 0;
  while (re.exec(text) !== null) count++;
  return count;
}

const stats: FileStats[] = [];
const unexpectedConnections: string[] = [];

for (const abs of walk(SRC_DIR)) {
  const text = fs.readFileSync(abs, 'utf8');
  const file = path.relative(ROOT_DIR, abs).split(path.sep).join('/');
  const async = countMatches(text, ASYNC_RE);
  const ownConnection = countMatches(text, OWN_CONNECTION_RE);
  const transactions = countMatches(text, TRANSACTION_RE);
  if (async === 0 && ownConnection === 0) continue;

  if (ownConnection > 0 && !ALLOWED_OWN_CONNECTION.has(file)) unexpectedConnections.push(file);
  stats.push({ file, async, ownConnection, transactions });
}

const totalAsync = stats.reduce((sum, s) => sum + s.async, 0);
const ownConnectionFiles = stats.filter((s) => s.ownConnection > 0);

console.log('==========================================================');
console.log(' データ層の移行状態（案A: 非同期化）');
console.log('==========================================================');
console.log(`  非同期ハンドル（db）の呼び出し: ${totalAsync} 箇所`);
console.log(`  自前で同期接続を開いているファイル: ${ownConnectionFiles.length}`);
console.log('');

console.log('  自前の同期接続（想定どおり）:');
for (const s of ownConnectionFiles) {
  const allowed = ALLOWED_OWN_CONNECTION.has(s.file);
  console.log(`   ${allowed ? '✅' : '⚠️ '} ${s.file}  (${s.ownConnection} 箇所${s.transactions > 0 ? ` / トランザクション ${s.transactions}` : ''})`);
}

if (unexpectedConnections.length > 0) {
  console.log('');
  console.log('  ⚠️  想定外の箇所で同期接続を開いています（非同期ハンドル db を使ってください）:');
  for (const file of unexpectedConnections) console.log(`   - ${file}`);
}

console.log('');
console.log('※ 移行の経緯・手順は docs/POSTGRESQL.md、await の付け忘れは npm run check:await を参照。');
