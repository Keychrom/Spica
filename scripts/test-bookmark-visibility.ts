import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

/**
 * ブックマークの閲覧権限とエクスポートの検査
 *
 *  - 後方互換の POST /api/posts/:id/bookmark も、閲覧できない投稿は 403（以前は素通り）
 *  - フォロワー限定は承認済みフォロワーだけがブックマークできる（両方の入口で）
 *  - DM は送信者だけでなく**宛先**もブックマークできる（recipients を取り忘れると 403 になっていた）
 *  - 第三者（宛先でない）は DM をブックマークできない
 *  - エクスポートの bookmarks は、いま閲覧できる投稿だけを出す
 *    （修正前に不正に作られたブックマーク行が残っていても中身を書き出さない）
 *  - DM は宛先であってもエクスポートに出さない（docs/DM.md）
 */
const ROOT = process.cwd();
const TEST_DB = 'data_test_bookmark_visibility.sqlite';
const SERVER_DB = path.join(ROOT, 'server', TEST_DB);
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3534;
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
    await new Promise((resolve) => setTimeout(resolve, 400));
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

async function run(): Promise<void> {
  let server: ChildProcess | null = null;
  let completed = false;
  try {
    await assertPortFree(PORT);
    server = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.join(ROOT, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: SERVER_DB,
        INSTANCE_NAME: 'Bookmark Visibility Test',
        RATE_LIMIT_DISABLED: 'true',
      },
      stdio: 'pipe',
      shell: true,
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    if (!(await waitForServer(`${BASE}/api/server-info`))) throw new Error('サーバー起動失敗');

    const register = async (id: string): Promise<{ token: string; actorUrl: string }> => {
      const res = await api('POST', '/api/auth/register', undefined, { id, name: id, agreedToRules: true });
      if (!res.data?.sessionToken) throw new Error(`${id} の登録失敗: ${JSON.stringify(res.data)}`);
      return { token: res.data.sessionToken as string, actorUrl: res.data.user?.actorUrl as string };
    };
    // 最初の登録者が管理者になる（DM の有効化に使う）
    const root = await register('root');
    const alice = await register('alice');
    const bob = await register('bob');
    const carol = await register('carol');

    const dmOn = await api('POST', '/api/admin/server-settings', root.token, { dm_enabled: true });
    check('DM を有効にできる', dmOn.status, 200);

    // bob だけが alice をフォローする（フォロワー限定の閲覧権限）
    const follow = await api('POST', '/api/follow', bob.token, { targetHandle: `@alice@localhost:${PORT}` });
    check('bob は alice をフォローできる', follow.status, 200);

    const createPost = async (token: string, content: string, visibility: string): Promise<string> => {
      const res = await api('POST', '/api/posts', token, { content, visibility });
      if (res.status !== 201 || !res.data?.id) throw new Error(`投稿作成失敗: ${JSON.stringify(res.data)}`);
      return res.data.id as string;
    };
    const followersId = await createPost(alice.token, 'フォロワー限定の秘密 secret-followers-12345', 'followers');
    const publicId = await createPost(alice.token, '公開の投稿 public-body-67890', 'public');

    // DM を 2 通作る（bob 宛 / carol 宛）。宛先の判定は recipients に入る actor URL を見る
    const dmToBob = await api('POST', '/api/dm/messages', alice.token, {
      to: 'bob',
      content: 'bob 宛の秘密 DM secret-dm-bob-11111',
    });
    check('bob 宛の DM を作れる', dmToBob.status, 201);
    const dmToBobId = String(dmToBob.data?.message?.id || '');
    if (!dmToBobId) throw new Error(`DM の ID が取れません: ${JSON.stringify(dmToBob.data)}`);

    const dmToCarol = await api('POST', '/api/dm/messages', alice.token, {
      to: 'carol',
      content: 'carol 宛の秘密 DM secret-dm-carol-22222',
    });
    check('carol 宛の DM を作れる', dmToCarol.status, 201);
    const dmToCarolId = String(dmToCarol.data?.message?.id || '');
    if (!dmToCarolId) throw new Error(`DM の ID が取れません: ${JSON.stringify(dmToCarol.data)}`);

    // 検査用の DB ハンドル（不正なブックマーク行の作成・403 の裏取りに使う）
    const { createAsyncDatabase } = await import('../server/src/db/asyncDriver.js');
    const inspect = createAsyncDatabase({
      driver: process.env.DB_DRIVER,
      connectionString: process.env.DATABASE_URL,
      dbPath: SERVER_DB,
    });
    const hasBookmark = async (userId: string, postId: string): Promise<boolean> => {
      const row = await inspect.prepare('SELECT 1 AS one FROM bookmarks WHERE user_id = ? AND post_id = ?').get(userId, postId);
      return Boolean(row);
    };

    console.log('\n🔒 [1] フォロワー限定はフォロワーだけがブックマークできる');
    const carolToggleF = await api('POST', '/api/bookmarks/toggle', carol.token, { postId: followersId });
    check('第三者（toggle）は 403', carolToggleF.status, 403);
    check('403 のとき行を作らない', await hasBookmark('carol', followersId), false);
    const carolPathF = await api('POST', `/api/posts/${encodeURIComponent(followersId)}/bookmark`, carol.token, {});
    check('第三者（後方互換のパス）は 403', carolPathF.status, 403);
    check('後方互換でも行を作らない', await hasBookmark('carol', followersId), false);

    const bobToggleF = await api('POST', '/api/bookmarks/toggle', bob.token, { postId: followersId });
    check('フォロワー（toggle）は追加できる', [bobToggleF.status, bobToggleF.data?.bookmarked], [200, true]);
    const bobToggleF2 = await api('POST', '/api/bookmarks/toggle', bob.token, { postId: followersId });
    check('フォロワー（toggle）は解除できる', [bobToggleF2.status, bobToggleF2.data?.bookmarked], [200, false]);
    const bobPathF = await api('POST', `/api/posts/${encodeURIComponent(followersId)}/bookmark`, bob.token, {});
    check('フォロワー（後方互換のパス）は追加できる', [bobPathF.status, bobPathF.data?.bookmarked], [200, true]);

    console.log('\n✉️ [2] DM は宛先もブックマークできる（第三者・別の宛先は不可）');
    const bobToggleDm = await api('POST', '/api/bookmarks/toggle', bob.token, { postId: dmToBobId });
    check('宛先（toggle）は追加できる', [bobToggleDm.status, bobToggleDm.data?.bookmarked], [200, true]);
    const bobPathDm = await api('POST', `/api/posts/${encodeURIComponent(dmToBobId)}/bookmark`, bob.token, {});
    check('宛先（後方互換のパス）は解除できる', [bobPathDm.status, bobPathDm.data?.bookmarked], [200, false]);
    const bobPathDm2 = await api('POST', `/api/posts/${encodeURIComponent(dmToBobId)}/bookmark`, bob.token, {});
    check('宛先（後方互換のパス）は追加できる', [bobPathDm2.status, bobPathDm2.data?.bookmarked], [200, true]);

    const carolToggleDm = await api('POST', '/api/bookmarks/toggle', carol.token, { postId: dmToBobId });
    check('第三者（toggle）は 403', carolToggleDm.status, 403);
    check('第三者（toggle）の行は作られない', await hasBookmark('carol', dmToBobId), false);
    const carolPathDm = await api('POST', `/api/posts/${encodeURIComponent(dmToBobId)}/bookmark`, carol.token, {});
    check('第三者（後方互換のパス）は 403', carolPathDm.status, 403);
    check('第三者（後方互換のパス）の行は作られない', await hasBookmark('carol', dmToBobId), false);

    const bobOnCarolDm = await api('POST', `/api/posts/${encodeURIComponent(dmToCarolId)}/bookmark`, bob.token, {});
    check('別の DM の宛先でもない人（bob）は 403', bobOnCarolDm.status, 403);

    const carolToggleOwnDm = await api('POST', '/api/bookmarks/toggle', carol.token, { postId: dmToCarolId });
    check('自分宛の DM（toggle）は追加できる', [carolToggleOwnDm.status, carolToggleOwnDm.data?.bookmarked], [200, true]);

    console.log('\n🕳️ [3] 存在しない投稿は 404');
    check('toggle は 404', (await api('POST', '/api/bookmarks/toggle', bob.token, { postId: 'no-such-post' })).status, 404);
    check('後方互換のパスも 404', (await api('POST', '/api/posts/no-such-post/bookmark', bob.token, {})).status, 404);

    console.log('\n📦 [4] エクスポートは閲覧できるブックマークだけを出す');
    // 正当なブックマーク（公開投稿）
    const carolPublic = await api('POST', '/api/bookmarks/toggle', carol.token, { postId: publicId });
    check('公開投稿はブックマークできる', [carolPublic.status, carolPublic.data?.bookmarked], [200, true]);

    // 修正前に作られていた可能性のある行を再現する（API ではもう作れない）。
    // carol 宛の DM は上の toggle で既に 1 行あるので、ここでは入れない
    const now = new Date().toISOString();
    for (const postId of [followersId, dmToBobId]) {
      await inspect
        .prepare('INSERT INTO bookmarks (user_id, post_id, created_at) VALUES (?, ?, ?)')
        .run('carol', postId, now);
    }
    check('検査用の行を直接入れられた', await hasBookmark('carol', followersId), true);
    check('自分宛の DM のブックマークも残っている', await hasBookmark('carol', dmToCarolId), true);
    await inspect.close();

    // サーバーを止めてから、同じ DB を読んでエクスポートする（test-dm と同じ作法）
    if (server?.pid) {
      spawnSync('taskkill', ['/pid', String(server.pid), '/f', '/t'], { shell: true, timeout: 10000 });
    }
    server = null;
    await new Promise((resolve) => setTimeout(resolve, 500));

    if (!process.env.DB_DRIVER || process.env.DB_DRIVER === 'sqlite') {
      process.env.DB_DRIVER = 'sqlite';
      process.env.DB_PATH = SERVER_DB;
    }
    process.env.DOMAIN = `localhost:${PORT}`;
    process.env.PORT = String(PORT);
    process.env.PROTOCOL = 'http';
    const { exportUserData } = await import('../server/src/exportService.js');
    const exported = await exportUserData('carol');
    const json = JSON.stringify(exported);

    check('エクスポートのブックマーク件数は 1', exported.bookmarks.length, 1);
    check('manifest の件数も 1', exported.manifest.counts.bookmarks, 1);
    check('公開投稿は残る', json.includes('public-body-67890'), true);
    check('フォロワー限定（非フォロワー）の中身は出ない', json.includes('secret-followers-12345'), false);
    check('他人宛の DM の中身は出ない', json.includes('secret-dm-bob-11111'), false);
    check('自分宛の DM でも中身は出ない', json.includes('secret-dm-carol-22222'), false);
    check('ブックマーク一覧に DM を含めない', exported.bookmarks.every((b: any) => b.post_id !== dmToCarolId), true);

    completed = true;
  } catch (err) {
    console.error('❌ テスト失敗:', err);
    failed++;
  } finally {
    if (server?.pid) {
      try { spawnSync('taskkill', ['/pid', String(server.pid), '/f', '/t'], { shell: true, timeout: 10000 }); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    // SQLite の場合はテスト DB を消す（PG では存在しない）
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
