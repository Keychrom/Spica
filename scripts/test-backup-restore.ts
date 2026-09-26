/**
 * バックアップから**実際に戻せるか**を確かめる復元演習 (`npx tsx scripts/test-backup-restore.ts`)
 *
 * 「バックアップが取れている」ことと「戻せる」ことは別なので、復元まで通しで確認する。
 *
 *   1. SQLite: `VACUUM INTO` でバックアップ → 新しいファイルへ戻す
 *      → `PRAGMA integrity_check` とレコード数 → **復元した DB でアプリが起動する**
 *   2. PostgreSQL: `pg_dump -Fc` → 新しい DB へ `pg_restore` → 同じことを確認
 *      （pg_dump / pg_restore が無い環境ではスキップ。失敗させない）
 *
 * 検査対象は一時 DB（このスクリプトが作る）なので、**ライブの DB には触りません**。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from 'pg';

const Sqlite = DatabaseSync;

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK_DIR = path.join(ROOT_DIR, '.bench', 'restore-drill');
const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';

/**
 * アプリのモジュール（`config` は **import した瞬間に環境変数を読む**）は、必ず関数の中で動的 import する。
 * 先に import すると `DB_PATH` の上書きが効かず、**別の DB（.env の DB_PATH。相対パスならカレント直下）
 * を触ってしまう**（実際に一度そうなった）。ここに静的 import を足さないこと。
 */

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}: 期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 復元した DB でアプリを起動して、応答するかを見る（DB の中身が壊れていれば起動しない） */
async function bootsWith(dbPath: string, port: number): Promise<{ ok: boolean; body: string }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    BIND_HOST: '127.0.0.1',
    DOMAIN: `localhost:${port}`,
    PROTOCOL: 'http',
    DB_PATH: dbPath,
    AUTO_MAINTENANCE: 'false',
    AUTO_BACKUP: 'false',
    RATE_LIMIT_DISABLED: 'true',
  };
  delete env.DB_DRIVER;
  delete env.DATABASE_URL;

  const proc: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(ROOT_DIR, 'server'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout?.on('data', (d) => (log += d.toString()));
  proc.stderr?.on('data', (d) => (log += d.toString()));

  try {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.status === 200) {
          const body = await res.text();
          return { ok: true, body: body.slice(0, 120) };
        }
      } catch {
        // まだ起動していない
      }
      await sleep(400);
    }
    return { ok: false, body: log.slice(-300) };
  } finally {
    if (proc.exitCode === null) proc.kill();
    // tsx の子プロセスが残らないように少し待つ
    await sleep(500);
  }
}

/** 復元した PostgreSQL でアプリを起動して、応答するかを見る */
async function bootsWithPg(dsn: string, port: number): Promise<{ ok: boolean; body: string }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    BIND_HOST: '127.0.0.1',
    DOMAIN: `localhost:${port}`,
    PROTOCOL: 'http',
    DB_DRIVER: 'postgres',
    DATABASE_URL: dsn,
    AUTO_MAINTENANCE: 'false',
    AUTO_BACKUP: 'false',
    RATE_LIMIT_DISABLED: 'true',
  };
  delete env.DB_PATH;

  const proc: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(ROOT_DIR, 'server'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout?.on('data', (d) => (log += d.toString()));
  proc.stderr?.on('data', (d) => (log += d.toString()));

  try {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.status === 200) {
          const body = await res.text();
          return { ok: true, body: body.slice(0, 120) };
        }
      } catch {
        // まだ起動していない
      }
      await sleep(400);
    }
    return { ok: false, body: log.slice(-300) };
  } finally {
    if (proc.exitCode === null) proc.kill();
    await sleep(500);
  }
}

async function runSqliteDrill(): Promise<void> {
  console.log('\n=== SQLite: VACUUM INTO → 復元 ===');
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const source = path.join(WORK_DIR, 'drill-source.sqlite');
  for (const p of [source, `${source}-wal`, `${source}-shm`]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  // 検査用の DB を作る。**アプリの initDatabase() で本物のスキーマを作る**
  // （手書きの最小スキーマだと、起動時の索引作成で落ちて「復元しても起動しない」と誤判定する）。
  // config は import 時に環境変数を読むので、先に絶対パスで指定してから動的 import する
  process.env.DB_PATH = source;
  delete process.env.DB_DRIVER;
  delete process.env.DATABASE_URL;
  const { db, initDatabase } = await import('../server/src/db.js');
  const { backupDatabase } = await import('../server/src/dbMaintenance.js');
  await initDatabase();
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO users (id, name, master_key_hash, role, is_frozen, public_key_pem, private_key_pem, created_at)
     VALUES (?, ?, ?, 'user', 0, 'pub', 'priv', ?)`,
  ).run('drill', '復元演習', 'hash', now);
  for (let i = 0; i < 50; i++) {
    await db.prepare(
      `INSERT INTO posts (id, user_id, author_name, author_url, author_handle, content, is_local, published_at)
       VALUES (?, 'drill', '復元演習', ?, '@drill@example.test', ?, 1, ?)`,
    ).run(`https://example.test/users/drill/posts/${i}`, 'https://example.test/users/drill', `本文 ${i}`, new Date(Date.now() - i * 1000).toISOString());
  }
  await db.close();
  // 書いた先が本当に検査用の DB か確かめる（取り違えると別の DB を壊すので） 
  check('検査用の DB に書けている', fs.existsSync(source), true);

  // ① バックアップ（アプリと同じ道具）
  const reader = new Sqlite(source);
  const backup = backupDatabase(reader, source, path.join(WORK_DIR, 'backups'));
  reader.close();
  check('バックアップが作られた', fs.existsSync(backup.path), true);
  check('バックアップのサイズが 0 より大きい', backup.bytes > 0, true);

  // ② 復元（ファイルをコピーするだけ。実際の運用手順と同じ）
  //    ⚠️ `-wal` / `-shm` を残したまま本体だけを差し替えると、SQLite が**前回の書き込みを
  //       復元した DB に適用**してしまい「壊れている」ように見える（docs/UPGRADE.md の落とし穴）。
  const restored = path.join(WORK_DIR, 'restored.sqlite');
  for (const p of [restored, `${restored}-wal`, `${restored}-shm`]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  fs.copyFileSync(backup.path, restored);
  check('復元したファイルができた', fs.existsSync(restored), true);

  // ③ 中身の確認
  const restoredDb = new Sqlite(restored);
  const integrity = restoredDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  check('integrity_check が ok', integrity.integrity_check, 'ok');
  check('利用者の件数が一致', (restoredDb.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c, 1);
  check('投稿の件数が一致', (restoredDb.prepare('SELECT COUNT(*) AS c FROM posts').get() as { c: number }).c, 50);
  const newest = restoredDb.prepare('SELECT id FROM posts ORDER BY published_at DESC LIMIT 1').get() as { id: string };
  restoredDb.close();
  check('新しい順に取れる（索引も復元されている）', newest.id, 'https://example.test/users/drill/posts/0');

  // ④ 復元した DB でアプリが起動するか
  const boot = await bootsWith(restored, 3910);
  check('復元した DB でアプリが起動する', boot.ok, true);
  if (!boot.ok) console.error(`    起動ログ: ${boot.body}`);
}

async function runPostgresDrill(): Promise<void> {
  console.log('\n=== PostgreSQL: pg_dump → pg_restore ===');
  const { backupPostgresDatabase, pgEnvFromDsn, resolvePgBinary } = await import('../server/src/pgBackup.js');
  if (!resolvePgBinary('pg_dump') || !resolvePgBinary('pg_restore')) {
    console.log('  ⏭️  pg_dump / pg_restore が無いのでスキップ');
    return;
  }
  if (!DSN) {
    console.log('  ⏭️  接続先（TEST_DATABASE_URL / DATABASE_URL）が無いのでスキップ');
    return;
  }

  // 検査用の DB を作る（本番の DB には触らない）
  const admin = new Client({ connectionString: DSN });
  await admin.connect();
  const sourceDb = 'spica_restore_drill';
  const targetDb = 'spica_restore_drill_restored';
  for (const name of [sourceDb, targetDb]) {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
  }
  await admin.end();

  const withDb = (base: string, name: string): string => base.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);

  // 検査用のデータを入れる。**スキーマはアプリのものを使う**
  // （手書きの最小スキーマだと `CREATE TABLE IF NOT EXISTS` が素通りして、
  //  復元後にアプリが「列が無い」で落ちる。バックアップの検査ではなくなる）
  const sourceDsn = withDb(DSN, sourceDb);
  const initSchema = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/pg-init.ts', '--dsn', sourceDsn], {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  check('検査用 DB にアプリのスキーマを適用できた', initSchema.status, 0);
  if (initSchema.status !== 0) console.error(`    ${String(initSchema.stderr).slice(0, 300)}`);

  const source = new Client({ connectionString: sourceDsn });
  await source.connect();
  const nowIso = new Date().toISOString();
  await source.query(
    `INSERT INTO users (id, name, master_key_hash, role, is_frozen, public_key_pem, private_key_pem, created_at)
     VALUES ('drill', '復元演習', 'hash', 'user', 0, 'pub', 'priv', $1)`,
    [nowIso],
  );
  for (let i = 0; i < 50; i++) {
    await source.query(
      `INSERT INTO posts (id, user_id, author_name, author_url, author_handle, content, is_local, published_at)
       VALUES ($1, 'drill', '復元演習', 'https://example.test/users/drill', '@drill@example.test', $2, 1, $3)`,
      [`https://example.test/users/drill/posts/${i}`, `本文 ${i}`, new Date(Date.now() - i * 1000).toISOString()],
    );
  }
  await source.end();

  // ① ダンプ
  const backupDir = path.join(WORK_DIR, 'backups-pg');
  const dump = await backupPostgresDatabase({ dsn: sourceDsn, backupDir, keep: 1 });
  check('ダンプが作られた', Boolean(dump), true);
  check('ダンプのサイズが 0 より大きい', (dump?.bytes ?? 0) > 0, true);

  // ② 復元
  const targetDsn = withDb(DSN, targetDb);
  const restore = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const proc = spawn(resolvePgBinary('pg_restore') as string, ['--no-owner', '--no-privileges', '-d', targetDsn, dump!.path], {
      env: { ...process.env, ...pgEnvFromDsn(targetDsn) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => resolve({ code, stderr }));
  });
  check('pg_restore が成功した', restore.code, 0);
  if (restore.code !== 0) console.error(`    ${restore.stderr.slice(0, 300)}`);

  // ③ 中身の確認
  const restored = new Client({ connectionString: targetDsn });
  await restored.connect();
  check('利用者の件数が一致', Number((await restored.query('SELECT COUNT(*) AS c FROM users')).rows[0].c), 1);
  check('投稿の件数が一致', Number((await restored.query('SELECT COUNT(*) AS c FROM posts')).rows[0].c), 50);
  const newest = await restored.query('SELECT id FROM posts ORDER BY published_at DESC LIMIT 1');
  check('新しい順に取れる（索引も復元されている）', newest.rows[0]?.id, 'https://example.test/users/drill/posts/0');
  await restored.end();

  // ④ 復元した DB でアプリが起動するか
  const boot = await bootsWithPg(targetDsn, 3911);
  check('復元した DB でアプリが起動する', boot.ok, true);
  if (!boot.ok) console.error(`    起動ログ: ${boot.body}`);

  // 後片付け
  const cleanup = new Client({ connectionString: DSN });
  await cleanup.connect();
  for (const name of [sourceDb, targetDb]) {
    await cleanup.query(`DROP DATABASE IF EXISTS ${name}`);
  }
  await cleanup.end();
}

async function main(): Promise<void> {
  console.log('🧪 バックアップの復元演習（取れるだけでなく、戻して動くか）');
  await runSqliteDrill();
  await runPostgresDrill();

  console.log(`\n${failed === 0 ? '🎉' : '❌'} 成功 ${passed} / 失敗 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('❌ 復元演習でエラー:', err);
  process.exit(1);
});
