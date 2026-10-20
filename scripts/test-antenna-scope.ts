import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';

/**
 * アンテナの取得範囲の検査
 *
 *  - src='home' は「自分 + 承認済みのフォロー先」だけ（フォローしていないローカルを含めない）
 *  - src='users' で対象が空なら**何も拾わない**（条件が無くなって全投稿に一致しない）
 *  - src='users' の対象指定（@付き・複数）が効く
 */
const ROOT = process.cwd();
const TEST_DB = 'data_test_antenna_scope.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3538;
const BASE = `http://localhost:${PORT}`;
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

async function exec(sql: string, ...params: any[]): Promise<void> {
  const conn = USE_PG
    ? createAsyncDatabase({ driver: 'postgres', connectionString: process.env.TEST_DATABASE_URL as string })
    : createAsyncDatabase({ driver: 'sqlite', dbPath: path.join(ROOT, 'server', TEST_DB) });
  try {
    await conn.prepare(sql).run(...params);
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
  try {
    await assertPortFree(PORT);
    server = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.join(ROOT, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.join(ROOT, 'server', TEST_DB),
        INSTANCE_NAME: 'Antenna Scope Test',
        RATE_LIMIT_DISABLED: 'true',
      },
      stdio: 'pipe',
      shell: true,
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    if (!(await waitForServer(`${BASE}/api/server-info`))) throw new Error('サーバー起動失敗');

    const register = async (id: string): Promise<string> => {
      const res = await api('POST', '/api/auth/register', undefined, { id, name: id, agreedToRules: true });
      if (!res.data?.sessionToken) throw new Error(`${id} の登録失敗: ${JSON.stringify(res.data)}`);
      return res.data.sessionToken as string;
    };
    const alice = await register('alice');
    const bob = await register('bob');
    const carol = await register('carol');

    check('alice は carol をフォローできる', (await api('POST', '/api/follow', alice, { targetHandle: `@carol@localhost:${PORT}` })).status, 200);
    const post = async (token: string, content: string): Promise<void> => {
      const res = await api('POST', '/api/posts', token, { content, visibility: 'public' });
      if (res.status !== 201) throw new Error(`投稿作成失敗: ${JSON.stringify(res.data)}`);
    };
    await post(alice, 'alice home post');
    await post(bob, 'bob local post');
    await post(carol, 'carol followed post');

    // 承認待ちのリモートフォロー + その投稿（home に入ってはいけない）
    await exec(
      `INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
       VALUES (?, ?, ?, ?, 0, 'pending', ?)`,
      'alice->remote-pending',
      `${BASE}/users/alice`,
      'https://remote.test/users/pending',
      'https://remote.test/users/pending/inbox',
      new Date().toISOString(),
    );
    await exec(
      `INSERT INTO posts (id, user_id, author_name, author_url, author_handle, content, is_local, visibility, published_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'public', ?)`,
      'https://remote.test/notes/pending-1',
      'https://remote.test/users/pending',
      'pending',
      'https://remote.test/users/pending',
      '@pending@remote.test',
      'remote pending post',
      new Date().toISOString(),
    );

    const createAntenna = async (name: string, src: string, userList = ''): Promise<string> => {
      const res = await api('POST', '/api/antennas', alice, { name, src, user_list: userList });
      if (res.status !== 201 || !res.data?.id) throw new Error(`アンテナ作成失敗: ${JSON.stringify(res.data)}`);
      return res.data.id as string;
    };
    const contents = async (id: string): Promise<string[]> => {
      const res = await api('GET', `/api/antennas/${encodeURIComponent(id)}/timeline?limit=50`, alice);
      if (res.status !== 200) throw new Error(`タイムライン取得失敗: ${res.status} ${JSON.stringify(res.data)}`);
      return ((res.data?.posts || []) as any[]).map((p) => String(p.content));
    };

    console.log('\n🏠 [1] home は自分 + 承認済みのフォロー先だけ');
    const homeId = await createAntenna('Home', 'home');
    const home = await contents(homeId);
    check('自分の投稿は入る', home.includes('alice home post'), true);
    check('フォロー中の carol は入る', home.includes('carol followed post'), true);
    check('フォローしていないローカルの bob は入らない', home.includes('bob local post'), false);
    check('承認待ちのリモートは入らない', home.includes('remote pending post'), false);

    console.log('\n👤 [2] 指定した人');
    const bobId = await createAntenna('BobOnly', 'users', '@bob');
    const bobPosts = await contents(bobId);
    check('bob の投稿だけ入る', bobPosts, ['bob local post']);

    const emptyId = await createAntenna('EmptyUsers', 'users', '');
    check('対象が空なら何も拾わない', await contents(emptyId), []);

    const bothId = await createAntenna('Both', 'users', 'bob, carol');
    const both = await contents(bothId);
    check('複数指定できる（bob）', both.includes('bob local post'), true);
    check('複数指定できる（carol）', both.includes('carol followed post'), true);
    check('指定外（alice）は入らない', both.includes('alice home post'), false);
  } catch (err) {
    console.error('❌ テスト失敗:', err);
    failed++;
  } finally {
    if (server?.pid) {
      try { spawnSync('taskkill', ['/pid', String(server.pid), '/f', '/t'], { shell: true, timeout: 10000 }); } catch {}
    }
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
