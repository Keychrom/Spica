import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// H（プロフィール項目 + バッジ + ユーザーディレクトリ）の検証
//   1. プロフィール項目: 保存・取得・上限（4件/40文字/200文字）・不正入力の無視
//   2. 連合: Actor の attachment (PropertyValue) として公開されるか
//   3. バッジ: 付与ロールがプロフィールAPIに載るか
//   4. ディレクトリ: 掲載ユーザーの一覧（鍵アカ・凍結・非掲載の扱い、検索、件数）
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_profile_fields.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 4711;
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
      `空きポートを指定して実行してください:  TEST_PORT=4720 npx tsx scripts/test-profile-fields.ts`,
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
  console.log('🧪 H（プロフィール項目 / バッジ / ディレクトリ）の検証');
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
        INSTANCE_NAME: 'Profile Test',
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
    const alice = await register('alice'); // 管理者
    const bob = await register('bob');
    const carol = await register('carol');
    const auth = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

    // ------------------------------------------------------------------
    console.log('🔗 [1] プロフィール項目の保存と取得');
    const saveRes = await fetch(`${BASE}/api/user/profile`, {
      method: 'PUT', headers: auth(alice.token),
      body: JSON.stringify({
        fields: [
          { name: 'Webサイト', value: 'https://example.com' },
          { name: '好きなもの', value: 'ActivityPub' },
        ],
      }),
    });
    check('保存のステータス', saveRes.status, 200);

    const profile = await (await fetch(`${BASE}/api/users/alice`)).json();
    check('項目が2件返る', profile.fields?.length, 2);
    check('項目の内容', profile.fields?.[0], { name: 'Webサイト', value: 'https://example.com' });
    check('ディレクトリ掲載は既定で可', profile.discoverable, true);

    // 上限と不正入力
    const tooMany = await fetch(`${BASE}/api/user/profile`, {
      method: 'PUT', headers: auth(alice.token),
      body: JSON.stringify({
        fields: [
          { name: 'a', value: '1' }, { name: 'b', value: '2' }, { name: 'c', value: '3' },
          { name: 'd', value: '4' }, { name: 'e', value: '5' },
        ],
      }),
    });
    const tooManyProfile = await (await fetch(`${BASE}/api/users/alice`)).json();
    check('5件目は切り捨てられる', tooManyProfile.fields?.length, 4);
    check('保存自体は成功する', tooMany.status, 200);

    await fetch(`${BASE}/api/user/profile`, {
      method: 'PUT', headers: auth(alice.token),
      body: JSON.stringify({
        fields: [
          { name: '空の値', value: '' },
          { name: 123, value: 'x' },
          { name: '長い名前' + 'あ'.repeat(80), value: 'v' },
          { name: 'ok', value: 'v' },
        ],
      }),
    });
    const sanitized = await (await fetch(`${BASE}/api/users/alice`)).json();
    check('空の値と不正な型は除外される', sanitized.fields?.length, 2);
    check('長すぎる名前は切り詰められる', String(sanitized.fields?.[0]?.name || '').length, 40);
    check('切り詰められた名前が残る', String(sanitized.fields?.[0]?.name || '').startsWith('長い名前'), true);

    // ------------------------------------------------------------------
    console.log('\n🌐 [2] 連合（Actor の attachment）');
    const actor = await (await fetch(`${BASE}/users/alice`, { headers: { Accept: 'application/activity+json' } })).json();
    check('attachment が配列で返る', Array.isArray(actor.attachment), true);
    check('PropertyValue 形式', actor.attachment?.[0]?.type, 'PropertyValue');
    check('attachment の name が切り詰められている', String(actor.attachment?.[0]?.name || '').length, 40);

    // ------------------------------------------------------------------
    console.log('\n🏅 [3] バッジ（ロール）');
    const roleRes = await fetch(`${BASE}/api/admin/roles`, {
      method: 'POST', headers: auth(alice.token),
      body: JSON.stringify({ name: '運営', color: '#f97316', permissions: ['moderate'] }),
    });
    const role = await roleRes.json();
    await fetch(`${BASE}/api/admin/users/bob/roles`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ roleIds: [role.id] }),
    });

    const bobProfile = await (await fetch(`${BASE}/api/users/bob`)).json();
    check('ロールがバッジとして返る', bobProfile.roles?.length, 1);
    check('バッジの名前', bobProfile.roles?.[0]?.name, '運営');
    check('バッジの色', bobProfile.roles?.[0]?.color, '#f97316');
    const carolProfile = await (await fetch(`${BASE}/api/users/carol`)).json();
    check('未付与ユーザーは空配列', carolProfile.roles?.length, 0);

    // ------------------------------------------------------------------
    console.log('\n👥 [4] ユーザーディレクトリ');
    const dirRes = await fetch(`${BASE}/api/directory`);
    const dir = await dirRes.json();
    check('ディレクトリのステータス', dirRes.status, 200);
    check('全ユーザーが載る', dir.users?.length, 3);
    const bobEntry = dir.users?.find((u: any) => u.id === 'bob');
    check('バッジが含まれる', bobEntry?.roles?.[0]?.name, '運営');
    check('ハンドルが含まれる', bobEntry?.handle, `@bob@localhost:${PORT}`);
    check('フォロワー数が含まれる', typeof bobEntry?.follower_count, 'number');
    check('投稿数が含まれる', typeof bobEntry?.post_count, 'number');

    const searchDir = await (await fetch(`${BASE}/api/directory?q=car`)).json();
    check('検索で絞り込める', searchDir.users?.length, 1);
    check('検索結果のID', searchDir.users?.[0]?.id, 'carol');

    // 非掲載（discoverable=false）は載らない
    await fetch(`${BASE}/api/user/profile`, {
      method: 'PUT', headers: auth(carol.token),
      body: JSON.stringify({ discoverable: false }),
    });
    const dirAfterOptOut = await (await fetch(`${BASE}/api/directory`)).json();
    check('非掲載ユーザーは出ない', dirAfterOptOut.users?.some((u: any) => u.id === 'carol'), false);
    check('件数が減る', dirAfterOptOut.users?.length, 2);

    // 凍結ユーザーは載らない
    await fetch(`${BASE}/api/admin/users/bob/freeze`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ isFrozen: true }),
    });
    const dirAfterFreeze = await (await fetch(`${BASE}/api/directory`)).json();
    check('凍結ユーザーは出ない', dirAfterFreeze.users?.some((u: any) => u.id === 'bob'), false);

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 H（プロフィール項目 / バッジ / ディレクトリ）の検証: すべて成功');
    } else {
      console.error(`❌ H の検証: ${failures} 件失敗`);
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
