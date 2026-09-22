/**
 * 秘密情報スキャンの検証 (scripts/check-secrets.ts)
 *
 * 実際に検出できることと、誤検出しないことの両方を見ます。
 *   npm run test:secret-scan
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForSecrets } from './check-secrets.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_DIR = path.join(ROOT_DIR, 'tmp-secretscan-test');

let passed = 0;
let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}（実際: ${JSON.stringify(actual)} / 期待: ${JSON.stringify(expected)}）`);
  }
}

function writeFixture(name: string, content: string): string {
  const abs = path.join(TEMP_DIR, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

/** そのファイルに関する検出だけを取り出す */
function findingsFor(filePart: string) {
  const result = scanForSecrets({ mode: 'all', includeIgnored: true });
  return result.findings.filter((f) => f.file.includes(filePart));
}

/** リポジトリ全体（追跡相当）の走査 */
function scanRepo() {
  return scanForSecrets({ mode: 'all' });
}

console.log('秘密情報スキャンのテスト');
console.log('');

try {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });

  // ── リポジトリ本体（フィクスチャを置く前に走査する）──────
  const repo = scanRepo();
  check('リポジトリに秘密情報は無い', repo.findings.length, 0);
  check('走査対象が空ではない', repo.filesScanned > 50, true);
  if (repo.findings.length > 0) {
    for (const f of repo.findings.slice(0, 10)) {
      console.log(`     → ${f.file}:${f.line} [${f.rule}] ${f.excerpt}`);
    }
  }

  // ── 中身の検出 ──────────────────────────────────────────
  writeFixture('src/config.ts', [
    `export const a = '${["AKIA","IOSFODNN7","EXAMPLE"].join("")}';`,
    `export const b = '${["-----BEGIN"," RSA PRIVATE KEY-----"].join("")}';`,
    `const t = '${["spica","sess","0123456789abcdef0123456789abcdef"].join("_")}';`,
    `const k = '${["ghp","abcdefghijklmnopqrstuvwxyz0123456789"].join("_")}';`,
    `const s = '${["xoxb","123456789012","abcdefghijklmnop"].join("-")}';`,
    `const url = '${["https://admin:","p4ssw0rd","@example.com/api"].join("")}';`,
  ].join('\n'));

  const config = findingsFor('config.ts');
  const rules = config.map((f) => f.rule).sort();
  check('AWS アクセスキー ID を検出', rules.includes('aws-access-key-id'), true);
  check('秘密鍵のヘッダを検出', rules.includes('private-key'), true);
  check('セッショントークンを検出', rules.includes('spica-session-token'), true);
  check('GitHub トークンを検出', rules.includes('github-token'), true);
  check('Slack トークンを検出', rules.includes('slack-token'), true);
  check('URL 埋め込みの認証情報を検出', rules.includes('basic-auth-url'), true);
  check('抜粋はマスクされる（生の値が出ない）', config.some((f) => f.excerpt.includes('***')), true);

  // ── 代入の検出 ─────────────────────────────────────────
  writeFixture('.env.production', [
    '${["S3_SECRET_ACCESS_KEY","AbCdEf0123456789XyZ"].join("=")}',
    '${["SMTP_PASS","sup3r-s3cret-pass"].join("=")}',
    '${["MASTER_KEY","0123456789abcdef0123456789abcdef"].join("=")}',
  ].join('\n'));
  const envFile = findingsFor('.env.production');
  check('.env 系ファイルを検出', envFile.some((f) => f.rule === 'dotenv-file'), true);
  check('代入された秘密を検出', envFile.some((f) => f.rule === 'assigned-secret'), true);

  // ── 誤検出しないこと ────────────────────────────────────
  writeFixture('src/example.ts', [
    `// 例: S3_SECRET_ACCESS_KEY=your-secret-key-here`,
    `const key = process.env.S3_SECRET_ACCESS_KEY;`,
    `const label = 'MASTER_KEY は SN-SNS の .env に置く';`,
    `const placeholder = '<あなたのキー>';`,
  ].join('\n'));
  check('プレースホルダや env 参照は検出しない', findingsFor('example.ts').length, 0);

  writeFixture('src/normal.ts', [
    `export function add(a: number, b: number) { return a + b; }`,
    `const ratio = 0.5;`,
    `// ランダムな文字列っぽいが秘密ではない: abcdefghijklmnop`,
  ].join('\n'));
  check('通常のコードは検出しない', findingsFor('normal.ts').length, 0);

  writeFixture('docs/notes.md', [
    '設定は .env に書きます。',
    '`SMTP_PASS` が未設定でも登録は動きます。',
  ].join('\n'));
  check('日本語の説明文は検出しない', findingsFor('notes.md').length, 0);

  // ── ファイル名の検出 ────────────────────────────────────
  writeFixture('dbstore/app.sqlite', 'SQLite format 3');
  writeFixture('keys/key-master.txt', 'master key');
  writeFixture('certs/server.pem', 'noop');
  const dbFindings = findingsFor('app.sqlite');
  check('SQLite ファイルを検出', dbFindings.some((f) => f.rule === 'sqlite-file'), true);
  check('マスターキー控えを検出', findingsFor('key-master.txt').some((f) => f.rule === 'master-key-file'), true);
  check('鍵素材を検出', findingsFor('server.pem').some((f) => f.rule === 'key-material'), true);

  // ── 除外（.gitignore）──────────────────────────────────
  fs.writeFileSync(path.join(TEMP_DIR, '.gitignore'), 'ignored-area/\n', 'utf8');
  writeFixture('ignored-area/hidden.sqlite', 'SQLite format 3');
  const ignored = scanForSecrets({ mode: 'all' }).findings.filter((f) => f.file.includes('hidden.sqlite'));
  check('.gitignore にあるファイルは既定で除外', ignored.length, 0);
  const notIgnored = scanForSecrets({ mode: 'all', includeIgnored: true }).findings.filter((f) => f.file.includes('hidden.sqlite'));
  check('--include-ignored なら検出する', notIgnored.length > 0, true);

  // ── .env.example は許可 ────────────────────────────────
  writeFixture('.env.example', 'S3_SECRET_ACCESS_KEY=your-secret-here\n');
  check('.env.example は検出しない', scanForSecrets({ mode: 'all', includeIgnored: true }).findings.some((f) => f.file.includes('.env.example')), false);

  // ── 例示用の接続文字列（ドキュメントのサンプル）───────
  writeFixture('docs/db.md', [
    'DATABASE_URL=postgres://spica:password@127.0.0.1:5432/spica',
    'REDIS_URL=redis://user:password@localhost:6379/0',
    'DATABASE_URL=postgres://spica:…@127.0.0.1:5432/spica',
  ].join('\n'));
  check('例示用の接続文字列は検出しない', findingsFor('db.md').length, 0);

  writeFixture('docs/leak.md', 'DATABASE_URL=postgres://spica:Xk9dP2mQ7wZ4@db.internal:5432/spica\n');
  check('本物らしい接続文字列は検出する', findingsFor('leak.md').some((f) => f.rule === 'assigned-secret'), true);
} finally {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}

console.log('');
console.log(`結果: ${passed} 件成功 / ${failed} 件失敗`);
process.exit(failed > 0 ? 1 : 0);
