import { config } from './config.js';
import { isRedisReady, redisGetJson, redisSetJson, redisGetNumber, redisIncr } from './redis.js';

/**
 * タイムラインの読み取りキャッシュ（短い TTL）。
 *
 * ホームタイムラインは「follows への IN 副問い合わせ + 並べ替え + 行ごとの整形」で、
 * 索引では速くならないと分かっている（docs/SCALE.md の実測）。同じ画面を何度も開くので、
 * **組み立て済みの応答をそのまま短時間だけ使い回す**のが効く。
 *
 * - `REDIS_URL` があれば全プロセスで共有（プロセスを増やしてもヒット率が落ちない）
 * - 無ければプロセス内（上限つき・TTL つき）
 * - 鍵はユーザーごとに分ける（リアクション・ブックマーク・投票の状態が混ざらないように）
 * - **投稿・削除・ブースト・フォロー・ブロック・ミュートワード・ドメイン遮断、および
 *   連合からの受信の直後は捨てる**ので、新しい投稿はすぐ見える。TTL だけに頼るのは、
 *   リアクション・ブックマーク・投票のような**その人にしか見えない状態**だけ
 *   （クライアントが楽観的に先に反映する）
 */

interface Entry {
  value: unknown;
  expiresAt: number;
}

const local = new Map<string, Entry>();
/** プロセス内で持つ上限（超えたら古いものから捨てる） */
const LOCAL_MAX_ENTRIES = 300;

/** Redis に置く世代番号の鍵（プロセスをまたぐ無効化に使う） */
const GENERATION_KEY = 'timeline:generation';

/** プロセス内の世代番号（Redis が無いときに使う） */
let memoryGeneration = 0;

let hits = 0;
let misses = 0;
let invalidations = 0;

/** キャッシュを使うか（TTL が 0 なら無効） */
export function isTimelineCacheEnabled(): boolean {
  return config.timelineCacheTtlSec > 0;
}

/**
 * いまの世代番号。Redis があれば**共有の世代**を読み、無ければプロセス内の世代を使う。
 *
 * 読めないとき（Redis が落ちている等）は 0 を返す。その場合も TTL は効くので、
 * 古い値がいつまでも残ることはない。
 */
async function currentGeneration(): Promise<number> {
  if (!isRedisReady()) return memoryGeneration;
  return (await redisGetNumber(GENERATION_KEY)) ?? 0;
}

/** 世代ごとに別の鍵にする（古い世代の値は読まれず、TTL で消える） */
function generationKey(key: string, generation: number): string {
  return generation === 0 ? key : `g${generation}:${key}`;
}

/** キャッシュから取る（無ければ null） */
export async function cacheGet(key: string): Promise<unknown | null> {
  if (!isTimelineCacheEnabled()) return null;

  if (isRedisReady()) {
    const generation = await currentGeneration();
    const value = await redisGetJson(generationKey(key, generation));
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
    const generation = await currentGeneration();
    await redisSetJson(generationKey(key, generation), value, ttlSec);
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

/**
 * キャッシュを捨てる（投稿・削除・ブースト・フォロー・ブロック・ミュートワード・
 * ドメインの遮断/サイレンス、および連合からの受信の直後に呼ぶ）。
 *
 * - Redis あり … 共有の世代番号を進める（**他のプロセスの値も読まれなくなる**。古い鍵は TTL で消える）
 * - Redis なし … プロセス内の Map を空にする
 *
 * まとめずに毎回捨てる。リレーの burst では毎秒数百回捨てることになるが、実測では burst 中の
 * 画面の遅さは**読みの組み立てではなくイベントループの占有**（同期の書き込みと署名検証）が原因で、
 * 捨てる回数をまとめても 197ms → 169ms しか変わらなかった（docs/SCALE.md の受信の burst）。
 * 件数を減らして分かりにくくするより、素直に毎回捨てる。
 *
 * 失敗しても致命的ではない（TTL でいずれ消える）ので、例外は投げない。
 */
export async function invalidateTimelineCache(): Promise<void> {
  if (!isTimelineCacheEnabled()) return;
  invalidations++;

  if (!isRedisReady()) {
    local.clear();
    memoryGeneration++;
    return;
  }

  const next = await redisIncr(GENERATION_KEY);
  if (next === null) {
    // 世代を進められないときは、せめて自分のプロセスぶんは捨てておく
    local.clear();
  }
}

/** いまの状態（`/health` と検査で使う） */
export function getTimelineCacheStats(): {
  enabled: boolean;
  backend: 'redis' | 'memory' | 'off';
  entries: number;
  hits: number;
  misses: number;
  invalidations: number;
} {
  return {
    enabled: isTimelineCacheEnabled(),
    backend: !isTimelineCacheEnabled() ? 'off' : isRedisReady() ? 'redis' : 'memory',
    entries: local.size,
    hits,
    misses,
    invalidations,
  };
}

/** 検査用: プロセス内のキャッシュを空にしてカウンタを戻す */
export function clearTimelineCache(): void {
  local.clear();
  hits = 0;
  misses = 0;
  invalidations = 0;
  memoryGeneration = 0;
}
