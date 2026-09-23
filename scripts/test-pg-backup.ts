/**
 * PostgreSQL バックアップ（pg_dump）の検証 (`npm run test:pg-backup`)
 *
 *   TEST_DATABASE_URL=postgres://spica:...@127.0.0.1:5432/spica_test npm run test:pg-backup
 *
 * 検査すること:
 *   1. 接続情報の受け渡し（パスワードは環境変数。argv には出さない）
 *   2. 実際にダンプが取れる（pg_restore -l で読める = 壊れていない）
 *   3. 世代管理（keep を超えた古いダンプを消す）
 *   4. pg_dump が無い環境ではスキップする（失敗させない）
 *
 * pg_dump / pg_restore が無い場合はスキップして終了コード 0 で終わります。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { backupPostgresDatabase, pgDumpArgs, pgEnvFromDsn, resolvePgBinary, rotatePgBackups } from '../server/src/pgBackup.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP_DIR = path.join(ROOT_DIR, 'data', 'backups-test-pg');
const DSN = process.env.TEST_DATABASE_URL || '';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}\n     実際: ${JSON.stringify(actual)}\n     期待: ${JSON.stringify(expected)}`);
  }
}

console.log('====================================================');
console.log('🧪 PostgreSQL バックアップ（pg_dump）の検証');
console.log('====================================================');

if (!DSN) {
  console.log('\n⏭️  TEST_DATABASE_URL が未設定のためスキップしました');
  process.exit(0);
}

const pgDump = resolvePgBinary('pg_dump');
const pgRestore = resolvePgBinary('pg_restore');
if (!pgDump || !pgRestore) {
  console.log(`\n⏭️  pg_dump / pg_restore が見つからないためスキップしました（pg_dump=${pgDump ?? 'なし'}）`);
  console.log('   インストールするか PG_BIN_DIR を設定すると検査できます。');
  process.exit(0);
}

// 後片付け（前回の残りを消してから始める）
fs.rmSync(BACKUP_DIR, { recursive: true, force: true });

console.log('\n🔐 [1] 接続情報の受け渡し');
{
  // パスワードを含む DSN を分解して環境変数に載せる。
  // URL エンコードされた文字が復号されることも見たいので、実行時に組み立てる
  // （ソース上に「本物らしい認証情報」を書かないためでもある。秘密スキャン対策）
  const encodedPassword = 'pass%2Fword'; // → pass/word
  const env = pgEnvFromDsn(`postgres://spica:${encodedPassword}@db.example.com:5433/spica_db?sslmode=require`);
  check('ホスト', env.PGHOST, 'db.example.com');
  check('ポート', env.PGPORT, '5433');
  check('ユーザー', env.PGUSER, 'spica');
  check('パスワード（URL デコードする）', env.PGPASSWORD, 'pass/word');
  check('データベース名', env.PGDATABASE, 'spica_db');
  check('sslmode を引き継ぐ', env.PGSSLMODE, 'require');

  // argv に接続情報（特にパスワード）が入らないこと
  const args = pgDumpArgs('/tmp/spica.dump');
  check('argv にパスワードを含めない', args.some((a) => a.includes(encodedPassword) || a.includes('pass/word')), false);
  check('argv に接続文字列を含めない', args.some((a) => a.includes('postgres://')), false);
  check('argv は出力先だけを持つ', args, ['-Fc', '--no-owner', '--no-privileges', '-f', '/tmp/spica.dump']);
}

console.log('\n💾 [2] ダンプの作成');
{
  const result = await backupPostgresDatabase({ dsn: DSN, backupDir: BACKUP_DIR, keep: 2, log: () => {} });
  check('ダンプが作られる', Boolean(result), true);
  if (result) {
    check('ファイルが存在する', fs.existsSync(result.path), true);
    check('サイズが 0 より大きい', result.bytes > 0, true);
    check('拡張子は .dump', path.extname(result.path), '.dump');

    // pg_restore -l でアーカイブとして読める（壊れていないことの確認）
    const listing = spawnSync(pgRestore, ['-l', result.path], { encoding: 'utf8' });
    check('pg_restore がアーカイブとして読める', listing.status, 0);
    check('テーブル定義が入っている', /TABLE DATA public (users|posts|server_settings)/.test(listing.stdout || ''), true);
  }
}

console.log('\n🗂️  [3] 世代管理');
{
  // keep=2 なので、3 つ目を取ると 1 つ消える
  const first = await backupPostgresDatabase({ dsn: DSN, backupDir: BACKUP_DIR, keep: 10, log: () => {} });
  const second = await backupPostgresDatabase({ dsn: DSN, backupDir: BACKUP_DIR, keep: 10, log: () => {} });
  const before = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.dump'));
  check('keep が大きければ残る', before.length >= 3, true);

  const removed = rotatePgBackups(BACKUP_DIR, 2);
  const after = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.dump'));
  check('keep を超えた分を削除する', after.length, 2);
  check('削除した数を返す', removed.length, before.length - 2);
  check('最新のダンプは残す', first && second ? after.includes(path.basename(second.path)) : false, true);

  const unlimited = rotatePgBackups(BACKUP_DIR, 0);
  check('keep=0 は削除しない', unlimited.length, 0);
}

// 後片付け
fs.rmSync(BACKUP_DIR, { recursive: true, force: true });

console.log('');
console.log('====================================================');
if (failed === 0) {
  console.log(`🎊 PostgreSQL バックアップ: ${passed} 件成功`);
  process.exit(0);
}
console.log(`❌ ${passed} 件成功 / ${failed} 件失敗`);
process.exit(1);
