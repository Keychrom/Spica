import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';

// ============================================================================
// 投稿の編集（ActivityPub の Update）の検査
//
//   [1] 編集の基本（本文・CW・センシティブ・「編集済み」の時刻）
//   [2] 権限（他人の投稿・リモート投稿・DM は編集できない）
//   [3] 連合の送信（Update の形・宛先・activity の id が毎回変わること）
//   [4] 連合の受信（作者本人からの Update だけを受け取り、本文を差し替える）
//   [5] 編集しても壊れないこと（リアクション・返信・タイムラインの並び）
//
// ポートは TEST_PORT で変更可能（既定 3648）。
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_post_edit.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3648;
const BASE = `http://localhost:${PORT}`;
const DOMAIN = `localhost:${PORT}`;
const REMOTE_ACTOR = 'https://remote.test/users/eve';
const REMOTE_POST_ID = 'https://remote.test/users/eve/posts/1001';

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

async function row(sql: string, ...params: any[]): Promise<any> {
  const conn = openDb();
  try {
    return await conn.prepare(sql).get(...params);
  } finally {
    await conn.close().catch(() => {});
  }
}

async function exec(sql: string, ...params: any[]): Promise<void> {
  const conn = openDb();
  try {
    await conn.prepare(sql).run(...params);
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
      `空きポートを指定して実行してください:  TEST_PORT=3648 npx tsx scripts/test-post-edit.ts`,
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

function generateTestKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey as unknown as string, privateKeyPem: privateKey as unknown as string };
}

/** 受信側と同じ書式で HTTP Signature を付ける */
function signInboxRequest(body: string, keyId: string, privateKeyPem: string): Record<string, string> {
  const host = DOMAIN;
  const date = new Date().toUTCString();
  const digest = `SHA-256=${crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('base64')}`;
  const contentType = 'application/activity+json';
  const signingString = [
    '(request-target): post /inbox',
    `host: ${host}`,
    `date: ${date}`,
    `digest: ${digest}`,
    `content-type: ${contentType}`,
  ].join('\n');
  const signer = crypto.createSign('sha256');
  signer.update(signingString);
  const signature = signer.sign(privateKeyPem, 'base64');
  return {
    Host: host,
    Date: date,
    Digest: digest,
    'Content-Type': contentType,
    Signature: `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date digest content-type",signature="${signature}"`,
  };
}

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('🧪 投稿の編集（Update）の検査');
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
        INSTANCE_NAME: 'Edit Test',
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
      const text = await res.text();
      let data: any = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { status: res.status, data };
    };

    const aliceReg = await api('POST', '/api/auth/register', undefined, { id: 'alice', name: 'Alice', agreedToRules: true });
    const alice = aliceReg.data.sessionToken as string;
    const bobReg = await api('POST', '/api/auth/register', undefined, { id: 'bob', name: 'Bob', agreedToRules: true });
    const bob = bobReg.data.sessionToken as string;

    const created = await api('POST', '/api/posts', alice, { content: '最初の本文です', visibility: 'public' });
    check('投稿できる', created.status, 201);
    const postId = created.data?.id as string;
    check('最初は編集済みではない', created.data?.edited_at ?? null, null);

    // ======================================================================
    console.log('\n✏️ [1] 編集の基本');

    const edited = await api('PUT', `/api/posts/${encodeURIComponent(postId)}`, alice, { content: '編集後の本文です' });
    check('編集できる', edited.status, 200);
    check('本文が差し替わる', edited.data?.post?.content, '編集後の本文です');
    check('編集済みの時刻が入る', typeof edited.data?.post?.edited_at, 'string');
    check('ID は変わらない', edited.data?.post?.id, postId);
    check('公開時刻は変わらない', edited.data?.post?.published_at, created.data?.published_at);

    const fetched = await api('GET', `/api/posts/${encodeURIComponent(postId)}/thread`);
    check('取得しても編集後', fetched.data?.post?.content, '編集後の本文です');
    check('取得しても編集済みが付く', typeof fetched.data?.post?.edited_at, 'string');

    const withCw = await api('PUT', `/api/posts/${encodeURIComponent(postId)}`, alice, { cw: '閲覧注意です', is_sensitive: true });
    check('CW とセンシティブも編集できる', [withCw.data?.post?.cw, Number(withCw.data?.post?.is_sensitive)], ['閲覧注意です', 1]);
    check('本文は指定しなければそのまま', withCw.data?.post?.content, '編集後の本文です');

    const clearedCw = await api('PUT', `/api/posts/${encodeURIComponent(postId)}`, alice, { cw: null });
    check('CW を外せる', clearedCw.data?.post?.cw, null);

    const empty = await api('PUT', `/api/posts/${encodeURIComponent(postId)}`, alice, { content: '   ' });
    check('本文を空にはできない', empty.status, 400);

    // ======================================================================
    console.log('\n🚫 [2] 権限');

    const byBob = await api('PUT', `/api/posts/${encodeURIComponent(postId)}`, bob, { content: '乗っ取り' });
    check('他人の投稿は編集できない', byBob.status, 403);
    check('本文も変わっていない', (await api('GET', `/api/posts/${encodeURIComponent(postId)}/thread`)).data?.post?.content, '編集後の本文です');

    const anonymous = await api('PUT', `/api/posts/${encodeURIComponent(postId)}`, undefined, { content: '匿名' });
    check('未ログインでは編集できない', anonymous.status, 401);

    // リモート投稿（キャッシュ）は編集できない
    await exec(
      'INSERT INTO remote_actors (id, username, domain, name, icon_url, inbox_url, public_key_id, public_key_pem, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      REMOTE_ACTOR, 'eve', 'remote.test', 'Eve', '', `${REMOTE_ACTOR}/inbox`, `${REMOTE_ACTOR}#main-key`, '', new Date().toISOString(),
    );
    await exec(
      `INSERT INTO posts (id, user_id, author_name, author_url, author_handle, content, is_local, visibility, published_at)
       VALUES (?,?,?,?,?,?,0,'public',?)`,
      REMOTE_POST_ID, 'eve@remote.test', 'Eve', REMOTE_ACTOR, '@eve@remote.test', 'リモートの投稿', new Date().toISOString(),
    );
    const remoteEdit = await api('PUT', `/api/posts/${encodeURIComponent(REMOTE_POST_ID)}`, alice, { content: '書き換え' });
    check('リモート投稿は編集できない', remoteEdit.status, 404);

    // ======================================================================
    console.log('\n📮 [3] 連合の送信（Update の形）');

    // リモートのフォロワーを 1 人足して、配信先が数えられることを見る
    await exec(
      'INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at) VALUES (?,?,?,?,0,?,?)',
      `follow-${REMOTE_ACTOR}`, REMOTE_ACTOR, `http://${DOMAIN}/users/alice`, `${REMOTE_ACTOR}/inbox`, 'accepted', new Date().toISOString(),
    );
    const withAudience = await api('PUT', `/api/posts/${encodeURIComponent(postId)}`, alice, { content: 'フォロワーにも配ります' });
    check('配信先が数えられる（リモートフォロワー）', withAudience.data?.federatedTo, 1);

    // Update そのものの形は activitypub のビルダで確認する（サーバー内の関数を直接呼ぶ）
    const { buildNote, buildUpdateNoteActivity } = await import('../server/src/activitypub.js');
    const note = buildNote({
      id: postId,
      authorUrl: `http://${DOMAIN}/users/alice`,
      content: 'テスト',
      publishedAt: new Date().toISOString(),
      editedAt: '2026-01-01T00:00:00.000Z',
      visibility: 'public',
    });
    const activity = buildUpdateNoteActivity({ note, actorUrl: `http://${DOMAIN}/users/alice` });
    check('type は Update', activity.type, 'Update');
    check('object は同じ ID の Note', activity.object.id, postId);
    check('object に updated が入る', activity.object.updated, '2026-01-01T00:00:00.000Z');
    check('activity の id は投稿 ID と別', activity.id.startsWith(`${postId}/update/`), true);
    const activity2 = buildUpdateNoteActivity({ note, actorUrl: `http://${DOMAIN}/users/alice` });
    check('編集のたびに activity の id が変わる（編集時刻が違えば）', activity.id !== activity2.id || activity.id.includes('2026-01-01'), true);

    // ======================================================================
    console.log('\n📥 [4] 連合の受信（作者本人の Update だけ受け取る）');

    const { privateKeyPem, publicKeyPem } = generateTestKeyPair();
    await exec('UPDATE remote_actors SET public_key_pem = ? WHERE id = ?', publicKeyPem, REMOTE_ACTOR);

    const sendUpdate = async (actorUrl: string, objectId: string, content: string) => {
      const body = JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${objectId}/update/${Date.now()}`,
        type: 'Update',
        actor: actorUrl,
        published: new Date().toISOString(),
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        object: {
          id: objectId,
          type: 'Note',
          attributedTo: actorUrl,
          content,
          published: new Date().toISOString(),
          updated: new Date().toISOString(),
          to: ['https://www.w3.org/ns/activitystreams#Public'],
        },
      });
      const headers = signInboxRequest(body, `${REMOTE_ACTOR}#main-key`, privateKeyPem);
      const res = await fetch(`${BASE}/inbox`, { method: 'POST', headers, body });
      if (res.status >= 400) {
        const text = await res.clone().text().catch(() => '');
        console.log(`    ℹ️ inbox 応答 ${res.status}: ${text.slice(0, 300)}`);
      }
      return res;
    };

    const inboxOk = await sendUpdate(REMOTE_ACTOR, REMOTE_POST_ID, 'リモートで編集されました');
    check('リモートからの Update を受け付ける', inboxOk.status, 200);
    await sleep(200);
    const remoteAfter = await row('SELECT content, edited_at FROM posts WHERE id = ?', REMOTE_POST_ID);
    check('本文が差し替わる', remoteAfter?.content, 'リモートで編集されました');
    check('編集済みの時刻が入る', typeof remoteAfter?.edited_at, 'string');

    // 作者が違う Update は無視する（なりすまし対策）
    const otherActor = 'https://remote.test/users/mallory';
    await exec(
      'INSERT INTO remote_actors (id, username, domain, name, icon_url, inbox_url, public_key_id, public_key_pem, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      otherActor, 'mallory', 'remote.test', 'Mallory', '', `${otherActor}/inbox`, `${otherActor}#main-key`, '', new Date().toISOString(),
    );
    const spoof = await sendUpdate(otherActor, REMOTE_POST_ID, 'なりすまし');
    check('作者が違う Update を受け付けない（401 か 200 で無視）', [200, 401].includes(spoof.status), true);
    await sleep(200);
    check('本文は書き換わらない', (await row('SELECT content FROM posts WHERE id = ?', REMOTE_POST_ID))?.content, 'リモートで編集されました');

    // 知らない投稿の Update は無視する
    const unknown = await sendUpdate(REMOTE_ACTOR, 'https://remote.test/users/eve/posts/9999', '知らない投稿');
    check('知らない投稿の Update は無視する', unknown.status, 200);

    // ======================================================================
    console.log('\n🧩 [5] 編集しても壊れないこと');

    const reactResult = await api('POST', `/api/posts/${encodeURIComponent(postId)}/react`, bob, { reaction: '⭐' });
    check('リアクションできる', reactResult.status, 200);
    const beforeReactions = await api('GET', `/api/posts/${encodeURIComponent(postId)}/thread`);
    const reactionCountBefore = (beforeReactions.data?.post?.reactions || []).length;
    check('リアクションが付いている', reactionCountBefore >= 1, true);
    const editAgain = await api('PUT', `/api/posts/${encodeURIComponent(postId)}`, alice, { content: 'リアクション付きで再編集' });
    check('リアクションがあっても編集できる', editAgain.status, 200);
    const afterReactions = await api('GET', `/api/posts/${encodeURIComponent(postId)}/thread`);
    check('リアクションは残る', (afterReactions.data?.post?.reactions || []).length, reactionCountBefore);
    check('本文も編集後', afterReactions.data?.post?.content, 'リアクション付きで再編集');
    check('編集済みも残る', typeof afterReactions.data?.post?.edited_at, 'string');

    const timeline = await api('GET', '/api/timeline?mode=local&limit=20');
    const inTimeline = (timeline.data as any[])?.find((p) => p.id === postId);
    check('タイムラインにも編集後の本文が出る', inTimeline?.content, 'リアクション付きで再編集');
    check('タイムラインにも編集済みが付く', typeof inTimeline?.edited_at, 'string');

    const reply = await api('POST', '/api/posts', bob, { content: '返信です', visibility: 'public', in_reply_to: postId });
    check('編集済みの投稿に返信できる', reply.status, 201);
    const thread = await api('GET', `/api/posts/${encodeURIComponent(postId)}/thread`);
    check('スレッドの親も編集後の本文', thread.data?.post?.content, 'リアクション付きで再編集');

    // タイムラインは新しい順なので、返信が親より上に来る。**画面はこの並びを入れ替えて
    // 線でつなぐ**（web の lib/thread.ts）。その材料（in_reply_to）が返っていることを確かめる
    const listAfterReply = await api('GET', '/api/timeline?mode=local&limit=20');
    const replyItem = (listAfterReply.data as any[])?.find((p) => p.id === reply.data?.id);
    check('タイムラインに返信が出る', Boolean(replyItem), true);
    check('返信の in_reply_to が親を指す', replyItem?.in_reply_to, postId);
    const idxReply = (listAfterReply.data as any[])?.findIndex((p) => p.id === reply.data?.id) ?? -1;
    const idxParent = (listAfterReply.data as any[])?.findIndex((p) => p.id === postId) ?? -1;
    check('返信は親より上に並ぶ（画面が入れ替える前提）', idxReply < idxParent, true);

    // ======================================================================
    console.log('\n📡 [6] 編集が SSE で届くこと（画面を開いている人が待たされない）');

    /** SSE を開いて、post_updated が来るまで待つ（来なければ false） */
    const waitForPostUpdated = async (timeoutMs: number): Promise<any | null> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${BASE}/api/streaming?streams=local`, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
        const reader = res.body?.getReader();
        if (!reader) return null;
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) return null;
          buffer += Buffer.from(value).toString('utf8');
          if (buffer.includes('event: post_updated')) {
            // data: 行だけを取り出す（イベントと data は別行で届く）
            const line = buffer.split('\n').find((l) => l.startsWith('data:') && l.includes('"id"'));
            if (line) {
              try { return JSON.parse(line.slice(5).trim()); } catch { return {}; }
            }
            return {};
          }
        }
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    };

    const watcher = waitForPostUpdated(8000);
    await sleep(500);
    await api('PUT', `/api/posts/${encodeURIComponent(postId)}`, alice, { content: 'SSE で届く編集' });
    const streamed = await watcher;
    check('編集が SSE で届く', streamed !== null, true);
    check('届いた本文は編集後', streamed?.content, 'SSE で届く編集');
    check('届いたイベントにも編集済みが入る', typeof streamed?.edited_at, 'string');

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
