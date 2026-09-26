import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// プロフィールの一覧・チャンネル設定・自分の通報の検証
//
//   これまでサーバー側にしか無く、画面から使えなかったもの:
//     1. GET /api/followers・/api/following … フォロー一覧（ローカルの相手も名前とアイコンが出るか）
//     2. PUT /api/channels/:id               … チャンネルの編集（作成者だけ / 他人は 403）
//     3. GET /api/reports/mine               … 自分が出した通報と対応状況
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_profile_lists.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 4512;
const BASE = `http://localhost:${PORT}`;

[TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
  [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)].forEach((p) => {
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
      `空きポートを指定して実行してください:  TEST_PORT=4522 npx tsx scripts/test-profile-lists.ts`,
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
  console.log('🧪 プロフィール一覧・チャンネル設定・通報履歴の検証');
  console.log(`   server=${PORT}`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;
  const dbPath = path.resolve(ROOT_DIR, 'server', TEST_DB);

  try {
    await assertPortFree(PORT);

    server = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: dbPath,
        INSTANCE_NAME: 'Profile Lists Test',
        RATE_LIMIT_DISABLED: 'true',
        AUTO_MAINTENANCE: 'false',
        AUTO_BACKUP: 'false',
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
        body: JSON.stringify({ id, name: `${id} さん`, summary: '', agreedToRules: true }),
      });
      const body = await res.json();
      if (!body?.sessionToken) throw new Error(`${id} の作成に失敗: ${JSON.stringify(body)}`);
      return { token: body.sessionToken as string, actorUrl: `${BASE}/users/${id}` };
    };
    const auth = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

    const alice = await register('alice');
    const bob = await register('bob');
    const carol = await register('carol');

    // フォロー関係は API で作る（DB を直接触らないので SQLite / PostgreSQL の両方で回せる）
    const follow = async (token: string, handle: string) => {
      const res = await fetch(`${BASE}/api/follow`, {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ targetHandle: handle }),
      });
      if (!res.ok) throw new Error(`フォローに失敗: HTTP ${res.status} ${await res.text()}`);
    };
    await follow(alice.token, `@bob@localhost:${PORT}`);   // alice → bob（承認済み）
    await follow(carol.token, `@alice@localhost:${PORT}`); // carol → alice（承認済み）
    // ※ ローカル同士のフォローは鍵アカウントでも即時承認される（外部配送が無いため）。
    //    承認待ちが一覧に出ないことは test-followers-visibility.ts 側で確認している。

    // ------------------------------------------------------------------
    console.log('👥 [1] フォロワー / フォロー中の一覧');
    const followersRes = await fetch(`${BASE}/api/followers?userId=alice`);
    const followers = await followersRes.json() as any[];
    check('フォロワー一覧のステータス', followersRes.status, 200);
    check('承認済みのフォロワーだけが返る', followers.length, 1);
    check('相手のユーザー名が埋まる', followers[0]?.username, 'carol');
    check('相手の表示名が埋まる', followers[0]?.name, 'carol さん');
    check('ローカル判定が付く', followers[0]?.is_local, 1);
    check('ドメインが自分のドメイン', followers[0]?.domain, `localhost:${PORT}`);

    const followingRes = await fetch(`${BASE}/api/following?userId=alice`);
    const following = await followingRes.json() as any[];
    check('フォロー中一覧のステータス', followingRes.status, 200);
    check('フォロー中の相手', following[0]?.username, 'bob');
    check('フォロー中のローカル判定', following[0]?.is_local, 1);

    // アイコンを設定したら一覧にも出る
    const iconRes = await fetch(`${BASE}/api/user/profile`, {
      method: 'PUT',
      headers: auth(bob.token),
      body: JSON.stringify({ name: 'bob さん', summary: '', icon_url: `${BASE}/logo.jpg`, banner_url: '', fields: [] }),
    });
    if (!iconRes.ok) throw new Error(`プロフィール更新に失敗: HTTP ${iconRes.status}`);
    const followingAfterIcon = await (await fetch(`${BASE}/api/following?userId=alice`)).json() as any[];
    check('アイコンが一覧に反映される', Boolean(followingAfterIcon[0]?.icon_url), true);

    const noUser = await fetch(`${BASE}/api/followers`);
    check('userId 無し・未ログインは 400', noUser.status, 400);

    // ------------------------------------------------------------------
    console.log('\n📢 [2] チャンネルの編集（PUT /api/channels/:id）');
    const createRes = await fetch(`${BASE}/api/channels`, {
      method: 'POST',
      headers: auth(alice.token),
      body: JSON.stringify({ name: 'テストチャンネル', description: '説明', color: '#6366f1', category: 'general' }),
    });
    const channel = await createRes.json() as any;
    check('チャンネル作成', createRes.status, 201);
    const channelId = channel.id as string;

    const updateRes = await fetch(`${BASE}/api/channels/${channelId}`, {
      method: 'PUT',
      headers: auth(alice.token),
      body: JSON.stringify({ name: '改名したチャンネル', description: '新しい説明', color: '#22c55e', category: 'tech' }),
    });
    const updated = await updateRes.json() as any;
    check('作成者は編集できる', updateRes.status, 200);
    check('名前が変わる', updated.name, '改名したチャンネル');
    check('説明が変わる', updated.description, '新しい説明');
    check('色が変わる', updated.color, '#22c55e');

    // 送っていない項目は元のまま（部分更新）
    const partialRes = await fetch(`${BASE}/api/channels/${channelId}`, {
      method: 'PUT',
      headers: auth(alice.token),
      body: JSON.stringify({ is_archived: true }),
    });
    const partial = await partialRes.json() as any;
    check('部分更新でも名前は消えない', partial.name, '改名したチャンネル');
    check('アーカイブできる', partial.is_archived, true);

    const otherRes = await fetch(`${BASE}/api/channels/${channelId}`, {
      method: 'PUT',
      headers: auth(carol.token),
      body: JSON.stringify({ name: '乗っ取り' }),
    });
    check('他人は編集できない', otherRes.status, 403);

    const missingRes = await fetch(`${BASE}/api/channels/does-not-exist`, {
      method: 'PUT',
      headers: auth(alice.token),
      body: JSON.stringify({ name: 'x' }),
    });
    check('存在しないチャンネルは 404', missingRes.status, 404);

    // ------------------------------------------------------------------
    console.log('\n🚩 [3] 自分の通報の一覧（GET /api/reports/mine）');
    const unauth = await fetch(`${BASE}/api/reports/mine`);
    check('未ログインは 401', unauth.status, 401);

    const emptyRes = await fetch(`${BASE}/api/reports/mine`, { headers: auth(alice.token) });
    check('通報前は空', (await emptyRes.json() as any[]).length, 0);

    const postRes = await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: auth(bob.token),
      body: JSON.stringify({ content: '通報される投稿' }),
    });
    const targetPost = await postRes.json() as any;

    const reportRes = await fetch(`${BASE}/api/reports`, {
      method: 'POST',
      headers: auth(alice.token),
      body: JSON.stringify({ targetPostId: targetPost.id, category: 'spam', comment: 'スパムです', forward: false }),
    });
    check('通報できる', reportRes.status, 201);

    const mineRes = await fetch(`${BASE}/api/reports/mine`, { headers: auth(alice.token) });
    const mine = await mineRes.json() as any[];
    check('自分の通報が 1 件返る', mine.length, 1);
    check('対応状況が open', mine[0]?.status, 'open');
    check('通報理由が入る', mine[0]?.category, 'spam');
    check('補足が入る', mine[0]?.comment, 'スパムです');
    check('対象の投稿が分かる', mine[0]?.target_post_preview, '通報される投稿');
    check('対象ハンドルが入る', String(mine[0]?.target_handle || '').includes('bob'), true);

    const othersRes = await fetch(`${BASE}/api/reports/mine`, { headers: auth(carol.token) });
    check('他人の通報は見えない', (await othersRes.json() as any[]).length, 0);

    // 管理者（alice = 最初の登録者）が対応したら「対応済み」とメモが見える
    const resolveRes = await fetch(`${BASE}/api/admin/reports/${mine[0].id}/resolve`, {
      method: 'POST',
      headers: auth(alice.token),
      body: JSON.stringify({ action: 'resolve', note: '確認しました' }),
    });
    check('管理者が対応できる', resolveRes.status, 200);
    const resolvedRes = await fetch(`${BASE}/api/reports/mine`, { headers: auth(alice.token) });
    const resolved = await resolvedRes.json() as any[];
    check('対応済みになる', resolved[0]?.status, 'resolved');
    check('対応メモが見える', resolved[0]?.resolution_note, '確認しました');

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 プロフィール一覧・チャンネル設定・通報履歴: すべて成功');
    } else {
      console.error(`❌ 検証: ${failures} 件失敗`);
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
