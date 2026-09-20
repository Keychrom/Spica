import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// お知らせ（Announcements）の検証テスト
//   1. 管理者が作成 / 更新 / 公開・非公開 / 削除できるか
//   2. 公開中のお知らせだけが全ユーザー向け API に出るか
//   3. 非管理者は管理 API を使えないか
//   4. 入力バリデーション（空タイトル・空本文）が効くか
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_announcements.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3911;
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
      `空きポートを指定して実行してください:  TEST_PORT=3920 npx tsx scripts/test-announcements.ts`,
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
  console.log('🧪 お知らせ（Announcements）の検証テスト');
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
        INSTANCE_NAME: 'Announcements Test',
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
    const alice = await register('alice'); // 最初のユーザー = 管理者
    const bob = await register('bob');
    const auth = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

    const publicList = async () => (await (await fetch(`${BASE}/api/announcements`)).json()) as any[];
    const adminList = async () => (await (await fetch(`${BASE}/api/admin/announcements`, { headers: auth(alice.token) })).json()) as any[];

    // ------------------------------------------------------------------
    console.log('📢 [1] 初期状態と管理者による作成');
    check('初期状態は空', (await publicList()).length, 0);

    const nonAdminList = await fetch(`${BASE}/api/admin/announcements`, { headers: auth(bob.token) });
    check('非管理者は一覧を取得できない(403)', nonAdminList.status, 403);
    const nonAdminCreate = await fetch(`${BASE}/api/admin/announcements`, {
      method: 'POST', headers: auth(bob.token),
      body: JSON.stringify({ title: 'x', content: 'y' }),
    });
    check('非管理者は作成できない(403)', nonAdminCreate.status, 403);

    const emptyTitle = await fetch(`${BASE}/api/admin/announcements`, {
      method: 'POST', headers: auth(alice.token),
      body: JSON.stringify({ title: '   ', content: '本文' }),
    });
    check('空タイトルは 400', emptyTitle.status, 400);
    const emptyContent = await fetch(`${BASE}/api/admin/announcements`, {
      method: 'POST', headers: auth(alice.token),
      body: JSON.stringify({ title: 'タイトル', content: '  ' }),
    });
    check('空本文は 400', emptyContent.status, 400);

    const createRes = await fetch(`${BASE}/api/admin/announcements`, {
      method: 'POST', headers: auth(alice.token),
      body: JSON.stringify({ title: 'メンテナンスのお知らせ', content: '9/25 3:00〜5:00 停止します。' }),
    });
    check('作成のステータス', createRes.status, 201);
    const created = await createRes.json();
    check('作成直後は公開中', created.announcement.is_active, 1);

    const listAfterCreate = await publicList();
    check('公開一覧に載る', listAfterCreate.length, 1);
    check('タイトルが一致', listAfterCreate[0]?.title, 'メンテナンスのお知らせ');
    check('作成者が記録される', (await adminList())[0]?.created_by, 'alice');

    const secondRes = await fetch(`${BASE}/api/admin/announcements`, {
      method: 'POST', headers: auth(alice.token),
      body: JSON.stringify({ title: '新機能のお知らせ', content: 'フォロワー限定投稿に対応しました。' }),
    });
    check('2件目の作成', secondRes.status, 201);
    const second = await secondRes.json();
    check('公開一覧は2件', (await publicList()).length, 2);
    check('新しい順に並ぶ', (await publicList())[0]?.id, second.announcement.id);

    // ------------------------------------------------------------------
    console.log('\n✏️  [2] 更新と公開・非公開');
    const updateRes = await fetch(`${BASE}/api/admin/announcements/${encodeURIComponent(created.announcement.id)}`, {
      method: 'PUT', headers: auth(alice.token),
      body: JSON.stringify({ title: '【重要】メンテナンスのお知らせ', isActive: false }),
    });
    check('更新のステータス', updateRes.status, 200);
    const updated = (await updateRes.json()).announcement;
    check('タイトルが更新される', updated.title, '【重要】メンテナンスのお知らせ');
    check('本文は維持される', updated.content, '9/25 3:00〜5:00 停止します。');
    check('非公開になる', updated.is_active, 0);

    const publicAfterHide = await publicList();
    check('非公開は公開一覧に出ない', publicAfterHide.some((a) => a.id === created.announcement.id), false);
    check('公開中の1件のみ残る', publicAfterHide.length, 1);
    check('管理一覧には残る', (await adminList()).length, 2);

    const showRes = await fetch(`${BASE}/api/admin/announcements/${encodeURIComponent(created.announcement.id)}`, {
      method: 'PUT', headers: auth(alice.token),
      body: JSON.stringify({ isActive: true }),
    });
    check('再公開のステータス', showRes.status, 200);
    check('再公開で公開一覧に戻る', (await publicList()).some((a) => a.id === created.announcement.id), true);

    const missingUpdate = await fetch(`${BASE}/api/admin/announcements/does-not-exist`, {
      method: 'PUT', headers: auth(alice.token),
      body: JSON.stringify({ title: 'x' }),
    });
    check('存在しない更新は 404', missingUpdate.status, 404);

    // ------------------------------------------------------------------
    console.log('\n🗑️  [3] 削除');
    const deleteRes = await fetch(`${BASE}/api/admin/announcements/${encodeURIComponent(created.announcement.id)}`, {
      method: 'DELETE', headers: auth(alice.token),
    });
    check('削除のステータス', deleteRes.status, 200);
    check('公開一覧から消える', (await publicList()).some((a) => a.id === created.announcement.id), false);
    check('管理一覧から消える', (await adminList()).some((a) => a.id === created.announcement.id), false);
    const missingDelete = await fetch(`${BASE}/api/admin/announcements/does-not-exist`, {
      method: 'DELETE', headers: auth(alice.token),
    });
    check('存在しない削除は 404', missingDelete.status, 404);

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 お知らせの検証: すべて成功');
    } else {
      console.error(`❌ お知らせの検証: ${failures} 件失敗`);
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
