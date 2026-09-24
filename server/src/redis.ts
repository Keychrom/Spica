import type { RedisClientType } from 'redis';
import { config } from './config.js';

/**
 * Redis（**任意依存**）の薄い層。
 *
 * `REDIS_URL` が未設定なら**何もしない**。呼び出し側はすべてインメモリ実装にフォールバックし、
 * 動きは今までと変わらない（単一プロセス前提）。設定したときだけ、次の 4 つがプロセスをまたいで
 * 共有され、複数プロセスで動かせるようになる:
 *
 *   1. レートリミッターのカウンタ（`consumeSharedRateLimit`）
 *   2. リアルタイム更新（SSE）のブロードキャスト（`publishEvent` / `subscribeEvent`）
 *   3. サーバー設定の変更通知（他プロセスの設定キャッシュを無効化する）
 *   4. 定期処理の単一実行ロック（`runExclusively`）— 予約投稿の二重公開を防ぐ
 *
 * 方針（S3 / SMTP / ffmpeg と同じ扱い）:
 *   - 起動時に繋がらなくても**ノードは起動する**。警告を出してインメモリで動き続ける
 *   - 個々の操作が失敗しても例外を投げない。呼び出し側がフォールバックできるよう false / null を返す
 *   - 再接続はクライアント（node-redis）に任せる。切れている間は `isRedisReady()` が false になる
 *   - クライアントは**遅延 import**する（使わない環境で依存を読み込まない）
 */

/** レート制限の判定結果（`consumeSharedRateLimit` の戻り値） */
export interface SharedRateLimitResult {
  allowed: boolean;
  /** このウィンドウ内で観測した回数（拒否したときは上限に達した回数） */
  count: number;
  /** 拒否したとき、何秒後に再試行できるか */
  retryAfterSec: number;
}

/** スライディングウィンドウを 1 往復で判定する（カウントと追加の間に他のプロセスが割り込まない） */
const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count >= max then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = 1
  if oldest[2] then
    retry = math.ceil((tonumber(oldest[2]) + window - now) / 1000)
    if retry < 1 then retry = 1 end
  end
  return {0, count, retry}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, count + 1, 0}
`;

/** 自分が取ったロックだけを解放する（TTL 切れで他のプロセスが取ったロックを消さない） */
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

type CommandClient = RedisClientType;
type SubscriberClient = RedisClientType;

let commandClient: CommandClient | null = null;
let subscriberClient: SubscriberClient | null = null;
/** READY 応答を待たずに in-memory で起動する（`REDIS_URL` が空なら最後まで false） */
let ready = false;
let initialized = false;
let closed = false;
/** 購読するチャンネル（再接続のたびに張り直す） */
const subscriptions = new Map<string, Set<(payload: string) => void>>();
/** いま購読中のチャンネル（同じチャンネルを二重に購読しないため） */
const subscribedChannels = new Set<string>();
let lastErrorLoggedAt = 0;

/** 同じ失敗を何度も出さない（Redis が落ちている間、リクエストごとにログが出るのを防ぐ） */
function logError(message: string, err?: any): void {
  const now = Date.now();
  if (now - lastErrorLoggedAt < 30_000) return;
  lastErrorLoggedAt = now;
  console.warn(`[Redis] ⚠️ ${message}${err ? `: ${err?.message || err}` : ''}（インメモリ実装で続けます）`);
}

/** `REDIS_URL` が設定されているか（設定されていても繋がっていないことがある） */
export function isRedisConfigured(): boolean {
  return Boolean(config.redisUrl);
}

/** いま Redis が使えるか。false なら呼び出し側はインメモリ実装を使う */
export function isRedisReady(): boolean {
  return ready;
}

/** 接頭辞つきのキー名（同じ Redis を複数のノードで共有しても衝突しないようにする） */
export function redisKey(suffix: string): string {
  return `${config.redisPrefix}:${suffix}`;
}

/** チャンネル名も同じ接頭辞を使う */
function channelName(suffix: string): string {
  return `${config.redisPrefix}:${suffix}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 接続する。**起動を待たせない**よう、繋がるまで最大 `timeoutMs` だけ待って戻る。
 * 繋がらなくても例外は投げない（呼び出し側は戻り値を見る）。
 */
export async function initRedis(options: { timeoutMs?: number } = {}): Promise<boolean> {
  if (initialized) return ready;
  initialized = true;
  closed = false;
  if (!config.redisUrl) return false;

  let createClient: typeof import('redis').createClient;
  try {
    ({ createClient } = await import('redis'));
  } catch (err) {
    logError('redis パッケージを読み込めませんでした', err);
    return false;
  }

  const clientOptions = {
    url: config.redisUrl,
    // RESP2 で話す。既定の RESP3 は接続時に HELLO を送るため、Redis 5 系では繋がらない
    // （この層で使うコマンドは RESP2 で足りる）
    RESP: 2 as const,
    // 切れている間にコマンドを溜めない（溜めると復帰時にまとめて実行されてしまう）
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 5000,
      // 永久に再試行する（最大 5 秒間隔）。ここで諦めると、あとから Redis を立てても繋がらない
      reconnectStrategy: (retries: number) => Math.min(retries * 200 + 200, 5000),
    },
  } as const;

  try {
    commandClient = createClient(clientOptions as any);
  } catch (err) {
    logError('クライアントを作成できませんでした（URL の形式を確認してください）', err);
    commandClient = null;
    return false;
  }

  commandClient.on('error', (err: any) => logError('接続エラー', err));
  commandClient.on('ready', () => {
    ready = true;
    console.log(`[Redis] ✅ 接続しました（prefix: ${config.redisPrefix}）`);
  });
  commandClient.on('end', () => {
    ready = false;
  });

  const connecting = commandClient.connect().then(
    () => true,
    (err: any) => {
      logError('接続できませんでした', err);
      return false;
    },
  );

  const timeoutMs = options.timeoutMs ?? 3000;
  const connected = await Promise.race([connecting, sleep(timeoutMs).then(() => false)]);
  if (!connected) {
    // 繋がっていなくてもプロセスは起動する。バックグラウンドで再試行が続く
    logError(`接続できませんでした（${timeoutMs}ms 待ちました）`);
  }
  return connected;
}

/** 終了時に接続を閉じる（未接続でも安全） */
export async function closeRedis(): Promise<void> {
  if (closed) return;
  closed = true;
  ready = false;
  for (const client of [subscriberClient, commandClient]) {
    if (!client) continue;
    try {
      if (client.isOpen) await client.quit();
      else await client.disconnect();
    } catch {
      // 終了時は握る
    }
  }
  subscriberClient = null;
  commandClient = null;
}

/**
 * イベントを全プロセスへ配る。戻り値が false のときは**配れていない**ので、
 * 呼び出し側は自プロセスのクライアントへ直接届ける（フォールバック）。
 */
export async function publishEvent(channel: string, payload: unknown): Promise<boolean> {
  if (!ready || !commandClient) return false;
  try {
    await commandClient.publish(channelName(channel), JSON.stringify(payload));
    return true;
  } catch (err) {
    logError('配信に失敗しました', err);
    return false;
  }
}

/**
 * 他プロセスのイベントを受け取る。
 * 同じチャンネルに複数のハンドラを登録できる（呼び出しは登録順）。
 * 購読は接続に紐づくので、接続が張り直されたらやり直す。
 */
export async function subscribeEvent(channel: string, handler: (payload: string) => void): Promise<void> {
  const handlers = subscriptions.get(channel) ?? new Set();
  handlers.add(handler);
  subscriptions.set(channel, handlers);

  // 購読用の接続が既にあれば、そのチャンネルだけを追加で購読する
  if (subscriberClient) {
    await subscribeChannel(subscriberClient, channel);
    return;
  }
  await ensureSubscriber();
}

/** 1 チャンネルを購読する（登録済みのハンドラを全部呼ぶ。二重購読はしない） */
async function subscribeChannel(client: SubscriberClient, channel: string): Promise<void> {
  const handlers = subscriptions.get(channel);
  if (!handlers || handlers.size === 0) return;
  if (subscribedChannels.has(channel)) return;

  try {
    await client.subscribe(channelName(channel), (message: string) => {
      for (const handler of handlers) {
        try {
          handler(message);
        } catch (err) {
          console.warn(`[Redis] イベント処理でエラー (${channel}):`, err);
        }
      }
    });
    subscribedChannels.add(channel);
  } catch (err) {
    logError(`購読に失敗しました (${channel})`, err);
  }
}

/** 登録済みの購読をすべて張り直す（接続時・再接続時） */
async function subscribeAll(client: SubscriberClient): Promise<void> {
  subscribedChannels.clear();
  for (const channel of subscriptions.keys()) {
    await subscribeChannel(client, channel);
  }
}

/** 購読用の接続を用意する（購読モードの接続では通常のコマンドを実行できないので別に持つ） */
async function ensureSubscriber(): Promise<void> {
  if (!ready || !commandClient || closed) return;
  if (subscriberClient) return;

  try {
    subscriberClient = commandClient.duplicate() as SubscriberClient;
  } catch (err) {
    logError('購読用の接続を作成できませんでした', err);
    return;
  }
  subscriberClient.on('error', (err: any) => logError('購読側の接続エラー', err));
  subscriberClient.on('ready', () => {
    // 張り直しのたびに購読をやり直す（前の接続の購読は消えている）
    void subscribeAll(subscriberClient!);
  });
  try {
    await subscriberClient.connect();
  } catch (err) {
    logError('購読用の接続を張れませんでした', err);
    try {
      await subscriberClient.disconnect();
    } catch {
      // 握る
    }
    subscriberClient = null;
  }
}

/**
 * レート制限のカウンタを Redis 上で判定する（スライディングウィンドウ）。
 * Redis が使えないときは null を返すので、呼び出し側はインメモリで判定する。
 */
export async function consumeSharedRateLimit(
  key: string,
  windowMs: number,
  max: number,
): Promise<SharedRateLimitResult | null> {
  if (!ready || !commandClient) return null;
  try {
    const now = Date.now();
    const result = (await commandClient.eval(RATE_LIMIT_SCRIPT, {
      keys: [redisKey(`ratelimit:${key}`)],
      // メンバーは「時刻 + 乱数」。同じミリ秒の複数リクエストが 1 件に潰れないようにする
      arguments: [String(now), String(windowMs), String(max), `${now}-${Math.random().toString(36).slice(2)}`],
    })) as unknown as [number, number, number];

    return {
      allowed: Number(result[0]) === 1,
      count: Number(result[1]),
      retryAfterSec: Number(result[2]),
    };
  } catch (err) {
    logError('レート制限の判定に失敗しました', err);
    return null;
  }
}

/**
 * `key` について「いまは 1 プロセスだけが実行する」ことを保証して `fn` を実行する。
 *
 * Redis が使えないときはそのまま実行する（単一プロセス前提の今までどおりの動き）。
 * 戻り値は「実行したか」（他のプロセスが実行中なら false）。
 */
export async function runExclusively(key: string, ttlMs: number, fn: () => Promise<void>): Promise<boolean> {
  if (!ready || !commandClient) {
    await fn();
    return true;
  }

  const lockKey = redisKey(`lock:${key}`);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let acquired = false;
  try {
    acquired = (await commandClient.set(lockKey, token, { NX: true, PX: ttlMs })) === 'OK';
  } catch (err) {
    logError('ロックの取得に失敗しました', err);
    await fn();
    return true;
  }
  if (!acquired) return false;

  // 実行が長引いたときに TTL が切れて二重実行にならないよう、必要なら延長する
  const renew = setInterval(() => {
    commandClient?.pExpire(lockKey, ttlMs).catch(() => {});
  }, Math.max(Math.floor(ttlMs / 3), 1000));
  renew.unref?.();

  try {
    await fn();
    return true;
  } finally {
    clearInterval(renew);
    try {
      await commandClient?.eval(RELEASE_LOCK_SCRIPT, { keys: [lockKey], arguments: [token] });
    } catch {
      // 解放に失敗しても TTL で消える
    }
  }
}

/** 接続状態の要約（`/health` や検査で使う） */
export function getRedisStatus(): { configured: boolean; ready: boolean; prefix: string } {
  return { configured: isRedisConfigured(), ready, prefix: config.redisPrefix };
}
