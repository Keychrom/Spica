/**
 * 案A（データ層の非同期化）の進捗 (`npm run db:async:status`)
 *
 * 同期 API（`db.prepare` / `db.exec`）と非同期 API（`adb.prepare` / `adb.exec`）の
 * 呼び出し箇所を数えて、残りを可視化する。移行はこの数字が 0 になるまで続く。
 *
 *   npm run db:async:status          # 一覧
 *   npm run db:async:status -- --json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT_DIR, 'server', 'src');

interface FileStats {
  file: string;
  sync: number;
  async: number;
  /** 同期接続を自分で開いている箇所（new DatabaseSync / wrapSqliteDatabase） */
  ownConnection: number;
  /** トランザクション制御（BEGIN / COMMIT / ROLLBACK） */
  transactions: number;
}

/** 同期 API の呼び出し（`db.prepare(` / `db.exec(`） */
const SYNC_RE = /(?<![A-Za-z0-9_$.])db\.(?:prepare|exec)\s*\(/g;
/** 非同期 API の呼び出し（`adb.prepare(` / `adb.exec(`） */
const ASYNC_RE = /(?<![A-Za-z0-9_$.])adb\.(?:prepare|exec)\s*\(/g;
const OWN_CONNECTION_RE = /new DatabaseSync\s*\(|wrapSqliteDatabase\s*\(/g;
const TRANSACTION_RE = /(?:exec|run)\s*\(\s*['"`]\s*(?:BEGIN|COMMIT|ROLLBACK)/g;

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
for (const abs of walk(SRC_DIR)) {
  const text = fs.readFileSync(abs, 'utf8');
  const file = path.relative(ROOT_DIR, abs).replace(/\\/g, '/');
  const sync = countMatches(text, SYNC_RE);
  const async = countMatches(text, ASYNC_RE);
  const ownConnection = countMatches(text, OWN_CONNECTION_RE);
  const transactions = countMatches(text, TRANSACTION_RE);
  // ドライバ自身と非同期層は数えない（実装本体なので）
  if (file.endsWith('db/driver.ts') || file.endsWith('db/asyncDriver.ts') || file.endsWith('db/pgWorker.ts')) continue;
  if (sync === 0 && async === 0 && ownConnection === 0) continue;
  stats.push({ file, sync, async, ownConnection, transactions });
}

const totalSync = stats.reduce((sum, s) => sum + s.sync, 0);
const totalAsync = stats.reduce((sum, s) => sum + s.async, 0);
const totalOwn = stats.reduce((sum, s) => sum + s.ownConnection, 0);
const done = totalAsync;
const remaining = totalSync;
const percent = done + remaining === 0 ? 100 : (done / (done + remaining)) * 100;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ totalSync, totalAsync, files: stats }, null, 2));
  process.exit(0);
}

console.log('==========================================================');
console.log(' 案A（データ層の非同期化）の進捗');
console.log('==========================================================');
console.log(`  非同期化済み: ${done} 箇所`);
console.log(`  残り（同期 API）: ${remaining} 箇所`);
if (totalOwn > 0) console.log(`  自前で開いている同期接続: ${totalOwn} 箇所`);
console.log(`  進捗: ${percent.toFixed(1)}%`);
console.log('');
console.log('  残りの多いファイル（上から着手する）:');

const byRemaining = [...stats].filter((s) => s.sync > 0).sort((a, b) => b.sync - a.sync);
const width = Math.min(60, Math.max(...byRemaining.map((s) => s.file.length), 10));
for (const s of byRemaining.slice(0, 20)) {
  const marks: string[] = [];
  if (s.async > 0) marks.push(`非同期 ${s.async}`);
  if (s.transactions > 0) marks.push(`トランザクション ${s.transactions}`);
  if (s.ownConnection > 0) marks.push(`自前接続 ${s.ownConnection}`);
  console.log(`   ${s.file.padEnd(width)}  残り ${String(s.sync).padStart(3)}${marks.length ? `  (${marks.join(' / ')})` : ''}`);
}
if (byRemaining.length > 20) console.log(`   … ほか ${byRemaining.length - 20} ファイル`);

const converted = stats.filter((s) => s.sync === 0 && s.async > 0);
if (converted.length > 0) {
  console.log('');
  console.log('  非同期化が完了したファイル:');
  for (const s of converted) console.log(`   ${s.file}  (${s.async} 箇所)`);
}
console.log('');
console.log('※ 手順は docs/POSTGRESQL.md の「案A の進め方」を参照。');
