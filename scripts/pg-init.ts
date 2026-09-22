/**
 * PostgreSQL にスキーマを適用する (`npm run db:pg:init`)
 *
 * server/src/db/schema.pg.sql（`npm run db:pg:schema` の生成物）を流し込む。
 * 生成物は `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` /
 * `CREATE OR REPLACE FUNCTION` で書かれているので、繰り返し実行しても安全。
 *
 * 使い方:
 *   DATABASE_URL=postgres://spica:...@127.0.0.1:5432/spica npm run db:pg:init
 *   npm run db:pg:init -- --dsn "postgres://..." --reset   … 既存スキーマを捨てて作り直す
 *
 * 注意:
 *   ・`CREATE EXTENSION pg_trgm` は管理者権限が要る。権限が無い場合は、先に
 *     管理者が `CREATE EXTENSION pg_trgm;` を該当 DB で実行しておく必要がある
 *     （今回は適用できなくても、その他のスキーマ適用は続行し、警告を出す）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_FILE = path.join(ROOT_DIR, 'server', 'src', 'db', 'schema.pg.sql');

function parseArgs(argv: string[]) {
  const dsnIndex = argv.indexOf('--dsn');
  return {
    dsn: dsnIndex >= 0 ? argv[dsnIndex + 1] : process.env.DATABASE_URL,
    reset: argv.includes('--reset'),
    yes: argv.includes('--yes'),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.dsn) {
    console.error('❌ 接続先がありません。DATABASE_URL を設定するか --dsn で指定してください。');
    console.error('   例: npm run db:pg:init -- --dsn "postgres://spica:password@127.0.0.1:5432/spica"');
    return 64;
  }
  if (!fs.existsSync(SCHEMA_FILE)) {
    console.error(`❌ スキーマが見つかりません: ${SCHEMA_FILE}`);
    console.error('   先に npm run db:pg:schema を実行してください。');
    return 66;
  }

  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const client = new Client({ connectionString: args.dsn });

  console.log('==========================================================');
  console.log(' PostgreSQL スキーマ適用');
  console.log('==========================================================');
  console.log(`接続先: ${String(args.dsn).replace(/:[^:@/]+@/, ':***@')}`);
  console.log(`スキーマ: ${path.relative(ROOT_DIR, SCHEMA_FILE).replace(/\\/g, '/')}`);
  console.log('');

  await client.connect();
  try {
    const before = await client.query(`
      SELECT COUNT(*)::int AS tables FROM information_schema.tables WHERE table_schema = 'public'
    `);
    console.log(`適用前のテーブル数: ${before.rows[0].tables}`);

    if (args.reset) {
      if (!/localhost|127\.0\.0\.1|_test/i.test(String(args.dsn)) && !args.yes) {
        console.error('❌ --reset は接続先がローカルでも *_test でもありません。本当に消すなら --yes を付けてください。');
        return 65;
      }
      console.log('⚠️  --reset: public スキーマを削除して作り直します...');
      await client.query('DROP SCHEMA IF EXISTS public CASCADE');
      await client.query('CREATE SCHEMA public');
    }

    // pg_trgm（権限が無い場合は警告して続行）
    let trigramReady = true;
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      console.log('pg_trgm: 準備OK（日本語の部分一致検索に使います）');
    } catch (err: any) {
      trigramReady = false;
      console.warn(`⚠️  pg_trgm を有効化できませんでした（${err.message}）。`);
      console.warn('    管理者権限で `CREATE EXTENSION pg_trgm;` を実行してから再実行してください。');
    }

    await client.query(sql);

    const after = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM information_schema.tables WHERE table_schema = 'public') AS tables,
        (SELECT COUNT(*)::int FROM pg_indexes WHERE schemaname = 'public') AS indexes,
        (SELECT COUNT(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace) AS triggers
    `);
    const { tables, indexes, triggers } = after.rows[0];
    console.log('');
    console.log(`✅ 適用しました: テーブル ${tables} / 索引 ${indexes} / トリガー ${triggers}`);
    if (!trigramReady) {
      console.log('   ※ pg_trgm が無効のため、検索（posts_fts）の索引は機能しません。');
    }
    console.log('');
    console.log('次の手順:');
    console.log('  既存データを移す場合: npm run db:pg:migrate -- --from data_astrabit.sqlite --verify');
    console.log('  ※ アプリ本体の PostgreSQL 対応（ドライバ）は未実装です。今はデータの移送と検証までが使えます。');
    return 0;
  } finally {
    await client.end();
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('❌ スキーマ適用に失敗しました:', err?.message || err);
  process.exit(1);
});
