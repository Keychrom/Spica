/**
 * ファイルが大きくなりすぎていないかを見る（既定 300 行）。
 *
 *   npm run check:size
 *
 * 大きいファイルは「変更の影響範囲が読めない」原因になる。
 * 超えたら、そのファイルを分割してから先へ進む。
 */
import fs from 'node:fs';
import path from 'node:path';

const LIMIT = Number(process.env.SIZE_LIMIT || 300);
const ROOT = path.resolve(import.meta.dirname, '..');
const TARGETS = ['src'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.mjs']);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const files = TARGETS.flatMap((target) => walk(path.join(ROOT, target)));
const rows = files
  .map((file) => ({ file: path.relative(ROOT, file), lines: fs.readFileSync(file, 'utf8').split('\n').length }))
  .sort((a, b) => b.lines - a.lines);

const over = rows.filter((row) => row.lines > LIMIT);

console.log(`check:size — ${rows.length} ファイル / 上限 ${LIMIT} 行`);
for (const row of rows.slice(0, 8)) {
  console.log(`  ${row.lines > LIMIT ? '✗' : '·'} ${String(row.lines).padStart(5)}  ${row.file}`);
}

if (over.length > 0) {
  console.error(`\n大きすぎるファイルが ${over.length} 件あります（上限 ${LIMIT} 行）:`);
  for (const row of over) console.error(`  ${row.lines} 行  ${row.file}`);
  process.exit(1);
}
console.log('\nOK（上限内）');
