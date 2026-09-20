import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// リスト（ユーザーを束ねた専用タイムライン）の検証
//   1. 作成 / 名前変更 / 削除
//   2. メンバー追加・削除（重複は 409 / 存在しないリストは 404）
//   3. タイムラインがメンバーの投稿だけを返すか
//   4. 公開範囲とミュートワードが尊重されるか
//   5. 他人のリストは操作できないか
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_lists.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 4211;
const BASE = `http://localhost:${PORT}`;

[TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
  const p1 = path.resolve(ROOT_DIR, f);
  const p2 = path.resolve(ROOT_DIR, 'server', f);
  [p1, p2].forEach((p) => {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  });
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    throw new Error(
      `ポート ${port} では既にサーバーが応答しています。稼働中のインスタンスへ書き込まないよう中断しました。\n` +
      `空きポートを指定して実行してください:  TEST_PORT=4220 npx tsx scripts/test-lists.ts`,
    );
  }
}

async function waitForServer(url: string, maxRetries = 40): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ✅ ${name}: ${JSON.stringify(actual)}`);
  } else {
    console.error(`  ❌ ${name}: 期待値 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);
    failures++;
  }
}

async function run() {
  console.log('====================================================');
  console.log('🧪 リスト（専用タイムライン）の検証');
  console.log(`   server=${PORT}`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;

  try {
    await assertPortFree(PORT);

    server = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Lists Test',
      },
      stdio: 'pipe',
      shell: true,
    });
    server.stdout?.on('data', () => {});

    if (!(await waitForServer(BASE))) throw new Error('サーバー起動失敗');
    console.log('✅ サーバー起動完了\n');

    const register = async (id: string) => {
      const res = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: `${id} さん`, agreedToRules: true }),
      });
      const body = await res.json();
      if (!body?.sessionToken) throw new Error(`${id} の作成に失敗: ${JSON.stringify(body)}`);
      return { token: body.sessionToken as string };
    };
    const alice = await register('alice');
    const bob = await register('bob');
    const carol = await register('carol');
    const auth = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

    const createPost = async (token: string, content: string, visibility?: string) => {
      const res = await fetch(`${BASE}/api/posts`, {
        method: 'POST', headers: auth(token),
        body: JSON.stringify({ content, ...(visibility ? { visibility } : {}) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`投稿作成失敗: ${JSON.stringify(body)}`);
      return body.id as string;
    };

    const bobPost1 = await createPost(bob.token, 'bob の投稿1');
    const bobPost2 = await createPost(bob.token, 'bob の投稿2');
    const carolPost = await createPost(carol.token, 'carol の投稿');
    const bobFollowersPost = await createPost(bob.token, 'bob のフォロワー限定', 'followers');
    const bobMutedPost = await createPost(bob.token, 'bob のネタバレ投稿');

    // ------------------------------------------------------------------
    console.log('📋 [1] リストの作成・変更・削除');
    const createRes = await fetch(`${BASE}/api/lists`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ name: '仲間たち' }),
    });
    check('作成のステータス', createRes.status, 201);
    const created = await createRes.json();
    check('リスト名', created.name, '仲間たち');

    const emptyName = await fetch(`${BASE}/api/lists`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ name: '  ' }),
    });
    check('空の名前は 400', emptyName.status, 400);

    const listRes = await fetch(`${BASE}/api/lists`, { headers: auth(alice.token) });
    const lists = await listRes.json();
    check('一覧に載る', lists.length, 1);
    check('メンバーは空', lists[0]?.members?.length, 0);

    const renameRes = await fetch(`${BASE}/api/lists/${created.id}`, {
      method: 'PUT', headers: auth(alice.token), body: JSON.stringify({ name: '親しい人たち' }),
    });
    check('名前変更のステータス', renameRes.status, 200);
    check('変更後の名前', (await (await fetch(`${BASE}/api/lists`, { headers: auth(alice.token) })).json())[0]?.name, '親しい人たち');

    // 他人のリストは操作できない
    const otherRename = await fetch(`${BASE}/api/lists/${created.id}`, {
      method: 'PUT', headers: auth(bob.token), body: JSON.stringify({ name: '乗っ取り' }),
    });
    check('他人のリストは変更できない(404)', otherRename.status, 404);
    const otherDelete = await fetch(`${BASE}/api/lists/${created.id}`, {
      method: 'DELETE', headers: auth(bob.token),
    });
    check('他人のリストは削除できない(404)', otherDelete.status, 404);

    // ------------------------------------------------------------------
    console.log('\n👥 [2] メンバーの追加・削除');
    const addBob = await fetch(`${BASE}/api/lists/${created.id}/members`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ member: 'bob' }),
    });
    check('メンバー追加(ローカルID)', addBob.status, 201);
    check('表示名が解決される', (await addBob.json()).display_name, 'bob さん');

    const duplicate = await fetch(`${BASE}/api/lists/${created.id}/members`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ member: '@bob@localhost:' + PORT }),
    });
    check('同じ相手の重複追加は 409', duplicate.status, 409);

    const emptyMember = await fetch(`${BASE}/api/lists/${created.id}/members`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ member: '' }),
    });
    check('空のメンバー指定は 400', emptyMember.status, 400);

    const missingList = await fetch(`${BASE}/api/lists/does-not-exist/members`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ member: 'bob' }),
    });
    check('存在しないリストは 404', missingList.status, 404);

    // ------------------------------------------------------------------
    console.log('\n📰 [3] リストのタイムライン');
    const tlRes = await fetch(`${BASE}/api/lists/${created.id}/timeline`, { headers: auth(alice.token) });
    const tl = await tlRes.json();
    check('タイムラインのステータス', tlRes.status, 200);
    check('メンバー数', tl.memberCount, 1);
    const ids = (tl.posts || []).map((p: any) => p.post_id ?? p.id);
    check('メンバー(bob)の公開投稿が含まれる', ids.includes(bobPost1) && ids.includes(bobPost2), true);
    check('非メンバー(carol)の投稿は含まれない', ids.includes(carolPost), false);
    check('フォロワー限定は本人以外に含まれない', ids.includes(bobFollowersPost), false);
    // メンバー(bob)の公開投稿3件（ミュートワード適用前なので「ネタバレ」投稿も含む）
    check('メンバーの公開投稿のみ3件', ids.length, 3);
    check('ミュートワード未設定なら該当投稿も含まれる', ids.includes(bobMutedPost), true);

    // ミュートワードが効く
    await fetch(`${BASE}/api/muted-words`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ keyword: 'ネタバレ' }),
    });
    const tlAfterMute = await (await fetch(`${BASE}/api/lists/${created.id}/timeline`, { headers: auth(alice.token) })).json();
    const idsAfterMute = (tlAfterMute.posts || []).map((p: any) => p.post_id ?? p.id);
    check('ミュートワード該当は除外される', idsAfterMute.includes(bobMutedPost), false);

    // メンバー削除でタイムラインから消える
    const members = (await (await fetch(`${BASE}/api/lists`, { headers: auth(alice.token) })).json())[0].members;
    const delMember = await fetch(`${BASE}/api/lists/${created.id}/members/${encodeURIComponent(members[0].id)}`, {
      method: 'DELETE', headers: auth(alice.token),
    });
    check('メンバー削除のステータス', delMember.status, 200);
    const tlAfterRemove = await (await fetch(`${BASE}/api/lists/${created.id}/timeline`, { headers: auth(alice.token) })).json();
    check('メンバー0件なら投稿なし', (tlAfterRemove.posts || []).length, 0);
    check('メンバー0件が反映される', tlAfterRemove.memberCount, 0);

    // ------------------------------------------------------------------
    console.log('\n🗑️  [4] リスト削除');
    const deleteRes = await fetch(`${BASE}/api/lists/${created.id}`, {
      method: 'DELETE', headers: auth(alice.token),
    });
    check('削除のステータス', deleteRes.status, 200);
    check('一覧から消える', (await (await fetch(`${BASE}/api/lists`, { headers: auth(alice.token) })).json()).length, 0);
    const missingAfterDelete = await fetch(`${BASE}/api/lists/${created.id}/timeline`, { headers: auth(alice.token) });
    check('削除後のタイムラインは 404', missingAfterDelete.status, 404);

    const noAuth = await fetch(`${BASE}/api/lists`);
    check('未ログインは 401', noAuth.status, 401);

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 リストの検証: すべて成功');
    } else {
      console.error(`❌ リストの検証: ${failures} 件失敗`);
      process.exitCode = 1;
    }
    console.log('====================================================');
  } catch (err) {
    console.error('❌ テスト実行エラー:', err);
    process.exitCode = 1;
  } finally {
    console.log('🧹 後片付け中...');
    if (server && server.pid) {
      try { spawn('taskkill', ['/pid', server.pid.toString(), '/f', '/t'], { shell: true }); } catch {}
    }
  }
}

run();
