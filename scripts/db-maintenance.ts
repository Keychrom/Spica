/**
 * DB メンテナンス CLI（1人運用向け）
 *
 *   npm run db:maintenance                     # ドライラン（何が消えるか確認）
 *   npm run db:maintenance -- --apply          # 実行（バックアップ → 削除 → VACUUM）
 *   npm run db:maintenance -- --days 7 --apply # 保持期間を 7 日にして実行
 *   npm run db:maintenance -- --help
 *
 * 実行内容:
 *   ① 古いリモート投稿の保持期間削除（リレー経由で流入した投稿が DB を膨らませるのを防ぐ）
 *   ② どの投稿からも参照されていないローカル保存メディア（uploads/）の削除
 *   ③ wal_checkpoint + VACUUM（削除で空いたページを解放）
 *   ④ VACUUM INTO によるバックアップ（WAL の内容も含む一貫したスナップショット）
 *
 * 注意: VACUUM は DB の排他ロックを取るため、サーバー起動中は失敗します。
 *       VACUUM まで行いたい場合はサーバーを停止してから実行してください
 *       （先頭のバックアップと投稿削除はサーバー起動中でも実行できます）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/src/config.js';
import { getFtsIndexScope, getRemoteAnnouncePolicy, readSetting } from '../server/src/searchPolicy.js';
import { pruneProxyCacheOn } from '../server/src/imageProxy.js';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';
import {
  DEFAULT_MAINTENANCE_OPTIONS,
  MaintenanceOptions,
  formatBytes,
  getDbSizeInfo,
  openMaintenanceDb,
  planRemotePostRemoval,
  runMaintenance,
} from '../server/src/dbMaintenance.js';

interface CliArgs {
  apply: boolean;
  days?: number;
  maxRemotePosts?: number;
  keepFollowed: boolean;
  keepRepliesToLocal: boolean;
  media: boolean;
  policy: boolean;
  proxyCache: boolean;
  backupOnly: boolean;
  backup: boolean;
  vacuum: boolean;
  backupsKeep?: number;
  dbPath?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    apply: false,
    keepFollowed: true,
    keepRepliesToLocal: true,
    media: true,
    policy: true,
    proxyCache: true,
    backupOnly: false,
    backup: true,
    vacuum: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} には値が必要です`);
      return v;
    };
    switch (a) {
      case '--apply': args.apply = true; break;
      case '--dry-run': args.apply = false; break;
      case '--days': args.days = parseInt(next(), 10); break;
      case '--max-remote-posts': args.maxRemotePosts = parseInt(next(), 10); break;
      case '--no-keep-followed': args.keepFollowed = false; break;
      case '--no-keep-replies-to-local': args.keepRepliesToLocal = false; break;
      case '--skip-media': args.media = false; break;
      case '--skip-policy': args.policy = false; break;
      case '--skip-proxy-cache': args.proxyCache = false; break;
      case '--no-backup': args.backup = false; break;
      case '--backup-only': args.backupOnly = true; break;
      case '--no-vacuum': args.vacuum = false; break;
      case '--backups-keep': args.backupsKeep = parseInt(next(), 10); break;
      case '--db': args.dbPath = next(); break;
      case '--help':
      case '-h': args.help = true; break;
      default:
        throw new Error(`不明なオプション: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
Spica DB メンテナンス

使い方:
  npm run db:maintenance [-- オプション]

オプション:
  --apply                 実際に削除と VACUUM を実行する（既定はドライラン）
  --days N                リモート投稿の保持日数（既定: REMOTE_POST_RETENTION_DAYS、無ければ 30。0 で期間削除なし）
  --max-remote-posts N    リモート投稿の最大保持件数（0 で無効。件数で上限を切りたいときに使う）
  --no-keep-followed      フォロー中アクターの投稿も保持対象から外す（既定は保持）
  --no-keep-replies-to-local  ローカル投稿への返信も保持対象から外す（既定は保持）
  --skip-media            孤立メディアの削除を行わない
  --skip-policy           保存・索引の方針（FTS スコープ / リモートブースト）を既存データへ適用しない
  --skip-proxy-cache      画像プロキシのキャッシュ整理を行わない
  --backup-only           バックアップ（VACUUM INTO）だけを行って終了する（cron 向け）
  --no-backup             実行前のバックアップ（VACUUM INTO）を省略（非推奨）
  --no-vacuum             wal_checkpoint + VACUUM を行わない
  --backups-keep N        バックアップの保持世代数（既定 3）
  --db PATH               対象 DB を明示（既定: .env の DB_PATH）
  -h, --help              このヘルプ

残されるリモート投稿（削除対象から除外）:
  ・ローカルユーザーがブックマーク/ピン留めした投稿
  ・ローカル投稿の返信先・引用元になっている投稿
  ・ローカルユーザーがリアクション/ブーストした投稿
  ・フォロー中アクターの投稿（--no-keep-followed で解除）
  ・ローカル投稿への返信（--no-keep-replies-to-local で解除）

保存先がリモート（S3/R2）のメディアは、この コマンドでは削除しません（uploads/ のみ対象）。
`);
}

/**
 * .env の DB_PATH は「サーバー起動時の cwd」= server/ 基準で解釈されるため、
 * リポジトリ直下から実行されるこの CLI も同じ基準に合わせる。
 * （合わせないと別の DB を掴んだり、存在しない DB を新規作成してしまう）
 */
function resolveServerDir(): string {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'server', 'package.json'))) return path.join(cwd, 'server');
  return cwd;
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err: any) {
    console.error(`❌ ${err.message}`);
    printHelp();
    return 64;
  }
  if (args.help) {
    printHelp();
    return 0;
  }

  const serverDir = resolveServerDir();
  const rawDbPath = process.env.DB_PATH || 'data_astrabit.sqlite';
  const dbPath = args.dbPath ? path.resolve(args.dbPath) : path.resolve(serverDir, rawDbPath);
  if (!fs.existsSync(dbPath)) {
    console.error(`❌ DB が見つかりません: ${dbPath}`);
    console.error(`   （.env の DB_PATH=${rawDbPath} を ${serverDir} 基準で解決しました。--db で明示もできます）`);
    return 66;
  }

  const envDays = parseInt(process.env.REMOTE_POST_RETENTION_DAYS ?? '', 10);
  const options: MaintenanceOptions = {
    ...DEFAULT_MAINTENANCE_OPTIONS,
    retentionDays: args.days !== undefined ? args.days : Number.isFinite(envDays) ? envDays : DEFAULT_MAINTENANCE_OPTIONS.retentionDays,
    maxRemotePosts: args.maxRemotePosts ?? 0,
    keepFollowed: args.keepFollowed,
    keepRepliesToLocal: args.keepRepliesToLocal,
    pruneMedia: args.media,
    applyPolicy: args.policy,
  };

  // uploads とバックアップは DB と同じサーバーディレクトリ配下に置く（cwd に依存しない）
  const uploadsDir = path.resolve(path.dirname(dbPath), 'data/uploads');
  const backupDir = path.resolve(path.dirname(dbPath), 'data/backups');
  const remoteStorageConfigured = Boolean(config.storage.endpoint);

  console.log('==========================================================');
  console.log(' Spica DB メンテナンス');
  console.log('==========================================================');
  console.log(`DB          : ${dbPath}`);
  console.log(`uploads     : ${uploadsDir}`);
  console.log(`バックアップ : ${backupDir}`);
  console.log(`モード       : ${args.apply ? '実行 (--apply)' : 'ドライラン（削除しません。実行は --apply）'}`);
  console.log(`保持期間     : ${options.retentionDays > 0 ? `${options.retentionDays} 日` : '無効'}`);
  if (options.maxRemotePosts > 0) console.log(`件数上限     : ${options.maxRemotePosts} 件`);
  console.log(`VACUUM      : ${args.vacuum ? 'あり' : 'なし'} / バックアップ: ${args.backup ? 'あり' : 'なし'}`);
  console.log('');

  // 事前調査（接続してから件数を出す）。CLI は自前の接続を 1 本だけ開き、
  // 非同期ハンドルで包んで共通の検査（アプリと同じコード）を使う
  const conn = openMaintenanceDb(dbPath);
  const db = createAsyncDatabase({ sqlite: conn });
  const before = await getDbSizeInfo(dbPath, db);
  let plan;
  let policyScope = 'local';
  let policyAnnounce = 'follows';
  let proxyPlan: { removed: number; freedBytes: number; scanned: number; totalBytes: number } | null = null;
  try {
    plan = await planRemotePostRemoval(db, options);
    // 方針の表示にも同じ接続を使う（サーバーの共有接続を開かないため）
    policyScope = await getFtsIndexScope(db);
    policyAnnounce = await getRemoteAnnouncePolicy(db);

    // ⑥ 画像プロキシのキャッシュ: まず削除予定だけ数える
    if (args.proxyCache) {
      const ttlStored = parseInt(await readSetting(db, 'image_proxy_ttl_days'), 10);
      const ttlDays = Number.isFinite(ttlStored) && ttlStored > 0 ? ttlStored : config.imageProxyTtlDays;
      const maxStored = parseInt(await readSetting(db, 'image_proxy_max_mb'), 10);
      const maxMb = Number.isFinite(maxStored) && maxStored > 0 ? maxStored : config.imageProxyMaxMb;
      proxyPlan = pruneProxyCacheOn(conn, dbPath, ttlDays, maxMb * 1024 * 1024, false);
    }
  } finally {
    conn.close();
  }

  console.log('■ 現在のサイズ');
  console.log(`  DB 本体: ${formatBytes(before.dbBytes)} / WAL: ${formatBytes(before.walBytes)} / 合計: ${formatBytes(before.dbBytes + before.walBytes)}`);
  console.log(`  ページ: ${before.pageCount} (空き ${before.freelistCount}) × ${before.pageSize} バイト`);
  console.log('');
  console.log('■ ⑤ 保存・索引の方針（設定値）');
  console.log(`  FTS 索引スコープ: ${policyScope} / リモートブースト: ${policyAnnounce}`);
  console.log('  （既存データへの適用は --apply 時に実行されます。管理画面から変更できます）');
  console.log('');
  console.log('■ ① リモート投稿の削除予定');
  console.log(`  削除対象: ${plan.total} 件（保持期間によるもの ${plan.byAge} 件 / 件数上限によるもの ${plan.byCount} 件）`);
  console.log(`  残す投稿: ${plan.kept} 件`);
  for (const [reason, count] of Object.entries(plan.keptByReason)) {
    if (count > 0) console.log(`    ・${reason} で保持: ${count} 件`);
  }
  if (proxyPlan) {
    console.log('');
    console.log('■ ⑥ 画像プロキシのキャッシュ');
    console.log(`  保持: ${proxyPlan.scanned} 件 / ${formatBytes(proxyPlan.totalBytes)}`);
    console.log(`  削除予定: ${proxyPlan.removed} 件 / ${formatBytes(proxyPlan.freedBytes)}（期限切れ・容量超過）`);
  }
  console.log('');

  if (args.backupOnly) {
    const started = Date.now();
    console.log('④ VACUUM INTO でバックアップを作成しています...');
    const { backupDatabase, rotateBackups } = await import('../server/src/dbMaintenance.js');
    const conn = openMaintenanceDb(dbPath);
    try {
      const result = backupDatabase(conn, dbPath, backupDir);
      const removed = rotateBackups(backupDir, args.backupsKeep ?? 3);
      console.log(`   バックアップ: ${result.path} (${formatBytes(result.bytes)})`);
      if (removed.length > 0) console.log(`   古い世代を削除: ${removed.join(', ')}`);
      console.log(`✅ 完了 (${((Date.now() - started) / 1000).toFixed(1)} 秒)`);
      return 0;
    } catch (err: any) {
      console.error(`❌ バックアップに失敗しました: ${err?.message || err}`);
      return 1;
    } finally {
      conn.close();
    }
  }

  const report = await runMaintenance({
    dbPath,
    uploadsDir,
    backupDir,
    options,
    apply: args.apply,
    backup: args.backup,
    vacuum: args.vacuum,
    backupsKeep: args.backupsKeep ?? 3,
    remoteStorageConfigured,
    pruneProxyCache: args.proxyCache,
    log: (line) => console.log(line),
  });

  console.log('');
  console.log('■ ② 孤立メディア（uploads/ 内）');
  console.log(`  走査: ${report.media.scannedFiles} ファイル (${formatBytes(report.media.scannedBytes)}) / 参照あり: ${report.media.referencedFiles}`);
  console.log(`  孤立: ${report.media.orphanFiles} ファイル (${formatBytes(report.media.orphanBytes)})`);
  if (report.media.skippedYoung > 0) console.log(`  新しすぎるため見送り: ${report.media.skippedYoung} ファイル（24時間以内）`);
  for (const sample of report.media.samples) console.log(`    ・${sample}`);
  if (report.media.remoteStorageNote) {
    console.log('  ※ S3/R2 などのリモート保存先のオブジェクトは対象外です（uploads/ のみ）');
  }
  console.log('');

  if (args.apply) {
    console.log('■ ① 削除結果');
    const r = report.removed;
    console.log(`  投稿: ${r.posts} 件 / FTS 索引: ${r.fts} 件`);
    console.log(`  リアクション: ${r.reactions} 件 / ブースト: ${r.announces} 件 / 通知: ${r.notifications} 件`);
    console.log(`  ブックマーク: ${r.bookmarks} 件 / アンケート: ${r.polls} 件`);
    console.log('');
    if (report.policy) {
      console.log('■ ⑤ 保存・索引の方針を適用');
      console.log(`  FTS 索引スコープ: ${report.policy.fts.scope}（索引から除外 ${report.policy.fts.toUnindex} 件 / 追加 ${report.policy.fts.toIndex} 件 / 残り ${report.policy.fts.ftsRowsAfter} 行）`);
      console.log(`  リモートブースト: ${report.policy.announces.policy}（削除 ${report.policy.announces.toRemove} 件 / 残り ${report.policy.announces.remaining} 件）`);
      console.log('');
    }
    if (report.optimize) {
      console.log('■ ③ FTS マージ + wal_checkpoint + VACUUM');
      console.log(
        `  FTS マージ: ${report.optimize.ftsOptimized ? '完了' : '対象なし'} / ` +
          `チェックポイント: ${report.optimize.checkpointed ? '完了' : '失敗'} / VACUUM: ${report.optimize.vacuumed ? '完了' : '失敗'}`,
      );
      if (report.optimize.lockedHint) {
        console.log('  ⚠️ サーバーが起動中のため VACUUM できませんでした。サーバーを停止して再実行してください。');
      } else if (report.optimize.error) {
        console.log(`  ⚠️ ${report.optimize.error}`);
      }
      console.log('');
    }
    if (report.backup) {
      console.log('■ ④ バックアップ');
      console.log(`  ${report.backup.path} (${formatBytes(report.backup.bytes)})`);
      if (report.backup.removed.length > 0) console.log(`  古い世代を削除: ${report.backup.removed.join(', ')}`);
      console.log('');
    }
    console.log('■ 結果');
    console.log(`  前: ${formatBytes(report.before.dbBytes + report.before.walBytes)} (DB ${formatBytes(report.before.dbBytes)} + WAL ${formatBytes(report.before.walBytes)})`);
    console.log(`  後: ${formatBytes(report.after.dbBytes + report.after.walBytes)} (DB ${formatBytes(report.after.dbBytes)} + WAL ${formatBytes(report.after.walBytes)})`);
    const saved = report.before.dbBytes + report.before.walBytes - (report.after.dbBytes + report.after.walBytes);
    console.log(`  削減: ${formatBytes(Math.max(0, saved))}`);
  } else {
    console.log('■ ドライラン結果');
    console.log(`  ${plan.total} 件の投稿と ${report.media.orphanFiles} ファイルが削除されます。`);
    console.log('  実行するには --apply を付けてください: npm run db:maintenance -- --apply');
  }
  console.log(`  所要時間: ${(report.elapsedMs / 1000).toFixed(1)} 秒`);
  console.log('');

  // VACUUM がロックで失敗した場合のみ異常終了（cron などで気付けるように）
  if (args.apply && report.optimize && !report.optimize.vacuumed && report.optimize.lockedHint) return 2;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('❌ 予期しないエラー:', err);
    process.exit(1);
  });
