import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';

// ============================================================================
// 初期設定ウィザード（オンボーディング）とプライバシー設定の検査
//
//   [1] 新規登録は onboarding_completed = 0 で作られる（既存ユーザーは 1 のまま）
//   [2] /api/auth/me とログインが状態を返す
//   [3] POST /api/me/onboarding/complete で完了になる（冪等）
//   [4] プライバシー設定（noindex / no_ai_training）がプロフィール更新で保存される
//   [5] プロフィール HTML の robots に反映される（noindex / noai, noimageai）
//   [6] noindex のユーザーは sitemap に出ない（他のユーザーは出る）
//
// ポートは TEST_PORT で変更可能（既定 3642）。
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_onboarding.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3642;
const BASE = `http://localhost:${PORT}`;
const DOMAIN = `localhost:${PORT}`;

[TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
  for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});

/** PostgreSQL でも回せる（run-suites-pg.sh から呼ばれたときは DB_DRIVER=postgres） */
const USE_PG =
  (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'postgres' && Boolean(process.env.TEST_DATABASE_URL);

const openDb = (): ReturnType<typeof createAsyncDatabase> =>
  USE_PG
    ? createAsyncDatabase({ driver: 'postgres', connectionString: process.env.TEST_DATABASE_URL as string })
    : createAsyncDatabase({ driver: 'sqlite', dbPath: path.resolve(ROOT_DIR, 'server', TEST_DB) });

async function lookupUser(id: string): Promise<any> {
  const conn = openDb();
  try {
    return await conn
      .prepare('SELECT onboarding_completed, noindex, no_ai_training, discoverable, is_locked FROM users WHERE id = ?')
      .get(id);
  } finally {
    await conn.close().catch(() => {});
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
let checks = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✅' : '❌'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期待値 ${JSON.stringify(expected)})`}`);
  if (!ok) failures++;
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
      `空きポートを指定して実行してください:  TEST_PORT=3642 npx tsx scripts/test-onboarding.ts`,
    );
  }
}

async function waitForServer(url: string, maxRetries = 60): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

async function waitForPortFree(port: number, maxRetries = 20): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await assertPortFree(port);
      return;
    } catch {
      await sleep(300);
    }
  }
}

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('🧪 初期設定ウィザードとプライバシー設定の検査');
  console.log(`   server=${PORT}`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;
  let completed = false;
  const dbPath = path.resolve(ROOT_DIR, 'server', TEST_DB);

  try {
    await assertPortFree(PORT);

    const tsxCli = path.resolve(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    server = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN,
        PROTOCOL: 'http',
        DB_PATH: dbPath,
        INSTANCE_NAME: 'Onboarding Test',
        RATE_LIMIT_DISABLED: 'true',
      },
      stdio: 'pipe',
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    if (!(await waitForServer(BASE))) throw new Error('サーバー起動失敗');
    console.log('✅ サーバー起動完了\n');

    const api = async (
      method: string,
      endpoint: string,
      token?: string,
      body?: unknown,
    ): Promise<{ status: number; data: any }> => {
      const res = await fetch(`${BASE}${endpoint}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      let data: any = null;
      const text = await res.text();
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { status: res.status, data };
    };

    // ======================================================================
    console.log('🧭 [1] 新規登録はウィザード未完了で作られる');

    const aliceRes = await api('POST', '/api/auth/register', undefined, {
      id: 'alice', name: 'Alice', agreedToRules: true,
    });
    check('登録に成功', aliceRes.status, 201);
    check('応答の onboarding_completed は 0', aliceRes.data?.user?.onboarding_completed, 0);
    check('DB でも 0', (await lookupUser('alice'))?.onboarding_completed, 0);
    const alice = aliceRes.data.sessionToken as string;

    const bobRes = await api('POST', '/api/auth/register', undefined, {
      id: 'bob', name: 'Bob', agreedToRules: true,
    });
    const bob = bobRes.data.sessionToken as string;

    // ======================================================================
    console.log('\n📡 [2] /auth/me と ログインが状態を返す');

    const me = await api('GET', '/api/auth/me', alice);
    check('auth/me の onboarding_completed', me.data?.onboarding_completed, 0);
    check('auth/me の noindex', me.data?.noindex, 0);
    check('auth/me の no_ai_training', me.data?.no_ai_training, 0);
    check('auth/me の discoverable', me.data?.discoverable, 1);
    check('auth/me の is_locked', me.data?.is_locked, 0);

    const login = await api('POST', '/api/auth/login', undefined, { id: 'alice', masterKey: aliceRes.data.masterKey });
    check('ログイン応答にも入る', login.data?.user?.onboarding_completed, 0);
    check('ログイン応答のプライバシー', login.data?.user?.no_ai_training, 0);

    // ======================================================================
    console.log('\n✅ [3] 完了にできる（冪等）');

    const done = await api('POST', '/api/me/onboarding/complete', alice);
    check('完了できる', done.status, 200);
    check('応答の値', done.data?.onboarding_completed, 1);
    check('DB でも 1', (await lookupUser('alice'))?.onboarding_completed, 1);
    const meAfter = await api('GET', '/api/auth/me', alice);
    check('auth/me に反映される', meAfter.data?.onboarding_completed, 1);
    const doneAgain = await api('POST', '/api/me/onboarding/complete', alice);
    check('二度押しても成功（冪等）', doneAgain.status, 200);
    check('bob はまだ未完了', (await lookupUser('bob'))?.onboarding_completed, 0);

    // ======================================================================
    console.log('\n🔒 [4] プライバシー設定の保存');

    const save = await api('PUT', '/api/user/profile', bob, {
      name: 'Bob',
      summary: 'こんにちは',
      noindex: true,
      no_ai_training: true,
    });
    check('プロフィール更新に成功', save.status, 200);
    check('応答の noindex', save.data?.noindex, 1);
    check('応答の no_ai_training', save.data?.no_ai_training, 1);
    const bobRow = await lookupUser('bob');
    check('DB に noindex が入る', bobRow?.noindex, 1);
    check('DB に no_ai_training が入る', bobRow?.no_ai_training, 1);
    check('既存の項目は壊れていない', bobRow?.discoverable, 1);

    const meBob = await api('GET', '/api/auth/me', bob);
    check('auth/me に反映される', [meBob.data?.noindex, meBob.data?.no_ai_training], [1, 1]);

    const partial = await api('PUT', '/api/user/profile', bob, { name: 'Bob' });
    check('未指定なら現状維持（noindex）', partial.data?.noindex, 1);
    check('未指定なら現状維持（no_ai_training）', partial.data?.no_ai_training, 1);

    const off = await api('PUT', '/api/user/profile', bob, { no_ai_training: false });
    check('false で戻せる', off.data?.no_ai_training, 0);
    const backOn = await api('PUT', '/api/user/profile', bob, { noindex: true, no_ai_training: true });
    check('もう一度 true に戻せる', [backOn.data?.noindex, backOn.data?.no_ai_training], [1, 1]);

    // ======================================================================
    console.log('\n🤖 [5] プロフィール HTML の robots に反映される');

    const htmlBob = await fetch(`${BASE}/users/bob`, { headers: { Accept: 'text/html' } });
    const bobHtml = await htmlBob.text();
    check('プロフィール HTML が返る', htmlBob.status, 200);
    check('noindex が出る', bobHtml.includes('name="robots" content="noindex, nofollow, noai, noimageai"'), true);

    // noindex だけの状態も見る（AI の指定が混ざらないこと）
    await api('PUT', '/api/user/profile', bob, { noindex: true, no_ai_training: false });
    const bobHtml2 = await (await fetch(`${BASE}/users/bob`, { headers: { Accept: 'text/html' } })).text();
    check('noindex だけなら noai は出ない', bobHtml2.includes('name="robots" content="noindex, nofollow"') && !bobHtml2.includes('noai'), true);

    // AI 拒否だけの状態（noindex は出さず、noai だけ出す）
    await api('PUT', '/api/user/profile', bob, { noindex: false, no_ai_training: true });
    const bobHtml3 = await (await fetch(`${BASE}/users/bob`, { headers: { Accept: 'text/html' } })).text();
    check('AI 拒否だけなら noindex は出ない', bobHtml3.includes('name="robots" content="noai, noimageai"'), true);
    check('そのとき noindex は含まない', /name="robots" content="noindex/.test(bobHtml3), false);

    // 既定（どちらも off）のユーザーには robots を出さない
    const aliceHtml = await (await fetch(`${BASE}/users/alice`, { headers: { Accept: 'text/html' } })).text();
    check('既定のユーザーには robots を出さない', /name="robots"/.test(aliceHtml), false);

    // ======================================================================
    console.log('\n🗺 [6] noindex のユーザーは sitemap に出ない');

    await api('PUT', '/api/user/profile', bob, { noindex: true, no_ai_training: true });
    const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
    check('bob は sitemap に出ない', sitemap.includes('/users/bob'), false);
    check('alice は sitemap に出る', sitemap.includes('/users/alice'), true);

    completed = true;
  } finally {
    console.log('');
    if (server) {
      server.kill('SIGTERM');
      await waitForPortFree(PORT, 6);
      if (!server.killed) {
        try { server.kill('SIGKILL'); } catch {}
      }
    }
  }

  [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
    for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
  });

  console.log('');
  if (!completed) {
    console.error('❌ テストを最後まで実行できませんでした（上のエラーを確認してください）');
  } else if (failures === 0) {
    console.log(`🎉 すべての確認に合格しました（${checks} 件）`);
  } else {
    console.error(`❌ ${checks} 件中 ${failures} 件の確認に失敗しました`);
  }
  process.exit(completed && failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('❌ テスト実行エラー:', err);
  process.exit(1);
});
