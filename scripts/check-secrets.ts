/**
 * コミット前の秘密情報スキャン (`npm run check:secrets`)
 *
 * gitleaks 等の外部バイナリを入れずに、このリポジトリで実際に扱う秘密だけを
 * 対象にした軽量スキャナです。目的は「公開ツリー (D:/Spica) に秘密を入れない」
 * ことなので、対象は次の 2 種類に絞っています。
 *
 *   1. 追跡されているファイルの中身に現れる資格情報
 *      （秘密鍵・アクセスキー・セッショントークン・パスワード代入など）
 *   2. 追跡されている「そもそも秘密が入っているファイル」
 *      （.env / *.sqlite / *-master.txt / *.pem など）
 *
 * 使い方:
 *   npm run check:secrets              … 追跡ファイルを走査（未追跡は無視）
 *   npm run check:secrets -- --all     … 作業ツリー全体を走査（1 と 2 の両方）
 *   npm run check:secrets -- --staged  … git のステージ済み差分だけを走査
 *
 * 終了コード: 0 = 問題なし / 1 = 検出あり（コミットを止める）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 走査から外すディレクトリ（追跡されていても中身は見ない） */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.vite', 'coverage',
  'data', 'uploads', 'backups', 'logs', 'vendor',
]);

/** 走査対象から外す拡張子（バイナリ・巨大ファイル） */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.svg',
  '.mp4', '.webm', '.mov', '.mp3', '.ogg', '.wav', '.m4a',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.zip', '.gz', '.tgz',
  '.pdf', '.wasm', '.map', '.lock',
]);

/** 1 ファイルあたりの走査上限（これを超えるものは中身を見ない） */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface Finding {
  file: string;
  line: number;
  rule: string;
  /** 検出した文字列（マスク済み） */
  excerpt: string;
  hint: string;
}

/** 秘密の「代入」を検出するためのキー名 */
const SECRET_KEYS = [
  'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID',
  'SECRET_ACCESS_KEY', 'ACCESS_KEY_ID', 'SECRET_KEY', 'API_KEY', 'APIKEY',
  'SMTP_PASS', 'SMTP_PASSWORD', 'SMTP_USER', 'MAIL_PASSWORD',
  'MASTER_KEY', 'ADMIN_KEY', 'SESSION_SECRET', 'JWT_SECRET', 'ENCRYPTION_KEY',
  'DB_PASSWORD', 'DATABASE_URL', 'REDIS_URL', 'REDIS_PASSWORD', 'PRIVATE_KEY', 'VAPID_PRIVATE_KEY',
];

/** プレースホルダ（これらが値なら検出しない） */
const PLACEHOLDER_RE = /^(?:x+|\*+|\.+|-+|<[^>]*>|\$\{[^}]*\}|your[-_ ]|change[-_]?me|placeholder|example|dummy|sample|test|none|null|undefined|true|false|yes|no|todo|ここに|未設定|ダミー|例)/i;

/**
 * 例示用の接続文字列かどうか（ドキュメントや .env.example のサンプル）。
 * ホストが例示用（localhost / 127.0.0.1 / example.com / host など）で、
 * かつパスワード部分がプレースホルダ語のときだけ「例示」とみなす。
 * どちらか一方でも本物らしければ検出対象のまま（実パスワードを見逃さない）。
 */
function isExampleConnectionString(value: string): boolean {
  // scheme 付き（postgres://…）と、パターン検出が拾う scheme 無し（//…）の両方を受ける。
  // ユーザー名は省略可（`redis://:password@host` の形があるため）
  const match = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^:@/]*):([^@]*)@(.+)$/i.exec(value);
  if (!match) return false;
  const password = match[2];
  const host = match[3].split('/')[0].replace(/^\[|\]$/g, '').split(':')[0].toLowerCase();
  const exampleHosts = new Set(['localhost', '127.0.0.1', '::1', 'example.com', 'host', 'hostname', 'db', 'postgres', 'database']);
  const exampleHost = exampleHosts.has(host) || host.endsWith('.example.com') || host.endsWith('.local');
  // プレースホルダのパスワード。日本語のドキュメントでは「パスワード」と書くことが多い
  const examplePassword = /^(password|pass|passwd|your[-_ ]?password|change[-_]?me|secret|placeholder|x+|\.{2,}|…+|パスワード|ぱすわーど|\$\{[^}]*\})$/i.test(password);
  return exampleHost && examplePassword;
}

/**
 * 値が「参照」かどうか（秘密そのものではなく、別の場所から読んでいるだけ）。
 *
 * 環境変数の展開（`$DATABASE_URL` / `${DATABASE_URL}` / `$(cat ...)`）、
 * コードからの読み出し（`process.env.X` / `import.meta.env.X`）、
 * 設定ファイルの参照（`{{ ... }}`）は、ファイル自体に秘密が入っていないので検出しない。
 * 実値が書かれていれば参照の形にならないため、ここで見逃すことはない。
 */
function isReferenceValue(value: string): boolean {
  if (
    /^(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]*\}|\$\(|<[^>]*>|\{\{[^}]*\}\}|process\.env\.|import\.meta\.env\.|Deno\.env|os\.environ)/.test(value)
  ) {
    return true;
  }
  // 関数呼び出しも「参照」として扱う（`DATABASE_URL: buildDsn(host, port)` のように、
  // 実値がソース上に無い形）。値の抽出が引数の途中で切れることがあるので、
  // 閉じ括弧は無くてもよい。ただし**呼び出しの中に文字列リテラルがある場合は除く**:
  // `atob('c2VjcmV0')` のように、秘密そのものが書かれている可能性があるため
  return /^[A-Za-z_$][A-Za-z0-9_$.]*\s*\([^'"]*\)?$/.test(value);
}

/** 値が URL になるキー（認証情報が無ければ秘密ではないので、下の緩和を使う） */
const URL_VALUED_KEYS = new Set(['DATABASE_URL', 'REDIS_URL', 'TEST_DATABASE_URL', 'TEST_REDIS_URL']);

/**
 * 認証情報を含まない URL かどうか（`redis://127.0.0.1:6379` のような形）。
 * 接続先そのものは秘密ではない（パスワードがあれば `user:pass@host` の形で入るので、
 * そのときは今までどおり検出する）。
 */
function isCredentialFreeUrl(value: string): boolean {
  const authority = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*/i.exec(value);
  if (!authority) return false;
  return !authority[0].includes('@');
}

/** 検出ルール本体 */
interface Rule {
  id: string;
  re: RegExp;
  hint: string;
  /** 値が代入されている場合のみ検出したいルールで使う（キー名 → 値の抽出） */
  keyed?: boolean;
}

const RULES: Rule[] = [
  {
    id: 'private-key',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/,
    hint: '秘密鍵そのものです。公開ツリーには絶対に入れないでください（SN-SNS 側でのみ保持）。',
  },
  {
    id: 'spica-session-token',
    re: /spica_sess_[0-9a-f]{16,}/,
    hint: 'Spica のセッショントークンです。漏れると成りすましが可能になります。無効化して再ログインしてください。',
  },
  {
    id: 'spica-api-key',
    re: /spica_sk_[0-9a-f]{16,}/,
    hint: 'Spica の API キーです。管理画面から該当キーを失効させてください。',
  },
  {
    id: 'aws-access-key-id',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    hint: 'AWS / S3 互換のアクセスキー ID です。キーをローテーションしてください。',
  },
  {
    id: 'github-token',
    re: /\b(?:ghp|gho|ghs|ghr|ghu)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    hint: 'GitHub のトークンです。GitHub 側で失効させてください。',
  },
  {
    id: 'slack-token',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    hint: 'Slack のトークンです。Slack 側で失効させてください。',
  },
  {
    id: 'openai-key',
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
    hint: 'API キーらしき文字列です。該当サービスのキーを失効させてください。',
  },
  {
    id: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    hint: 'JWT（トークン）らしき文字列です。公開ツリーに入れないでください。',
  },
  {
    id: 'basic-auth-url',
    re: /\/\/[A-Za-z0-9._%-]{3,}:[^\s/@'"]{6,}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    hint: 'URL に認証情報が埋め込まれています（scheme://user:pass@host）。',
  },
];

/** 値の代入から検出するルール（.env 形式・TS/JS の代入・YAML など） */
function keyedRule(line: string): { key: string; value: string } | null {
  for (const key of SECRET_KEYS) {
    // KEY=value / KEY: value / KEY = "value" / "KEY": "value"
    const re = new RegExp(
      `["']?\\b${key}\\b["']?\\s*[:=]\\s*(?:"([^"\\n]*)"|'([^'\\n]*)'|\`([^\`\\n]*)\`|([^\\s,;#}]+))`,
      'i',
    );
    const m = re.exec(line);
    if (m) {
      const value = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
      return { key, value };
    }
  }
  return null;
}

/** 追跡されているファイルに含まれる「秘密が入ったファイル」のパターン */
const SECRET_FILE_RULES: { id: string; re: RegExp; hint: string }[] = [
  {
    id: 'dotenv-file',
    re: /(^|\/)\.env(\..+)?$/,
    hint: '.env は秘密の入れ物です。追跡してはいけません（.env.example のみ可）。',
  },
  {
    id: 'sqlite-file',
    re: /\.(sqlite3?|db|db3|sqlite-wal|sqlite-shm)$/i,
    hint: 'SQLite にはサーバー設定（server_settings）やユーザー情報が入ります。追跡しないでください。',
  },
  {
    id: 'master-key-file',
    re: /(^|\/)[^/]*-master\.txt$/i,
    hint: 'マスターキーの控えです。公開ツリーに含めないでください。',
  },
  {
    id: 'key-material',
    re: /\.(pem|key|p12|pfx|jks|keystore)$/i,
    hint: '鍵素材です。公開ツリーに含めないでください。',
  },
  {
    id: 'backup-archive',
    re: /(\.backup|\.bak|\.sql\.gz|\.sqlite\.bak)$/i,
    hint: 'バックアップには秘密が丸ごと入っています。追跡しないでください。',
  },
];

const ALLOWED_SECRET_FILES = new Set(['.env.example', 'env.example', '.env.sample']);

/** マスク済みの抜粋を作る（前後 4 文字だけ残す） */
function mask(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 12) return '***';
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
}

function shouldScanFile(relPath: string): boolean {
  const parts = relPath.split('/');
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  if (SKIP_EXT.has(path.extname(relPath).toLowerCase())) return false;
  if (relPath.endsWith('package-lock.json')) return false;
  // ルール定義自身は、ルールの正規表現ソースが自分のルールに一致してしまうため除く
  // （検出テスト側の「偽の秘密」は実行時に組み立てるようにしたので除外しない。
  //   GitHub の push protection が本物と誤判定するのを避けるためでもある）
  if (path.basename(relPath) === 'check-secrets.ts') return false;
  if (path.basename(relPath) === 'LICENSE') return false;
  return true;
}

function isProbablyBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 4096);
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

/** git があればそれを使う（追跡ファイル / ステージ済み / 全ファイル） */
function gitFiles(mode: 'tracked' | 'staged'): string[] | null {
  const args = mode === 'staged'
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
    : ['ls-files', '-z'];
  try {
    const out = execFileSync('git', args, {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], // git が無い場合のエラー出力は黙らせる
    });
    return out.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
  } catch {
    return null;
  }
}

function walk(dir: string, base = ''): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      out.push(...walk(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * .gitignore の簡易マッチャ。
 *
 * git が使えないツリー（開発ツリー）では「コミットされないファイル」を
 * 検出対象から外すために使います。複雑な記法は扱わず、`*` `**` `/` と
 * 否定 (`!`) だけを見ます。公開ツリー（git あり）では git 側の判定を使うので、
 * ここは近似で十分です。
 */
function loadGitignore(dir: string): { re: RegExp; negate: boolean; dirOnly: boolean }[] {
  const file = path.join(dir, '.gitignore');
  if (!fs.existsSync(file)) return [];
  const patterns: { re: RegExp; negate: boolean; dirOnly: boolean }[] = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/') || line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const body = line
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '(?:.*/)?')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    const prefix = anchored ? '^' : '(?:^|.*/)';
    patterns.push({ re: new RegExp(`${prefix}${body}(?:/.*)?$`), negate, dirOnly });
  }
  return patterns;
}

function isIgnored(rel: string, patterns: ReturnType<typeof loadGitignore>): boolean {
  let ignored = false;
  for (const p of patterns) {
    if (p.dirOnly && !rel.includes('/')) continue;
    if (p.re.test(rel)) ignored = !p.negate;
  }
  return ignored;
}

export interface ScanOptions {
  mode?: 'tracked' | 'staged' | 'all';
  /** 空のファイルでも .env などを検出対象にする（既定 true） */
  checkFilenames?: boolean;
  /** .gitignore を無視して全部見る（既定 false） */
  includeIgnored?: boolean;
}

export interface ScanResult {
  filesScanned: number;
  findings: Finding[];
  /** git が使えたか（使えない場合は作業ツリー全体を走査した） */
  usedGit: boolean;
}

export function scanForSecrets(options: ScanOptions = {}): ScanResult {
  const mode = options.mode ?? 'tracked';
  const checkFilenames = options.checkFilenames !== false;

  let files: string[];
  let usedGit = true;
  const ignores = loadGitignore(ROOT_DIR);

  if (mode === 'all') {
    const all = walk(ROOT_DIR);
    files = options.includeIgnored ? all : all.filter((f) => !isIgnored(f, ignores));
    usedGit = false;
  } else {
    const fromGit = gitFiles(mode);
    if (fromGit) {
      files = fromGit;
    } else {
      // git が無い（SN-SNS の開発ツリー等）→ 作業ツリーを走査し、.gitignore を尊重する
      files = walk(ROOT_DIR).filter((f) => !isIgnored(f, ignores));
      usedGit = false;
    }
  }

  const findings: Finding[] = [];
  let filesScanned = 0;

  for (const rel of files) {
    const base = path.basename(rel);

    // ① ファイル名そのものが秘密の入れ物か
    if (checkFilenames && !ALLOWED_SECRET_FILES.has(base)) {
      for (const rule of SECRET_FILE_RULES) {
        if (rule.re.test(rel)) {
          findings.push({ file: rel, line: 0, rule: rule.id, excerpt: rel, hint: rule.hint });
        }
      }
      if (!shouldScanFile(rel)) continue;
    }

    if (!shouldScanFile(rel)) continue;

    const abs = path.join(ROOT_DIR, rel);
    let buf: Buffer;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (isProbablyBinary(buf)) continue;

    filesScanned++;
    const lines = buf.toString('utf8').split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 4000) continue; // 圧縮された 1 行ファイル等

      for (const rule of RULES) {
        const m = rule.re.exec(line);
        if (m) {
          // 例示用（example.com などのホスト + プレースホルダのパスワード）は検出しない。
          // ドキュメントやテストに `postgres://user:password@example.com/...` を書けるようにするため
          if (rule.id === 'basic-auth-url' && isExampleConnectionString(m[0])) continue;
          findings.push({
            file: rel,
            line: i + 1,
            rule: rule.id,
            excerpt: mask(m[0]),
            hint: rule.hint,
          });
        }
      }

      const keyed = keyedRule(line);
      const keyedValue = keyed ? keyed.value.trim() : '';
      // 接続先の URL は、認証情報（user:pass@）が無ければ秘密ではない
      // （ドキュメントに `REDIS_URL=redis://127.0.0.1:6379` と書けるようにする）
      const credentialFreeUrl = keyed !== null
        && URL_VALUED_KEYS.has(keyed.key)
        && isCredentialFreeUrl(keyedValue);
      if (
        keyed
        && keyedValue.length >= 12
        && !PLACEHOLDER_RE.test(keyedValue)
        && !isReferenceValue(keyedValue)
        && !isExampleConnectionString(keyedValue)
        && !credentialFreeUrl
      ) {
        findings.push({
          file: rel,
          line: i + 1,
          rule: 'assigned-secret',
          excerpt: `${keyed.key}=${mask(keyed.value)}`,
          hint: `${keyed.key} に値が直接書かれています。公開ツリーでは .env.example のプレースホルダに留めてください。`,
        });
      }
    }
  }

  return { filesScanned, findings, usedGit };
}

function parseArgs(argv: string[]): ScanOptions & { json: boolean; quiet: boolean } {
  const mode = argv.includes('--all') ? 'all' : argv.includes('--staged') ? 'staged' : 'tracked';
  return {
    mode,
    checkFilenames: !argv.includes('--no-filenames'),
    includeIgnored: argv.includes('--include-ignored'),
    json: argv.includes('--json'),
    quiet: argv.includes('--quiet'),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = scanForSecrets(opts);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.findings.length > 0 ? 1 : 0);
  }

  console.log('🔍 秘密情報スキャン');
  console.log(`   対象: ${opts.mode === 'staged' ? 'ステージ済みの変更' : opts.mode === 'all' ? '作業ツリー全体' : '追跡ファイル'}${result.usedGit ? '（git）' : '（git 無し → ファイル走査）'}`);
  console.log(`   走査したファイル: ${result.filesScanned} 件`);

  if (result.findings.length === 0) {
    console.log('   ✅ 秘密情報は見つかりませんでした。');
    process.exit(0);
  }

  console.log('');
  console.log(`❌ ${result.findings.length} 件の問題が見つかりました:`);
  for (const f of result.findings) {
    const where = f.line > 0 ? `${f.file}:${f.line}` : f.file;
    console.log(`  ・${where}  [${f.rule}]  ${f.excerpt}`);
    console.log(`     ${f.hint}`);
  }
  console.log('');
  console.log('このままコミットすると秘密が公開されます。SN-SNS 側（.env / server_settings）に移してください。');
  process.exit(1);
}

// 直接実行されたときだけ CLI として動く（テストからは scanForSecrets を import する）
const isEntryPoint = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntryPoint) main();
