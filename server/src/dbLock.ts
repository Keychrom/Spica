import { db } from './db.js';

/**
 * DB を使った排他ロック（Redis が無いときの代わり）。
 *
 * `runExclusively` は Redis があるときは Redis のロックを使うが、無いときは
 * 「常に実行」にフォールバックしていた。そのため Redis を入れずに複数プロセスで
 * 動かすと、**予約投稿が二重に公開される**（静かに壊れるので気づきにくい）。
 *
 * ここでは DB の 1 行をロックとして使う:
 *   - `INSERT` で取る（すでに行があれば、期限切れのときだけ UPDATE で奪う）
 *   - 取った側だけが `expires_at` を延長できる（`owner` が一致するときだけ更新する）
 *   - 解放は `owner` が一致するときだけ消す（他人のロックを消さない）
 *
 * 期限（TTL）があるので、持ったまま落ちたプロセスのロックは自然に失効する。
 * PostgreSQL では `ON CONFLICT DO NOTHING/DO UPDATE`、SQLite では UNIQUE 制約で同じ意味になる。
 */

/** ロックの取り方の結果 */
export interface DbLockHandle {
  /** 取れたか */
  acquired: boolean;
  /** 自分を表す識別子（取れたときだけ入る。期限の延長に使う） */
  owner?: string;
  /** 取れたときに呼ぶと解放する（取れなかったときは何もしない） */
  release: () => Promise<void>;
}

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS app_locks (
    key TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    acquired_at TEXT NOT NULL
  );
`;

let tableReady: Promise<void> | null = null;

/** テーブルを用意する（起動直後でも安全なように 1 度だけ） */
function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = db
      .exec(TABLE_DDL)
      .catch((err) => {
        // 作れなかったら次回もう一度試す
        tableReady = null;
        throw err;
      });
  }
  return tableReady;
}

/**
 * ロックを取る（取れなければ `acquired: false`）。
 *
 * @param key ロックの名前（例 'scheduler'）
 * @param ttlMs 期限。持ったまま落ちたときに、この時間で自動的に失効する
 */
export async function acquireDbLock(key: string, ttlMs: number): Promise<DbLockHandle> {
  const owner = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const noop = async (): Promise<void> => {};

  try {
    await ensureTable();

    // 1. 新規に行を作る。
    //    PostgreSQL では素の INSERT が `ON CONFLICT DO NOTHING` に翻訳されるので changes=0、
    //    SQLite では UNIQUE 制約で例外になる。**どちらも「すでにある」なので 2 へ進む**。
    let inserted = false;
    try {
      const result = await db
        .prepare('INSERT INTO app_locks (key, owner, expires_at, acquired_at) VALUES (?, ?, ?, ?)')
        .run(key, owner, expiresAt, now.toISOString());
      inserted = Number(result.changes ?? 0) === 1;
    } catch {
      inserted = false;
    }
    if (inserted) return { acquired: true, owner, release: () => releaseDbLock(key, owner) };

    // 2. 期限切れなら奪う（「期限が切れている」ことも条件に入れる＝条件付き UPDATE）
    const taken = await db
      .prepare('UPDATE app_locks SET owner = ?, expires_at = ?, acquired_at = ? WHERE key = ? AND expires_at <= ?')
      .run(owner, expiresAt, now.toISOString(), key, now.toISOString());
    if (Number(taken.changes ?? 0) !== 1) {
      return { acquired: false, release: noop };
    }
    return { acquired: true, owner, release: () => releaseDbLock(key, owner) };
  } catch (err) {
    // DB が使えないときは「取れなかった」に倒す（二重実行より、動かない方がまし）
    console.warn('[DbLock] ロックの取得に失敗:', (err as any)?.message || err);
    return { acquired: false, release: noop };
  }
}

/**
 * ロックを取って `fn` を実行する（取れなければ何もせず false）。
 * 実行中は期限を延ばし続けるので、`ttlMs` より長い処理でも途中で奪われない。
 */
export async function withDbLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ ran: boolean; result?: T }> {
  const lock = await acquireDbLock(key, ttlMs);
  if (!lock.acquired) return { ran: false };

  // 実行が長引いても TTL が切れないように延ばし続ける
  const renew = setInterval(() => {
    void extendDbLock(key, lock.owner ?? '', ttlMs);
  }, Math.max(Math.floor(ttlMs / 3), 1000));
  renew.unref?.();

  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    clearInterval(renew);
    await lock.release();
  }
}

/** 自分が持っているロックの期限を延ばす（長い処理の途中で呼ぶ） */
export async function extendDbLock(key: string, owner: string, ttlMs: number): Promise<void> {
  try {
    await db
      .prepare('UPDATE app_locks SET expires_at = ? WHERE key = ? AND owner = ?')
      .run(new Date(Date.now() + ttlMs).toISOString(), key, owner);
  } catch {
    // 延長に失敗しても TTL で失効するだけ
  }
}

/** ロックを解放する（自分が持っているときだけ消す） */
async function releaseDbLock(key: string, owner: string): Promise<void> {
  try {
    await db.prepare('DELETE FROM app_locks WHERE key = ? AND owner = ?').run(key, owner);
  } catch {
    // 消せなくても TTL で失効する
  }
}

/** 検査用: いまロックを誰が持っているか */
export async function getDbLockOwner(key: string): Promise<string | null> {
  try {
    await ensureTable();
    const row = (await db.prepare('SELECT owner FROM app_locks WHERE key = ?').get(key)) as { owner: string } | undefined;
    return row?.owner ?? null;
  } catch {
    return null;
  }
}
