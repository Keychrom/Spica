import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

/**
 * 投稿削除の SSE 配信の検査
 *
 *  - フォロワー限定・DM・ローカル限定の投稿を削除しても、delete_post を全クライアントへ配信しない
 *    （以前は DELETE の後に isPublicPost を呼び、行が無い → true で全員に配信していた）
 *  - 公開投稿の削除は従来どおり全クライアントへ delete_post を配信する（対照）
 */
const ROOT = process.cwd();
const TEST_DB = 'data_test_delete_broadcast.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3535;
const BASE = `http://localhost:${PORT}`;

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function assertPortFree(port: number): Promise<void> {
  const inUse = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.setTimeout(2000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
  if (inUse) {
    throw new Error(`ポート ${port} は使用中です。TEST_PORT で空きポートを指定してください。`);
  }
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
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

interface SseEvent { event: string; data: any }
interface SseClient { events: SseEvent[]; close: () => void }

async function openSse(token: string | null): Promise<SseClient> {
  const url = `${BASE}/api/streaming${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const events: SseEvent[] = [];
  void (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          let event = 'message';
          const dataLines: string[] = [];
          for (const line of part.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          let data: any = null;
          try { data = dataLines.length ? JSON.parse(dataLines.join('\n')) : null; } catch {}
          if (event) events.push({ event, data });
        }
      }
    } catch {}
  })();
  return { events, close: () => controller.abort() };
}

function deleteCount(client: SseClient, postId: string): number {
  return client.events.filter((e) => e.event === 'delete_post' && e.data?.postId === postId).length;
}

async function waitFor(fn: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(100);
  }
  return false;
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
        INSTANCE_NAME: 'Delete Broadcast Test',
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
    // 最初の登録者が管理者（DM の有効化に使う）
    const root = await register('root');
    const alice = await register('alice');
    const bob = await register('bob');
    const carol = await register('carol');

    const dmOn = await api('POST', '/api/admin/server-settings', root, { dm_enabled: true });
    check('DM を有効にできる', dmOn.status, 200);

    // bob だけが alice をフォローする
    check(
      'bob は alice をフォローできる',
      (await api('POST', '/api/follow', bob, { targetHandle: `@alice@localhost:${PORT}` })).status,
      200,
    );

    const createPost = async (token: string, content: string, visibility: string): Promise<string> => {
      const res = await api('POST', '/api/posts', token, { content, visibility });
      if (res.status !== 201 || !res.data?.id) throw new Error(`投稿作成失敗: ${JSON.stringify(res.data)}`);
      return res.data.id as string;
    };
    const removePost = (token: string, postId: string): Promise<ApiResult> =>
      api('DELETE', `/api/posts/${encodeURIComponent(postId)}`, token, {});

    const guestSse = await openSse(null);
    const bobSse = await openSse(bob);
    const carolSse = await openSse(carol);
    const clients = [guestSse, bobSse, carolSse];
    await sleep(800);
    check('3 つの SSE が接続できる', clients.every((c) => c.events.some((e) => e.event === 'connected')), true);

    console.log('\n🔒 [1] フォロワー限定の削除は配信しない');
    const followersId = await createPost(alice, '削除するフォロワー限定の投稿', 'followers');
    check('フォロワー限定を削除できる', (await removePost(alice, followersId)).status, 200);
    await sleep(1200);
    check('未ログインに delete_post が届かない', deleteCount(guestSse, followersId), 0);
    check('フォロワーに delete_post が届かない', deleteCount(bobSse, followersId), 0);
    check('第三者に delete_post が届かない', deleteCount(carolSse, followersId), 0);

    console.log('\n✉️ [2] DM の削除は配信しない');
    const dm = await api('POST', '/api/dm/messages', alice, { to: 'bob', content: '削除する DM' });
    check('DM を作れる', dm.status, 201);
    const dmId = String(dm.data?.message?.id || '');
    if (!dmId) throw new Error(`DM の ID が取れません: ${JSON.stringify(dm.data)}`);
    check('DM を削除できる', (await removePost(alice, dmId)).status, 200);
    await sleep(1200);
    check('未ログインに DM の delete_post が届かない', deleteCount(guestSse, dmId), 0);
    check('宛先に DM の delete_post が届かない', deleteCount(bobSse, dmId), 0);
    check('第三者に DM の delete_post が届かない', deleteCount(carolSse, dmId), 0);

    console.log('\n🏠 [3] ローカル限定の削除は配信しない');
    const localId = await createPost(alice, '削除するローカル限定の投稿', 'local');
    check('ローカル限定を削除できる', (await removePost(alice, localId)).status, 200);
    await sleep(1200);
    check('ローカル限定の delete_post は届かない', clients.every((c) => deleteCount(c, localId) === 0), true);

    console.log('\n🌍 [4] 公開投稿の削除は全員に配信する（対照）');
    const publicId = await createPost(alice, '削除する公開投稿', 'public');
    check('公開投稿を削除できる', (await removePost(alice, publicId)).status, 200);
    const delivered = await waitFor(() => clients.every((c) => deleteCount(c, publicId) >= 1));
    check('未ログインに届く', deleteCount(guestSse, publicId) >= 1, true);
    check('フォロワーに届く', deleteCount(bobSse, publicId) >= 1, true);
    check('第三者に届く', deleteCount(carolSse, publicId) >= 1, true);
    check('配信を待てた', delivered, true);

    guestSse.close();
    bobSse.close();
    carolSse.close();
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
