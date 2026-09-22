/**
 * PostgreSQL 移植の実サイズを測る (`npm run db:port-report`)
 *
 * Spica のデータ層は `node:sqlite` の同期 API を直接使っている。PostgreSQL へ
 * 移すときに何がどれだけ引っかかるのかを、**SQL リテラルだけを抽出して**数える。
 * 「なんとなく大変」ではなく、どの構文が何箇所あるかを判断材料にするための道具。
 *
 * 素朴にソース全体を正規表現で走査すると、JavaScript の三項演算子の `?`、
 * `str.match(`、`new Date(` まで拾ってしまう。ここでは prepare/exec/get/all/run に
 * 渡している文字列（テンプレートリテラル・引用符）を切り出し、その中だけを見る。
 *
 * 出力:
 *   ・呼び出し箇所の総数（db.prepare / db.exec / トランザクション）
 *   ・SQL リテラルの中に現れる方言依存の構文ごとの件数と代表的なファイル:行
 *   ・作業分類（rewrite = 機械的な置換 / redesign = 設計から変える）
 *
 *   npm run db:port-report            … サマリ
 *   npm run db:port-report -- --list  … 該当箇所を全件表示
 *   npm run db:port-report -- --json  … JSON で出力
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT_DIR, 'server', 'src');

interface Rule {
  id: string;
  kind: 'rewrite' | 'redesign';
  label: string;
  pattern: RegExp;
  note: string;
}

const RULES: Rule[] = [
  {
    id: 'placeholder',
    kind: 'rewrite',
    label: 'プレースホルダ ?',
    pattern: /\?/g,
    note: 'PostgreSQL は $1, $2 形式。機械的に置換できるが全クエリに触る。',
  },
  {
    id: 'fts5',
    kind: 'redesign',
    label: 'FTS5（posts_fts / MATCH）',
    pattern: /posts_fts|\bfts5\b|trigram|\bMATCH\s+['"?]/gi,
    note: '検索基盤そのものの差し替え（pg_trgm / tsvector / 外部検索）が必要。',
  },
  {
    id: 'datetime',
    kind: 'rewrite',
    label: 'datetime() / julianday() / date()',
    pattern: /\b(datetime|julianday|unixepoch)\s*\(|\bdate\s*\(\s*['"?]/gi,
    note: 'PG には無い。比較は TIMESTAMPTZ、計算は interval に置き換える。',
  },
  {
    id: 'pragma',
    kind: 'rewrite',
    label: 'PRAGMA',
    pattern: /\bPRAGMA\b/gi,
    note: 'WAL / busy_timeout / table_info など。PG では設定・カタログ参照に置換。',
  },
  {
    id: 'insert-or',
    kind: 'rewrite',
    label: 'INSERT OR IGNORE / REPLACE',
    pattern: /INSERT\s+OR\s+(IGNORE|REPLACE)/gi,
    note: 'ON CONFLICT DO NOTHING / DO UPDATE へ。REPLACE は競合キーの指定が要る。',
  },
  {
    id: 'vacuum',
    kind: 'redesign',
    label: 'VACUUM / wal_checkpoint',
    pattern: /\b(VACUUM|wal_checkpoint)\b/gi,
    note: 'PG は autovacuum。バックアップは pg_dump / pg_basebackup に置換。',
  },
  {
    id: 'changes',
    kind: 'rewrite',
    label: 'changes / last_insert_rowid',
    pattern: /last_insert_rowid|\bchanges\b/gi,
    note: 'RETURNING 句か rowCount に置換。',
  },
  {
    id: 'sqlite-catalog',
    kind: 'rewrite',
    label: 'sqlite_master / sqlite_ 系',
    pattern: /sqlite_(master|schema|sequence)/gi,
    note: 'information_schema / pg_catalog に置換。',
  },
  {
    id: 'boolean-int',
    kind: 'rewrite',
    label: '真偽値の 0/1 比較',
    pattern: /\b(is_local|is_sensitive|is_read|is_pinned|is_active|email_verified|is_locked|forwarded|is_system|is_remote|is_expired|is_deleted)\s*=\s*[01]\b/g,
    note: 'PG では BOOLEAN か SMALLINT を決めて統一する（現状は INTEGER 0/1）。',
  },
  {
    id: 'autoinc',
    kind: 'rewrite',
    label: 'AUTOINCREMENT / INTEGER PRIMARY KEY',
    pattern: /AUTOINCREMENT|INTEGER\s+PRIMARY\s+KEY/gi,
    note: 'ID はアプリ側採番が中心だが、該当箇所は BIGSERIAL / IDENTITY へ。',
  },
  {
    id: 'temp-table',
    kind: 'rewrite',
    label: '一時テーブル / CREATE TEMP',
    pattern: /CREATE\s+TEMP|temp\./gi,
    note: 'PG の一時表は接続スコープ。トランザクション内での扱いを確認する。',
  },
  {
    id: 'strftime',
    kind: 'rewrite',
    label: 'strftime / to_char 無しの書式',
    pattern: /strftime\s*\(|\bdate_trunc\s*\(|%Y-%m-%d/gi,
    note: 'to_char / date_trunc / INTERVAL に置換。',
  },
  {
    id: 'limit-offset-binding',
    kind: 'rewrite',
    label: 'LIMIT ? / OFFSET ?',
    pattern: /(LIMIT|OFFSET)\s*\?/gi,
    note: 'PG でも LIMIT $n は可能だが、型の推論に CAST が要る場合がある。',
  },
  {
    id: 'group-concat',
    kind: 'rewrite',
    label: 'GROUP_CONCAT',
    pattern: /GROUP_CONCAT\s*\(/gi,
    note: 'string_agg(expr, sep) に置換（引数の順序が違う）。',
  },
  {
    id: 'insert-into-select',
    kind: 'redesign',
    label: 'INSERT INTO ... SELECT（一括移送）',
    pattern: /INSERT\s+INTO\s+\w+[\s\S]{0,120}?SELECT/gi,
    note: 'メンテナンスの一括移送。件数・分割方法を移植時に見直す。',
  },
];

const CALL_PATTERNS = [
  { id: 'prepare', label: 'db.prepare(...)', pattern: /db\.prepare\s*\(/g },
  { id: 'exec', label: 'db.exec(...)', pattern: /db\.exec\s*\(/g },
  { id: 'transaction', label: 'transaction(...) / BEGIN / COMMIT', pattern: /\bBEGIN\b|\bCOMMIT\b/g },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

interface SqlLiteral {
  text: string;
  /** リテラルが始まる行（1 始まり） */
  startLine: number;
}

/**
 * ソースから SQL リテラルを切り出す。
 * prepare/exec/get/all/run/事务 の直後の文字列を対象にする
 * （`db.prepare(\`...\`)` / `db.prepare('...')` / `db.prepare("...")`）。
 */
function extractSqlLiterals(source: string): SqlLiteral[] {
  const literals: SqlLiteral[] = [];
  const callRe = /db\.(?:prepare|exec)\s*\(|\.(?:get|all|run|iterate)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = callRe.exec(source)) !== null) {
    let i = match.index + match[0].length;
    // 空白と改行を飛ばす
    while (i < source.length && /\s/.test(source[i])) i++;
    const quote = source[i];
    if (quote !== '`' && quote !== "'" && quote !== '"') continue;

    const startIndex = i;
    let j = i + 1;
    let text = '';
    while (j < source.length) {
      const ch = source[j];
      if (ch === '\\') {
        text += source[j + 1] ?? '';
        j += 2;
        continue;
      }
      if (quote === '`' && ch === '$' && source[j + 1] === '{') {
        // テンプレートの埋め込みは JS 式なので、SQL としては中身を見ない
        let depth = 1;
        j += 2;
        while (j < source.length && depth > 0) {
          if (source[j] === '{') depth++;
          else if (source[j] === '}') depth--;
          j++;
        }
        text += ' ? ';
        continue;
      }
      if (ch === quote) break;
      text += ch;
      j++;
    }
    if (j >= source.length) continue;

    const startLine = source.slice(0, startIndex).split('\n').length;
    literals.push({ text, startLine });
  }
  return literals;
}

function lineOf(literal: SqlLiteral, offset: number): number {
  return literal.startLine + literal.text.slice(0, offset).split('\n').length - 1;
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function main() {
  const args = process.argv.slice(2);
  const listAll = args.includes('--list');
  const asJson = args.includes('--json');
  const top = (() => {
    const idx = args.indexOf('--top');
    const value = idx >= 0 ? parseInt(args[idx + 1] ?? '5', 10) : 5;
    return Number.isFinite(value) && value > 0 ? value : 5;
  })();

  const files = walk(SRC_DIR);
  const callCounts = new Map<string, number>();
  const findings = new Map<string, Hit[]>();
  const ruleById = new Map(RULES.map((r) => [r.id, r]));
  for (const rule of RULES) findings.set(rule.id, []);

  let sqlLiteralCount = 0;

  for (const abs of files) {
    const rel = path.relative(ROOT_DIR, abs).replace(/\\/g, '/');
    const source = fs.readFileSync(abs, 'utf8');

    for (const call of CALL_PATTERNS) {
      const matches = source.match(call.pattern);
      if (matches) callCounts.set(call.id, (callCounts.get(call.id) ?? 0) + matches.length);
    }

    const literals = extractSqlLiterals(source);
    sqlLiteralCount += literals.length;

    for (const literal of literals) {
      for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rule.pattern.exec(literal.text)) !== null) {
          const line = lineOf(literal, m.index);
          const snippet = literal.text
            .slice(Math.max(0, m.index - 30), m.index + m[0].length + 30)
            .replace(/\s+/g, ' ')
            .trim();
          findings.get(rule.id)!.push({ file: rel, line, text: snippet });
        }
      }
    }
  }

  const totalCalls = Array.from(callCounts.values()).reduce((a, b) => a + b, 0);
  const summary = RULES.map((rule) => {
    const hits = findings.get(rule.id)!;
    const byFile = new Map<string, number>();
    for (const hit of hits) byFile.set(hit.file, (byFile.get(hit.file) ?? 0) + 1);
    return {
      id: rule.id,
      label: rule.label,
      kind: rule.kind,
      count: hits.length,
      note: rule.note,
      files: Array.from(byFile.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, top)
        .map(([file, count]) => ({ file, count })),
      hits: listAll ? hits : hits.slice(0, top),
    };
  }).sort((a, b) => b.count - a.count);

  const rewriteTotal = summary.filter((s) => s.kind === 'rewrite').reduce((a, s) => a + s.count, 0);
  const redesignTotal = summary.filter((s) => s.kind === 'redesign').reduce((a, s) => a + s.count, 0);

  if (asJson) {
    console.log(JSON.stringify({
      scannedFiles: files.length,
      sqlLiterals: sqlLiteralCount,
      callSites: Object.fromEntries(callCounts),
      totalCallSites: totalCalls,
      rewriteHits: rewriteTotal,
      redesignHits: redesignTotal,
      constructs: summary,
    }, null, 2));
    return;
  }

  console.log('==========================================================');
  console.log(' PostgreSQL 移植の実サイズ（server/src の SQL リテラルを走査）');
  console.log('==========================================================');
  console.log(`走査したファイル: ${files.length}`);
  console.log(`SQL リテラル: ${sqlLiteralCount} 本`);
  console.log(`同期 API の呼び出し: ${totalCalls} 箇所`);
  for (const [id, count] of callCounts.entries()) {
    const label = CALL_PATTERNS.find((c) => c.id === id)?.label ?? id;
    console.log(`  ・${label}: ${count}`);
  }
  console.log('');
  console.log('方言依存の構文（SQL リテラル内のみを数える）:');
  console.log(`  分類 rewrite（機械的な置換）: ${rewriteTotal}`);
  console.log(`  分類 redesign（設計から変える）: ${redesignTotal}`);
  console.log('');

  for (const item of summary) {
    if (item.count === 0) continue;
    const mark = item.kind === 'rewrite' ? '🔧' : '🧱';
    console.log(`${mark} ${item.label}: ${item.count}  [${item.kind}]`);
    console.log(`    ${item.note}`);
    console.log(`    多いファイル: ${item.files.map((f) => `${f.file}(${f.count})`).join(', ')}`);
    for (const hit of item.hits) {
      console.log(`      ${hit.file}:${hit.line}  ${hit.text}`);
    }
    console.log('');
  }

  const empty = summary.filter((s) => s.count === 0).map((s) => s.label);
  if (empty.length > 0) console.log(`（該当なし: ${empty.join(' / ')}）`);
  console.log('');
  console.log('※ 設計と手順は docs/POSTGRESQL.md を参照してください。');
  void ruleById;
}

main();
