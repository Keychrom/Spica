import { config } from './config.js';
import { isRedisReady, redisGetJson, redisSetJson } from './redis.js';

/**
 * タイムラインの読み取りキャッシュ（短い TTL）。
 *
 * ホームタイムラインは「follows への IN 副問い合わせ + 並べ替え + 行ごとの整形」で、
 * 索引では速くならないと分かっている（docs/SCALE.md の実測）。同じ画面を何度も開くので、
 * **組み立て済みの応答をそのまま短時間だけ使い回す**のが効く。
 *
 * - `REDIS_URL` があれば全プロセスで共有（プロセスを増やしてもヒット率が落ちない）
 * - 無ければプロセス内（上限つき・TTL つき）。**どちらも設定しなければ（TTL 0）無効**
 * - 鍵はユーザーごとに分ける（リアクション・ブックマーク・投票の状態が混ざらないように）
 * - 無効化は TTL だけに頼る（投稿直後の見え方が最大 TTL ぶん古くなるのは許容。
 *   自分の投稿はクライアントが手元で先に出す）
 */

interface Entry {
  value: unknown;
  expiresAt: number;
}

const local = new Map<string, Entry>();
/** プロセス内で持つ上限（超えたら古いものから捨てる） */
const LOCAL_MAX_ENTRIES = 300;

let hits = 0;
let misses = 0;

/** キャッシュを使うか（TTL が 0 なら無効） */
export function isTimelineCacheEnabled(): boolean {
  return config.timelineCacheTtlSec > 0;
}

/** キャッシュから取る（無ければ null） */
export async function cacheGet(key: string): Promise<unknown | null> {
  if (!isTimelineCacheEnabled()) return null;

  if (isRedisReady()) {
    const value = await redisGetJson(key);
    if (value !== null && value !== undefined) {
      hits++;
      return value;
    }
    misses++;
    return null;
  }

  const entry = local.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    hits++;
    return entry.value;
  }
  if (entry) local.delete(key);
  misses++;
  return null;
}

/** キャッシュに入れる（Redis が使えなければプロセス内） */
export async function cacheSet(key: string, value: unknown, ttlSec = config.timelineCacheTtlSec): Promise<void> {
  if (!isTimelineCacheEnabled() || ttlSec <= 0) return;

  if (isRedisReady()) {
    await redisSetJson(key, value, ttlSec);
    return;
  }

  // 上限を超えたら期限切れ → 古い順に捨てる（Map は挿入順）
  if (local.size >= LOCAL_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, entry] of local.entries()) {
      if (entry.expiresAt <= now || local.size >= LOCAL_MAX_ENTRIES) local.delete(k);
      if (local.size < LOCAL_MAX_ENTRIES) break;
    }
  }
  local.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
}

/** いまの状態（`/health` と検査で使う） */
export function getTimelineCacheStats(): { enabled: boolean; backend: 'redis' | 'memory' | 'off'; entries: number; hits: number; misses: number } {
  return {
    enabled: isTimelineCacheEnabled(),
    backend: !isTimelineCacheEnabled() ? 'off' : isRedisReady() ? 'redis' : 'memory',
    entries: local.size,
    hits,
    misses,
  };
}

/** 検査用: プロセス内のキャッシュを空にしてカウンタを戻す */
export function clearTimelineCache(): void {
  local.clear();
  hits = 0;
  misses = 0;
}
