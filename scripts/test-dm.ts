import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';

// ============================================================================
// DM（1対1のメッセージ）の検査
//
//   docs/DM.md の実装（作業順 1〜5）を、実際にサーバーを起動して確かめる。
//
//   [1] 管理者スイッチが off のとき
//       ・/api/dm/* は 404（「物理的に無い」扱い）
//       ・受信した DM は保存せず 202 / 機能フラグ features.dm = false
//   [2] on に切り替え（設定の変更だけで完結する）
//   [3] 受け取りの許可: 許可リストに無い相手は保存しない / 許可した相手は保存する
//   [4] 会話一覧・本文・既読の往復
//   [5] 第三者（宛先でないローカルユーザー）には本文も存在も見せない
//       （スレッド・検索・タイムライン・タグ・RSS・sitemap・OGP・エクスポート・AP）
//   [6] ローカル同士の送信（許可・通知・ブロック優先）
//   [7] 新しい相手への送信の 1 日あたりの上限
//
// ポートは TEST_PORT で変更可能（既定 3634）。
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_dm.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3634;
const BASE = `http://localhost:${PORT}`;
const DOMAIN = `localhost:${PORT}`;
const REMOTE_ACTOR = 'https://remote.test/users/eve';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
/** 新しい相手への送信の上限（検査では小さくして 4 人目で止まることを見る） */
const NEW_PARTNER_LIMIT = 3;

/** DM の本文にだけ入る目印（タイムライン・検索・RSS などに出ないことの確認に使う） */
const DM_SECRET = 'himitsudm12345';
const EVE_BODY = `エヴからの秘密のメッセージ ${DM_SECRET} #${DM_SECRET}`;

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

/** 保存結果を見るための口（サーバーとは別の接続。PG でも同じ形で使える） */
const openDb = (): ReturnType<typeof createAsyncDatabase> =>
  USE_PG
    ? createAsyncDatabase({ driver: 'postgres', connectionString: process.env.TEST_DATABASE_URL as string })
    : createAsyncDatabase({ driver: 'sqlite', dbPath: path.resolve(ROOT_DIR, 'server', TEST_DB) });

async function lookupPost(id: string): Promise<any> {
  const conn = openDb();
  try {
    return await conn.prepare('SELECT visibility, recipients, content FROM posts WHERE id = ?').get(id);
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
      `空きポートを指定して実行してください:  TEST_PORT=3644 npx tsx scripts/test-dm.ts`,
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
  console.log('🧪 DM（1対1のメッセージ）の検査');
  console.log(`   server=${PORT} 上限=${NEW_PARTNER_LIMIT} 人/日`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;
  let completed = false;
  const dbPath = path.resolve(ROOT_DIR, 'server', TEST_DB);
  /** 保存結果を見るための口（サーバーとは別の接続） */
  const row = (id: string): Promise<any> => lookupPost(id);

  try {
    await assertPortFree(PORT);

    // npx + shell 経由だと kill がシェルに当たるため、tsx の CLI を node で直接起動する
    const tsxCli = path.resolve(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    server = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN,
        PROTOCOL: 'http',
        DB_PATH: dbPath,
        INSTANCE_NAME: 'DM Test',
        RATE_LIMIT_DISABLED: 'true',
        DM_NEW_PARTNER_LIMIT: String(NEW_PARTNER_LIMIT),
      },
      stdio: 'pipe',
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    if (!(await waitForServer(BASE))) throw new Error('サーバー起動失敗');
    console.log('✅ サーバー起動完了\n');

    // --- ローカルユーザー ---
    const register = async (id: string) => {
      const res = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: id.toUpperCase(), agreedToRules: true }),
      });
      const data = await res.json();
      if (!data?.sessionToken) throw new Error(`${id} の作成に失敗: ${JSON.stringify(data)}`);
      return data as { sessionToken: string; user: { id: string; actorUrl: string } };
    };
    const alice = await register('alice');
    const bob = await register('bob');
    const carol = await register('carol');
    const dave = await register('dave');
    await register('erin');
    const actor = (u: { user: { actorUrl: string } }) => u.user.actorUrl;

    const api = (method: string, url: string, token: string | null, body?: unknown) =>
      fetch(`${BASE}${url}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    // --- リモートアクターをシード（署名鍵を固定するため直接投入） ---
    const keys = generateTestKeyPair();
    for (let i = 0; i < 10; i++) {
      const seed = openDb();
      try {
        await seed.prepare(
          `INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
           VALUES (?, 'eve', 'remote.test', 'Eve', '', '', '', ?, NULL, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET public_key_pem = excluded.public_key_pem`,
        ).run(
          REMOTE_ACTOR,
          `https://remote.test/inbox`,
          `${REMOTE_ACTOR}#main-key`,
          keys.publicKeyPem,
          new Date().toISOString(),
        );
        await seed.close().catch(() => {});
        break;
      } catch (err) {
        await seed.close().catch(() => {});
        if (i === 9) throw err;
        await sleep(200);
      }
    }
    console.log('✅ リモートアクター ' + REMOTE_ACTOR + ' を登録\n');

    /** リモート（eve）から Create(Note) を届ける。to に宛先だけを入れる（Public を入れない） */
    const deliver = async (noteId: string, to: string[], content: string) => {
      const activity = {
        '@context': ['https://www.w3.org/ns/activitystreams'],
        id: `${REMOTE_ACTOR}/activities/${encodeURIComponent(noteId)}`,
        type: 'Create',
        actor: REMOTE_ACTOR,
        to,
        cc: [],
        object: {
          id: noteId,
          type: 'Note',
          attributedTo: REMOTE_ACTOR,
          content,
          published: new Date().toISOString(),
          to,
          cc: [],
        },
      };
      const body = JSON.stringify(activity);
      const res = await fetch(`${BASE}/inbox`, {
        method: 'POST',
        headers: signInboxRequest(body, `${REMOTE_ACTOR}#main-key`, keys.privateKeyPem),
        body,
      });
      return res.status;
    };

    const eveDm1 = `${REMOTE_ACTOR}/notes/dm1`;

    // ======================================================================
    console.log('🔌 [1] dm_enabled が off のとき（既定）');
    const infoOff = await (await fetch(`${BASE}/api/server-info`)).json() as any;
    check('機能フラグ features.dm は false', infoOff.features?.dm, false);
    check('会話一覧は 404', (await api('GET', '/api/dm/conversations', alice.sessionToken)).status, 404);
    check('会話の本文も 404', (await api('GET', '/api/dm/conversations/x', alice.sessionToken)).status, 404);
    check('送信も 404', (await api('POST', '/api/dm/messages', alice.sessionToken, { to: 'bob', content: 'hi' })).status, 404);
    check('既読も 404', (await api('POST', '/api/dm/conversations/x/read', alice.sessionToken)).status, 404);

    const offReception = await deliver(eveDm1, [actor(alice)], EVE_BODY);
    check('受信した DM は 202（受理するが保存しない）', offReception, 202);
    await sleep(700);
    check('off のときは保存されない', await row(eveDm1), undefined);

    // ======================================================================
    console.log('\n🔛 [2] 管理画面から on にする（設定の変更だけで完結）');
    const settingsOff = await (await api('GET', '/api/admin/server-settings', alice.sessionToken)).json() as any;
    check('管理 API で dm_enabled = false が読める', settingsOff.dm_enabled, false);
    const enableRes = await api('POST', '/api/admin/server-settings', alice.sessionToken, { dm_enabled: true });
    check('管理 API で on にできる', enableRes.status, 200);
    check('保存後の応答にも入る', ((await enableRes.json()) as any).settings?.dm_enabled, true);
    check('再起動なしで管理 API に反映される', ((await (await api('GET', '/api/admin/server-settings', alice.sessionToken)).json()) as any).dm_enabled, true);
    check('機能フラグ features.dm が true になる', ((await (await fetch(`${BASE}/api/server-info`)).json()) as any).features?.dm, true);
    check('on なら /api/dm/* は生きている（認証済みで 200）', (await api('GET', '/api/dm/conversations', alice.sessionToken)).status, 200);
    check('未認証は 401（404 ではない）', (await api('GET', '/api/dm/conversations', null)).status, 401);

    // ======================================================================
    console.log('\n🔐 [3] 受け取りの許可（許可リスト）');
    const eveDm2 = `${REMOTE_ACTOR}/notes/dm2`;
    check('許可していない相手からの DM も 202', await deliver(eveDm2, [actor(alice)], EVE_BODY), 202);
    await sleep(700);
    check('許可リストに無い相手の DM は保存されない', await row(eveDm2), undefined);
    check('通知も作られない', (await (await api('GET', '/api/notifications', alice.sessionToken)).json() as any[]).filter((n) => n.type === 'dm').length, 0);

    const prefsRes = await api('PUT', '/api/me/prefs', alice.sessionToken, {
      dmPolicy: 'allowlist',
      dmAllow: [REMOTE_ACTOR],
    });
    check('設定の保存は 200', prefsRes.status, 200);
    const prefs = ((await prefsRes.json()) as any).prefs;
    check('dmPolicy が保存される', prefs.dmPolicy, 'allowlist');
    check('dmAllow が保存される', prefs.dmAllow, [REMOTE_ACTOR]);

    const eveDm3 = `${REMOTE_ACTOR}/notes/dm3`;
    const acceptedStatus = await deliver(eveDm3, [actor(alice)], EVE_BODY);
    check('許可した相手からの DM は受理される（2xx）', acceptedStatus >= 200 && acceptedStatus < 300, true);
    await sleep(700);
    const saved = await row(eveDm3);
    check('許可した相手の DM は保存される（visibility = direct）', saved?.visibility, 'direct');
    check('宛先（recipients）に自分が入る', JSON.parse(saved?.recipients || '[]'), [actor(alice)]);
    check('本文も保存されている', saved?.content, EVE_BODY);

    const aliceNotifs = (await (await api('GET', '/api/notifications', alice.sessionToken)).json()) as any[];
    const dmNotifs = aliceNotifs.filter((n) => n.type === 'dm');
    check('通知 dm が作られる', dmNotifs.length, 1);
    check('通知本文にメッセージ本文を入れない（content）', String(dmNotifs[0]?.content || '').includes(DM_SECRET), false);
    check('通知本文にメッセージ本文を入れない（post_content は空）', dmNotifs[0]?.post_content, '');
    check('通知から相手が分かる', dmNotifs[0]?.actor_id, REMOTE_ACTOR);

    const carolNotifs = (await (await api('GET', '/api/notifications', carol.sessionToken)).json()) as any[];
    check('第三者（carol）の通知には出ない', carolNotifs.some((n) => n.type === 'dm'), false);
    check('第三者（carol）の会話一覧は空', await (await api('GET', '/api/dm/conversations', carol.sessionToken)).json(), []);

    // ======================================================================
    console.log('\n💬 [4] 会話一覧・本文・既読の往復');
    const conversations = (await (await api('GET', '/api/dm/conversations', alice.sessionToken)).json()) as any[];
    check('会話が 1 件になる', conversations.length, 1);
    check('相手は eve', conversations[0]?.partner?.actor_url, REMOTE_ACTOR);
    check('未読数が 1', conversations[0]?.unread_count, 1);
    check('最終メッセージが本文を持つ', conversations[0]?.last_message?.content, EVE_BODY);
    check('最終メッセージは自分ではない', conversations[0]?.last_message?.is_mine, false);

    const conversationId = conversations[0]?.id as string;
    const thread = (await (await api('GET', `/api/dm/conversations/${encodeURIComponent(conversationId)}`, alice.sessionToken)).json()) as any;
    check('本文が取れる', thread.messages?.length, 1);
    check('本文の内容が一致する', thread.messages?.[0]?.content, EVE_BODY);
    check('受信メッセージは未読', thread.messages?.[0]?.is_read, false);

    const readRes = await api('POST', `/api/dm/conversations/${encodeURIComponent(conversationId)}/read`, alice.sessionToken);
    check('既読にできる', readRes.status, 200);
    check('既読件数が返る', ((await readRes.json()) as any).updated >= 1, true);
    const threadAfter = (await (await api('GET', `/api/dm/conversations/${encodeURIComponent(conversationId)}`, alice.sessionToken)).json()) as any;
    check('既読が反映される', threadAfter.messages?.[0]?.is_read, true);
    check('会話一覧の未読も 0', ((await (await api('GET', '/api/dm/conversations', alice.sessionToken)).json()) as any[])[0]?.unread_count, 0);

    // ======================================================================
    console.log('\n🙈 [5] 第三者には本文も存在も見せない');

    // ローカル同士の DM も作る（第三者に見えないことの確認に使う）
    const publicPost = await api('POST', '/api/posts', alice.sessionToken, { content: 'いつもの公開投稿', visibility: 'public' });
    check('比較用の公開投稿を作れる', publicPost.status, 201);
    const localSend = await api('POST', '/api/dm/messages', alice.sessionToken, { to: 'bob', content: `ローカルの秘密 ${DM_SECRET}` });
    check('ローカルへの送信もできる（201）', localSend.status, 201);
    const localSent = ((await localSend.json()) as any).message;
    const localDmId = localSent?.id as string;
    const localDmSuffix = String(localDmId || '').split('/').pop() as string;
    check('ローカルへの送信は保存される（visibility = direct）', (await row(localDmId))?.visibility, 'direct');

    check('第三者のスレッド取得は 404', (await api('GET', `/api/posts/${encodeURIComponent(localDmId)}/thread`, carol.sessionToken)).status, 404);
    check('第三者（未ログイン）のスレッドも 404', (await api('GET', `/api/posts/${encodeURIComponent(localDmId)}/thread`, null)).status, 404);

    for (const mode of ['all', 'local', 'home']) {
      const timeline = (await (await api('GET', `/api/timeline?mode=${mode}&limit=100`, carol.sessionToken)).json()) as any[];
      check(`第三者のタイムライン（${mode}）に出ない`, Array.isArray(timeline) && timeline.some((p) => p.id === localDmId), false);
    }
    const aliceTimeline = (await (await api('GET', '/api/timeline?mode=all&limit=100', alice.sessionToken)).json()) as any[];
    check('本人のタイムラインにも出ない', aliceTimeline.some((p) => p.id === localDmId), false);
    const guestTimeline = (await (await api('GET', '/api/timeline?mode=all&limit=100', null)).json()) as any[];
    check('未ログインのタイムラインにも出ない', guestTimeline.some((p) => p.id === localDmId), false);

    const search = (await (await api('GET', `/api/search?q=${DM_SECRET}`, carol.sessionToken)).json()) as any;
    check('第三者の検索に出ない', (search.posts || []).length, 0);
    const searchSelf = (await (await api('GET', `/api/search?q=${DM_SECRET}`, alice.sessionToken)).json()) as any;
    check('本人の検索にも出ない（検索の対象外）', (searchSelf.posts || []).length, 0);

    const popularTags = (await (await fetch(`${BASE}/api/tags/popular`)).json()) as any;
    check('人気タグに出ない', JSON.stringify(popularTags).includes(DM_SECRET), false);
    const autocomplete = (await (await fetch(`${BASE}/api/autocomplete/tags?q=${DM_SECRET}`)).json()) as any;
    check('タグ補完に出ない', JSON.stringify(autocomplete).includes(DM_SECRET), false);

    const profilePosts = (await (await fetch(`${BASE}/api/users/alice/posts`)).json()) as any[];
    check('プロフィールの投稿一覧に出ない', profilePosts.some((p) => p.id === localDmId), false);

    const rss = await (await fetch(`${BASE}/users/alice/feed.xml`)).text();
    check('RSS に出ない', rss.includes(DM_SECRET), false);
    const siteRss = await (await fetch(`${BASE}/feed.xml`)).text();
    check('サイト全体の RSS に出ない', siteRss.includes(DM_SECRET), false);
    const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
    check('sitemap に出ない', sitemap.includes(localDmSuffix), false);

    const ogp = await fetch(`${BASE}/?post=${encodeURIComponent(localDmId)}`, { headers: { Accept: 'text/html' } });
    const ogpHtml = await ogp.text();
    check('OGP（クローラ向け HTML）に本文が出ない', ogpHtml.includes(DM_SECRET), false);

    const ap = await fetch(`${BASE}/users/alice/posts/${localDmSuffix}`);
    check('ActivityPub のノート解決は 404', ap.status, 404);

    const notices = (await (await api('GET', '/api/notifications', carol.sessionToken)).json()) as any[];
    check('第三者に dm 通知は届かない', notices.some((n) => n.type === 'dm'), false);

    // ======================================================================
    console.log('\n📨 [6] ローカル同士の送信（許可・通知・ブロック優先）');
    // alice → bob は届かない（bob は既定で誰からも受け取らない）
    const toBob1 = await api('POST', '/api/dm/messages', alice.sessionToken, { to: '@bob@' + DOMAIN, content: `bob への最初のメッセージ ${DM_SECRET}` });
    check('許可していない相手への送信も 201', toBob1.status, 201);
    const toBob1Body = (await toBob1.json()) as any;
    check('届かなかったことが分かる（delivered = false）', toBob1Body.delivered, false);
    check('理由が返る', toBob1Body.reason, 'recipient_policy');

    check('受け取らない設定の相手には会話が出ない', await (await api('GET', '/api/dm/conversations', bob.sessionToken)).json(), []);
    check('受け取らない設定では通知も作らない', ((await (await api('GET', '/api/notifications', bob.sessionToken)).json()) as any[]).some((n) => n.type === 'dm'), false);

    // bob が alice を許可すると、届いていた分が見えるようになる
    await api('PUT', '/api/me/prefs', bob.sessionToken, { dmPolicy: 'allowlist', dmAllow: [actor(alice)] });
    const bobConversations = (await (await api('GET', '/api/dm/conversations', bob.sessionToken)).json()) as any[];
    check('許可すると会話が出る', bobConversations.length, 1);
    check('相手は alice', bobConversations[0]?.partner?.actor_url, actor(alice));
    // [5] で送った分と [6] の 1 通が同じ会話（相手ごとに 1 つ）になる
    check('未読が 2（[5] と [6] の分）', bobConversations[0]?.unread_count, 2);
    const bobThread = (await (await api('GET', `/api/dm/conversations/${encodeURIComponent(bobConversations[0].id)}`, bob.sessionToken)).json()) as any;
    check('宛先（許可済み）はスレッドも取れる', (await api('GET', `/api/posts/${encodeURIComponent(toBob1Body.message.id)}/thread`, bob.sessionToken)).status, 200);
    check('本文が 2 通（時系列）', bobThread.messages?.length, 2);
    check('最後が [6] の本文', bobThread.messages?.[1]?.content, `bob への最初のメッセージ ${DM_SECRET}`);
    check('最初が [5] の本文', bobThread.messages?.[0]?.content, `ローカルの秘密 ${DM_SECRET}`);

    // 返信（同じ会話の続き）
    const toBob2 = await api('POST', '/api/dm/messages', alice.sessionToken, {
      to: '@bob@' + DOMAIN,
      content: 'bob への返信',
      in_reply_to: toBob1Body.message.id,
    });
    check('返信は 201', toBob2.status, 201);
    const toBob2Body = (await toBob2.json()) as any;
    check('許可済みなので届く（delivered = true）', toBob2Body.delivered, true);
    check('同じ会話になる', toBob2Body.message.conversation_id, toBob1Body.message.conversation_id);

    await sleep(300);
    const bobNotifs = (await (await api('GET', '/api/notifications', bob.sessionToken)).json()) as any[];
    const bobDmNotifs = bobNotifs.filter((n) => n.type === 'dm');
    check('ローカルでも dm 通知が届く', bobDmNotifs.length >= 1, true);
    check('通知に本文を入れない', bobDmNotifs.some((n) => String(n.content || '').includes(DM_SECRET) || String(n.post_content || '').includes(DM_SECRET)), false);

    const bobConversations2 = (await (await api('GET', '/api/dm/conversations', bob.sessionToken)).json()) as any[];
    check('未読が 3 になる', bobConversations2[0]?.unread_count, 3);
    const bobRead = await api('POST', `/api/dm/conversations/${encodeURIComponent(bobConversations2[0].id)}/read`, bob.sessionToken);
    check('既読にできる', ((await bobRead.json()) as any).updated >= 3, true);
    check('既読後は未読 0', ((await (await api('GET', '/api/dm/conversations', bob.sessionToken)).json()) as any[])[0]?.unread_count, 0);
    const bobThreadAfterRead = (await (await api('GET', `/api/dm/conversations/${encodeURIComponent(bobConversations2[0].id)}`, bob.sessionToken)).json()) as any;
    check('本文も既読になる', (bobThreadAfterRead.messages || []).every((m: any) => m.is_read || m.is_mine), true);

    // ブロックは許可リストより優先する
    await api('POST', '/api/users/alice/block', bob.sessionToken);
    const blockedSend = await api('POST', '/api/dm/messages', alice.sessionToken, { to: '@bob@' + DOMAIN, content: `ブロック後 ${DM_SECRET}` });
    check('ブロックしていても送信自体はできる（201）', blockedSend.status, 201);
    check('届かない（delivered = false）', ((await blockedSend.json()) as any).delivered, false);
    check('ブロック後は会話ごと見えない', await (await api('GET', '/api/dm/conversations', bob.sessionToken)).json(), []);
    check('ブロック後はスレッドも 404', (await api('GET', `/api/posts/${encodeURIComponent(toBob1Body.message.id)}/thread`, bob.sessionToken)).status, 404);

    // 自分がブロックしている相手には送らない
    await api('POST', '/api/users/bob/block', alice.sessionToken);
    const sendToBlocked = await api('POST', '/api/dm/messages', alice.sessionToken, { to: 'bob', content: 'ブロックしている相手への送信' });
    check('自分がブロックしている相手には送れない（403）', sendToBlocked.status, 403);

    // ======================================================================
    console.log('\n🚦 [7] 新しい相手への送信の上限（スパム対策）');
    const targets = ['alice', 'bob', 'carol'];
    let sent = 0;
    for (const target of targets) {
      const res = await api('POST', '/api/dm/messages', dave.sessionToken, { to: target, content: `新規の相手 ${target}` });
      if (res.status === 201) sent++;
    }
    check(`新しい相手 ${NEW_PARTNER_LIMIT} 人までは送れる`, sent, NEW_PARTNER_LIMIT);
    const overLimit = await api('POST', '/api/dm/messages', dave.sessionToken, { to: 'erin', content: '上限を超える送信' });
    check('上限を超えると 429', overLimit.status, 429);
    check('エラー文が返る', typeof ((await overLimit.json()) as any).error, 'string');

    const firstConversations = (await (await api('GET', '/api/dm/conversations', dave.sessionToken)).json()) as any[];
    const replyTarget = firstConversations.find((c) => c.partner?.user_id === 'alice');
    const replyRes = await api('POST', '/api/dm/messages', dave.sessionToken, {
      to: 'alice',
      content: '既存の相手への返信',
      in_reply_to: replyTarget?.last_message?.id,
    });
    check('既存の相手への返信は上限に引っかからない', replyRes.status, 201);

    // ======================================================================
    console.log('\n📦 [8] エクスポートに DM を出さない（実データで確認）');
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

  // --- エクスポート（サーバーを止めてから、同じ DB を読んで確認する） ---
  if (completed) {
    try {
      if (!USE_PG) {
        process.env.DB_DRIVER = 'sqlite';
        process.env.DB_PATH = dbPath;
      }
      process.env.DOMAIN = DOMAIN;
      process.env.PORT = String(PORT);
      process.env.PROTOCOL = 'http';
      const { exportUserData } = await import('../server/src/exportService.js');
      const exported = await exportUserData('alice');
      const json = JSON.stringify(exported);
      check('エクスポートに DM の本文が出ない', json.includes(DM_SECRET), false);
      check('エクスポートした投稿に DM が混ざらない', exported.posts.every((p: any) => p.visibility !== 'direct'), true);
      check('公開投稿はエクスポートに残る', exported.posts.some((p: any) => p.content === 'いつもの公開投稿'), true);
    } catch (err: any) {
      failures++;
      checks++;
      console.error(`  ❌ エクスポートの確認に失敗: ${err?.message || err}`);
      completed = false;
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
