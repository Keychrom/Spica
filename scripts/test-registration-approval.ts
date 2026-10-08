import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';

// ============================================================================
// 承認制の登録モード（registration_mode = 'approval'）の検査
//
//   [1] モードの設定（admin API が approval を受け付ける / 不正な値は 400）
//   [2] 申請（register が pending になる・sessionToken を返さない・マスターキーは返る）
//   [3] 承認前は入れない（ログイン 403 / 公開の場所に出ない / 件数に数えない）
//   [4] 管理者の申請一覧（申請メッセージ・連絡先が管理者だけに見える）
//   [5] 承認すると入れる（ログイン・Actor・WebFinger・ディレクトリ・件数）
//   [6] 却下すると入れない（理由がログイン時に出る）+ 拒否しても ID は予約されたまま
//   [7] 他のモード（open / invite / closed）の挙動を壊していない
//
// ポートは TEST_PORT で変更可能（既定 3638）。
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_approval.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3638;
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
      .prepare('SELECT approval_status, approval_note, approval_reason, role FROM users WHERE id = ?')
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

/** 部分一致で見る（エラー文の全文一致は壊れやすい） */
function checkContains(name: string, actual: unknown, needle: string): void {
  checks++;
  const ok = String(actual || '').includes(needle);
  console.log(`  ${ok ? '✅' : '❌'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (含むべき文字列 ${JSON.stringify(needle)})`}`);
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
      `空きポートを指定して実行してください:  TEST_PORT=3638 npx tsx scripts/test-registration-approval.ts`,
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
  console.log('🧪 承認制の登録モードの検査');
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
        INSTANCE_NAME: 'Approval Test',
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
    console.log('👑 [1] 管理者を1人作って、登録モードを承認制にする');

    const adminRes = await api('POST', '/api/auth/register', undefined, {
      id: 'admin', name: 'Admin', agreedToRules: true,
    });
    check('最初のユーザーは管理者', adminRes.data?.user?.role, 'admin');
    check('通常登録は sessionToken が返る', typeof adminRes.data?.sessionToken, 'string');
    check('通常登録に pending は付かない', adminRes.data?.pending, undefined);
    check('通常登録は approved', (await lookupUser('admin'))?.approval_status, 'approved');
    const admin = adminRes.data.sessionToken as string;

    const badMode = await api('POST', '/api/admin/registration-mode', admin, { mode: 'nonsense' });
    check('不正な登録モードは 400', badMode.status, 400);

    const setMode = await api('POST', '/api/admin/registration-mode', admin, { mode: 'approval' });
    check('承認制に変更できる', setMode.status, 200);
    check('応答に approval が入る', setMode.data?.registration_mode, 'approval');
    checkContains('案内文に「承認制」', setMode.data?.message, '承認制');

    const info = await api('GET', '/api/server-info');
    check('server-info が approval を配る', info.data?.registration_mode, 'approval');

    // ======================================================================
    console.log('\n📝 [2] 申請する（承認されるまで入れない）');

    const apply = await api('POST', '/api/auth/register', undefined, {
      id: 'bob',
      name: 'Bob',
      summary: 'はじめまして',
      agreedToRules: true,
      requestMessage: '趣味でfediverseをやっています。参加させてください。',
    });
    check('申請は 201', apply.status, 201);
    check('pending が返る', apply.data?.pending, true);
    check('approval_status が pending', apply.data?.approval_status, 'pending');
    check('sessionToken を返さない', apply.data?.sessionToken, undefined);
    check('マスターキーは返る（承認後のログインに必要）', typeof apply.data?.masterKey, 'string');
    checkContains('案内文に「承認」', apply.data?.message, '承認');

    const bobRow = await lookupUser('bob');
    check('DB でも pending', bobRow?.approval_status, 'pending');
    check('申請メッセージが残る', String(bobRow?.approval_note || '').includes('参加させてください'), true);
    check('ロールは一般ユーザー', bobRow?.role, 'user');

    const dup = await api('POST', '/api/auth/register', undefined, {
      id: 'bob', name: 'Bob2', agreedToRules: true,
    });
    check('申請中の ID は予約される（二重申請は 409）', dup.status, 409);

    // ======================================================================
    console.log('\n🚪 [3] 承認前は入れない・見えない・数えない');

    const loginPending = await api('POST', '/api/auth/login', undefined, {
      id: 'bob', masterKey: apply.data.masterKey,
    });
    check('マスターキーでログインできない（403）', loginPending.status, 403);
    checkContains('承認待ちだと分かる', loginPending.data?.error, '承認待ち');

    const actor = await fetch(`${BASE}/users/bob`, { headers: { Accept: 'application/activity+json' } });
    check('Actor 文書は 404', actor.status, 404);

    const wf = await fetch(`${BASE}/.well-known/webfinger?resource=acct:bob@${DOMAIN}`);
    check('WebFinger は 404', wf.status, 404);

    const profile = await api('GET', '/api/users/bob');
    check('プロフィール API は 404', profile.status, 404);

    const rss = await fetch(`${BASE}/users/bob/feed.xml`);
    check('ユーザー RSS は 404', rss.status, 404);

    const directory = await api('GET', '/api/directory');
    check('ディレクトリに出ない', Array.isArray(directory.data) && directory.data.some((u: any) => u.id === 'bob'), false);

    const search = await api('GET', '/api/search?q=bob');
    check('検索に出ない', JSON.stringify(search.data || {}).includes('"bob"'), false);

    const infoPending = await api('GET', '/api/server-info');
    check('server-info は壊れていない', typeof infoPending.data?.stats?.users, 'number');
    // ※ 公開の利用者数は 60 秒キャッシュされるので、数え上げの検証はキャッシュの無い管理 API で行う
    const adminStatsPending = await api('GET', '/api/admin/stats', admin);
    check('管理統計の利用者数に数えない', adminStatsPending.data?.stats?.users, 1);
    check('承認待ちとして別枠で数える', adminStatsPending.data?.stats?.pendingRegistrations, 1);

    const sitemap = await fetch(`${BASE}/sitemap.xml`);
    check('sitemap に出ない', (await sitemap.text()).includes('/users/bob'), false);

    // ======================================================================
    console.log('\n📋 [4] 管理者の申請一覧');

    const list = await api('GET', '/api/admin/registration-requests', admin);
    check('一覧が取れる', list.status, 200);
    check('承認待ちは 1 件', list.data?.pending_count, 1);
    check('申請者が入っている', list.data?.requests?.[0]?.id, 'bob');
    checkContains('申請メッセージが見える', list.data?.requests?.[0]?.note, '参加させてください');
    check('承認前の申請は自分の紹介文も見える', list.data?.requests?.[0]?.summary, 'はじめまして');

    const listByBob = await api('GET', '/api/admin/registration-requests', apply.data.sessionToken);
    check('申請中は管理 API を使えない（トークンが無い）', listByBob.status, 403);

    // ======================================================================
    console.log('\n✅ [5] 承認すると入れる');

    const approve = await api('POST', '/api/admin/registration-requests/bob/approve', admin);
    check('承認できる', approve.status, 200);
    check('approval_status が approved', approve.data?.approval_status, 'approved');
    check('DB でも approved', (await lookupUser('bob'))?.approval_status, 'approved');

    const loginOk = await api('POST', '/api/auth/login', undefined, { id: 'bob', masterKey: apply.data.masterKey });
    check('承認後はログインできる', loginOk.status, 200);
    check('sessionToken が返る', typeof loginOk.data?.sessionToken, 'string');
    const bob = loginOk.data.sessionToken as string;

    const actorOk = await fetch(`${BASE}/users/bob`, { headers: { Accept: 'application/activity+json' } });
    check('Actor 文書が返る', actorOk.status, 200);
    check('preferredUsername が bob', (await actorOk.json())?.preferredUsername, 'bob');

    const wfOk = await fetch(`${BASE}/.well-known/webfinger?resource=acct:bob@${DOMAIN}`);
    check('WebFinger が返る', wfOk.status, 200);

    const adminStatsApproved = await api('GET', '/api/admin/stats', admin);
    check('承認後は利用者数に数える', adminStatsApproved.data?.stats?.users, 2);
    check('承認待ちは 0 件', adminStatsApproved.data?.stats?.pendingRegistrations, 0);

    const post = await api('POST', '/api/posts', bob, { content: '承認されました', visibility: 'public' });
    check('承認後は投稿できる', post.status, 201);

    const listAfter = await api('GET', '/api/admin/registration-requests', admin);
    check('承認待ちは 0 件になる', listAfter.data?.pending_count, 0);

    const adminUsers = await api('GET', '/api/admin/users', admin);
    const bobRowAdmin = (adminUsers.data as any[])?.find((u: any) => u.id === 'bob');
    check('管理画面の一覧に approval_status が入る', bobRowAdmin?.approval_status, 'approved');

    // ======================================================================
    console.log('\n🚫 [6] 却下すると入れない（理由が伝わる）');

    const applyCarol = await api('POST', '/api/auth/register', undefined, {
      id: 'carol', name: 'Carol', agreedToRules: true, requestMessage: 'よろしくお願いします',
    });
    check('carol の申請は pending', applyCarol.data?.pending, true);

    const reject = await api('POST', '/api/admin/registration-requests/carol/reject', admin, {
      reason: 'このサーバーは現在、知人からの紹介のみ受け付けています。',
    });
    check('却下できる', reject.status, 200);
    check('approval_status が rejected', reject.data?.approval_status, 'rejected');

    const loginCarol = await api('POST', '/api/auth/login', undefined, {
      id: 'carol', masterKey: applyCarol.data.masterKey,
    });
    check('却下後もログインできない（403）', loginCarol.status, 403);
    checkContains('理由が伝わる', loginCarol.data?.error, '知人からの紹介');
    check('理由が DB に残る', String((await lookupUser('carol'))?.approval_reason || '').includes('知人からの紹介'), true);

    const duplicateCarol = await api('POST', '/api/auth/register', undefined, {
      id: 'carol', name: 'Carol2', agreedToRules: true,
    });
    check('却下しても ID は予約されたまま', duplicateCarol.status, 409);

    const reApprove = await api('POST', '/api/admin/registration-requests/carol/approve', admin);
    check('却下した申請も後から承認できる', reApprove.status, 200);
    const loginCarol2 = await api('POST', '/api/auth/login', undefined, {
      id: 'carol', masterKey: applyCarol.data.masterKey,
    });
    check('承認し直すとログインできる', loginCarol2.status, 200);

    const missing = await api('POST', '/api/admin/registration-requests/nobody/approve', admin);
    check('存在しない申請の承認は 404', missing.status, 404);

    const listByMod = await api('GET', '/api/admin/registration-requests', bob);
    check('一般ユーザーは申請一覧を見られない', listByMod.status, 403);

    // ======================================================================
    console.log('\n🔄 [7] 他のモードの挙動を壊していない');

    const setOpen = await api('POST', '/api/admin/registration-mode', admin, { mode: 'open' });
    check('自由登録に戻せる', setOpen.data?.registration_mode, 'open');
    const dave = await api('POST', '/api/auth/register', undefined, { id: 'dave', name: 'Dave', agreedToRules: true });
    check('自由登録は即時利用できる', typeof dave.data?.sessionToken, 'string');
    check('自由登録に pending は付かない', dave.data?.pending, undefined);

    const setInvite = await api('POST', '/api/admin/registration-mode', admin, { mode: 'invite' });
    check('招待制に戻せる', setInvite.data?.registration_mode, 'invite');
    const noCode = await api('POST', '/api/auth/register', undefined, { id: 'erin', name: 'Erin', agreedToRules: true });
    check('招待制はコード必須のまま', noCode.status, 400);

    const setClosed = await api('POST', '/api/admin/registration-mode', admin, { mode: 'closed' });
    check('停止モードに戻せる', setClosed.data?.registration_mode, 'closed');
    const closed = await api('POST', '/api/auth/register', undefined, { id: 'frank', name: 'Frank', agreedToRules: true });
    check('停止中は登録できないまま', closed.status, 403);

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
