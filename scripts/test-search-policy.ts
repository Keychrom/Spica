import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';

// ============================================================================
// リモートコンテンツの保存・索引ポリシーの検証
//
// Mastodon / Misskey に合わせ、既定では「リモート投稿の本文は索引しない」
// 「フォロー外のブーストは保存しない」。設定（管理画面 / 環境変数）で切り替えられる。
//
//   1. FTS スコープ local（既定）: ローカルは索引・リモートは索引しない
//   2. FTS スコープ follows: フォロー中アクターの投稿は索引する
//   3. FTS スコープ all: すべて索引する（従来挙動）
//   4. ブースト方針 follows（既定）: フォロー外のブーストは保存しない
//   5. ブースト方針 all: 保存する / none: 保存しない
//   6. 遡及適用: 既存データへ方針を適用（索引から外す / ブースト削除）
//   7. 管理APIで切り替えられる
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_search_policy.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3691;
const BASE = `http://localhost:${PORT}`;
const REMOTE_ACTOR = 'https://remote.test/users/eve';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

[TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
  for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});

// テストプロセス内で server/src/db.ts を読み込む場合に備え、必ずテスト用DBを指す
// （未設定のままだと cwd の別のDBを開いてしまうため）
process.env.DB_PATH = path.resolve(ROOT_DIR, 'server', TEST_DB);

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
  if (inUse) throw new Error(`ポート ${port} は使用中です。TEST_PORT=3700 のように空きポートを指定してください。`);
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

function generateTestKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey as unknown as string, privateKeyPem: privateKey as unknown as string };
}

function signInboxRequest(body: string, keyId: string, privateKeyPem: string): Record<string, string> {
  const host = `localhost:${PORT}`;
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
  console.log('🧪 検索索引・リモートブーストの方針 検証テスト');
  console.log(`   server=${PORT}`);
  console.log('====================================================\n');

  const tsxCli = path.resolve(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  let server: ChildProcess | null = null;
  let completed = false;

  const startServer = async (env: Record<string, string> = {}): Promise<ChildProcess> => {
    const child = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Search Policy Test',
        RATE_LIMIT_DISABLED: 'true',
        ...env,
      },
      stdio: 'pipe',
    });
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
    if (!(await waitForServer(BASE))) throw new Error('サーバー起動失敗');
    return child;
  };
  const stopServer = async (child: ChildProcess | null): Promise<void> => {
    if (!child) return;
    child.kill('SIGTERM');
    for (let i = 0; i < 20; i++) {
      try { await assertPortFree(PORT); break; } catch { await sleep(300); }
    }
    try { child.kill('SIGKILL'); } catch {}
  };

  try {
    await assertPortFree(PORT);
    // 既定（local / follows）で起動
    server = await startServer();
    console.log('✅ サーバー起動完了（既定: FTS=local, ブースト=follows）\n');

    // --- 準備: ローカルユーザー + リモートアクター + フォロー関係 ---
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'alice', name: 'alice', agreedToRules: true }),
    });
    const alice = await reg.json();
    const token = alice.sessionToken as string;

    const keys = generateTestKeyPair();
    const db = new DatabaseSync(path.resolve(ROOT_DIR, 'server', TEST_DB));
    db.exec('PRAGMA busy_timeout = 10000');
    const seedActor = (id: string, username: string, publicKeyPem: string) => {
      db.prepare(
        `INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
         VALUES (?, ?, 'remote.test', ?, '', '', '', ?, NULL, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET public_key_pem = excluded.public_key_pem`,
      ).run(id, username, username, `${id}/inbox`, `${id}#main-key`, publicKeyPem, new Date().toISOString());
    };
    seedActor(REMOTE_ACTOR, 'eve', keys.publicKeyPem);
    // alice が eve をフォロー（ローカル→リモートのフォロー）
    db.prepare(
      `INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
       VALUES (?, ?, ?, ?, 1, 'accepted', ?)
       ON CONFLICT(follower_url, following_url) DO UPDATE SET status = 'accepted'`,
    ).run('f-eve', alice.user.actorUrl, REMOTE_ACTOR, `${REMOTE_ACTOR}/inbox`, new Date().toISOString());

    const deliverNote = async (id: string, content: string) => {
      const activity = {
        '@context': ['https://www.w3.org/ns/activitystreams'],
        id: `${REMOTE_ACTOR}/activities/${encodeURIComponent(id)}`,
        type: 'Create',
        actor: REMOTE_ACTOR,
        to: [PUBLIC],
        object: { id, type: 'Note', attributedTo: REMOTE_ACTOR, content, published: new Date().toISOString(), to: [PUBLIC] },
      };
      const body = JSON.stringify(activity);
      return fetch(`${BASE}/inbox`, { method: 'POST', headers: signInboxRequest(body, `${REMOTE_ACTOR}#main-key`, keys.privateKeyPem), body });
    };
    const deliverAnnounce = async (id: string, targetId: string) => {
      const activity = {
        '@context': ['https://www.w3.org/ns/activitystreams'],
        id: `${REMOTE_ACTOR}/activities/${encodeURIComponent(id)}`,
        type: 'Announce',
        actor: REMOTE_ACTOR,
        to: [PUBLIC],
        object: targetId,
      };
      const body = JSON.stringify(activity);
      return fetch(`${BASE}/inbox`, { method: 'POST', headers: signInboxRequest(body, `${REMOTE_ACTOR}#main-key`, keys.privateKeyPem), body });
    };

    const ftsRow = (postId: string) => db.prepare('SELECT COUNT(*) AS c FROM posts_fts WHERE post_id = ?').get(postId) as { c: number };
    const postRow = (postId: string) => db.prepare('SELECT fts_indexed FROM posts WHERE id = ?').get(postId) as { fts_indexed: number } | undefined;
    const makeLocalPost = async (content: string) => {
      const res = await fetch(`${BASE}/api/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content }),
      });
      return (await res.json()).id as string;
    };

    // ------------------------------------------------------------------
    console.log('🔎 [1] 既定（FTS=local）: ローカルは索引・リモートは索引しない');
    const local1 = await makeLocalPost('ローカルの検索テスト投稿');
    await deliverNote(`${REMOTE_ACTOR}/notes/r1`, 'リモートの検索テスト投稿（フォロー中）');
    await sleep(500);
    check('ローカル投稿は索引される', ftsRow(local1).c, 1);
    check('フォロー中でもリモート投稿は索引しない（既定）', ftsRow(`${REMOTE_ACTOR}/notes/r1`).c, 0);
    check('リモート投稿の fts_indexed は 0', postRow(`${REMOTE_ACTOR}/notes/r1`)?.fts_indexed, 0);
    const searchLocal = await (await fetch(`${BASE}/api/search?q=検索テスト投稿`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const foundIds = (searchLocal.posts || []).map((p: any) => p.id);
    check('検索でローカル投稿は見つかる', foundIds.includes(local1), true);
    check('検索でリモート投稿は出ない', foundIds.includes(`${REMOTE_ACTOR}/notes/r1`), false);

    // ------------------------------------------------------------------
    console.log('\n🎛️ [7] 管理APIで follows に切り替え');
    const adminSet = await fetch(`${BASE}/api/admin/content-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ftsIndexScope: 'follows' }),
    });
    check('管理APIで設定できる', adminSet.status, 200);
    const afterSet = await adminSet.json();
    check('設定値が返る', afterSet.fts_index_scope, 'follows');

    console.log('\n🔎 [2] FTS=follows: フォロー中アクターの投稿は索引する');
    await deliverNote(`${REMOTE_ACTOR}/notes/r2`, 'フォロー中の人のリモート投稿');
    await sleep(500);
    check('フォロー中のリモート投稿は索引される', ftsRow(`${REMOTE_ACTOR}/notes/r2`).c, 1);

    // フォローしていないアクターからの投稿
    const otherKeys = generateTestKeyPair();
    const OTHER_ACTOR = 'https://remote.test/users/mallory';
    seedActor(OTHER_ACTOR, 'mallory', otherKeys.publicKeyPem);
    const otherActivity = {
      '@context': ['https://www.w3.org/ns/activitystreams'],
      id: `${OTHER_ACTOR}/activities/x1`,
      type: 'Create',
      actor: OTHER_ACTOR,
      to: [PUBLIC],
      object: { id: `${OTHER_ACTOR}/notes/x1`, type: 'Note', attributedTo: OTHER_ACTOR, content: 'フォロー外の人の投稿', published: new Date().toISOString(), to: [PUBLIC] },
    };
    const otherBody = JSON.stringify(otherActivity);
    await fetch(`${BASE}/inbox`, { method: 'POST', headers: signInboxRequest(otherBody, `${OTHER_ACTOR}#main-key`, otherKeys.privateKeyPem), body: otherBody });
    await sleep(500);
    check('フォロー外のリモート投稿は索引しない', ftsRow(`${OTHER_ACTOR}/notes/x1`).c, 0);

    console.log('\n🔎 [3] FTS=all: すべて索引する（従来挙動）');
    await fetch(`${BASE}/api/admin/content-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ftsIndexScope: 'all' }),
    });
    await deliverNote(`${REMOTE_ACTOR}/notes/r3`, '全索引モードのリモート投稿');
    await sleep(500);
    check('all ではリモート投稿も索引される', ftsRow(`${REMOTE_ACTOR}/notes/r3`).c, 1);

    // ------------------------------------------------------------------
    console.log('\n🔇 [4] ブースト方針（既定 follows）: フォロー外のブーストは保存しない');
    const target = await makeLocalPost('ブースト対象のローカル投稿');
    const annFollowed = await deliverAnnounce(`${REMOTE_ACTOR}/announces/a1`, target);
    await sleep(400);
    const announceCount = (actor: string) => Number((db.prepare('SELECT COUNT(*) AS c FROM announces WHERE user_id = ?').get(actor) as any).c);
    check('フォロー中のブーストは受理される', annFollowed.status >= 200 && annFollowed.status < 300, true);
    check('フォロー中のブーストは保存される', announceCount(REMOTE_ACTOR), 1);

    const otherAnnounce = {
      '@context': ['https://www.w3.org/ns/activitystreams'],
      id: `${OTHER_ACTOR}/activities/ann1`,
      type: 'Announce',
      actor: OTHER_ACTOR,
      to: [PUBLIC],
      object: target,
    };
    const otherAnnBody = JSON.stringify(otherAnnounce);
    const otherAnnRes = await fetch(`${BASE}/inbox`, { method: 'POST', headers: signInboxRequest(otherAnnBody, `${OTHER_ACTOR}#main-key`, otherKeys.privateKeyPem), body: otherAnnBody });
    await sleep(400);
    check('フォロー外のブーストは 202（受理するが保存しない）', otherAnnRes.status, 202);
    check('フォロー外のブーストは保存されない', announceCount(OTHER_ACTOR), 0);

    console.log('\n🔇 [5] ブースト方針 all / none');
    await fetch(`${BASE}/api/admin/content-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ remoteAnnouncePolicy: 'all' }),
    });
    await fetch(`${BASE}/inbox`, { method: 'POST', headers: signInboxRequest(otherAnnBody, `${OTHER_ACTOR}#main-key`, otherKeys.privateKeyPem), body: otherAnnBody });
    await sleep(400);
    check('all ではフォロー外のブーストも保存される', announceCount(OTHER_ACTOR), 1);

    await fetch(`${BASE}/api/admin/content-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ remoteAnnouncePolicy: 'none' }),
    });
    await deliverAnnounce(`${REMOTE_ACTOR}/announces/a2`, target);
    await sleep(400);
    check('none ではリモートのブーストを保存しない', announceCount(REMOTE_ACTOR), 1);

    // ------------------------------------------------------------------
    console.log('\n🧹 [6] 遡及適用（db:maintenance の新しい手順）');
    // 方針を local / follows に戻してから（サーバー稼働中に管理APIで）、停止して適用する
    const resetPolicy = await fetch(`${BASE}/api/admin/content-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ftsIndexScope: 'local', remoteAnnouncePolicy: 'follows' }),
    });
    check('方針を local / follows に戻せる', resetPolicy.status, 200);

    await stopServer(server);
    server = null;

    const { applyFtsPolicy, applyAnnouncePolicy } = await import('../server/src/searchPolicy.js');
    // 実際のメンテナンスと同じく、専用の接続を渡して適用する
    const policyConn = new DatabaseSync(path.resolve(ROOT_DIR, 'server', TEST_DB));
    policyConn.exec('PRAGMA busy_timeout = 10000');
    const policyDb = createAsyncDatabase({ sqlite: policyConn });

    const ftsApplied = await applyFtsPolicy(policyDb);
    check('方針に反する索引が外される（リモート分）', ftsApplied.toUnindex >= 2, true);
    check('索引に入れ直す件数は 0（狭める方向）', ftsApplied.toIndex, 0);
    const localFtsAfter = Number((await policyDb.prepare('SELECT COUNT(*) AS c FROM posts_fts').get() as any).c);
    check('索引にはローカル投稿だけが残る（ローカル2件）', localFtsAfter, 2);

    const annApplied = await applyAnnouncePolicy(policyDb);
    check('方針に反するブーストが削除される', annApplied.toRemove, 1);
    check('フォロー中のブーストは残る', annApplied.remaining, 1);
    policyConn.close();

    completed = true;
  } finally {
    console.log('');
    if (!completed) console.error('❌ テストを最後まで実行できませんでした（上のエラーを参照）');
    else if (failures === 0) console.log('🎉 すべての確認に合格しました');
    else console.error(`❌ ${failures} 件の確認に失敗しました`);
    await stopServer(server);
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
