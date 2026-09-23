/**
 * 非同期データベース層の検証 (`npm run test:db-async`)
 *
 * SQLite だけで動きます。TEST_DATABASE_URL があれば **同じ検査を PostgreSQL でも**流します。
 *
 * 検査の軸は「ドライバをまたいで同じ結果が返ること」。行の突き合わせの参照側には
 * SQLite の同期ラッパー（wrapSqliteDatabase。SQLite 専用のメンテナンス CLI と同じ実装）を使い、
 * PostgreSQL 側もその値と一致するかを見ます。
 *
 *   TEST_DATABASE_URL=postgres://spica:pass@127.0.0.1:5432/spica_test npm run test:db-async
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createAsyncDatabase, withTransaction, type AsyncSpicaDatabase } from '../server/src/db/asyncDriver.js';
import { wrapSqliteDatabase, type SpicaDatabase } from '../server/src/db/driver.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQLITE_FILE = path.resolve(ROOT_DIR, 'server', 'data_test_db_async.sqlite');
const DSN = process.env.TEST_DATABASE_URL || '';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
  } else {
    failed++;
    console.log(`  ❌ ${name}\n     実際: ${JSON.stringify(actual)}\n     期待: ${JSON.stringify(expected)}`);
  }
}

/** 1 つのデータベース（同期版 + 非同期版）に対して同じ検査を流す */
/** ドライバごとの最終スナップショット（同じ操作を流した結果を突き合わせる） */
const snapshots = new Map<string, unknown>();

/**
 * 1 つの非同期ハンドルに同じ検査を流す。
 * 最後に同じ操作列の結果（probe テーブルの中身）を控え、先に流したドライバと突き合わせる。
 */
async function inspect(label: string, async: AsyncSpicaDatabase): Promise<void> {
  console.log(`\n── ${label} ─────────────────────────────`);

  const before = { passed, failed };

  await async.exec('DROP TABLE IF EXISTS async_probe');
  // 列の型名は両方の DB で通るものを使う（SQLite は未知の型名を受け付ける。
  // スキーマ生成側は BLOB → BYTEA の変換を別途行っている）
  await async.exec(`
    CREATE TABLE async_probe (
      id TEXT PRIMARY KEY,
      num BIGINT,
      flag INTEGER DEFAULT 0,
      note TEXT,
      blob BYTEA,
      created_at TEXT
    );
  `);

  // ── 基本の 3 操作 ────────────────────────────────────────
  const inserted = await async.prepare('INSERT INTO async_probe (id, num, flag, note) VALUES (?, ?, ?, ?)').run('a', 1, 1, 'ひとつめ');
  check(`${label}: run が changes を返す`, inserted.changes, 1);
  await async.prepare('INSERT INTO async_probe (id, num, flag, note) VALUES (?, ?, ?, ?)').run('b', 2, 0, 'ふたつめ');

  check(
    `${label}: get が 1 行を返す`,
    (await async.prepare('SELECT id, num, note FROM async_probe WHERE id = ?').get('a')) as unknown,
    { id: 'a', num: 1, note: 'ひとつめ' },
  );
  check(
    `${label}: all が複数行を返す`,
    ((await async.prepare('SELECT id FROM async_probe ORDER BY id').all()) as { id: string }[]).map((row) => row.id),
    ['a', 'b'],
  );
  check(`${label}: 該当なしの get は undefined`, (await async.prepare('SELECT id FROM async_probe WHERE id = ?').get('nope')) as unknown, undefined);
  check(`${label}: 該当なしの all は空配列`, (await async.prepare('SELECT id FROM async_probe WHERE id = ?').all('nope')) as unknown, []);



  // ── 値の型（数値・真偽値 0/1・NULL・BLOB） ───────────────
  const withBlob = Buffer.from('バイナリ', 'utf8');
  await async.prepare('INSERT INTO async_probe (id, num, flag, note, blob) VALUES (?, ?, ?, ?, ?)').run('c', 1798761600000, 0, null, withBlob);
  const row = (await async.prepare('SELECT num, flag, note, blob FROM async_probe WHERE id = ?').get('c')) as any;
  check(`${label}: ミリ秒タイムスタンプが数値で戻る`, typeof row.num === 'number' && row.num, 1798761600000);
  check(`${label}: NULL は null で戻る`, row.note, null);
  // バイナリ列の型はドライバで異なる（SQLite は Uint8Array / PostgreSQL は Buffer）。
  // Spica のスキーマにバイナリ列は無く、実際の用途は無いが、差として記録しておく。
  check(`${label}: バイナリは往復しても壊れない`, Buffer.from(row.blob).toString('utf8'), 'バイナリ');
  check(`${label}: バイナリ列の型（参考）`, async.kind === 'sqlite' ? 'Uint8Array' : 'Buffer', Buffer.isBuffer(row.blob) ? 'Buffer' : 'Uint8Array');

  // ── 方言の吸収（PRAGMA / INSERT OR） ─────────────────────
  const columns = (await async.prepare('PRAGMA table_info(async_probe)').all()) as { name: string }[];
  check(`${label}: PRAGMA table_info が列を返す`, columns.map((c) => c.name).sort(), ['blob', 'created_at', 'flag', 'id', 'note', 'num']);

  await async.prepare('INSERT OR IGNORE INTO async_probe (id, num) VALUES (?, ?)').run('a', 99);
  check(`${label}: INSERT OR IGNORE は既存行を変えない`, ((await async.prepare('SELECT num FROM async_probe WHERE id = ?').get('a')) as any).num, 1);
  await async.prepare('INSERT OR IGNORE INTO async_probe (id, num) VALUES (?, ?)').run('d', 4);
  check(`${label}: INSERT OR IGNORE は新規行を入れる`, ((await async.prepare('SELECT num FROM async_probe WHERE id = ?').get('d')) as any).num, 4);
  await async.prepare('INSERT OR REPLACE INTO async_probe (id, num) VALUES (?, ?)').run('a', 42);
  check(`${label}: INSERT OR REPLACE は上書きする`, ((await async.prepare('SELECT num FROM async_probe WHERE id = ?').get('a')) as any).num, 42);

  // ── トランザクション ────────────────────────────────────
  // ここまでの行数: a / b / c / d の 4 行（INSERT OR REPLACE は a の上書きなので増えない）
  await withTransaction(async, async () => {
    await async.prepare('INSERT INTO async_probe (id, num) VALUES (?, ?)').run('tx1', 1);
  });
  check(`${label}: コミットした行が残る`, ((await async.prepare('SELECT COUNT(*) AS n FROM async_probe').get()) as any).n, 5);

  let rolledBack = false;
  try {
    await withTransaction(async, async () => {
      await async.prepare('INSERT INTO async_probe (id, num) VALUES (?, ?)').run('tx2', 2);
      throw new Error('意図的な失敗');
    });
  } catch (err) {
    rolledBack = (err as Error).message === '意図的な失敗';
  }
  check(`${label}: 失敗したトランザクションは元のエラーを投げる`, rolledBack, true);
  check(`${label}: 失敗したトランザクションはロールバックされる`, ((await async.prepare('SELECT COUNT(*) AS n FROM async_probe').get()) as any).n, 5);

  // ── 順序（直列化）: 並行に投げても発行順に処理される ──────
  await async.prepare('DELETE FROM async_probe').run();
  const writes = [1, 2, 3, 4, 5].map((n) => async.prepare('INSERT INTO async_probe (id, num) VALUES (?, ?)').run(`p${n}`, n));
  await Promise.all(writes);
  check(
    `${label}: 並行に投げても全件入る`,
    ((await async.prepare('SELECT id FROM async_probe ORDER BY id').all()) as { id: string }[]).map((r) => r.id),
    ['p1', 'p2', 'p3', 'p4', 'p5'],
  );

  // ── エラーの伝播 ────────────────────────────────────────
  let errored = false;
  try {
    await async.prepare('SELECT * FROM no_such_table_here').get();
  } catch {
    errored = true;
  }
  check(`${label}: 存在しないテーブルはエラーになる`, errored, true);

  // エラーの後も使い続けられる
  check(`${label}: エラーの後も使える`, ((await async.prepare('SELECT COUNT(*) AS n FROM async_probe').get()) as any).n, 5);

  // ── 同じ操作列を流した結果が、先のドライバと一致するか ─────
  const snapshot = (await async.prepare('SELECT id, num, note FROM async_probe ORDER BY id').all()) as unknown;
  const previous = [...snapshots.entries()][0];
  if (previous) {
    check(`${label}: 同じ操作を流すと ${previous[0]} と同じ行になる`, snapshot, previous[1]);
  }
  snapshots.set(label, snapshot);

  await async.exec('DROP TABLE IF EXISTS async_probe');
  console.log(`  （${label}: ${passed - before.passed} 件成功 / ${failed - before.failed} 件失敗）`);
}

console.log('非同期データベース層のテスト');
console.log('');

// ── SQLite（同期接続を共有する） ─────────────────────────
for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.rmSync(`${SQLITE_FILE}${suffix}`, { force: true });
  } catch {
    // 消せなくても続行する
  }
}
const sqliteInner = new DatabaseSync(SQLITE_FILE);
sqliteInner.exec('PRAGMA journal_mode = WAL;');
const sqliteSync = wrapSqliteDatabase(sqliteInner);
const sqliteAsync = createAsyncDatabase({ driver: 'sqlite', sqlite: sqliteInner });
await inspect('SQLite', sqliteAsync);

// 同期版と非同期版が同じ接続を見ていること
await sqliteAsync.exec('CREATE TABLE IF NOT EXISTS shared_probe (id TEXT)');
sqliteSync.prepare('INSERT INTO shared_probe (id) VALUES (?)').run('shared');
check(
  'SQLite: 同期版の書き込みが非同期版から見える',
  ((await sqliteAsync.prepare('SELECT id FROM shared_probe WHERE id = ?').get('shared')) as any).id,
  'shared',
);
await sqliteAsync.exec('DROP TABLE shared_probe');

// ── PostgreSQL（TEST_DATABASE_URL があるときだけ） ────────
// 参照側は SQLite の同期ラッパー（同じ操作で同じ値が返るはず。ドライバ間の一致を見る）
let skippedPg = false;
if (DSN) {
  const pgAsync = createAsyncDatabase({ driver: 'postgres', connectionString: DSN });
  await pgAsync.ready();
  await inspect('PostgreSQL', pgAsync);
  await pgAsync.close();
} else {
  skippedPg = true;
  console.log('\n⏭️  PostgreSQL の検査はスキップしました（TEST_DATABASE_URL 未設定）');
}

// SQLite の後片付け（PostgreSQL の突き合わせが終わってから）
await sqliteAsync.close();
fs.rmSync(SQLITE_FILE, { force: true });
for (const suffix of ['-wal', '-shm']) {
  try {
    fs.rmSync(`${SQLITE_FILE}${suffix}`, { force: true });
  } catch {
    // 消せなくても続行する
  }
}

console.log('');
console.log('====================================================');
if (failed === 0) {
  console.log(`🎊 非同期データベース層: ${passed} 件成功${skippedPg ? '（PostgreSQL はスキップ）' : ''}`);
  process.exit(0);
}
console.log(`❌ ${passed} 件成功 / ${failed} 件失敗`);
process.exit(1);
