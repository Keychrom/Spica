import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';

/**
 * リンクプレビューのバックグラウンド再試行
 *
 *  - 初回取得が接続断で失敗すると status='error' を保存し、ジョブを積む
 *  - ジョブは直近の 'error' を無視して取り直す（以前は hasRecentFailure で即 return し、
 *    3 回とも HTTP リクエストを送らずに失敗していた）
 *  - 2 回目で成功したら status='ok' とタイトルが入る
 *
 * 取得先はローカルの HTTP サーバー（ALLOW_PRIVATE_REMOTE_FETCH=true）。
 */
const ROOT = process.cwd();
const TEST_DB = 'data_test_link_preview_retry.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3539;
const TARGET_PORT = PORT + 1;
const BASE = `http://localhost:${PORT}`;
const TARGET = `http://127.0.0.1:${TARGET_PORT}`;
const PAGE_URL = `${TARGET}/page`;
const USE_PG =
  (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'postgres' && Boolean(process.env.TEST_DATABASE_URL);

for (const suffix of ['', '-wal', '-shm']) {
  for (const dir of [ROOT, path.join(ROOT, 'server')]) {
    const file = path.join(dir, `${TEST_DB}${suffix}`);
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
      } catch {
        throw new Error(`テスト DB が使用中です（前回のサーバーが残っています）: ${file}`);
      }
    }
  }
}

async function readPreview(url: string): Promise<{ status?: string; title?: string | null } | null> {
  const conn = USE_PG
    ? createAsyncDatabase({ driver: 'postgres', connectionString: process.env.TEST_DATABASE_URL as string })
    : createAsyncDatabase({ driver: 'sqlite', dbPath: path.join(ROOT, 'server', TEST_DB) });
  try {
    return (await conn.prepare('SELECT status, title FROM link_previews WHERE url = ?').get(url)) as
      | { status?: string; title?: string | null }
      | null;
  } finally {
    await conn.close().catch(() => {});
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ✅ ${name}: ${String(actual)}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}: 期待値 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);
  }
}

async function assertPortFree(port: number): Promise<void> {
  const inUse = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.setTimeout(2000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
  if (inUse) throw new Error(`ポート ${port} は使用中です。TEST_PORT で空きポートを指定してください。`);
}

async function waitForServer(url: string, maxRetries = 50): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

type ApiResult = { status: number; data: any };
async function api(method: string, endpoint: string, token?: string, body?: unknown): Promise<ApiResult> {
  const res = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function run(): Promise<void> {
  let server: ChildProcess | null = null;
  let target: http.Server | null = null;
  let requests = 0;
  try {
    await assertPortFree(PORT);
    await assertPortFree(TARGET_PORT);

    // 1 回目は接続を切る（fetch が例外 → status='error'）。2 回目以降は OGP を返す
    target = http.createServer((req, res) => {
      requests++;
      if (requests === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><meta property="og:title" content="Retry OK"><meta property="og:description" content="second try"></head><body>ok</body></html>');
    });
    await new Promise<void>((resolve) => target!.listen(TARGET_PORT, '127.0.0.1', () => resolve()));

    server = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.join(ROOT, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.join(ROOT, 'server', TEST_DB),
        INSTANCE_NAME: 'Link Preview Retry Test',
        RATE_LIMIT_DISABLED: 'true',
        ALLOW_PRIVATE_REMOTE_FETCH: 'true',
      },
      stdio: 'pipe',
      shell: true,
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    if (!(await waitForServer(`${BASE}/api/server-info`))) throw new Error('サーバー起動失敗');

    const reg = await api('POST', '/api/auth/register', undefined, { id: 'lpuser', name: 'LP', agreedToRules: true });
    const token = String(reg.data?.sessionToken || '');
    if (!token) throw new Error(`登録失敗: ${JSON.stringify(reg.data)}`);

    const created = await api('POST', '/api/posts', token, {
      content: `プレビュー再試行 ${PAGE_URL}`,
      visibility: 'public',
    });
    check('投稿できる', created.status, 201);

    // 初回の失敗（error）と、ジョブの再試行（ok）を待つ
    let preview: { status?: string; title?: string | null } | null = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      preview = await readPreview(PAGE_URL);
      if (preview?.status === 'ok') break;
      await sleep(500);
    }
    check('再試行でプレビューが完成する', preview?.status, 'ok');
    check('タイトルが入る', preview?.title, 'Retry OK');
    check('取得先に 2 回以上リクエストした（初回 + 再試行）', requests >= 2, true);
  } catch (err) {
    console.error('❌ テスト失敗:', err);
    failed++;
  } finally {
    if (server?.pid) {
      try { spawnSync('taskkill', ['/pid', String(server.pid), '/f', '/t'], { shell: true, timeout: 10000 }); } catch {}
    }
    if (target) await new Promise<void>((resolve) => target!.close(() => resolve())).catch(() => {});
    await sleep(500);
    for (const suffix of ['', '-wal', '-shm']) {
      for (const dir of [ROOT, path.join(ROOT, 'server')]) {
        const file = path.join(dir, `${TEST_DB}${suffix}`);
        if (fs.existsSync(file)) {
          try { fs.unlinkSync(file); } catch {}
        }
      }
    }
  }

  console.log('');
  console.log(`結果: ${passed} 件成功 / ${failed} 件失敗`);
  process.exit(failed > 0 ? 1 : 0);
}

void run();
