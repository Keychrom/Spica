import { parentPort, workerData } from 'node:worker_threads';
import { Client, types } from 'pg';

/**
 * PostgreSQL ワーカー（同期ファサードのバックエンド）
 *
 * メインスレッドは `Atomics.wait` でブロックして待つため、結果は postMessage ではなく
 * SharedArrayBuffer に書き込んで通知する。接続は 1 本だけ持ち、トランザクション
 * （BEGIN / COMMIT）がそのまま効くようにしている（SQLite と同じ性質）。
 */

// BIGINT(int8) は既定で文字列で返る。Spica の値は 2^53 に収まるので数値に寄せる
types.setTypeParser(20, (value: string | null) => (value === null ? null : Number(value)));
// NUMERIC も同様に（使っていないが、来たら数値にする）
types.setTypeParser(1700, (value: string | null) => (value === null ? null : Number(value)));

interface Request {
  id: number;
  kind: 'query' | 'run' | 'exec' | 'close';
  sql: string;
  params: unknown[];
  buffer: SharedArrayBuffer;
}

interface WorkerData {
  connectionString: string;
}

const port = parentPort;
if (!port) throw new Error('pgWorker は worker thread として起動してください');

const { connectionString } = workerData as WorkerData;
const client = new Client({ connectionString });
let connectError: Error | null = null;
const connecting = client.connect().catch((err: Error) => {
  connectError = err;
});

/** SharedArrayBuffer に結果を書き込む（state: 1=成功 / 2=エラー） */
function write(buffer: SharedArrayBuffer, state: 1 | 2, payload: string): void {
  const header = new Int32Array(buffer, 0, 2);
  const data = new Uint8Array(buffer, 8);
  const bytes = Buffer.from(payload, 'utf8');
  if (bytes.length > data.length) {
    // バッファ不足を伝える（メインスレッドが必要なサイズで再試行する）
    const needed = `RESULT_TOO_LARGE:${bytes.length}`;
    const neededBytes = Buffer.from(needed, 'utf8');
    if (neededBytes.length > data.length) {
      // それすら入らないほど小さいバッファ（通常は起きない）
      const minimal = `RESULT_TOO_LARGE:${bytes.length}`;
      data.set(Buffer.from(minimal, 'utf8').subarray(0, data.length), 0);
      Atomics.store(header, 1, Math.min(minimal.length, data.length));
      Atomics.store(header, 0, 2);
      Atomics.notify(header, 0);
      return;
    }
    data.set(neededBytes, 0);
    Atomics.store(header, 1, neededBytes.length);
    Atomics.store(header, 0, 2);
    Atomics.notify(header, 0);
    return;
  }
  data.set(bytes, 0);
  Atomics.store(header, 1, bytes.length);
  Atomics.store(header, 0, state);
  Atomics.notify(header, 0);
}

/** JSON に載らない値（Buffer / Date / BigInt）を文字列化して運ぶ */
function encodeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return { $buf: value.toString('base64') };
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  return value;
}

function encodeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) out[key] = encodeValue(value);
    return out;
  });
}

port.on('message', async (request: Request) => {
  try {
    await connecting;
    if (connectError) throw connectError;

    switch (request.kind) {
      case 'query': {
        const result = await client.query(request.sql, request.params as any[]);
        write(request.buffer, 1, JSON.stringify(encodeRows(result.rows)));
        return;
      }
      case 'run': {
        const result = await client.query(request.sql, request.params as any[]);
        write(request.buffer, 1, JSON.stringify({ changes: result.rowCount ?? 0 }));
        return;
      }
      case 'exec': {
        // パラメータ無しの複文（DDL など）。simple query で送る
        await client.query(request.sql);
        write(request.buffer, 1, JSON.stringify({ changes: 0 }));
        return;
      }
      case 'close': {
        await client.end().catch(() => {});
        write(request.buffer, 1, JSON.stringify(null));
        // 終了はメインスレッド側の terminate に任せる
        return;
      }
      default:
        throw new Error(`未知のリクエスト種別: ${(request as Request).kind}`);
    }
  } catch (err: any) {
    const message = [err?.message, err?.detail, err?.where].filter(Boolean).join(' / ') || String(err);
    write(request.buffer, 2, message);
  }
});
