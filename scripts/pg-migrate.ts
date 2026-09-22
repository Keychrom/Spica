/**
 * SQLite から PostgreSQL へデータを移送する (`npm run db:pg:migrate`)
 *
 * ノードごと DB を移すための道具。エクスポート/インポート（ユーザー単位のアーカイブ）では
 * ノードの全データは移らないため、テーブル単位で移送する。
 *
 *   npm run db:pg:migrate -- --from server/data_astrabit.sqlite --dsn "$DATABASE_URL" --verify
 *
 * 動き:
 *   ・外部キーの依存順にテーブルを処理する（参照される側が先）
 *   ・1 万件ずつバッチ INSERT。`ON CONFLICT DO NOTHING` なので中断・再実行しても壊れない
 *   ・`--verify` でテーブルごとの行数と内容（順序に依存しない要約）を突き合わせる
 *
 * オプション:
 *   --from PATH   移送元の SQLite（既定: .env の DB_PATH）
 *   --dsn DSN     移送先の PostgreSQL（既定: DATABASE_URL）
 *   --batch N     1 バッチの行数（既定 1000。パラメータ上限に合わせて自動で調整）
 *   --tables a,b  指定したテーブルだけ移送する
 *   --skip a,b    指定したテーブルを除く
 *   --truncate    移送前に移送先のテーブルを空にする（TRUNCATE ... CASCADE）
 *   --verify      移送後に検証する
 *   --dry-run     移送せず対象と件数だけ表示する
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from 'pg';
import { loadSqliteObjects, orderTablesByFk, coerceValue, digestRow, configurePgTypes } from './pg-shared.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** PostgreSQL の 1 文あたりのパラメータ上限は 65535。余裕を見て 60000 に収める */
const MAX_PARAMS = 60000;

interface Args {
  from?: string;
  dsn?: string;
  batch: number;
  tables?: string[];
  skip?: string[];
  truncate: boolean;
  verify: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const list = (flag: string): string[] | undefined => {
    const raw = value(flag);
    return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  };
  return {
    from: value('--from'),
    dsn: value('--dsn') ?? process.env.DATABASE_URL,
    batch: (() => {
      const parsed = parseInt(value('--batch') ?? '1000', 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
    })(),
    tables: list('--tables'),
    skip: list('--skip'),
    truncate: argv.includes('--truncate'),
    verify: argv.includes('--verify'),
    dryRun: argv.includes('--dry-run'),
  };
}

function maskDsn(dsn: string): string {
  return dsn.replace(/:[^:@/]+@/, ':***@');
}

interface TableSpec {
  name: string;
  columns: string[];
  pk: string[];
  pgTypes: string[];
}

/** SQLite 側の列と主キーを調べる */
function sqliteTableSpec(db: DatabaseSync, name: string): { columns: string[]; pk: string[] } {
  const info = db.prepare(`PRAGMA table_info("${name}")`).all() as unknown as { name: string; pk: number }[];
  return {
    columns: info.map((row) => row.name),
    pk: info.filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk).map((row) => row.name),
  };
}

/** PostgreSQL 側の列型を調べる */
async function pgColumnTypes(client: Client, table: string): Promise<Map<string, string>> {
  const result = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Map(result.rows.map((row: any) => [row.column_name, String(row.data_type)]));
}

async function pgRowCount(client: Client, table: string): Promise<number> {
  const result = await client.query(`SELECT COUNT(*)::bigint AS c FROM "${table}"`);
  return Number(result.rows[0].c);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const fromPath = args.from
    ? path.resolve(args.from)
    : path.resolve(ROOT_DIR, 'server', process.env.DB_PATH || 'data_astrabit.sqlite');
  if (!fs.existsSync(fromPath)) {
    console.error(`❌ 移送元の SQLite が見つかりません: ${fromPath}`);
    return 66;
  }
  if (!args.dsn && !args.dryRun) {
    console.error('❌ 移送先がありません。DATABASE_URL を設定するか --dsn で指定してください。');
    return 64;
  }

  const objects = loadSqliteObjects(fromPath);
  const { ordered, cycles } = orderTablesByFk(objects);
  let tableNames = ordered.map((t) => t.name);
  if (args.tables) {
    const wanted = new Set(args.tables);
    tableNames = tableNames.filter((name) => wanted.has(name));
  }
  if (args.skip) {
    const skipped = new Set(args.skip);
    tableNames = tableNames.filter((name) => !skipped.has(name));
  }
  if (cycles.length > 0) {
    console.warn(`⚠️  外部キーが循環しています（この順で処理）: ${cycles.join(', ')}`);
  }

  console.log('==========================================================');
  console.log(' SQLite → PostgreSQL データ移送');
  console.log('==========================================================');
  console.log(`移送元: ${fromPath}`);
  console.log(`移送先: ${args.dsn ? maskDsn(args.dsn) : '(ドライラン)'}`);
  console.log(`テーブル: ${tableNames.length} / バッチ ${args.batch} 行`);
  console.log('');

  const sqlite = new DatabaseSync(fromPath);
  sqlite.exec('PRAGMA busy_timeout = 10000');

  const plans: TableSpec[] = [];
  for (const name of tableNames) {
    const { columns, pk } = sqliteTableSpec(sqlite, name);
    plans.push({ name, columns, pk, pgTypes: [] });
  }

  if (args.dryRun) {
    let total = 0;
    for (const plan of plans) {
      const count = Number((sqlite.prepare(`SELECT COUNT(*) AS c FROM "${plan.name}"`).get() as any).c);
      total += count;
      console.log(`  ${plan.name}: ${count.toLocaleString()} 行`);
    }
    console.log('');
    console.log(`合計 ${total.toLocaleString()} 行（ドライラン: 移送していません）`);
    sqlite.close();
    return 0;
  }

  const client = new Client({ connectionString: args.dsn });
  configurePgTypes();
  await client.connect();
  const started = Date.now();

  try {
    await client.query('BEGIN');
    let movedRows = 0;

    for (const plan of plans) {
      const typeMap = await pgColumnTypes(client, plan.name);
      if (typeMap.size === 0) {
        console.warn(`⚠️  ${plan.name}: 移送先にテーブルがありません（npm run db:pg:init を先に実行）。スキップします。`);
        continue;
      }
      // 実データの SQLite には、いまの migrations には無い列が残っていることがある
      // （手で足した・昔のバージョンの名残）。移送先に無い列はコピーできないので、
      // 「両方にある列」だけを移送し、差分は警告として出す。
      const sqliteOnly = plan.columns.filter((column) => !typeMap.has(column));
      const pgOnly = Array.from(typeMap.keys()).filter((column) => !plan.columns.includes(column));
      if (sqliteOnly.length > 0) {
        console.warn(
          `⚠️  ${plan.name}: SQLite にしか無い列をスキップします: ${sqliteOnly.join(', ')}` +
            '（コードから使われていなければ影響はありません。使うなら db.ts の migrations に足してください）',
        );
      }
      if (pgOnly.length > 0) {
        console.log(`   ℹ️  ${plan.name}: PostgreSQL にしか無い列（既定値で埋まります）: ${pgOnly.join(', ')}`);
      }
      plan.columns = plan.columns.filter((column) => typeMap.has(column));
      plan.pgTypes = plan.columns.map((column) => typeMap.get(column) ?? 'TEXT');

      if (args.truncate) {
        await client.query(`TRUNCATE TABLE "${plan.name}" CASCADE`);
      }

      const rowsPerBatch = Math.max(1, Math.min(args.batch, Math.floor(MAX_PARAMS / Math.max(1, plan.columns.length))));
      const columnList = plan.columns.map((c) => `"${c}"`).join(', ');
      const sqliteCount = Number((sqlite.prepare(`SELECT COUNT(*) AS c FROM "${plan.name}"`).get() as any).c);
      const orderBy = plan.pk.length > 0 ? plan.pk.map((c) => `"${c}"`).join(', ') : 'rowid';
      const select = sqlite.prepare(`SELECT ${plan.columns.map((c) => `"${c}"`).join(', ')} FROM "${plan.name}" ORDER BY ${orderBy} LIMIT ? OFFSET ?`);

      let offset = 0;
      let inserted = 0;
      while (offset < sqliteCount) {
        const batch = select.all(rowsPerBatch, offset) as unknown as Record<string, unknown>[];
        if (batch.length === 0) break;

        const params: unknown[] = [];
        const tuples: string[] = [];
        for (const row of batch) {
          const placeholders: string[] = [];
          for (let i = 0; i < plan.columns.length; i++) {
            params.push(coerceValue(plan.pgTypes[i], row[plan.columns[i]]));
            placeholders.push(`$${params.length}`);
          }
          tuples.push(`(${placeholders.join(', ')})`);
        }

        const sql = `INSERT INTO "${plan.name}" (${columnList}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`;
        const result = await client.query(sql, params as any[]);
        inserted += result.rowCount ?? 0;
        offset += batch.length;

        if (sqliteCount > 20000 && offset % (rowsPerBatch * 10) === 0) {
          console.log(`    ${plan.name}: ${offset.toLocaleString()} / ${sqliteCount.toLocaleString()} 行...`);
        }
      }

      movedRows += inserted;
      const pgCount = await pgRowCount(client, plan.name);
      const mark = pgCount === sqliteCount ? '✅' : '⚠️';
      console.log(`  ${mark} ${plan.name}: ${inserted.toLocaleString()} 行を投入（SQLite ${sqliteCount.toLocaleString()} / PostgreSQL ${pgCount.toLocaleString()}）`);
    }

    await client.query('COMMIT');
    console.log('');
    console.log(`✅ 移送完了: ${movedRows.toLocaleString()} 行（${((Date.now() - started) / 1000).toFixed(1)} 秒）`);

    if (args.verify) {
      console.log('');
      console.log('■ 検証（行数と内容の要約を突き合わせ）');
      let mismatches = 0;
      for (const plan of plans) {
        const typeMap = await pgColumnTypes(client, plan.name);
        if (typeMap.size === 0) continue;
        if (plan.columns.length === 0) continue;

        const sqliteCount = Number((sqlite.prepare(`SELECT COUNT(*) AS c FROM "${plan.name}"`).get() as any).c);
        const pgCount = await pgRowCount(client, plan.name);

        // 内容の要約: 行ごとの md5 を XOR と加算でまとめる（順序に依存しない）
        const digest = async (side: 'sqlite' | 'pg'): Promise<string> => {
          let xor = Buffer.alloc(16);
          let sum = 0n;
          const batchSize = 5000;
          let offset = 0;
          const orderBy = plan.pk.length > 0 ? plan.pk.map((c) => `"${c}"`).join(', ') : null;

          while (true) {
            let rows: Record<string, unknown>[];
            if (side === 'sqlite') {
              const select = sqlite.prepare(
                `SELECT ${plan.columns.map((c) => `"${c}"`).join(', ')} FROM "${plan.name}" ${orderBy ? `ORDER BY ${orderBy}` : ''} LIMIT ? OFFSET ?`,
              );
              rows = select.all(batchSize, offset) as unknown as Record<string, unknown>[];
            } else {
              const result = await client.query(
                `SELECT ${plan.columns.map((c) => `"${c}"`).join(', ')} FROM "${plan.name}" ${orderBy ? `ORDER BY ${orderBy}` : ''} LIMIT $1 OFFSET $2`,
                [batchSize, offset],
              );
              rows = result.rows;
            }
            if (rows.length === 0) break;
            for (const row of rows) {
              const rowDigest = Buffer.from(digestRow(plan.columns, row, crypto), 'hex');
              for (let i = 0; i < 16; i++) xor[i] ^= rowDigest[i];
              sum += BigInt(`0x${rowDigest.subarray(0, 8).toString('hex')}`);
            }
            offset += rows.length;
            if (rows.length < batchSize) break;
          }
          return `${xor.toString('hex')}:${sum.toString(16)}`;
        };

        const sqliteDigest = await digest('sqlite');
        const pgDigest = await digest('pg');
        const ok = sqliteCount === pgCount && sqliteDigest === pgDigest;
        if (!ok) mismatches++;
        console.log(
          `  ${ok ? '✅' : '❌'} ${plan.name}: ${sqliteCount.toLocaleString()} 行 / 要約 ${sqliteDigest.slice(0, 12)}…` +
            (ok ? '' : ` → PostgreSQL ${pgCount.toLocaleString()} 行 / ${pgDigest.slice(0, 12)}…`),
        );
      }
      console.log('');
      if (mismatches === 0) {
        console.log('✅ すべてのテーブルで行数と内容の要約が一致しました');
      } else {
        console.error(`❌ ${mismatches} テーブルで不一致があります`);
        return 1;
      }
    }

    return 0;
  } catch (err: any) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('❌ 移送に失敗しました:', err?.message || err);
    if (err?.detail) console.error('   detail:', err.detail);
    if (err?.where) console.error('   where:', err.where);
    return 1;
  } finally {
    await client.end();
    sqlite.close();
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('❌ 予期しないエラー:', err);
  process.exit(1);
});
