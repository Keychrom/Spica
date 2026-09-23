/**
 * PostgreSQL のバックアップ CLI（1人運用向け）
 *
 *   npm run db:pg:backup                       # .env の DATABASE_URL を pg_dump で取る
 *   npm run db:pg:backup -- --out /path/to/dir # 保存先を変える
 *   npm run db:pg:backup -- --keep 5           # 残す世代数（既定 3）
 *
 * 認証情報は環境変数で pg_dump に渡すので、`ps` からパスワードは見えません。
 * pg_dump が見つからない場合は、その旨を出して終了コード 3 で終わります
 * （アプリ内の自動メンテナンスは、この場合は警告してスキップします）。
 *
 * 復元は pg_restore:
 *   pg_restore --clean --if-exists -d "$DATABASE_URL" data/backups/spica-YYYYMMDD-HHMMSSmmm.dump
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupPostgresDatabase, resolvePgDumpBinary } from '../server/src/pgBackup.js';
import { formatBytes } from '../server/src/dbMaintenance.js';
import { config } from '../server/src/config.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv: string[]): { out?: string; keep?: number; help: boolean } {
  const args: { out?: string; keep?: number; help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--keep') args.keep = parseInt(argv[++i], 10);
  }
  return args;
}

function printHelp(): void {
  console.log(`PostgreSQL のバックアップ（pg_dump -Fc）

  npm run db:pg:backup [-- --out <dir>] [--keep <n>]

  --out <dir>   保存先（既定: <repo>/data/backups）
  --keep <n>    残す世代数（既定: BACKUPS_KEEP または 3）
  -h, --help    この説明

  pg_dump は PATH、PG_BIN_DIR、OS の標準的なインストール先の順に探します。`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  if (config.dbDriver !== 'postgres') {
    console.log('ℹ️  DB_DRIVER が postgres ではありません（SQLite のバックアップは npm run db:maintenance）。');
    return 0;
  }
  if (!config.databaseUrl) {
    console.error('❌ DATABASE_URL が設定されていません（.env を確認してください）。');
    return 64;
  }
  if (!resolvePgDumpBinary()) {
    console.error('❌ pg_dump が見つかりません。インストールするか PG_BIN_DIR を設定してください。');
    return 3;
  }

  const backupDir = args.out ? path.resolve(args.out) : path.join(ROOT_DIR, 'data', 'backups');
  const keep = Number.isFinite(args.keep) ? (args.keep as number) : config.backupsKeep;

  console.log('==========================================================');
  console.log(' PostgreSQL バックアップ (pg_dump)');
  console.log('==========================================================');
  console.log(`保存先: ${backupDir}`);
  console.log(`世代数: ${keep > 0 ? `${keep} 世代` : '無制限'}`);
  console.log('');

  try {
    const result = await backupPostgresDatabase({
      dsn: config.databaseUrl,
      backupDir,
      keep,
      log: (line) => console.log(line),
    });
    if (!result) return 3;
    console.log(`✅ 作成しました: ${result.path} (${formatBytes(result.bytes)})`);
    if (result.removed.length > 0) console.log(`   古い世代を削除: ${result.removed.join(', ')}`);
    console.log('');
    console.log('復元する場合:');
    console.log(`  pg_restore --clean --if-exists -d "$DATABASE_URL" "${result.path}"`);
    return 0;
  } catch (err: any) {
    console.error(`❌ バックアップに失敗しました: ${err?.message || err}`);
    return 1;
  }
}

process.exit(await main());
