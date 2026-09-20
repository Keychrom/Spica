import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// カーソルページネーション検証テスト
//
//   1. タイムラインを limit で分割して全件を取得できる（取りこぼし・重複なし）
//   2. 並び順が ORDER BY と一致して単調減少している
//   3. 最終ページには X-Next-Cursor が付かない
//   4. 不正なカーソルは 400（黙って先頭ページを返さない）
//   5. プロフィール投稿 / ブックマーク / 通知 / チャンネルTL も同様に辿れる
//   6. outbox は totalItems が実数で、first → next と辿って全ノートを取得できる
//      （ホーム限定の投稿は outbox に含まれない）
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_pagination.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3511;
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

// 稼働中のサーバーへ誤ってリクエストを送らないためのガード
// （bind 判定は Windows では当てにならないため TCP 接続の成否で判定する。接続のみでデータは送信しない）
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
      `空きポートを指定して実行してください:  TEST_PORT=3520 npx tsx scripts/test-pagination.ts`,
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
  if (actual === expected) {
    console.log(`  ✅ ${name}: ${actual}`);
  } else {
    console.error(`  ❌ ${name}: 期待値 ${expected} / 実際 ${actual}`);
    failures++;
  }
}

type Row = Record<string, any>;

/** X-Next-Cursor ヘッダを辿って全ページを取得する */
async function walk(url: string, headers: Record<string, string> = {}) {
  const rows: Row[] = [];
  const cursors: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let ended = false;
  for (let i = 0; i < 60; i++) {
    const u = new URL(url);
    if (cursor) u.searchParams.set('cursor', cursor);
    const res = await fetch(u.toString(), { headers });
    if (!res.ok) {
      throw new Error(`ページ取得失敗: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    const items: Row[] = Array.isArray(data)
      ? data
      : (Array.isArray(data.posts) ? data.posts : (Array.isArray(data.orderedItems) ? data.orderedItems : []));
    rows.push(...items);
    pages++;
    const next = res.headers.get('x-next-cursor');
    if (!next) {
      ended = true;
      break;
    }
    if (cursors.includes(next)) throw new Error('カーソルが循環しています');
    cursors.push(next);
    cursor = next;
  }
  return { rows, pages, cursors, ended };
}

/** ORDER BY timeline_at DESC, post_id DESC と一致しているか（重複・取りこぼしの検出） */
function assertDescending(rows: Row[]): string | null {
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    const atA = String(a.timeline_at ?? a.published_at ?? '');
    const atB = String(b.timeline_at ?? b.published_at ?? '');
    const idA = String(a.post_id ?? a.id ?? '');
    const idB = String(b.post_id ?? b.id ?? '');
    if (atA < atB) return `${i}: ${atA} < ${atB}`;
    if (atA === atB && idA < idB) return `${i}: 同時刻で ${idA} < ${idB}`;
  }
  return null;
}

async function run() {
  console.log('====================================================');
  console.log('🧪 カーソルページネーション検証テスト');
  console.log(`   port=${PORT}`);
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
        INSTANCE_NAME: 'Pagination Test',
      },
      stdio: 'pipe',
      shell: true,
    });
    server.stdout?.on('data', () => {}); // ログは抑制

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
      return body.sessionToken as string;
    };
    const adminToken = await register('admin');
    const bobToken = await register('bob');
    const auth = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

    const createPost = async (content: string, extra: Record<string, unknown> = {}, token = adminToken) => {
      const res = await fetch(`${BASE}/api/posts`, {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ content, ...extra }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`投稿作成失敗: HTTP ${res.status} ${JSON.stringify(body)}`);
      return body.id as string;
    };

    // --- 投稿を用意 (admin: 公開24件 + ホーム限定1件) ---
    const PUBLIC_COUNT = 24;
    const adminPostIds: string[] = [];
    for (let i = 0; i < PUBLIC_COUNT; i++) {
      adminPostIds.push(await createPost(`ページネーション検証用の投稿 ${i + 1} 件目 #pagination`));
    }
    const localOnlyId = await createPost('ホーム限定の投稿（outbox には載らない）', { visibility: 'local' });
    console.log(`📝 投稿を作成: 公開 ${PUBLIC_COUNT} 件 + ホーム限定 1 件\n`);

    // ------------------------------------------------------------------
    console.log('📄 [1] タイムラインを limit=5 で分割取得');
    const tl = await walk(`${BASE}/api/timeline?mode=local&limit=5`);
    check('取得件数', tl.rows.length, PUBLIC_COUNT + 1);
    check('ページ数', tl.pages, Math.ceil((PUBLIC_COUNT + 1) / 5));
    check('最終ページでカーソルが尽きる', tl.ended, true);
    check('並び順が単調減少', assertDescending(tl.rows), null);
    const tlIds = new Set(tl.rows.map((r) => r.post_id ?? r.id));
    check('重複なく全投稿を含む', tlIds.size, PUBLIC_COUNT + 1);
    check('ホーム限定投稿もローカルTLに含まれる', tlIds.has(localOnlyId), true);

    // ------------------------------------------------------------------
    console.log('\n🚫 [2] 不正なカーソルは 400');
    const badCursor = await fetch(`${BASE}/api/timeline?mode=local&cursor=!!!not-a-cursor!!!`);
    check('不正カーソルのステータス', badCursor.status, 400);

    // ------------------------------------------------------------------
    console.log('\n📦 [3] limit 上限（1ページに収まる場合はカーソルなし）');
    const onePage = await fetch(`${BASE}/api/timeline?mode=local&limit=100`);
    const onePageRows = await onePage.json();
    check('件数', onePageRows.length, PUBLIC_COUNT + 1);
    check('X-Next-Cursor なし', onePage.headers.get('x-next-cursor'), null);

    // ------------------------------------------------------------------
    console.log('\n👤 [4] プロフィール投稿のページング');
    const profile = await walk(`${BASE}/api/users/admin/posts?limit=7`);
    check('取得件数', profile.rows.length, PUBLIC_COUNT + 1);
    check('最終ページでカーソルが尽きる', profile.ended, true);
    check('並び順が単調減少', assertDescending(profile.rows), null);

    // ------------------------------------------------------------------
    console.log('\n🔁 [5] リノートを含む連合タイムライン（UNION の境界検証）');
    const bobPostId = await createPost('bob の投稿（リノート対象）', {}, bobToken);
    const announceRes = await fetch(`${BASE}/api/posts/${encodeURIComponent(bobPostId)}/announce`, {
      method: 'POST',
      headers: auth(adminToken),
      body: JSON.stringify({}),
    });
    if (!announceRes.ok) {
      throw new Error(`リノート失敗: HTTP ${announceRes.status} ${(await announceRes.text()).slice(0, 200)}`);
    }
    check('リノート成功', announceRes.ok, true);
    const allTl = await walk(`${BASE}/api/timeline?mode=all&limit=9`);
    // 投稿 26 件（admin 25 + bob 1）+ リノート表示 1 件
    check('取得件数（投稿 + リノート行）', allTl.rows.length, PUBLIC_COUNT + 2 + 1);
    check('ページ境界で重複・取りこぼしなし', assertDescending(allTl.rows), null);
    check('最終ページでカーソルが尽きる', allTl.ended, true);

    // ------------------------------------------------------------------
    console.log('\n🔖 [6] ブックマークのページング');
    for (const pid of adminPostIds.slice(0, 3)) {
      await fetch(`${BASE}/api/bookmarks/toggle`, {
        method: 'POST',
        headers: auth(adminToken),
        body: JSON.stringify({ postId: pid }),
      });
    }
    const bm = await walk(`${BASE}/api/bookmarks?limit=2`, { Authorization: `Bearer ${adminToken}` });
    check('取得件数', bm.rows.length, 3);
    check('ページ数', bm.pages, 2);
    check('最終ページでカーソルが尽きる', bm.ended, true);

    // ------------------------------------------------------------------
    console.log('\n🔔 [7] 通知のページング');
    for (const pid of adminPostIds.slice(3, 6)) {
      const reactRes = await fetch(`${BASE}/api/posts/${encodeURIComponent(pid)}/react`, {
        method: 'POST',
        headers: auth(bobToken),
        body: JSON.stringify({ reaction: '⭐' }),
      });
      if (!reactRes.ok) {
        throw new Error(`リアクション失敗: HTTP ${reactRes.status} ${(await reactRes.text()).slice(0, 200)}`);
      }
    }
    const notif = await walk(`${BASE}/api/notifications?limit=2`, { Authorization: `Bearer ${adminToken}` });
    check('取得件数', notif.rows.length, 3);
    check('ページ数', notif.pages, 2);
    check('最終ページでカーソルが尽きる', notif.ended, true);

    // ------------------------------------------------------------------
    console.log('\n📤 [8] ActivityPub outbox のページング');
    const outboxRoot = await fetch(`${BASE}/users/admin/outbox`, { headers: { Accept: 'application/activity+json' } });
    const outbox = await outboxRoot.json();
    check('totalItems が公開ノートの実数', outbox.totalItems, PUBLIC_COUNT);
    check('first がページURL', typeof outbox.first === 'string' && outbox.first.endsWith('?page=true'), true);
    check('ルートに orderedItems がある', Array.isArray(outbox.orderedItems), true);

    // first → next を辿って全ノートを取得
    const outboxNoteIds: string[] = [];
    let nextUrl: string | null = `${BASE}/users/admin/outbox?page=true&limit=10`;
    let outboxPages = 0;
    while (nextUrl && outboxPages < 20) {
      const res = await fetch(nextUrl, { headers: { Accept: 'application/activity+json' } });
      const data = await res.json();
      check(`outbox ページ${outboxPages + 1} の type`, data.type, 'OrderedCollectionPage');
      check(`outbox ページ${outboxPages + 1} の partOf`, data.partOf, `${BASE}/users/admin/outbox`);
      check(`outbox ページ${outboxPages + 1} の totalItems`, data.totalItems, PUBLIC_COUNT);
      for (const activity of data.orderedItems || []) {
        outboxNoteIds.push(activity.object?.id ?? activity.id);
      }
      outboxPages++;
      nextUrl = data.next ?? null;
    }
    check('outbox の総ページ数（10件区切り）', outboxPages, Math.ceil(PUBLIC_COUNT / 10));
    check('outbox の合計件数', outboxNoteIds.length, PUBLIC_COUNT);
    check('ホーム限定投稿は outbox に含まれない', outboxNoteIds.includes(localOnlyId), false);
    check('outbox に重複なし', new Set(outboxNoteIds).size, PUBLIC_COUNT);

    // ------------------------------------------------------------------
    console.log('\n📺 [9] チャンネルタイムラインのページング');
    const chRes = await fetch(`${BASE}/api/channels`, {
      method: 'POST',
      headers: auth(adminToken),
      body: JSON.stringify({ name: 'ページネーションチャンネル', description: 'テスト' }),
    });
    const channel = await chRes.json();
    const chId = channel.id ?? channel.channel?.id;
    if (!chId) throw new Error(`チャンネル作成に失敗: ${JSON.stringify(channel)}`);
    for (let i = 0; i < 3; i++) {
      await createPost(`チャンネル投稿 ${i + 1}`, { channel_id: chId });
    }
    const chTl = await walk(`${BASE}/api/channels/${chId}/timeline?limit=2`);
    check('取得件数', chTl.rows.length, 3);
    check('ページ数', chTl.pages, 2);
    check('最終ページでカーソルが尽きる', chTl.ended, true);

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 ページネーション検証: すべて成功');
    } else {
      console.error(`❌ ページネーション検証: ${failures} 件失敗`);
      process.exitCode = 1;
    }
    console.log('====================================================');
  } catch (err) {
    console.error('❌ テスト実行エラー:', err);
    process.exitCode = 1;
  } finally {
    console.log('🧹 サーバープロセスを終了中...');
    if (server && server.pid) {
      try { spawn('taskkill', ['/pid', server.pid.toString(), '/f', '/t'], { shell: true }); } catch {}
    }
  }
}

run();
