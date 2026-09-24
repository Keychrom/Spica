import { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { consumeSharedRateLimit, isRedisReady } from './redis.js';

/**
 * レートリミッター（スライディングウィンドウ方式）
 *
 * 目的: 総当たり（ログイン）、スパム投稿、未認証リクエストの flooding を抑える。
 *
 * 既定はインメモリ（単一プロセス前提）。`REDIS_URL` を設定するとカウンタを Redis に置き、
 * **全プロセスで共有**する（ロードバランサで振り分けても上限が効くようになる）。
 * Redis が落ちているとき・失敗したときはその場でインメモリの判定にフォールバックするので、
 * レート制限が無効になったり、リクエストが落ちたりはしない。
 *
 * 注意: IP アドレスは `trust proxy` の設定に依存する。リバースプロキシ配下で
 * X-Forwarded-For を詐称されると回避され得るため、あくまで「素朴な flooding を
 * 止めるための第一の壁」として扱い、署名検証などの本来の防御と併用すること。
 */

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

// 古いエントリを定期的に掃除してメモリを一定に保つ
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    bucket.hits = bucket.hits.filter((t) => t > now - 60 * 60 * 1000);
    if (bucket.hits.length === 0) {
      buckets.delete(key);
    }
  }
}, 5 * 60 * 1000).unref?.();

export interface RateLimitOptions {
  /** 観測ウィンドウ（ミリ秒） */
  windowMs: number;
  /** ウィンドウ内で許可する最大リクエスト数 */
  max: number;
  /** バケットを分けるための接頭辞 */
  keyPrefix: string;
  message?: string;
}

/** 判定の結果（インメモリと Redis で同じ形にそろえる） */
interface LimitOutcome {
  allowed: boolean;
  count: number;
  retryAfterSec: number;
}

/** インメモリの判定。Redis 未使用のときと、Redis が失敗したときのフォールバックに使う */
function consumeLocal(key: string, windowMs: number, max: number): LimitOutcome {
  const now = Date.now();
  const windowStart = now - windowMs;

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    buckets.set(key, bucket);
  }

  bucket.hits = bucket.hits.filter((t) => t > windowStart);

  if (bucket.hits.length >= max) {
    return {
      allowed: false,
      count: bucket.hits.length,
      retryAfterSec: Math.max(Math.ceil((bucket.hits[0] + windowMs - now) / 1000), 1),
    };
  }

  bucket.hits.push(now);
  return { allowed: true, count: bucket.hits.length, retryAfterSec: 0 };
}

/** 上限に達したときの応答（429）。呼び出し元はそのまま return する */
function respondTooMany(res: Response, options: RateLimitOptions, key: string, outcome: LimitOutcome): void {
  res.setHeader('Retry-After', String(outcome.retryAfterSec));
  console.warn(
    `[RateLimit] 🚦 ${key} が上限に達しました (${options.max}/${options.windowMs}ms${isRedisReady() ? '・共有カウンタ' : ''})`,
  );
  res.status(429).json({
    error: options.message || 'リクエストが多すぎます。しばらく待ってからお試しください。',
    retryAfter: outcome.retryAfterSec,
  });
}

export function rateLimit(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (config.rateLimitDisabled) {
      return next();
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${options.keyPrefix}:${ip}`;

    // Redis を使っているときはカウンタが共有される（非同期）。
    // 失敗してもリクエストは落とさず、その場はインメモリの判定で続ける。
    if (isRedisReady()) {
      void (async () => {
        let outcome: LimitOutcome;
        try {
          outcome = (await consumeSharedRateLimit(key, options.windowMs, options.max)) ?? consumeLocal(key, options.windowMs, options.max);
        } catch {
          outcome = consumeLocal(key, options.windowMs, options.max);
        }
        if (!outcome.allowed) {
          respondTooMany(res, options, key, outcome);
          return;
        }
        next();
      })().catch(() => {
        // ここに来るのは next() が投げたときだけ。未処理の rejection でプロセスを落とさない
      });
      return;
    }

    const outcome = consumeLocal(key, options.windowMs, options.max);
    if (!outcome.allowed) {
      respondTooMany(res, options, key, outcome);
      return;
    }
    next();
  };
}

/** テスト用: 現在のバケット数を返す */
export function rateLimitBucketCount(): number {
  return buckets.size;
}
