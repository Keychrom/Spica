import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// ロール制御の検証
//   1. ロールの作成 / 更新 / 削除（権限の正規化・重複名・未知の権限）
//   2. ユーザーへの付与 / 解除
//   3. 権限の強制:
//        - 'moderate' のみ → 通報・凍結・ブロックは使えるが、ロール管理や設定は 403
//        - 'admin' 権限のロール → 管理 API 全体が使える
//        - 解除すると即座に権限を失う
//   4. 最後の管理者から管理権限を外せないこと
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_roles.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 4611;
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
      `空きポートを指定して実行してください:  TEST_PORT=4620 npx tsx scripts/test-roles.ts`,
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
  console.log('🧪 ロール制御の検証');
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
        INSTANCE_NAME: 'Roles Test',
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
    const carol = await register('carol');
    const auth = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

    // ------------------------------------------------------------------
    console.log('🎭 [1] ロールの作成・更新・削除');
    const listInitial = await fetch(`${BASE}/api/admin/roles`, { headers: auth(alice.token) });
    check('ロール一覧のステータス', listInitial.status, 200);
    check('初期はロール0件', (await listInitial.json()).roles.length, 0);

    const nonAdmin = await fetch(`${BASE}/api/admin/roles`, { headers: auth(bob.token) });
    check('非管理者は一覧を取得できない(403)', nonAdmin.status, 403);

    const emptyName = await fetch(`${BASE}/api/admin/roles`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ name: '  ', permissions: ['moderate'] }),
    });
    check('空の名前は 400', emptyName.status, 400);

    const noPermission = await fetch(`${BASE}/api/admin/roles`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ name: '権限なし', permissions: [] }),
    });
    check('権限なしは 400', noPermission.status, 400);

    const moderatorRole = await fetch(`${BASE}/api/admin/roles`, {
      method: 'POST', headers: auth(alice.token),
      body: JSON.stringify({ name: 'モデレーター', color: '#f59e0b', permissions: ['moderate'] }),
    });
    check('ロール作成のステータス', moderatorRole.status, 201);
    const modRole = await moderatorRole.json();
    check('権限が保存される', modRole.permissions, 'moderate');
    check('色が保存される', modRole.color, '#f59e0b');

    const unknownPermission = await fetch(`${BASE}/api/admin/roles`, {
      method: 'POST', headers: auth(alice.token),
      body: JSON.stringify({ name: '不正権限', permissions: ['moderate', 'superpower'] }),
    });
    const unknownRole = await unknownPermission.json();
    check('未知の権限は無視される', unknownRole.permissions, 'moderate');

    const duplicateName = await fetch(`${BASE}/api/admin/roles`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ name: 'モデレーター', permissions: ['moderate'] }),
    });
    check('同名ロールは 409', duplicateName.status, 409);

    const adminRoleRes = await fetch(`${BASE}/api/admin/roles`, {
      method: 'POST', headers: auth(alice.token),
      body: JSON.stringify({ name: '副管理者', permissions: ['admin'] }),
    });
    const adminRole = await adminRoleRes.json();
    check('管理者権限のロール作成', adminRoleRes.status, 201);

    const updateRes = await fetch(`${BASE}/api/admin/roles/${modRole.id}`, {
      method: 'PUT', headers: auth(alice.token),
      body: JSON.stringify({ name: 'モデレーター(改)', permissions: ['moderate', 'announce'] }),
    });
    check('ロール更新のステータス', updateRes.status, 200);
    check('更新後の権限', (await updateRes.json()).role.permissions, 'moderate,announce');

    // ------------------------------------------------------------------
    console.log('\n👤 [2] ユーザーへの付与');
    const assignRes = await fetch(`${BASE}/api/admin/users/bob/roles`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ roleIds: [modRole.id] }),
    });
    check('付与のステータス', assignRes.status, 200);
    check('付与件数', (await assignRes.json()).applied, 1);

    const rolesAfterAssign = await (await fetch(`${BASE}/api/admin/roles`, { headers: auth(alice.token) })).json();
    check('メンバー数が増える', rolesAfterAssign.roles.find((r: any) => r.id === modRole.id)?.member_count, 1);

    const missingUser = await fetch(`${BASE}/api/admin/users/nobody/roles`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ roleIds: [modRole.id] }),
    });
    check('存在しないユーザーは 404', missingUser.status, 404);

    // ------------------------------------------------------------------
    console.log('\n🔐 [3] 権限の強制');
    // モデレーター: 通報一覧は見られる
    const reportList = await fetch(`${BASE}/api/admin/reports`, { headers: auth(bob.token) });
    check('モデレーターは通報一覧を取得できる', reportList.status, 200);
    // モデレーター: ロール管理は不可
    const roleManageByMod = await fetch(`${BASE}/api/admin/roles`, { headers: auth(bob.token) });
    check('モデレーターはロール管理不可(403)', roleManageByMod.status, 403);
    // モデレーター: サーバー設定は不可
    const settingsByMod = await fetch(`${BASE}/api/admin/server-settings`, { headers: auth(bob.token) });
    check('モデレーターはサーバー設定不可(403)', settingsByMod.status, 403);
    // モデレーター: ドメインブロックは可
    const blocksByMod = await fetch(`${BASE}/api/admin/blocks`, { headers: auth(bob.token) });
    check('モデレーターはドメインブロックを扱える', blocksByMod.status, 200);
    // モデレーター: 投稿削除など一般 API は通常どおり
    const timelineByMod = await fetch(`${BASE}/api/timeline?mode=all&limit=1`, { headers: auth(bob.token) });
    check('通常 API は影響なし', timelineByMod.status, 200);
    // ロール未付与の carol は不可
    const reportsByCarol = await fetch(`${BASE}/api/admin/reports`, { headers: auth(carol.token) });
    check('未付与ユーザーは通報一覧不可(403)', reportsByCarol.status, 403);

    // 管理者権限のロールを付与すると管理 API 全体が使える
    await fetch(`${BASE}/api/admin/users/carol/roles`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ roleIds: [adminRole.id] }),
    });
    const settingsByCarol = await fetch(`${BASE}/api/admin/server-settings`, { headers: auth(carol.token) });
    check('admin 権限のロールでサーバー設定を取得できる', settingsByCarol.status, 200);

    // 解除すると即座に失う
    await fetch(`${BASE}/api/admin/users/carol/roles`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ roleIds: [] }),
    });
    const settingsAfterRevoke = await fetch(`${BASE}/api/admin/server-settings`, { headers: auth(carol.token) });
    check('解除後は 403 になる', settingsAfterRevoke.status, 403);

    // ------------------------------------------------------------------
    console.log('\n🛡️  [4] 締め出し防止と後片付け');
    const lastAdmin = await fetch(`${BASE}/api/admin/users/alice/roles`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ roleIds: [] }),
    });
    check('最後の管理者から管理権限は外せない(400)', lastAdmin.status, 400);

    const deleteRole = await fetch(`${BASE}/api/admin/roles/${modRole.id}`, {
      method: 'DELETE', headers: auth(alice.token),
    });
    check('ロール削除のステータス', deleteRole.status, 200);
    const rolesAfterDelete = await (await fetch(`${BASE}/api/admin/roles`, { headers: auth(alice.token) })).json();
    check('削除したロールが一覧から消える', rolesAfterDelete.roles.some((r: any) => r.id === modRole.id), false);
    check('他のロールは残る', rolesAfterDelete.roles.length, 2);
    const reportsAfterDelete = await fetch(`${BASE}/api/admin/reports`, { headers: auth(bob.token) });
    check('ロール削除で権限も失う(403)', reportsAfterDelete.status, 403);

    const missingDelete = await fetch(`${BASE}/api/admin/roles/nope`, { method: 'DELETE', headers: auth(alice.token) });
    check('存在しないロールの削除は 404', missingDelete.status, 404);

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 ロール制御の検証: すべて成功');
    } else {
      console.error(`❌ ロール制御の検証: ${failures} 件失敗`);
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
