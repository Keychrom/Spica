/**
 * 「非同期化した関数を await し忘れていないか」を静的に洗い出す補助スクリプト。
 *
 *   npx tsx scripts/check-await.ts            # server/src + scripts を走査
 *   npx tsx scripts/check-await.ts --verbose  # 除外した行も出す
 *
 * 対象のファイルで `export async function X` / `export const X = async` を集め、
 * 呼び出し側が await / return / void / yield / .then のどれも付けずに呼んでいたら報告する。
 *
 * なぜ必要か: `res.json({ settings: getInstanceInfo() })` のように Promise が
 * そのまま値として流れても tsc は通ってしまう（await 忘れは実行時にしか見えない）。
 * 移行中に実際に 8 箇所の付け忘れが見つかったので、目視の代わりに常時使う。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT_DIR, 'server', 'src');
const SCRIPTS_DIR = path.join(ROOT_DIR, 'scripts');
const VERBOSE = process.argv.includes('--verbose');

/** await が付いていなくても問題ない文脈（コールバックとして渡す・配列に積むだけ） */
const ACCEPTABLE_CONTEXTS = [
  /Promise\.(all|allSettled|race|any)\s*\(/,
  /\.(then|catch|finally)\s*\(/,
  /=>\s*$/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const allFiles = [...walk(SRC_DIR), ...walk(SCRIPTS_DIR)];

/** ファイルごとの「非同期で export されている関数名」 */
const asyncExports = new Map<string, Set<string>>();
for (const file of allFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const names = new Set<string>();
  for (const re of [
    /export\s+async\s+function\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*async/g,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) names.add(m[1]);
  }
  if (names.size > 0) asyncExports.set(file, names);
}

const problems: string[] = [];

for (const file of allFiles) {
  const rel = path.relative(ROOT_DIR, file).replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

  // 呼び出し元ファイルが import している非同期関数だけを対象にする（同名の別物を拾わない）
  const text = lines.join('\n');
  const candidates = new Set<string>();
  for (const [owner, names] of asyncExports) {
    const sameFile = owner === file;
    if (!sameFile) {
      const ownerModule = './' + path.relative(path.dirname(file), owner).replace(/\\/g, '/').replace(/\.ts$/, '.js');
      if (!text.includes(ownerModule) && !text.includes(path.basename(owner, '.ts') + '.js')) continue;
    }
    for (const n of names) if (new RegExp(`(?<![A-Za-z0-9_$.])${n}\\s*\\(`).test(text)) candidates.add(n);
  }
  if (candidates.size === 0) continue;

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    for (const name of candidates) {
      if (!new RegExp(`(?<![A-Za-z0-9_$.])${name}\\s*\\(`).test(line)) continue;
      // 宣言・定義そのものは除く
      if (new RegExp(`(function|interface|type|const|let|var)\\s+${name}\\b`).test(line)) continue;
      // 代入して後で await する形（= の右側）も除く（const r = foo(); ... await r）
      if (new RegExp(`=\\s*${name}\\s*\\(`).test(line)) continue;
      // await / return / void / yield が付いている
      if (new RegExp(`(await|return|void|yield)\\s+${name}\\s*\\(`).test(trimmed)) continue;
      if (ACCEPTABLE_CONTEXTS.some((re) => re.test(line))) {
        if (VERBOSE) problems.push(`(除外) ${rel}:${i + 1}: ${trimmed}`);
        continue;
      }
      problems.push(`${rel}:${i + 1}: ${trimmed}`);
      break;
    }
  });
}

const real = problems.filter((p) => !p.startsWith('(除外)'));
if (real.length === 0) {
  console.log(`✅ await の付け忘れらしき箇所はありません（対象: ${asyncExports.size} ファイルの非同期 export）`);
} else {
  console.log(`⚠️  await が無い呼び出しが ${real.length} 箇所あります（誤検出も含むので目視で確認）:`);
  for (const p of problems) console.log(`   ${p}`);
}
