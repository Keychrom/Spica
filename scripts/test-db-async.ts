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
  const pgAsync = createAsyncDatabase({
    driver: 'postgres',
    connectionString: DSN,
    statementTimeoutMs: 30_000,
    idleInTransactionTimeoutMs: 60_000,
  });
  await pgAsync.ready();
  await inspect('PostgreSQL', pgAsync);

  // ── セッション設定（タイムアウト）が効いていること ──────
  console.log('\n── PostgreSQL: セッション設定 ───────────');
  check(
    'statement_timeout が設定されている',
    ((await pgAsync.prepare('SHOW statement_timeout').get()) as any).statement_timeout,
    '30s',
  );
  check(
    'idle_in_transaction_session_timeout が設定されている',
    ((await pgAsync.prepare('SHOW idle_in_transaction_session_timeout').get()) as any).idle_in_transaction_session_timeout,
    '1min',
  );

  // ── 接続が切れても落ちず、次のクエリで復帰すること ────────
  // 管理者が PostgreSQL を再起動した / ネットワークが瞬断した、に相当する状況を作る。
  // （pg は切断時に 'error' を emit する。受け手がいないと Node はプロセスごと落とす）
  console.log('\n── PostgreSQL: 接続断からの復帰 ───────────');
  const { Client } = await import('pg');
  const killer = new Client({ connectionString: DSN });
  await killer.connect();
  const pid = ((await pgAsync.prepare('SELECT pg_backend_pid() AS pid').get()) as any).pid;

  // 実行中のクエリはエラーとして返る（ハングしない・プロセスも落ちない）
  let inFlightError: string | null = null;
  const slow = pgAsync.prepare('SELECT pg_sleep(5)').get().catch((err: any) => {
    inFlightError = String(err?.message || err);
    return null;
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await killer.query('SELECT pg_terminate_backend($1)', [pid]);
  await slow;
  check('切断時に実行中だったクエリはエラーになる', Boolean(inFlightError), true);

  // 次のクエリは再接続して成功する（ここで例外が出たり落ちたりしたら失敗）
  let recovered: number | null = null;
  let recoveryError: string | null = null;
  try {
    recovered = Number(((await pgAsync.prepare('SELECT 1 AS ok').get()) as any).ok);
  } catch (err: any) {
    recoveryError = String(err?.message || err);
  }
  check('切断後のクエリは再接続して成功する', recovered, 1);
  if (recoveryError) console.log(`     再試行時のエラー: ${recoveryError.split('\n')[0]}`);

  // 新しい接続でもセッション設定は入り直す（SET は接続ごと）
  check(
    '再接続後も statement_timeout が設定されている',
    ((await pgAsync.prepare('SHOW statement_timeout').get()) as any).statement_timeout,
    '30s',
  );

  const secondPid = ((await pgAsync.prepare('SELECT pg_backend_pid() AS pid').get()) as any).pid;
  check('接続が張り直されている（別のバックエンド）', secondPid !== pid, true);

  // ── プール: セッション固定と並行実行 ────────────────────
  console.log('\n── PostgreSQL: セッション固定と並行実行 ───────────');
  {
    const pidOf = async (): Promise<number> =>
      Number(((await pgAsync.prepare('SELECT pg_backend_pid() AS pid').get()) as any).pid);

    // (1) withSession の中は同じ接続に固定される（一時テーブルが使える）
    const inside = await pgAsync.withSession(async () => {
      const a = await pidOf();
      await pgAsync.exec('CREATE TEMP TABLE pool_probe (id TEXT)');
      await pgAsync.exec("INSERT INTO pool_probe (id) VALUES ('x')");
      const b = await pidOf();
      const count = Number(((await pgAsync.prepare('SELECT COUNT(*) AS c FROM pool_probe').get()) as any).c);
      return { a, b, count };
    });
    check('セッション内は同じ接続に固定される', inside.a === inside.b, true);
    check('セッション内では一時テーブルが見える', inside.count, 1);

    // (2) 同時に走る 2 つのセッションは別の接続で、一時テーブルも混ざらない
    //（同じ名前の一時テーブルを同時に作っても衝突しないこと＝接続が分かれている証拠）
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const [s1, s2] = await Promise.all([
      pgAsync.withSession(async () => {
        await pgAsync.exec('CREATE TEMP TABLE pool_iso (id TEXT)');
        await pgAsync.prepare("INSERT INTO pool_iso (id) VALUES ('a')").run();
        await sleep(300); // もう一方が同時に動けるように待つ
        const pid = await pidOf();
        const rows = (await pgAsync.prepare('SELECT id FROM pool_iso ORDER BY id').all()) as { id: string }[];
        return { pid, ids: rows.map((r) => r.id) };
      }),
      pgAsync.withSession(async () => {
        await sleep(50); // 1 本目がテーブルを作るのを待ってから同じ名前で作る
        await pgAsync.exec('CREATE TEMP TABLE pool_iso (id TEXT)');
        await pgAsync.prepare("INSERT INTO pool_iso (id) VALUES ('b')").run();
        const pid = await pidOf();
        const rows = (await pgAsync.prepare('SELECT id FROM pool_iso ORDER BY id').all()) as { id: string }[];
        return { pid, ids: rows.map((r) => r.id) };
      }),
    ]);
    check('同時セッションは別の接続を使う', s1.pid !== s2.pid, true);
    check('一時テーブルはセッションごとに独立している', [s1.ids.join(','), s2.ids.join(',')], ['a', 'b']);

    // (3) 入れ子の withSession は同じ接続を使う（デッドロックしない）
    const nested = await pgAsync.withSession(async () => {
      const a = await pidOf();
      const b = await pgAsync.withSession(pidOf);
      return { a, b };
    });
    check('入れ子の withSession も同じ接続を使う', nested.a === nested.b, true);

    // (4) 独立したクエリはプールで並行に走る（1 接続に直列化されていない）
    const started = Date.now();
    const slept = await Promise.all(
      [0, 1, 2].map(() => pgAsync.prepare('SELECT pg_sleep(0.3) AS s, pg_backend_pid() AS pid').get()),
    );
    const elapsed = Date.now() - started;
    const pids = new Set(slept.map((row: any) => Number(row.pid)));
    check('並行に投げた 3 クエリが 2 本以上の接続に分かれる', pids.size >= 2, true);
    check('直列化されていない（3×0.3 秒より十分速い）', elapsed < 700, true);

    // (5) トランザクションも 1 接続に固定される
    const inTx = await withTransaction(pgAsync, async () => {
      const a = await pidOf();
      const b = await pidOf();
      return { a, b };
    });
    check('トランザクション内も同じ接続', inTx.a === inTx.b, true);
  }

  // ── 一時テーブルを使うメンテナンスが、プールでも壊れないこと ──
  // （接続が変わると一時テーブルが見えなくなる。実際に削除まで走らせて確かめる）
  console.log('\n── PostgreSQL: 一時テーブルを使う削除 ───────────');
  {
    const { DEFAULT_MAINTENANCE_OPTIONS, planRemotePostRemoval, applyRemotePostRemoval } = await import(
      '../server/src/dbMaintenance.js'
    );
    const now = Date.now();
    const old = new Date(now - 90 * 86400_000).toISOString();
    const fresh = new Date(now - 1 * 86400_000).toISOString();
    const seedPost = (id: string, isLocal: number, publishedAt: string) =>
      pgAsync
        .prepare(
          `INSERT INTO posts (id, user_id, author_name, author_url, author_handle, content, is_local, visibility, emojis, media_attachments, published_at, fts_indexed)
           VALUES (?, 'u1', 't', 'https://remote.test/users/eve', '@eve@remote.test', '本文', ?, 'public', '[]', '[]', ?, 0)
           ON CONFLICT (id) DO UPDATE SET published_at = EXCLUDED.published_at`,
        )
        .run(id, isLocal, publishedAt);

    await seedPost('pool-old-1', 0, old);
    await seedPost('pool-old-2', 0, old);
    await seedPost('pool-new-1', 0, fresh);
    await seedPost('pool-local-1', 1, old);

    const options = { ...DEFAULT_MAINTENANCE_OPTIONS, retentionDays: 30, pruneMedia: false, applyPolicy: false };
    const plan = await planRemotePostRemoval(pgAsync, options);
    check('削除計画に古いリモート投稿が入る', plan.byAge >= 2, true);

    const removed = await applyRemotePostRemoval(pgAsync, options);
    check('古いリモート投稿が削除される', removed.posts >= 2, true);

    const remaining = async (id: string): Promise<number> =>
      Number(((await pgAsync.prepare('SELECT COUNT(*) AS c FROM posts WHERE id = ?').get(id)) as any).c);
    check('保持期間内のリモート投稿は残る', await remaining('pool-new-1'), 1);
    check('ローカル投稿は削除されない', await remaining('pool-local-1'), 1);
    check('削除対象は残らない', await remaining('pool-old-1'), 0);

    // 一時テーブルが残留していない（次の実行が同じ名前で作れる）
    const reused = await pgAsync.withSession(async () => {
      await pgAsync.exec('CREATE TEMP TABLE _maintenance_targets (id TEXT PRIMARY KEY)');
      const count = Number(((await pgAsync.prepare('SELECT COUNT(*) AS c FROM _maintenance_targets').get()) as any).c);
      await pgAsync.exec('DROP TABLE IF EXISTS temp._maintenance_targets');
      return count;
    });
    check('一時テーブルは残留していない（作り直せる）', reused, 0);

    // 後片付け
    for (const id of ['pool-new-1', 'pool-local-1']) {
      await pgAsync.prepare('DELETE FROM posts WHERE id = ?').run(id);
    }
  }

  await killer.end();

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
