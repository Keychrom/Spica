import { db } from './db.js';

/**
 * ワードフィルター（ミュートワード）
 *
 * ユーザーごとに登録したキーワードを含む投稿を、タイムラインなどから除外する。
 * 一致判定は本文と CW（閲覧注意）の両方を対象にする。
 */

export interface MutedWord {
  id: string;
  keyword: string;
  case_sensitive: number;
  whole_word: number;
}

// キーワードごとの正規表現をキャッシュする（毎回コンパイルしない）
const regexCache = new Map<string, RegExp>();

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegex(word: MutedWord): RegExp | null {
  const cacheKey = `${word.keyword}|${word.case_sensitive}|${word.whole_word}`;
  const cached = regexCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const keyword = word.keyword?.trim();
  if (!keyword) {
    return null;
  }

  const escaped = escapeRegExp(keyword);
  // whole_word の場合は ASCII の英数字境界で判定する（日本語には境界が無いため前後を見ない）
  const pattern = word.whole_word === 1
    ? `(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`
    : escaped;

  try {
    const regex = new RegExp(pattern, word.case_sensitive === 1 ? 'u' : 'iu');
    if (regexCache.size > 2000) {
      regexCache.clear();
    }
    regexCache.set(cacheKey, regex);
    return regex;
  } catch {
    // 不正なパターンは無視する
    return null;
  }
}

/**
 * 指定ユーザーが登録しているミュートワードを取得する。
 *
 * タイムライン 1 回ごとに引く（＝利用者ごとに毎回 1 本）ので、**30 秒だけ覚える**。
 * 追加・削除のときは `invalidateMutedWords()` で捨てるので、自分の設定はすぐ効く
 * （他のプロセスは TTL ぶん待つ。ドメインブロックのルールと同じ扱い）。
 */
const MUTED_WORDS_TTL_MS = 30_000;
const mutedWordsCache = new Map<string, { at: number; words: MutedWord[] }>();

/** ミュートワードのキャッシュを捨てる（追加・削除の直後に呼ぶ） */
export function invalidateMutedWords(userId?: string): void {
  if (!userId) {
    mutedWordsCache.clear();
    return;
  }
  mutedWordsCache.delete(userId);
}

export async function getMutedWords(userId: string | null | undefined): Promise<MutedWord[]> {
  if (!userId) {
    return [];
  }
  const cached = mutedWordsCache.get(userId);
  if (cached && Date.now() - cached.at < MUTED_WORDS_TTL_MS) {
    return cached.words;
  }
  try {
    const words = (await db
      .prepare('SELECT id, keyword, case_sensitive, whole_word FROM muted_words WHERE user_id = ?')
      .all(userId)) as unknown as MutedWord[];
    // 覚える数にも上限を置く（管理者が大量の利用者を抱えても増え続けないように）
    if (mutedWordsCache.size >= 1000) mutedWordsCache.clear();
    mutedWordsCache.set(userId, { at: Date.now(), words });
    return words;
  } catch {
    return [];
  }
}

/** 本文（および CW）がいずれかのミュートワードに一致するか */
export function matchesMutedWords(text: string, words: MutedWord[]): boolean {
  if (!text || words.length === 0) {
    return false;
  }
  for (const word of words) {
    const regex = buildRegex(word);
    if (regex && regex.test(text)) {
      return true;
    }
  }
  return false;
}

/** 投稿（本文 + CW）がミュートワードに一致するか */
export function postMatchesMutedWords(
  post: { content?: string | null; cw?: string | null },
  words: MutedWord[],
): boolean {
  if (words.length === 0) {
    return false;
  }
  const target = `${post.content || ''}\n${post.cw || ''}`;
  return matchesMutedWords(target, words);
}
