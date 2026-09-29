/**
 * ルートハンドラの**未処理の Promise 拒否**を静的に洗い出す検査。
 *
 * Express 4 は async ハンドラの戻り値（Promise）を見ない。ハンドラの中で
 * `try` の外で await が reject すると、どこにも拾われず `unhandledRejection` になる
 * （Node の既定はプロセス終了 = サーバー全停止）。守る方法は 2 つだけ:
 *
 *   1. `asyncHandler(...)` で包む（Express のエラーハンドラへ流す）
 *   2. ハンドラ本体の await をすべて try/catch の中に入れる
 *
 * この検査は「どちらも満たしていない async ハンドラ」を報告する。構文木で見るので、
 * 行の並びに依存しない（`await` が try の中にあるかどうかを字句で判定する）。
 *
 * 使い方: npx tsx scripts/check-route-errors.ts     （違反があれば終了コード 1）
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve('server/src');
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'use']);

interface Violation {
  file: string;
  line: number;
  text: string;
  reason: string;
}

const violations: Violation[] = [];

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** ルーター登録の呼び出しか（`xxxRouter.get(...)` / `router.use(...)`） */
function isRouterCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!ROUTE_METHODS.has(callee.name.text)) return false;
  const target = callee.expression.getText();
  return /(^|\.)router$/i.test(target) || /Router$/.test(target);
}

/** async 関数の中の await が、すべて try ブロックで囲まれているか */
function allAwaitsGuarded(fn: ts.FunctionLikeDeclaration): boolean {
  let guarded = true;
  const visit = (node: ts.Node, insideTry: boolean): void => {
    if (!guarded) return;
    // 関数が入れ子になっていたら、その中の await は別の責任（呼び出し側が受け取る）なので見ない
    if (node !== fn && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node))) {
      return;
    }
    if (ts.isAwaitExpression(node) && !insideTry) {
      guarded = false;
      return;
    }
    const nextInsideTry =
      insideTry || (ts.isTryStatement(node.parent ?? node) && (node.parent as ts.TryStatement).tryBlock === node);
    ts.forEachChild(node, (child) => visit(child, nextInsideTry));
  };
  if (fn.body && ts.isBlock(fn.body)) ts.forEachChild(fn.body, (child) => visit(child, false));
  return guarded;
}

for (const file of collectFiles(ROOT)) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);
  const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isRouterCall(node)) {
      for (const arg of node.arguments) {
        if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) continue;
        if (!arg.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) continue;
        // asyncHandler(...) で包まれていれば安全（親が asyncHandler 呼び出し）
        const parent = arg.parent;
        const wrapped =
          parent && ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'asyncHandler';
        if (wrapped) continue;
        if (allAwaitsGuarded(arg)) continue;
        const { line } = source.getLineAndCharacterOfPosition(arg.getStart(source));
        violations.push({
          file: rel,
          line: line + 1,
          text: node.expression.getText() + ' ' + arg.getText().slice(0, 60).replace(/\s+/g, ' ') + '…',
          reason: 'try の外に await があり、asyncHandler でも包まれていない',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (violations.length === 0) {
  console.log('✅ ルートハンドラの例外処理: 未処理の Promise 拒否になりうるハンドラはありません');
  process.exit(0);
}

console.error(`❌ 未処理の Promise 拒否になりうるルートハンドラ: ${violations.length} 件`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${v.reason}`);
  console.error(`    ${v.text}`);
}
console.error('\n  直し方: asyncHandler(async (req, res) => { ... }) で包むか、await を try/catch の中へ入れる。');
process.exit(1);
