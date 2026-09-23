import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * PostgreSQL のバックアップ（pg_dump）。
 *
 * SQLite は `VACUUM INTO` でアプリ自身がバックアップを取れるが、PostgreSQL には
 * その手段が無いので `pg_dump` を呼ぶ。設計上の約束:
 *
 *   - 認証情報は**環境変数で子プロセスに渡す**。コマンドライン引数に DSN を置くと
 *     `ps` で他のユーザーからパスワードが見えてしまうため（`PGPASSWORD` などを使う）。
 *   - `pg_dump` が無い環境では**失敗させずにスキップ**して警告を出す
 *     （バックアップが無いだけで、ノードの運用は続けられる）。
 *   - `-Fc`（カスタム形式・圧縮）で取り、`pg_restore` で復元する。
 *
 * 手動実行は `npm run db:pg:backup`（scripts/pg-backup.ts）、自動実行は
 * アプリの自動メンテナンス（maintenanceService）から呼ばれる。
 */

export interface PgBackupResult {
  /** 作成したダンプのパス */
  path: string;
  bytes: number;
  /** 世代管理で削除した古いダンプ */
  removed: string[];
}

export interface PgBackupOptions {
  /** 接続文字列（DATABASE_URL）。パスワードを含むが、argv には出さない */
  dsn: string;
  backupDir: string;
  /** 残す世代数（0 以下で無制限） */
  keep?: number;
  /** ダンプに含めるデータベース名の上書き（既定は DSN のパスから） */
  label?: string;
  /** 進捗ログ */
  log?: (line: string) => void;
  /** 1 回のダンプの上限（ミリ秒。既定 10 分） */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** 実行ファイルの名前（Windows は .exe） */
function binaryName(tool: string): string {
  return process.platform === 'win32' ? `${tool}.exe` : tool;
}

/**
 * PostgreSQL のクライアント（pg_dump / pg_restore）の場所を探す。
 *   1. 環境変数 PG_BIN_DIR（例: /usr/lib/postgresql/18/bin）
 *   2. PATH
 *   3. OS ごとの標準的なインストール先
 * 見つからなければ null（呼び出し側はスキップして警告する）。
 */
export function resolvePgBinary(tool: 'pg_dump' | 'pg_restore'): string | null {
  const bin = binaryName(tool);
  const explicit = process.env.PG_BIN_DIR;
  if (explicit) {
    const candidate = path.join(explicit, bin);
    if (fs.existsSync(candidate)) return candidate;
  }

  // PATH 上のものを探す（実際に起動できるかは実行時に分かる）
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) return candidate;
  }

  // 標準的なインストール先
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    for (const root of ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL']) {
      if (!fs.existsSync(root)) continue;
      for (const version of fs.readdirSync(root)) {
        candidates.push(path.join(root, version, 'bin', bin));
      }
    }
  } else {
    candidates.push(`/usr/bin/${bin}`, `/usr/local/bin/${bin}`, `/opt/homebrew/bin/${bin}`);
    // Debian / Ubuntu はバージョン付きのディレクトリに入る
    for (const root of ['/usr/lib/postgresql', '/usr/local/pgsql']) {
      if (!fs.existsSync(root)) continue;
      for (const version of fs.readdirSync(root)) {
        candidates.push(path.join(root, version, 'bin', bin));
      }
    }
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** pg_dump の場所（後方互換の入口） */
export function resolvePgDumpBinary(): string | null {
  return resolvePgBinary('pg_dump');
}

/**
 * pg_dump に渡す引数。**接続情報は含めない**（環境変数で渡す）ので、
 * `ps` で argv を見られてもパスワードは漏れない。テストで検証している。
 */
export function pgDumpArgs(target: string): string[] {
  return ['-Fc', '--no-owner', '--no-privileges', '-f', target];
}

/** 接続文字列を子プロセス用の環境変数に変換する（パスワードを argv に出さない） */
export function pgEnvFromDsn(dsn: string): Record<string, string> {
  const env: Record<string, string> = {};
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error(`DATABASE_URL を解釈できません: ${dsn.replace(/:[^:@/]*@/, ':***@')}`);
  }
  if (url.hostname) env.PGHOST = url.hostname;
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const database = url.pathname.replace(/^\//, '');
  if (database) env.PGDATABASE = decodeURIComponent(database);
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

/** DSN からデータベース名を取り出す（ファイル名に使う） */
function databaseNameOf(dsn: string, fallbackLabel?: string): string {
  if (fallbackLabel) return fallbackLabel;
  try {
    const name = new URL(dsn).pathname.replace(/^\//, '');
    return name ? decodeURIComponent(name) : 'spica';
  } catch {
    return 'spica';
  }
}

/** バックアップファイル名（同じ秒に連続実行しても衝突しないようミリ秒まで入れる） */
function backupFileName(label: string): string {
  const d = new Date();
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
  return `${label}-${stamp}.dump`;
}

/** 古いダンプを残しつつ削除する（既定 3 世代。`rotateBackups` の PG 版） */
export function rotatePgBackups(backupDir: string, keep: number): string[] {
  if (keep <= 0 || !fs.existsSync(backupDir)) return [];
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.endsWith('.dump'))
    .map((f) => ({ f, full: path.join(backupDir, f), mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const removed: string[] = [];
  for (const entry of files.slice(keep)) {
    try {
      fs.unlinkSync(entry.full);
      removed.push(entry.f);
    } catch {
      // 消せなくても致命的ではない
    }
  }
  return removed;
}

/**
 * pg_dump でバックアップを取る。
 * pg_dump が見つからない場合は `null` を返す（呼び出し側は警告して続行する）。
 */
export async function backupPostgresDatabase(options: PgBackupOptions): Promise<PgBackupResult | null> {
  const log = options.log ?? (() => {});
  const binary = resolvePgDumpBinary();
  if (!binary) {
    log('⚠️  pg_dump が見つからないためバックアップをスキップしました。');
    log('    インストールするか、PG_BIN_DIR に pg_dump のあるディレクトリを指定してください。');
    return null;
  }

  fs.mkdirSync(options.backupDir, { recursive: true });
  const label = databaseNameOf(options.dsn, options.label);
  const target = path.join(options.backupDir, backupFileName(label));
  if (fs.existsSync(target)) fs.unlinkSync(target);

  const env = { ...process.env, ...pgEnvFromDsn(options.dsn) };
  const args = pgDumpArgs(target);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { env, windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`pg_dump が ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} 秒で終わらなかったため中断しました`));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();

    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`pg_dump が失敗しました (exit ${code}): ${stderr.trim().split('\n').slice(-3).join(' / ')}`));
    });
  });

  return {
    path: target,
    bytes: fs.statSync(target).size,
    removed: rotatePgBackups(options.backupDir, options.keep ?? 3),
  };
}
