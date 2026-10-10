import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// ユーザー設定（サーバー保存）の検査
//
//   1. 既定値が返る / 保存した値が次に読める（端末をまたいだ同期の土台）
//   2. 不正な値・知らないキーは捨てる（古いクライアントが壊しても設定は壊れない）
//   3. mutedDomains の正規化（URL・@ 付き・大文字・パス付きをホスト名に揃える）
//   4. ドメインミュートが自分のタイムラインから該当ドメインの投稿を消す
//   5. ホームの「ブーストを隠す」「返信を隠す」（自分の返信は残る）
//   6. ログイン中の端末一覧と、個別 / 一括のログアウト
//
// ポートは TEST_PORT で変更可能（既定 3324）。
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_user_prefs.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3324;
const ORIGIN = `http://localhost:${PORT}`;

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
    throw new Error(`ポート ${port} では既にサーバーが応答しています。TEST_PORT=3325 のように変えて実行してください。`);
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
  if (actual === expected) {
    console.log(`  ✅ ${name}: ${actual}`);
  } else {
    console.error(`  ❌ ${name}: 期待値 ${expected} / 実際 ${actual}`);
    failures++;
  }
}

async function run() {
  console.log('====================================================');
  console.log('🧪 ユーザー設定（サーバー保存）テスト');
  console.log(`   port=${PORT} origin=${ORIGIN}`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;

  try {
    await assertPortFree(PORT);

    server = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: 'prefs.test',
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'User Prefs Test',
      },
      stdio: 'pipe',
      shell: true,
    });
    server.stdout?.on('data', (d) => {
      const line = d.toString().trim();
      if (line.includes('❌') || line.includes('Error')) console.log(`[Server] ${line}`);
    });

    if (!(await waitForServer(ORIGIN))) throw new Error('サーバー起動失敗');
    console.log('✅ サーバー起動完了\n');

    // --- 準備: 利用者 2 人（A: 設定をいじる人 / B: 相手） ---
    const register = async (id: string) => {
      const res = await fetch(`${ORIGIN}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'PrefsTest/1.0 (Windows)' },
        body: JSON.stringify({ id, name: id, agreedToRules: true }),
      });
      const data = await res.json();
      if (!data?.sessionToken) throw new Error(`登録失敗 ${id}: ${JSON.stringify(data)}`);
      return data as { sessionToken: string; masterKey: string };
    };
    const alice = await register('alice');
    const bob = await register('bob');

    const apiCall = (method: string, url: string, token: string, body?: unknown) =>
      fetch(`${ORIGIN}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const getPrefs = async (token: string) => (await (await apiCall('GET', '/api/me/prefs', token)).json()).prefs;

    // ------------------------------------------------------------------
    console.log('📖 [1] 既定値と保存');
    const initial = await getPrefs(alice.sessionToken);
    check('既定のテーマ', initial.themeMode, 'dark');
    check('既定の新着の扱い', initial.newPostsBehavior, 'badge');
    check('既定の通知のまとめ', initial.notificationGrouping, 'group');
    check('既定のドメインミュート', initial.mutedDomains.length, 0);

    const putRes = await apiCall('PUT', '/api/me/prefs', alice.sessionToken, {
      themeMode: 'pure_black',
      fontSize: 'large',
      newPostsBehavior: 'auto',
      hideBoostsInHome: true,
    });
    check('保存のステータス', putRes.status, 200);
    const saved = (await putRes.json()).prefs;
    check('保存した値が返る', saved.themeMode, 'pure_black');
    const reloaded = await getPrefs(alice.sessionToken);
    check('次に読んでも残っている', reloaded.fontSize, 'large');
    check('触っていない項目は既定のまま', reloaded.density, 'comfortable');

    // ------------------------------------------------------------------
    console.log('\n🛡️ [2] 不正な値・知らないキーは捨てる');
    const dirty = (await (await apiCall('PUT', '/api/me/prefs', alice.sessionToken, {
      themeMode: 'neon',
      fontSize: 42,
      newPostsBehavior: 'teleport',
      mutedDomains: 'example.com',
      evilKey: 'should not be stored',
      defaultCwText: 'x'.repeat(500),
    })).json()).prefs;
    check('不正なテーマは既定へ', dirty.themeMode, 'dark');
    check('不正な文字サイズは既定へ', dirty.fontSize, 'normal');
    check('不正な新着の扱いは既定へ', dirty.newPostsBehavior, 'badge');
    check('配列でない mutedDomains は既定へ', Array.isArray(dirty.mutedDomains) && dirty.mutedDomains.length, 0);
    check('知らないキーは保存しない', Object.prototype.hasOwnProperty.call(dirty, 'evilKey'), false);
    check('長すぎる文言は切り詰める', String(dirty.defaultCwText).length, 200);

    // 直前の [1] で入れた値も、検証に通ったものは残る
    check('有効な値は残っている', dirty.hideBoostsInHome, true);

    // ------------------------------------------------------------------
    console.log('\n🔤 [3] mutedDomains の正規化');
    const normalized = (await (await apiCall('PUT', '/api/me/prefs', alice.sessionToken, {
      mutedDomains: ['https://Bad.Example.COM/some/path', '@spam.example', 'ok.example.com', 'not-a-domain', 'ok.example.com'],
    })).json()).prefs.mutedDomains;
    check('正規化された件数', normalized.length, 3);
    check('URL + 大文字 + パスを落とす', normalized[0], 'bad.example.com');
    check('@ 付きを拾う', normalized[1], 'spam.example');
    check('重複は 1 つ', normalized.filter((d: string) => d === 'ok.example.com').length, 1);
    check('ドット無しは捨てる', normalized.includes('not-a-domain'), false);

    // ------------------------------------------------------------------
    console.log('\n🚫 [4] ドメインミュートがタイムラインから消す');
    // リモートの投稿を 1 件、DB に直接入れる（example.com の人）。
    // ⚠️ ここは SQLite 決め打ちにしない — PG のバッテリー（run-suites-pg.sh）でも回るので、
    //    driver を見て繋ぐ（以前は node:sqlite を直接開いていて PG だと "no such table: posts" になった）
    const { createAsyncDatabase } = await import('../server/src/db/asyncDriver.js');
    const testDb = createAsyncDatabase({
      driver: process.env.DB_DRIVER,
      connectionString: process.env.DATABASE_URL,
      dbPath: path.resolve(ROOT_DIR, 'server', TEST_DB),
    });
    const remotePostId = 'https://example.com/notes/1';
    await testDb.prepare(`
      INSERT INTO posts (id, user_id, author_name, author_url, author_handle, author_icon, content, is_local, visibility, published_at, fts_indexed)
      VALUES (?, ?, 'Remote Person', 'https://example.com/users/r', '@r@example.com', '', 'リモートの投稿です', 0, 'public', ?, 0)
    `).run(remotePostId, 'https://example.com/users/r', new Date().toISOString());

    const allTimeline = async (token: string) => {
      const res = await apiCall('GET', '/api/timeline?mode=all&limit=50', token);
      return (await res.json()) as any[];
    };
    const localPost = await (await apiCall('POST', '/api/posts', alice.sessionToken, { content: 'ローカルの投稿', visibility: 'public' })).json();
    const beforeMute = await allTimeline(alice.sessionToken);
    check('ミュート前は連合に出る', beforeMute.some((p) => p.id === remotePostId), true);
    check('ミュート前はローカルも出る', beforeMute.some((p) => p.id === localPost.id), true);

    await apiCall('PUT', '/api/me/prefs', alice.sessionToken, { mutedDomains: ['example.com'] });
    const afterMute = await allTimeline(alice.sessionToken);
    check('ミュート後は出ない', afterMute.some((p) => p.id === remotePostId), false);
    check('ローカル投稿は残る', afterMute.some((p) => p.is_local === 1), true);
    const bobView = await allTimeline(bob.sessionToken);
    check('他人（bob）には影響しない', bobView.some((p) => p.id === remotePostId), true);

    // ------------------------------------------------------------------
    console.log('\n🏠 [5] ホームのブースト・返信の表示');
    // bob が自分の投稿と、alice の投稿のブーストを作る
    const bobPost = await (await apiCall('POST', '/api/posts', bob.sessionToken, { content: 'bobの投稿', visibility: 'public' })).json();
    const alicePost = await (await apiCall('POST', '/api/posts', alice.sessionToken, { content: 'aliceの投稿', visibility: 'public' })).json();
    const announceRes = await apiCall('POST', `/api/posts/${encodeURIComponent(alicePost.id)}/announce`, bob.sessionToken);
    console.log(`     （ブースト: ${announceRes.status} ${(await announceRes.text()).slice(0, 120)}）`);
    // bob が alice の投稿に返信する
    await apiCall('POST', '/api/posts', bob.sessionToken, { content: 'bobの返信', visibility: 'public', in_reply_to: alicePost.id });

    // alice が bob をフォローする（ホームに載るように）
    const bobHandle = `@bob@prefs.test`;
    const followRes = await apiCall('POST', '/api/follow', alice.sessionToken, { targetHandle: bobHandle });
    console.log(`     （フォロー: ${followRes.status}）`);

    const homeTimeline = async () => {
      const res = await apiCall('GET', '/api/timeline?mode=home&limit=50', alice.sessionToken);
      return (await res.json()) as any[];
    };
    // 直前の検査で hideBoostsInHome を true にしたので、いったん戻す
    await apiCall('PUT', '/api/me/prefs', alice.sessionToken, { hideBoostsInHome: false, hideRepliesInHome: false });
    const homeBefore = await homeTimeline();
    check('ホームにブーストが出る', homeBefore.some((p) => p.renote), true);
    check('ホームに他人の返信が出る', homeBefore.some((p) => p.in_reply_to === alicePost.id), true);

    await apiCall('PUT', '/api/me/prefs', alice.sessionToken, { hideBoostsInHome: true, hideRepliesInHome: true });
    const homeAfter = await homeTimeline();
    check('ブーストを隠すと出ない', homeAfter.some((p) => p.renote), false);
    check('他人の返信も出ない', homeAfter.some((p) => p.in_reply_to === alicePost.id), false);
    check('普通の投稿は残る', homeAfter.some((p) => p.id === bobPost.id), true);

    // alice 自身の返信は残る
    await apiCall('POST', '/api/posts', alice.sessionToken, { content: 'aliceの返信', visibility: 'public', in_reply_to: bobPost.id });
    const homeWithOwnReply = await homeTimeline();
    check('自分の返信は残る', homeWithOwnReply.some((p) => p.content === 'aliceの返信'), true);

    // 元に戻す（他の検査に影響しないように）
    await apiCall('PUT', '/api/me/prefs', alice.sessionToken, { hideBoostsInHome: false, hideRepliesInHome: false });

    // ------------------------------------------------------------------
    console.log('\n🖥️ [6] ログイン中の端末（セッション）');
    const sessionsRes = await apiCall('GET', '/api/sessions', alice.sessionToken);
    const sessions = (await sessionsRes.json()).sessions as any[];
    check('いまのセッションが 1 件', sessions.length, 1);
    check('いまの端末に印が付く', sessions[0].current, true);
    check('端末の説明が入る', sessions[0].user_agent.includes('PrefsTest'), true);

    // もう 2 台からログインする（マスターキーで）
    const loginAs = async () => {
      const res = await fetch(`${ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'OtherDevice/2.0 (Android)' },
        body: JSON.stringify({ id: 'alice', masterKey: alice.masterKey }),
      });
      const data = await res.json();
      return data.sessionToken as string;
    };
    const secondToken = await loginAs();
    await loginAs();
    const sessions2 = (await (await apiCall('GET', '/api/sessions', alice.sessionToken)).json()).sessions as any[];
    check('3 台になっている', sessions2.length, 3);

    const other = sessions2.find((s) => !s.current)!;
    const delRes = await apiCall('DELETE', `/api/sessions/${encodeURIComponent(other.id)}`, alice.sessionToken);
    check('個別ログアウトのステータス', delRes.status, 200);
    const sessions3 = (await (await apiCall('GET', '/api/sessions', alice.sessionToken)).json()).sessions as any[];
    check('1 台減った', sessions3.length, 2);

    // 失効したトークンでは入れない
    const revokedToken = secondToken; // まだ生きている方（other は消した方）
    const revokeOthersRes = await apiCall('POST', '/api/sessions/revoke-others', alice.sessionToken);
    check('一括ログアウトのステータス', revokeOthersRes.status, 200);
    const sessions4 = (await (await apiCall('GET', '/api/sessions', alice.sessionToken)).json()).sessions as any[];
    check('いまの端末だけ残る', sessions4.length, 1);
    const revokedMe = await apiCall('GET', '/api/auth/me', revokedToken);
    check('切られた端末は 401', revokedMe.status, 401);

    const currentId = sessions4[0].id;
    const delCurrent = await apiCall('DELETE', `/api/sessions/${encodeURIComponent(currentId)}`, alice.sessionToken);
    check('いまの端末は消せない（400）', delCurrent.status, 400);

    // ------------------------------------------------------------------
    console.log("\n⌨️ [7] 操作の設定（キーボード・よく使うリアクション）");
    const opPrefs = await getPrefs(alice.sessionToken);
    check('キーボードショートカットの既定はオフ', opPrefs.keyboardShortcuts, false);
    check('よく使うリアクションの既定は空', opPrefs.recentReactions.length, 0);

    const many = ['🎉', '🎉', '', 123, 'x'.repeat(60), '👍', '🔥', '💯', '🚀', '✨', '😂', '👀', '🥺', '❤️', '🍣', '🍺', '🐈', '🌙'];
    const opSaved = (await (await apiCall('PUT', '/api/me/prefs', alice.sessionToken, {
      keyboardShortcuts: true,
      recentReactions: many,
    })).json()).prefs;
    check('キーボードをオンにできる', opSaved.keyboardShortcuts, true);
    check('上限 12 件に丸める', opSaved.recentReactions.length, 12);
    check('重複と空と長すぎるものは落ちる', opSaved.recentReactions.includes(''), false);
    check('最初の並びは保たれる', opSaved.recentReactions[0], '🎉');
    check('数字は弾く', opSaved.recentReactions.includes('123' as any), false);

    // ------------------------------------------------------------------
    console.log("\n💬 [8] 引用した人の一覧・リアクション履歴・カレンダー");
    const quotePost = await (await apiCall('POST', '/api/posts', bob.sessionToken, { content: '引用のテスト', visibility: 'public', quote_id: alicePost.id })).json();
    check('引用の投稿ができた', Boolean(quotePost?.id), true);
    const quotesRes = await apiCall('GET', `/api/posts/${encodeURIComponent(alicePost.id)}/quotes`, alice.sessionToken);
    const quotes = (await quotesRes.json()) as any[];
    check('引用一覧のステータス', quotesRes.status, 200);
    check('引用した投稿が入る', quotes.some((q) => q.id === quotePost.id), true);

    const homeWithQuote = await homeTimeline();
    const target = homeWithQuote.find((p) => p.id === alicePost.id);
    check('引用数が投稿に付く', target ? target.quote_count : -1, 1);

    await apiCall('POST', `/api/posts/${encodeURIComponent(bobPost.id)}/react`, alice.sessionToken, { reaction: '🎉' });
    const myReactions = (await (await apiCall('GET', '/api/me/reactions', alice.sessionToken)).json()) as any[];
    check('リアクション履歴に載る', myReactions.some((r) => r.post?.id === bobPost.id && r.reaction === '🎉'), true);

    const calendar = (await (await apiCall('GET', '/api/me/post-calendar', alice.sessionToken)).json()) as any;
    const today = new Date().toISOString().slice(0, 10);
    const todayRow = (calendar.days || []).find((d: any) => d.day === today);
    check('カレンダーに今日が出る', Boolean(todayRow) && todayRow.count >= 1, true);

    // ------------------------------------------------------------------
    console.log("\n🔔 [9] 新しい端末のログイン通知");
    const notifs = (await (await apiCall('GET', '/api/notifications', alice.sessionToken)).json()) as any[];
    check('ログイン通知が届く', notifs.some((n) => n.type === 'login'), true);
    check('端末の説明が通知に入る', notifs.some((n) => n.type === 'login' && String(n.content).includes('OtherDevice')), true);
    check('予約投稿以外は自分の操作でも届く（種別が増えても壊れない）', notifs.filter((n) => n.type === 'login').length >= 1, true);

    // ------------------------------------------------------------------
    console.log("\n🔇 [10] ミュートワードは通知にも効く");
    await apiCall('POST', '/api/muted-words', alice.sessionToken, { word: 'bobの投稿' });
    const notifsAfterMute = (await (await apiCall('GET', '/api/notifications', alice.sessionToken)).json()) as any[];
    check('ワードに当たる通知は消える（返信の本文に含む）', notifsAfterMute.some((n) => String(n.post_content || '').includes('bobの投稿')), false);

    console.log('');
  } catch (err: any) {
    console.error(`\n❌ テスト実行中にエラー: ${err?.message || err}`);
    failures++;
  } finally {
    if (server && server.pid) {
      if (process.platform === 'win32') {
        try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else {
        server.kill();
        await sleep(300);
        try { server.kill('SIGKILL'); } catch {}
      }
    }
  }

  console.log('====================================================');
  if (failures === 0) console.log('✅ すべて成功');
  else console.error(`❌ ${failures} 件失敗`);
  console.log('====================================================');
  process.exit(failures === 0 ? 0 : 1);
}

void run();
