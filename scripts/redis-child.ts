/**
 * Redis 連携の検査で使う**別プロセス**（`scripts/test-redis.ts` から起動される）。
 *
 * 「プロセスをまたいで共有できているか」を確かめるには、本物の別プロセスが要る。
 * この子プロセスは指定された操作を 1 つだけ実行し、結果を JSON 1 行で stdout に出す。
 *
 *   npx tsx scripts/redis-child.ts fallback
 *   npx tsx scripts/redis-child.ts rate <key> <windowMs> <max> <times>
 *   npx tsx scripts/redis-child.ts publish <channel> <payloadJson>
 *   npx tsx scripts/redis-child.ts lock <key> <ttlMs> <holdMs>
 *   npx tsx scripts/redis-child.ts set-setting <key> <value>
 *   npx tsx scripts/redis-child.ts connect
 *
 * 環境変数（親から渡す）: REDIS_URL / REDIS_PREFIX / DB_PATH（set-setting のときだけ使う）
 */
const [command, ...args] = process.argv.slice(2);

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

const redis = await import('../server/src/redis.js');

try {
  switch (command) {
    case 'fallback': {
      // REDIS_URL が空のときの動き（＝今までの動き）を確かめる
      const shared = await redis.consumeSharedRateLimit('child-fallback', 60_000, 5);
      const published = await redis.publishEvent('stream', { k: 'event', e: 'noop', d: null });
      let lockRan = false;
      await redis.runExclusively('child-fallback-lock', 5_000, async () => {
        lockRan = true;
      });
      out({
        configured: redis.isRedisConfigured(),
        ready: redis.isRedisReady(),
        shared,
        published,
        lockRan,
      });
      break;
    }

    case 'rate': {
      const [key, windowMs, max, times] = args;
      await redis.initRedis();
      const results = [];
      for (let i = 0; i < Number(times); i++) {
        results.push(await redis.consumeSharedRateLimit(key, Number(windowMs), Number(max)));
      }
      out({ ready: redis.isRedisReady(), results });
      break;
    }

    case 'publish': {
      const [channel, payload] = args;
      await redis.initRedis();
      const sent = await redis.publishEvent(channel, JSON.parse(payload));
      out({ ready: redis.isRedisReady(), sent });
      break;
    }

    case 'lock': {
      const [key, ttlMs, holdMs] = args;
      await redis.initRedis();
      let ran = false;
      const acquired = await redis.runExclusively(key, Number(ttlMs), async () => {
        ran = true;
        await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
      });
      out({ ready: redis.isRedisReady(), acquired, ran });
      break;
    }

    case 'set-setting': {
      // アプリ本体と同じ経路（setServerSetting）で設定を書き、他プロセスへ通知が飛ぶかを見る
      const [key, value] = args;
      await redis.initRedis();
      const { db, initDatabase, setServerSetting } = await import('../server/src/db.js');
      await initDatabase();
      await setServerSetting(key, value);
      // 通知は fire-and-forget なので、送信が終わるまで少し待つ
      await new Promise((resolve) => setTimeout(resolve, 300));
      await db.close();
      out({ ready: redis.isRedisReady(), ok: true });
      break;
    }

    case 'connect': {
      // 繋がらない URL を渡されたときに、例外を投げずに false を返すか（fail-soft）
      const connected = await redis.initRedis({ timeoutMs: 1500 });
      out({ connected, ready: redis.isRedisReady(), configured: redis.isRedisConfigured() });
      break;
    }

    default:
      out({ error: `unknown command: ${command}` });
      process.exitCode = 2;
  }
} catch (err: any) {
  out({ error: String(err?.message || err) });
  process.exitCode = 1;
} finally {
  await redis.closeRedis().catch(() => {});
}

// 再接続のタイマーが残っているとプロセスが終わらないので、明示的に終わる
process.exit(process.exitCode ?? 0);
