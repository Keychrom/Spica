import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// 通知の種類別設定の検証
//
//   1. 設定の取得・保存（既定はすべて有効）
//   2. 無効にした種類の通知は生成されない（リアクションだけ切る等）
//   3. 有効な種類の通知は従来どおり生成される
//   4. 通知一覧・未読件数からも無効な種類が除かれる
//   5. 未認証は 401 / 不正な値は無視される
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_notif_prefs.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3661;
const BASE = `http://localhost:${PORT}`;

[TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
  for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
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
  if (inUse) throw new Error(`ポート ${port} は使用中です。TEST_PORT=3670 のように空きポートを指定してください。`);
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

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('🧪 通知の種類別設定 検証テスト');
  console.log(`   server=${PORT}`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;
  let completed = false;

  try {
    await assertPortFree(PORT);
    const tsxCli = path.resolve(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    server = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Notification Prefs Test',
        RATE_LIMIT_DISABLED: 'true',
      },
      stdio: 'pipe',
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    if (!(await waitForServer(BASE))) throw new Error('サーバー起動失敗');
    console.log('✅ サーバー起動完了\n');

    const register = async (id: string) => {
      const res = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: id, agreedToRules: true }),
      });
      const body = await res.json();
      if (!body?.sessionToken) throw new Error(`${id} の作成に失敗: ${JSON.stringify(body)}`);
      return { token: body.sessionToken as string, id };
    };
    const alice = await register('alice');
    const bob = await register('bob');
    const carol = await register('carol');
    const auth = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

    const notifications = async (t: string, filter?: string) => {
      const res = await fetch(`${BASE}/api/notifications${filter ? `?filter=${filter}` : ''}`, { headers: { Authorization: `Bearer ${t}` } });
      return (await res.json()) as any[];
    };
    const unreadCount = async (t: string) => {
      const res = await fetch(`${BASE}/api/notifications/unread-count`, { headers: { Authorization: `Bearer ${t}` } });
      return (await res.json()).unreadCount as number;
    };
    const savePrefs = async (t: string, prefs: Record<string, boolean>) => {
      const res = await fetch(`${BASE}/api/notifications/settings`, { method: 'POST', headers: auth(t), body: JSON.stringify({ prefs }) });
      return { status: res.status, body: await res.json() };
    };
    const createPost = async (t: string, content: string) => {
      const res = await fetch(`${BASE}/api/posts`, { method: 'POST', headers: auth(t), body: JSON.stringify({ content }) });
      return (await res.json()).id as string;
    };

    // ------------------------------------------------------------------
    console.log('⚙️ [1] 設定の取得・保存');
    const initial = await (await fetch(`${BASE}/api/notifications/settings`, { headers: { Authorization: `Bearer ${bob.token}` } })).json();
    check('既定では全種類が有効', initial.prefs.reaction, true);
    check('種類のラベル一覧が返る', Array.isArray(initial.types) && initial.types.length >= 6, true);
    check('返信も既定で有効', initial.prefs.reply, true);

    const saved = await savePrefs(bob.token, { reaction: false, renote: false });
    check('保存が成功する', saved.status, 200);
    check('保存した値が返る', saved.body.prefs.reaction, false);
    check('指定しなかった種類は有効のまま', saved.body.prefs.follow, true);
    const reread = await (await fetch(`${BASE}/api/notifications/settings`, { headers: { Authorization: `Bearer ${bob.token}` } })).json();
    check('再取得しても保持される', reread.prefs.renote, false);

    const anon = await fetch(`${BASE}/api/notifications/settings`);
    check('未認証は 401', anon.status, 401);

    // ------------------------------------------------------------------
    console.log('\n🔕 [2] 無効にした種類は通知されない（リアクション）');
    const bobPost = await createPost(bob.token, 'リアクション通知のテスト');
    await fetch(`${BASE}/api/posts/${encodeURIComponent(bobPost)}/reaction`, {
      method: 'POST',
      headers: auth(alice.token),
      body: JSON.stringify({ reaction: '⭐' }),
    });
    await sleep(400);
    const bobNotifs = await notifications(bob.token);
    check('リアクション通知は生成されない', bobNotifs.filter((n) => n.type === 'reaction').length, 0);
    check('未読件数も 0 のまま', await unreadCount(bob.token), 0);

    console.log('\n🔔 [3] 有効な種類は従来どおり通知される（フォロー）');
    await fetch(`${BASE}/api/follow`, { method: 'POST', headers: auth(alice.token), body: JSON.stringify({ targetHandle: `@bob@localhost:${PORT}` }) });
    await sleep(400);
    const afterFollow = await notifications(bob.token);
    check('フォロー通知は生成される', afterFollow.filter((n) => n.type === 'follow').length, 1);
    check('未読件数が 1 になる', await unreadCount(bob.token), 1);

    console.log('\n🔕 [4] フォロー通知を切ると生成されない');
    await savePrefs(bob.token, { reaction: false, renote: false, follow: false });
    await fetch(`${BASE}/api/follow`, { method: 'POST', headers: auth(carol.token), body: JSON.stringify({ targetHandle: `@bob@localhost:${PORT}` }) });
    await sleep(400);
    const hiddenFollows = await notifications(bob.token);
    check('無効中のフォロー通知は一覧に出ない', hiddenFollows.filter((n) => n.type === 'follow').length, 0);
    check('未読件数も 0 になる', await unreadCount(bob.token), 0);

    // 戻すと「切っている間に作られなかった」ことが確認できる（過去の1件のみ）
    await savePrefs(bob.token, { reaction: false, renote: false, follow: true });
    const restoredFollows = await notifications(bob.token);
    check('戻すと過去の1件だけが見える（新規は生成されていない）', restoredFollows.filter((n) => n.type === 'follow').length, 1);
    await savePrefs(bob.token, { reaction: false, renote: false, follow: false });

    console.log('\n🙈 [5] 無効化した種類は一覧からも隠れる（過去分）');
    const replyNotif = await createPost(alice.token, 'これは返信です');
    await savePrefs(bob.token, { reaction: false, renote: false, follow: false });
    // bob の投稿への返信 → reply 通知（有効なうちに作る）
    await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: auth(alice.token),
      body: JSON.stringify({ content: 'bob への返信', in_reply_to: bobPost }),
    });
    await sleep(400);
    const withReply = await notifications(bob.token);
    check('返信通知は生成される（有効なので）', withReply.filter((n) => n.type === 'reply').length, 1);
    void replyNotif;

    await savePrefs(bob.token, { reaction: false, renote: false, follow: false, reply: false });
    const hidden = await notifications(bob.token);
    check('無効にした返信は一覧から消える', hidden.filter((n) => n.type === 'reply').length, 0);
    check('未効の種類のみ残る（フォローも無効なので0件）', hidden.length, 0);
    check('未読件数からも除外される', await unreadCount(bob.token), 0);

    console.log('\n↩️ [6] 戻すと再び有効になる');
    await savePrefs(bob.token, { reaction: true, renote: true, follow: true, reply: true });
    const restored = await notifications(bob.token);
    check('過去の通知がまた見える', restored.length >= 2, true);
    check('未読件数も戻る', (await unreadCount(bob.token)) >= 2, true);

    console.log('\n🧹 [7] 不正な値は無視される');
    const invalid = await savePrefs(bob.token, { reaction: 'yes', unknownType: false } as any);
    check('不正な値でも保存は成功する', invalid.status, 200);
    check('文字列は無視され既定（有効）のまま', invalid.body.prefs.reaction, true);
    check('未知の種類は保存されない', invalid.body.prefs.unknownType, undefined);

    completed = true;
  } finally {
    console.log('');
    if (!completed) console.error('❌ テストを最後まで実行できませんでした（上のエラーを参照）');
    else if (failures === 0) console.log('🎉 すべての確認に合格しました');
    else console.error(`❌ ${failures} 件の確認に失敗しました`);
    if (server) {
      server.kill('SIGTERM');
      for (let i = 0; i < 20; i++) {
        try { await assertPortFree(PORT); break; } catch { await sleep(300); }
      }
      try { server.kill('SIGKILL'); } catch {}
    }
    [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
      for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
        if (fs.existsSync(p)) {
          try { fs.unlinkSync(p); } catch {}
        }
      }
    });
  }
  process.exit(completed && failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('❌ テスト実行エラー:', err);
  process.exit(1);
});
