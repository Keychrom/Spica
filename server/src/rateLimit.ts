import { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

/**
 * インメモリ・レートリミッター（スライディングウィンドウ方式）
 *
 * 目的: 総当たり（ログイン）、スパム投稿、未認証リクエストの flooding を抑える。
 * 依存パッケージを増やさず、単一プロセス前提で完結させる。
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

export function rateLimit(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (config.rateLimitDisabled) {
      return next();
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${options.keyPrefix}:${ip}`;
    const now = Date.now();
    const windowStart = now - options.windowMs;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      buckets.set(key, bucket);
    }

    bucket.hits = bucket.hits.filter((t) => t > windowStart);

    if (bucket.hits.length >= options.max) {
      const retryAfterSec = Math.max(Math.ceil((bucket.hits[0] + options.windowMs - now) / 1000), 1);
      res.setHeader('Retry-After', String(retryAfterSec));
      console.warn(`[RateLimit] 🚦 ${key} が上限に達しました (${options.max}/${options.windowMs}ms)`);
      return res.status(429).json({
        error: options.message || 'リクエストが多すぎます。しばらく待ってからお試しください。',
        retryAfter: retryAfterSec,
      });
    }

    bucket.hits.push(now);
    next();
  };
}

/** テスト用: 現在のバケット数を返す */
export function rateLimitBucketCount(): number {
  return buckets.size;
}
