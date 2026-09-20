import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// ワードフィルター（ミュートワード）と鍵アカウント（フォロー承認制）の検証
//
//   1. ミュートワード: 一致する投稿が本人のタイムラインからのみ除外されるか
//      （他ユーザーには見える / 削除すると再表示 / 大文字小文字の区別）
//   2. 鍵アカウント: Actor に manuallyApprovesFollowers が載るか
//   3. フォロー承認フロー: 承認待ちになる → Accept が送られない → 承認で Accept が送られ
//      フォロワーに載る → フォロワー限定投稿が届く（拒否なら届かない）
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_filters_locked.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3811;
const CAPTURE_PORT = PORT + 1;
const BASE = `http://localhost:${PORT}`;

const DAVE = 'https://remote.test/users/dave';
const EVE = 'https://remote.test/users/eve';

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
      `空きポートを指定して実行してください:  TEST_PORT=3820 npx tsx scripts/test-filters-and-locked.ts`,
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

const captured: { path: string; body: any }[] = [];
function startCaptureServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body: any = raw;
        try { body = JSON.parse(raw); } catch {}
        captured.push({ path: req.url || '/', body });
        res.statusCode = 202;
        res.end('{}');
      });
    });
    server.listen(CAPTURE_PORT, '127.0.0.1', () => resolve(server));
  });
}

/** 指定した宛先（inbox パスの一部）に配送された Activity の type / Note ID を取り出す */
function activitiesTo(pathFragment: string): any[] {
  return captured.filter((c) => c.path.includes(pathFragment)).map((c) => c.body);
}
function notesTo(pathFragment: string): string[] {
  return activitiesTo(pathFragment)
    .filter((a) => a?.type === 'Create' && a.object?.id)
    .map((a) => a.object.id as string);
}
function hasActivity(pathFragment: string, type: string): boolean {
  return activitiesTo(pathFragment).some((a) => a?.type === type);
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

async function run() {
  console.log('====================================================');
  console.log('🧪 ワードフィルター / 鍵アカウントの検証テスト');
  console.log(`   server=${PORT} capture=${CAPTURE_PORT}`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;
  let capture: http.Server | null = null;

  try {
    await assertPortFree(PORT);
    await assertPortFree(CAPTURE_PORT);
    capture = await startCaptureServer();

    server = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Filters Test',
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
    const carol = await register('carol');
    const auth = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

    const createPost = async (token: string, content: string, visibility?: string) => {
      const res = await fetch(`${BASE}/api/posts`, {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ content, ...(visibility ? { visibility } : {}) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`投稿作成失敗: HTTP ${res.status} ${JSON.stringify(body)}`);
      return body.id as string;
    };

    const timelineIds = async (token: string) => {
      const res = await fetch(`${BASE}/api/timeline?mode=all&limit=100`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const rows = await res.json();
      return rows.map((r: any) => r.post_id ?? r.id);
    };

    // ------------------------------------------------------------------
    console.log('🔇 [1] ワードフィルター');
    const spoilerPostId = await createPost(carol.token, 'この作品のネタバレを含みます');
    const normalPostId = await createPost(carol.token, '今日はいい天気ですね');

    const addWord = await fetch(`${BASE}/api/muted-words`, {
      method: 'POST', headers: auth(bob.token),
      body: JSON.stringify({ keyword: 'ネタバレ' }),
    });
    check('ミュートワード追加', addWord.status, 201);
    const words = await (await fetch(`${BASE}/api/muted-words`, { headers: auth(bob.token) })).json();
    check('登録済みキーワード数', words.length, 1);
    check('キーワード内容', words[0]?.keyword, 'ネタバレ');

    const bobTimeline = await timelineIds(bob.token);
    check('bob のTLから除外される', bobTimeline.includes(spoilerPostId), false);
    check('一致しない投稿は残る', bobTimeline.includes(normalPostId), true);
    const carolTimeline = await timelineIds(carol.token);
    check('他ユーザーには見える(carol)', carolTimeline.includes(spoilerPostId), true);
    const aliceTimeline = await timelineIds(alice.token);
    check('他ユーザーには見える(alice)', aliceTimeline.includes(spoilerPostId), true);

    // 大文字小文字の区別
    await fetch(`${BASE}/api/muted-words`, {
      method: 'POST', headers: auth(bob.token),
      body: JSON.stringify({ keyword: 'SPOILER', caseSensitive: true }),
    });
    const lowerPost = await createPost(carol.token, 'spoiler 小文字は対象外');
    const upperPost = await createPost(carol.token, 'SPOILER 大文字は対象');
    const bobTimeline2 = await timelineIds(bob.token);
    check('大文字小文字を区別: 小文字は残る', bobTimeline2.includes(lowerPost), true);
    check('大文字小文字を区別: 大文字は除外', bobTimeline2.includes(upperPost), false);

    // 削除すると再表示される
    await fetch(`${BASE}/api/muted-words/${encodeURIComponent(words[0].id)}`, {
      method: 'DELETE', headers: auth(bob.token),
    });
    const bobTimeline3 = await timelineIds(bob.token);
    check('削除すると再表示される', bobTimeline3.includes(spoilerPostId), true);
    const dupAdd = await fetch(`${BASE}/api/muted-words`, {
      method: 'POST', headers: auth(bob.token),
      body: JSON.stringify({ keyword: 'SPOILER' }),
    });
    check('同じキーワードの重複登録は 409', dupAdd.status, 409);
    const emptyAdd = await fetch(`${BASE}/api/muted-words`, {
      method: 'POST', headers: auth(bob.token),
      body: JSON.stringify({ keyword: '   ' }),
    });
    check('空のキーワードは 400', emptyAdd.status, 400);

    // ------------------------------------------------------------------
    console.log('\n🔒 [2] 鍵アカウント設定と Actor');
    const lockRes = await fetch(`${BASE}/api/user/profile`, {
      method: 'PUT', headers: auth(alice.token),
      body: JSON.stringify({ is_locked: true }),
    });
    check('鍵アカ設定の保存', lockRes.status, 200);
    check('保存後の is_locked', (await lockRes.json()).is_locked, 1);

    const profile = await (await fetch(`${BASE}/api/users/alice`)).json();
    check('プロフィールAPIの is_locked', profile.is_locked, true);
    const actorJson = await (await fetch(`${BASE}/users/alice`, { headers: { Accept: 'application/activity+json' } })).json();
    check('Actor の manuallyApprovesFollowers', actorJson.manuallyApprovesFollowers, true);

    // ------------------------------------------------------------------
    console.log('\n⏳ [3] フォロー承認フロー');
    const daveKeys = generateTestKeyPair();
    const eveKeys = generateTestKeyPair();
    const { DatabaseSync } = await import('node:sqlite');
    const seedDb = new DatabaseSync(path.resolve(ROOT_DIR, 'server', TEST_DB));
    const seedActor = (actor: string, key: string, inbox: string) => {
      seedDb.prepare(`
        INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
        VALUES (?, ?, 'remote.test', ?, '', '', '', ?, NULL, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET inbox_url = excluded.inbox_url, public_key_pem = excluded.public_key_pem
      `).run(actor, actor.split('/').pop(), actor.split('/').pop(), inbox, `${actor}#main-key`, key, new Date().toISOString());
    };
    seedActor(DAVE, daveKeys.publicKeyPem, `http://localhost:${CAPTURE_PORT}/dave/inbox`);
    seedActor(EVE, eveKeys.publicKeyPem, `http://localhost:${CAPTURE_PORT}/eve/inbox`);

    const sendFollow = async (actor: string, key: string) => {
      const body = JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${actor}/follows/1`,
        type: 'Follow',
        actor,
        object: alice.actorUrl,
      });
      return fetch(`${BASE}/inbox`, {
        method: 'POST',
        headers: signInboxRequest(body, `${actor}#main-key`, key),
        body,
      });
    };

    const followRes = await sendFollow(DAVE, daveKeys.privateKeyPem);
    check('承認待ちとして受理される', followRes.status, 202);
    await sleep(600);
    check('承認待ちでは Accept が送られない', hasActivity('/dave/inbox', 'Accept'), false);

    const requests = await (await fetch(`${BASE}/api/follow-requests`, { headers: auth(alice.token) })).json();
    check('フォローリクエスト一覧に載る', requests.length, 1);
    check('リクエストの相手', requests[0]?.actor_url, DAVE);
    const followersBefore = await (await fetch(`${BASE}/api/followers?userId=alice`)).json();
    check('承認前はフォロワーに居ない', followersBefore.length, 0);

    // 承認待ちの相手にはフォロワー限定投稿が届かない
    const pendingNoteId = await createPost(alice.token, '承認前のフォロワー限定ノート', 'followers');
    await sleep(600);
    check('承認前はフォロワー限定が届かない(dave)', notesTo('/dave/inbox').includes(pendingNoteId), false);

    const approveRes = await fetch(`${BASE}/api/follow-requests/respond`, {
      method: 'POST', headers: auth(alice.token),
      body: JSON.stringify({ actorUrl: DAVE, action: 'accept' }),
    });
    check('承認のステータス', approveRes.status, 200);
    await sleep(700);
    check('承認で Accept が配送される', hasActivity('/dave/inbox', 'Accept'), true);

    const followersAfter = await (await fetch(`${BASE}/api/followers?userId=alice`)).json();
    check('承認後はフォロワーに載る', followersAfter.length, 1);
    check('フォロワー一覧の内容', followersAfter[0]?.follower_url, DAVE);
    const requestsAfter = await (await fetch(`${BASE}/api/follow-requests`, { headers: auth(alice.token) })).json();
    check('承認後はリクエストから消える', requestsAfter.length, 0);

    // 承認後のフォロワー限定投稿は届く
    const acceptedNoteId = await createPost(alice.token, '承認後のフォロワー限定ノート', 'followers');
    await sleep(700);
    check('承認後はフォロワー限定が届く', notesTo('/dave/inbox').includes(acceptedNoteId), true);

    // 拒否のケース
    const eveFollowRes = await sendFollow(EVE, eveKeys.privateKeyPem);
    check('2人目も承認待ちになる', eveFollowRes.status, 202);
    await sleep(400);
    const rejectRes = await fetch(`${BASE}/api/follow-requests/respond`, {
      method: 'POST', headers: auth(alice.token),
      body: JSON.stringify({ actorUrl: EVE, action: 'reject' }),
    });
    check('拒否のステータス', rejectRes.status, 200);
    await sleep(700);
    check('拒否で Reject が配送される', hasActivity('/eve/inbox', 'Reject'), true);
    const followersFinal = await (await fetch(`${BASE}/api/followers?userId=alice`)).json();
    check('拒否した相手はフォロワーに居ない', followersFinal.length, 1);
    const eveNoteId = await createPost(alice.token, '拒否後のフォロワー限定ノート', 'followers');
    await sleep(600);
    check('拒否した相手には届かない', notesTo('/eve/inbox').includes(eveNoteId), false);
    check('承認済みの相手には届く', notesTo('/dave/inbox').includes(eveNoteId), true);

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 ワードフィルター / 鍵アカウントの検証: すべて成功');
    } else {
      console.error(`❌ ワードフィルター / 鍵アカウントの検証: ${failures} 件失敗`);
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
    if (capture) capture.close();
  }
}

run();
