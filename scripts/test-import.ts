import { spawn, ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// アカウント移行インポートの検証
//
//   1. Mastodon 形式（outbox.json）: 公開範囲の変換・CW・元の投稿日時の保持
//   2. Misskey 形式（notes.json）: visibility の変換・specified(DM相当)の除外
//   3. 重複: 同じアーカイブを再取り込みしても増えない
//   4. 不正ファイル: JSON でない / 形式が違う場合は 400
//   5. 取り込んだ投稿がタイムライン・プロフィールに反映される
//   6. Spica のエクスポート（ZIP）→ 別ユーザーへの取り込み（Phase 2）:
//      投稿・メディア・フォロー・フォロワー・ブックマーク・リアクションが入る
//   7. ZIP の安全確認: 「..」を含む zip-slip のアーカイブは拒否される
//   8. Spica の JSON エクスポート（full-backup.json）: 実ファイルの無いメディアはスキップ
// ============================================================================

const require = createRequire(import.meta.url);
const archiver = require('archiver');

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

function buildZipForm(zip: Buffer, filename: string): FormData {
  const form = new FormData();
  form.append('archive', new Blob([zip], { type: 'application/zip' }), filename);
  return form;
}

/** 検査用の ZIP を組み立てる（エクスポート側と同じ archiver を使う） */
async function buildZip(entries: { name: string; data: string }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const options = { zlib: { level: 9 } };
    // ESM/CJS の読み込み方で形が変わるため、エクスポート側（exportService.ts）と同じ手順で作る
    const archive = typeof archiver === 'function'
      ? archiver('zip', options)
      : archiver.default
        ? archiver.default('zip', options)
        : new (archiver.ZipArchive ?? archiver.Archiver)('zip', options);
    archive.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    archive.on('error', (err: Error) => reject(err));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const entry of entries) {
      archive.append(entry.data, { name: entry.name });
    }
    archive.finalize().catch(reject);
  });
}

// 1x1 の PNG（アップロードと移行に使う実ファイル）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Spica の JSON エクスポート（full-backup.json）を模したフィクスチャ。
 * メディアの実ファイルは含まれない（＝取り込み時にスキップされる）。
 */
function buildSpicaJsonFixture(bookmarkPostId: string) {
  return {
    manifest: {
      version: '1.0',
      generator: 'Spica / Import Test',
      exported_at: new Date().toISOString(),
      user_id: 'olduser',
      handle: '@olduser@old.example',
      counts: { posts: 2, following: 0, followers: 0, bookmarks: 1, reactions: 1, media: 1 },
    },
    account: {
      id: 'olduser',
      name: '旧サーバーのひと',
      summary: '',
      icon_url: '',
      banner_url: '',
      created_at: '2023-01-01T00:00:00.000Z',
      role: 'user',
      actor_url: 'https://old.example/users/olduser',
      handle: '@olduser@old.example',
      public_key_pem: 'dummy',
    },
    posts: [
      {
        id: 'https://old.example/users/olduser/posts/1',
        content: 'JSON から取り込む投稿',
        cw: null,
        visibility: 'public',
        published_at: '2024-04-01T00:00:00.000Z',
        in_reply_to: null,
        media_attachments: [],
        emojis: [],
        reactions_count: 0,
        renote_count: 0,
      },
      {
        id: 'https://old.example/users/olduser/posts/2',
        content: '1件目への返信',
        cw: 'CWつきの返信',
        visibility: 'public',
        published_at: '2024-04-02T00:00:00.000Z',
        in_reply_to: 'https://old.example/users/olduser/posts/1',
        // 実ファイルが同梱されていないメディア（取り込み時にスキップされる）
        media_attachments: [{ url: 'https://old.example/media/photo.png', mediaType: 'image/png', name: 'photo.png' }],
        emojis: [],
        reactions_count: 0,
        renote_count: 0,
      },
    ],
    following: [],
    followers: [],
    bookmarks: [
      {
        post_id: bookmarkPostId,
        bookmarked_at: '2024-04-03T00:00:00.000Z',
        content: 'ボブの投稿',
        author_name: 'ボブさん',
        author_handle: '@bob@localhost',
        published_at: '2024-04-01T00:00:00.000Z',
      },
    ],
    reactions: [
      {
        reaction: '🔥',
        post_id: bookmarkPostId,
        post_content: 'ボブの投稿',
        created_at: '2024-04-04T00:00:00.000Z',
      },
    ],
    media: [
      {
        id: 'media_old_1',
        url: 'https://old.example/media/photo.png',
        key: 'media/olduser/photo.png',
        media_type: 'image/png',
        size: 1234,
        name: 'photo.png',
        thumbnail_url: '',
        thumbnail_key: '',
        width: null,
        height: null,
        duration: null,
        post_id: 'https://old.example/users/olduser/posts/2',
        created_at: '2024-04-02T00:00:00.000Z',
      },
    ],
  };
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
        RATE_LIMIT_DISABLED: 'true',
        // エクスポートはジョブ経由なので、ワーカーを早く回して待ち時間を短くする
        JOB_INTERVAL_MS: '1000',
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

    // ------------------------------------------------------------------
    console.log('\n📦 [5] Spica のエクスポート（ZIP）→ 別ユーザーへの取り込み（Phase 2）');
    const carol = await register('carol');
    const carolHeaders = { Authorization: `Bearer ${carol.token}` };
    const jsonHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
    const userPosts = async (userId: string, token: string) => {
      const res = await fetch(`${BASE}/api/users/${userId}/posts?limit=100`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return (await res.json()) as any[];
    };

    // alice: メディア付きの投稿を用意する（実ファイルは ZIP 経由で移行される）
    const uploadForm = new FormData();
    uploadForm.append('file', new Blob([PNG], { type: 'image/png' }), 'import-photo.png');
    const uploadRes = await fetch(`${BASE}/api/media/upload`, { method: 'POST', headers, body: uploadForm });
    const uploaded = (await uploadRes.json()) as any;
    check('メディアのアップロード', typeof uploaded?.attachment?.url, 'string');

    const mediaPostRes = await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: jsonHeaders(alice.token),
      body: JSON.stringify({
        content: '写真つきの投稿（移行テスト）',
        attachments: [
          { url: uploaded.attachment.url, mediaType: 'image/png', name: 'import-photo.png', description: 'テスト画像' },
        ],
      }),
    });
    check('メディア付き投稿の作成', mediaPostRes.status, 201);

    // bob: リアクションとブックマークの対象になる投稿
    const bobPostRes = await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: jsonHeaders(bob.token),
      body: JSON.stringify({ content: 'ボブの投稿（リアクションとブックマークの対象）' }),
    });
    const bobPost = (await bobPostRes.json()) as any;
    check('ボブの投稿の作成', bobPostRes.status, 201);

    const reactRes = await fetch(`${BASE}/api/posts/${encodeURIComponent(bobPost.id)}/react`, {
      method: 'POST',
      headers: jsonHeaders(alice.token),
      body: JSON.stringify({ reaction: '🌟' }),
    });
    check('リアクションの付与', reactRes.status, 200);

    const bookmarkRes = await fetch(`${BASE}/api/bookmarks/toggle`, {
      method: 'POST',
      headers: jsonHeaders(alice.token),
      body: JSON.stringify({ postId: bobPost.id }),
    });
    const bookmarkBody = (await bookmarkRes.json()) as any;
    check('ブックマークの付与', bookmarkBody.bookmarked, true);

    // alice ⇄ bob のフォロー（ローカル同士なので即時成立）
    const followRes = await fetch(`${BASE}/api/follow`, {
      method: 'POST',
      headers: jsonHeaders(alice.token),
      body: JSON.stringify({ targetHandle: `@bob@localhost:${PORT}` }),
    });
    check('alice が bob をフォロー', ((await followRes.json()) as any).status, 'Followed');
    const followBackRes = await fetch(`${BASE}/api/follow`, {
      method: 'POST',
      headers: jsonHeaders(bob.token),
      body: JSON.stringify({ targetHandle: `@alice@localhost:${PORT}` }),
    });
    check('bob が alice をフォロー（alice のフォロワーになる）', ((await followBackRes.json()) as any).status, 'Followed');

    // alice のエクスポート（ZIP）を作ってダウンロードする
    const alicePostCount = (await profilePosts(alice.token)).length;
    const exportRes = await fetch(`${BASE}/api/user/export`, {
      method: 'POST',
      headers: jsonHeaders(alice.token),
      body: JSON.stringify({ format: 'zip' }),
    });
    check('エクスポートの受付', exportRes.status, 202);
    const exportJob = (await exportRes.json()) as any;

    let exportStatus: any = null;
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${BASE}/api/user/export/${exportJob.jobId}`, { headers });
      exportStatus = await res.json();
      if (exportStatus?.status === 'done' || exportStatus?.status === 'failed') break;
      await sleep(500);
    }
    check('エクスポートの完了', exportStatus?.status, 'done');

    const zipRes = await fetch(`${BASE}${exportStatus.downloadUrl}`, { headers });
    const zip = Buffer.from(await zipRes.arrayBuffer());
    check('ZIP のダウンロード', zipRes.status, 200);
    check('ZIP のシグネチャ', zip.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004');

    // carol が取り込む（投稿・メディア・フォロー・フォロワー・ブックマーク・リアクション）
    const carolImportRes = await fetch(`${BASE}/api/import/archive`, {
      method: 'POST',
      headers: carolHeaders,
      body: buildZipForm(zip, 'spica-export.zip'),
    });
    check('Spica ZIP の取り込み', carolImportRes.status, 200);
    const carolImport = (await carolImportRes.json()) as any;
    check('形式判定', carolImport.format, 'spica');
    check('投稿がすべて入る', carolImport.imported, alicePostCount);
    check('メディアが入る', carolImport.media?.imported, 1);
    check('メディアのスキップなし', carolImport.media?.skipped, 0);
    check('フォローが入る', carolImport.following?.imported, 1);
    check('フォロワーが入る', carolImport.followers?.imported, 1);
    check('ブックマークが入る', carolImport.bookmarks?.imported, 1);
    check('リアクションが入る', carolImport.reactions?.imported, 1);

    const carolPosts = await userPosts('carol', carol.token);
    check('carol のプロフィールに投稿が入る', carolPosts.length, alicePostCount);
    const migratedMediaPost = carolPosts.find((p) => p.content === '写真つきの投稿（移行テスト）');
    check('メディア付き投稿の添付が入る', migratedMediaPost?.media_attachments?.length, 1);
    check('添付の説明（alt）が入る', migratedMediaPost?.media_attachments?.[0]?.description, 'テスト画像');

    // メディアは carol のドライブに入り、投稿に紐づいて実ファイルが配信される
    const carolDriveRes = await fetch(`${BASE}/api/drive`, { headers: carolHeaders });
    const carolDrive = (await carolDriveRes.json()) as any;
    check('取り込んだメディアがドライブに入る', carolDrive.items?.length, 1);
    check('メディアの保存先が carol になる', String(carolDrive.items?.[0]?.url).includes('/uploads/carol/'), true);
    check('メディアが投稿に紐づく', Boolean(carolDrive.items?.[0]?.postId), true);
    const mediaFetch = await fetch(carolDrive.items[0].url);
    const mediaBytes = Buffer.from(await mediaFetch.arrayBuffer());
    check('メディアの実ファイルが配信される', mediaFetch.status, 200);
    check('メディアの中身が空でない', mediaBytes.length > 0, true);

    // フォロー / フォロワー / ブックマーク / リアクションが carol 側に反映される
    const carolFollowing = (await (await fetch(`${BASE}/api/following?userId=carol`, { headers: carolHeaders })).json()) as any[];
    check('取り込んだフォローが反映される', carolFollowing.some((f) => f.following_url === bob.actorUrl), true);
    const carolFollowers = (await (await fetch(`${BASE}/api/followers?userId=carol`, { headers: carolHeaders })).json()) as any[];
    check('取り込んだフォロワーが反映される', carolFollowers.some((f) => f.follower_url === bob.actorUrl), true);
    const carolBookmarks = (await (await fetch(`${BASE}/api/bookmarks`, { headers: carolHeaders })).json()) as any[];
    check('取り込んだブックマークが反映される', carolBookmarks.some((p) => (p.post_id ?? p.id) === bobPost.id), true);
    const carolReactions = (await (await fetch(`${BASE}/api/me/reactions`, { headers: carolHeaders })).json()) as any[];
    check('取り込んだリアクションが反映される', carolReactions.some((r) => r.reaction === '🌟' && r.post?.id === bobPost.id), true);

    // ------------------------------------------------------------------
    console.log('\n🔁 [6] Spica ZIP の再取り込み（冪等）');
    const carolAgainRes = await fetch(`${BASE}/api/import/archive`, {
      method: 'POST',
      headers: carolHeaders,
      body: buildZipForm(zip, 'spica-export.zip'),
    });
    const carolAgain = (await carolAgainRes.json()) as any;
    check('再取り込みでも投稿は増えない', carolAgain.imported, 0);
    check('すべてスキップされる', carolAgain.skipped, alicePostCount);
    check('メディアは再アップロードされない', carolAgain.media?.imported, 0);
    check('フォローは増えない', carolAgain.following?.imported, 0);
    check('フォロワーは増えない', carolAgain.followers?.imported, 0);
    check('ブックマークは増えない', carolAgain.bookmarks?.imported, 0);
    check('リアクションは増えない', carolAgain.reactions?.imported, 0);
    check('ドライブの件数は1件のまま', ((await (await fetch(`${BASE}/api/drive`, { headers: carolHeaders })).json()) as any).items?.length, 1);
    check('プロフィール件数も変わらない', (await userPosts('carol', carol.token)).length, alicePostCount);

    // ------------------------------------------------------------------
    console.log('\n🛡️ [7] ZIP の安全確認（zip-slip / 中身が空）');
    const evilZip = await buildZip([{ name: 'a/../../evil.txt', data: 'zip-slip' }]);
    const evilRes = await fetch(`${BASE}/api/import/archive`, {
      method: 'POST',
      headers: carolHeaders,
      body: buildZipForm(evilZip, 'evil.zip'),
    });
    check('「..」を含む ZIP は拒否される', evilRes.status, 400);

    const onlyMediaZip = await buildZip([{ name: 'media/carol/note.txt', data: 'not a spica export' }]);
    const onlyMediaRes = await fetch(`${BASE}/api/import/archive`, {
      method: 'POST',
      headers: carolHeaders,
      body: buildZipForm(onlyMediaZip, 'media-only.zip'),
    });
    check('取り込めるデータが無い ZIP は 400', onlyMediaRes.status, 400);

    // ------------------------------------------------------------------
    console.log('\n📄 [8] Spica の JSON エクスポート（full-backup.json）の取り込み');
    const dave = await register('dave');
    const daveHeaders = { Authorization: `Bearer ${dave.token}` };
    const jsonImportRes = await fetch(`${BASE}/api/import/archive`, {
      method: 'POST',
      headers: daveHeaders,
      body: buildForm(buildSpicaJsonFixture(bobPost.id), 'spica-full-backup.json'),
    });
    check('JSON の取り込み', jsonImportRes.status, 200);
    const jsonImport = (await jsonImportRes.json()) as any;
    check('形式判定', jsonImport.format, 'spica');
    check('投稿が入る', jsonImport.imported, 2);
    check('実ファイルの無いメディアはスキップされる', jsonImport.media?.skipped, 1);
    check('メディアは取り込まれない', jsonImport.media?.imported, 0);
    check('ブックマークが入る', jsonImport.bookmarks?.imported, 1);
    check('リアクションが入る', jsonImport.reactions?.imported, 1);

    const davePosts = await userPosts('dave', dave.token);
    const daveReply = davePosts.find((p) => p.content === '1件目への返信');
    check('CW が入る', daveReply?.cw, 'CWつきの返信');
    check('返信先が取り込み後のIDに読み替えられる', /\/users\/dave\/posts\/import-/.test(String(daveReply?.in_reply_to)), true);

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
    // 検査でアップロード・取り込みしたメディアを片付ける
    for (const id of ['alice', 'bob', 'carol', 'dave']) {
      try { fs.rmSync(path.resolve(ROOT_DIR, 'server', 'data', 'uploads', id), { recursive: true, force: true }); } catch {}
    }
  }
}

run();
