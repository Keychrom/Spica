/**
 * 生成済みスキーマ（SQL テキスト）を読むための小さな道具。
 * サーバー本体（起動時の列の差分埋め）とテストの両方から使う純粋関数だけを置く。
 */

/** 括弧の深さを見ながらトップレベルのカンマで分ける（`DEFAULT ('a,b')` のような値を壊さない） */
export function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * 既存のテーブルに後から足せる列か。
 * `NOT NULL` は DEFAULT が無いと既存行に代入できず失敗するので足さない
 * （そういう列が要るなら、スキーマ側で DEFAULT を付ける）。
 */
export function isAddableColumn(definition: string): boolean {
  const upper = definition.toUpperCase();
  if (/\bNOT\s+NULL\b/.test(upper) && !/\bDEFAULT\b/.test(upper)) return false;
  if (/\bPRIMARY\s+KEY\b/.test(upper)) return false;
  if (/\bGENERATED\b/.test(upper)) return false;
  return true;
}
