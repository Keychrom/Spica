import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// アカウント移行インポート（投稿の取り込み）の検証
//
//   1. Mastodon 形式（outbox.json）: 公開範囲の変換・CW・元の投稿日時の保持
//   2. Misskey 形式（notes.json）: visibility の変換・specified(DM相当)の除外
//   3. 重複: 同じアーカイブを再取り込みしても増えない
//   4. 不正ファイル: JSON でない / 形式が違う場合は 400
//   5. 取り込んだ投稿がタイムライン・プロフィールに反映される
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_import.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 4111;
const BASE = `http://localhost:${PORT}`;
const PUBLIC_URI = 'https://www.w3.org/ns/activitystreams#Public';

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
      `空きポートを指定して実行してください:  TEST_PORT=4120 npx tsx scripts/test-import.ts`,
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

/** Mastodon の outbox.json を組み立てる */
function buildMastodonArchive() {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'OrderedCollection',
    totalItems: 3,
    orderedItems: [
      {
        type: 'Create',
        object: {
          id: 'https://old.example/users/migrator/statuses/1',
          type: 'Note',
          content: '<p>移行テストの1件目です</p><p>2行目<br />3行目</p>',
          published: '2024-01-05T10:00:00Z',
          to: [PUBLIC_URI],
          cc: [],
        },
      },
      {
        type: 'Create',
        object: {
          id: 'https://old.example/users/migrator/statuses/2',
          type: 'Note',
          content: '<p>未収載の投稿です</p>',
          summary: 'ネタバレ注意',
          published: '2024-02-10T12:30:00Z',
          to: ['https://old.example/users/migrator/followers'],
          cc: [PUBLIC_URI],
        },
      },
      {
        type: 'Create',
        object: {
          id: 'https://old.example/users/migrator/statuses/3',
          type: 'Note',
          content: '<p>フォロワー限定の投稿です</p>',
          published: '2024-03-15T08:15:00Z',
          to: ['https://old.example/users/migrator/followers'],
          cc: [],
        },
      },
    ],
  };
}

/** Misskey の notes.json を組み立てる */
function buildMisskeyArchive() {
  return [
    { id: 'misskeynote1', text: 'Misskeyからの移行テスト', createdAt: '2023-12-01T01:23:45.000Z', visibility: 'public', cw: null },
    { id: 'misskeynote2', text: 'ホーム限定の投稿', createdAt: '2023-12-02T02:00:00.000Z', visibility: 'home', cw: 'CW付き' },
    { id: 'misskeynote3', text: 'フォロワー限定の投稿', createdAt: '2023-12-03T03:00:00.000Z', visibility: 'followers', cw: null },
    { id: 'misskeynote4', text: 'ダイレクト相当（取り込まない）', createdAt: '2023-12-04T04:00:00.000Z', visibility: 'specified', cw: null },
  ];
}

function buildForm(json: unknown, filename: string): FormData {
  const form = new FormData();
  form.append('archive', new Blob([JSON.stringify(json)], { type: 'application/json' }), filename);
  return form;
}

async function run() {
  console.log('====================================================');
  console.log('🧪 アカウント移行インポート（投稿取り込み）の検証');
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
        INSTANCE_NAME: 'Import Test',
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
      return { token: body.sessionToken as string, actorUrl: body.user.actorUrl as string };
    };
    const alice = await register('alice');
    const bob = await register('bob');
    const headers = { Authorization: `Bearer ${alice.token}` };

    const profilePosts = async (token: string) => {
      const res = await fetch(`${BASE}/api/users/alice/posts?limit=100`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return (await res.json()) as any[];
    };

    // ------------------------------------------------------------------
    console.log('📥 [1] Mastodon 形式（outbox.json）');
    const mastodonRes = await fetch(`${BASE}/api/import/archive`, {
      method: 'POST', headers, body: buildForm(buildMastodonArchive(), 'outbox.json'),
    });
    check('インポートのステータス', mastodonRes.status, 200);
    const mastodonResult = await mastodonRes.json();
    check('形式判定', mastodonResult.format, 'mastodon');
    check('取り込み件数', mastodonResult.imported, 3);
    check('スキップ件数', mastodonResult.skipped, 0);
    check('失敗件数', mastodonResult.failed, 0);

    const posts = await profilePosts(alice.token);
    check('プロフィールに反映される', posts.length, 3);
    // 元の投稿日時の降順で並ぶ（時系列が維持される）
    check('元の投稿日時が保持される(最新)', posts[0]?.published_at, '2024-03-15T08:15:00.000Z');
    check('元の投稿日時が保持される(最古)', posts[2]?.published_at, '2024-01-05T10:00:00.000Z');
    const publicPost = posts.find((p) => p.published_at === '2024-01-05T10:00:00.000Z');
    const unlistedPost = posts.find((p) => p.published_at === '2024-02-10T12:30:00.000Z');
    const privatePost = posts.find((p) => p.published_at === '2024-03-15T08:15:00.000Z');
    check('公開の公開範囲', publicPost?.visibility, 'public');
    check('未収載の公開範囲', unlistedPost?.visibility, 'local');
    check('フォロワー限定の公開範囲', privatePost?.visibility, 'followers');
    check('CW が取り込まれる', unlistedPost?.cw, 'ネタバレ注意');
    check('HTMLがプレーンテキスト化される', publicPost?.content, '移行テストの1件目です\n2行目\n3行目');

    // タイムラインにも出る（公開分）
    const tlRes = await fetch(`${BASE}/api/timeline?mode=all&limit=100`, { headers });
    const tl = (await tlRes.json()) as any[];
    check('公開投稿はタイムラインに出る', tl.some((p: any) => (p.post_id ?? p.id) === publicPost?.id), true);
    check('フォロワー限定は第三者に出ない', (await (async () => {
      const other = await fetch(`${BASE}/api/timeline?mode=all&limit=100`, { headers: { Authorization: `Bearer ${bob.token}` } });
      const rows = (await other.json()) as any[];
      return rows.some((p: any) => (p.post_id ?? p.id) === privatePost?.id);
    })()), false);

    // ------------------------------------------------------------------
    console.log('\n🔁 [2] 重複の防止（同じアーカイブの再取り込み）');
    const againRes = await fetch(`${BASE}/api/import/archive`, {
      method: 'POST', headers, body: buildForm(buildMastodonArchive(), 'outbox.json'),
    });
    const againResult = await againRes.json();
    check('再取り込みでも増えない(imported)', againResult.imported, 0);
    check('すべてスキップされる', againResult.skipped, 3);
    check('プロフィール件数は3件のまま', (await profilePosts(alice.token)).length, 3);

    // ------------------------------------------------------------------
    console.log('\n📥 [3] Misskey 形式（notes.json）');
    const misskeyRes = await fetch(`${BASE}/api/import/archive`, {
      method: 'POST', headers, body: buildForm(buildMisskeyArchive(), 'notes.json'),
    });
    const misskeyResult = await misskeyRes.json();
    check('形式判定', misskeyResult.format, 'misskey');
    check('取り込み件数（specified を除く3件）', misskeyResult.imported, 3);

    const postsAfter = await profilePosts(alice.token);
    check('合計6件になる', postsAfter.length, 6);
    const homePost = postsAfter.find((p) => p.published_at === '2023-12-02T02:00:00.000Z');
    const followersPost = postsAfter.find((p) => p.published_at === '2023-12-03T03:00:00.000Z');
    check('home はローカル限定に変換', homePost?.visibility, 'local');
    check('followers はそのまま', followersPost?.visibility, 'followers');
    check('Misskey の CW が取り込まれる', homePost?.cw, 'CW付き');
    check('specified(DM相当)は取り込まれない', postsAfter.some((p) => String(p.content).includes('ダイレクト相当')), false);

    // ------------------------------------------------------------------
    console.log('\n🚫 [4] 不正な入力');
    const notJson = new FormData();
    notJson.append('archive', new Blob(['this is not json'], { type: 'application/json' }), 'broken.json');
    const brokenRes = await fetch(`${BASE}/api/import/archive`, { method: 'POST', headers, body: notJson });
    check('JSONとして壊れている場合は 400', brokenRes.status, 400);

    const unknownFormat = await fetch(`${BASE}/api/import/archive`, {
      method: 'POST', headers, body: buildForm({ foo: 'bar' }, 'unknown.json'),
    });
    check('形式が違う場合は 400', unknownFormat.status, 400);

    const noAuth = await fetch(`${BASE}/api/import/archive`, {
      method: 'POST', body: buildForm(buildMastodonArchive(), 'outbox.json'),
    });
    check('未ログインは 401', noAuth.status, 401);

    const otherUserPosts = await fetch(`${BASE}/api/users/alice/posts?limit=100`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    check('他人のプロフィールは取得できる（公開分のみ）', otherUserPosts.status, 200);

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 インポートの検証: すべて成功');
    } else {
      console.error(`❌ インポートの検証: ${failures} 件失敗`);
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
