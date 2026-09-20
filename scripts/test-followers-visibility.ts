import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// フォロワー限定（visibility = 'followers'）の可視性検証テスト
//
// 見落としがあると情報漏洩に直結するため、以下をすべて確認する:
//   1. 閲覧制御: 本人 / フォロワー / 第三者 / 未ログイン で見える範囲が正しいか
//      （タイムライン、プロフィール、検索、スレッド、トレンドタグ、補完、ブックマーク）
//   2. ActivityPub: 未認証の dereference が拒否されるか / outbox に載らないか
//   3. 配送: フォロワーの Inbox には届き、リレーには届かないか
//   4. 宛先: 配送された Note の to/cc が Public を含まないか
//   5. 操作: 閲覧できない相手からのリアクション・リノート・引用・ブックマークが拒否されるか
//   6. リアルタイム: フォロワー限定の投稿が SSE で全員に配信されないか
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_followers_visibility.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3611;
const CAPTURE_PORT = PORT + 1;
const BASE = `http://localhost:${PORT}`;

// シードされたテストDB（後片付けで閉じる）
let testDb: { close: () => void } | null = null;

const FOLLOWER_ACTOR = 'https://remote.test/users/dave';
const RELAY_INBOX = `http://localhost:${CAPTURE_PORT}/relay/inbox`;

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
      `空きポートを指定して実行してください:  TEST_PORT=3620 npx tsx scripts/test-followers-visibility.ts`,
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

// --- 配送ペイロードを捕捉するローカル HTTP サーバー ---
const captured: { path: string; body: any }[] = [];
function startCaptureServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try { captured.push({ path: req.url || '/', body: JSON.parse(raw) }); } catch { captured.push({ path: req.url || '/', body: raw }); }
        res.statusCode = 202;
        res.end('{}');
      });
    });
    server.listen(CAPTURE_PORT, '127.0.0.1', () => resolve(server));
  });
}

function activitiesTo(pathFragment: string): any[] {
  return captured.filter((c) => c.path.includes(pathFragment)).map((c) => c.body);
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

/** SSE を購読してイベント名を収集する */
async function openSse(token: string | null): Promise<{ events: string[]; close: () => void }> {
  const url = `${BASE}/api/streaming${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const events: string[] = [];
  (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const nameLine = part.split('\n').find((l) => l.startsWith('event:'));
          if (nameLine) events.push(nameLine.slice(6).trim());
        }
      }
    } catch {}
  })();
  return { events, close: () => controller.abort() };
}

async function run() {
  console.log('====================================================');
  console.log('🧪 フォロワー限定の可視性・配送検証テスト');
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
        INSTANCE_NAME: 'Followers Visibility Test',
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

    // bob は alice をフォローする（ローカルフォローは即 accepted）
    const followRes = await fetch(`${BASE}/api/follow`, {
      method: 'POST',
      headers: auth(bob.token),
      body: JSON.stringify({ targetHandle: `@alice@localhost:${PORT}` }),
    });
    if (!followRes.ok) throw new Error(`フォローに失敗: HTTP ${followRes.status} ${await followRes.text()}`);

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

    // --- フォロワー(dave) と リレー を用意（配送先を捕捉サーバーに向ける） ---
    const daveKeys = generateTestKeyPair();
    const { DatabaseSync } = await import('node:sqlite');
    const seedDb = new DatabaseSync(path.resolve(ROOT_DIR, 'server', TEST_DB));
    testDb = seedDb;
    const seed = (sql: string, ...args: any[]) => {
      for (let i = 0; i < 10; i++) {
        try { seedDb.prepare(sql).run(...args); return; } catch (e) { if (i === 9) throw e; }
      }
    };
    seed(
      `INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
       VALUES (?, 'dave', 'remote.test', 'Dave', '', '', '', ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET inbox_url = excluded.inbox_url, public_key_pem = excluded.public_key_pem`,
      FOLLOWER_ACTOR,
      `http://localhost:${CAPTURE_PORT}/follower/inbox`,
      `${FOLLOWER_ACTOR}#main-key`,
      daveKeys.publicKeyPem,
      new Date().toISOString(),
    );
    seed(
      `INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
       VALUES (?, ?, ?, ?, 0, 'accepted', ?)
       ON CONFLICT(follower_url, following_url) DO UPDATE SET status = 'accepted'`,
      `${FOLLOWER_ACTOR} -> ${alice.actorUrl}`,
      FOLLOWER_ACTOR,
      alice.actorUrl,
      `http://localhost:${CAPTURE_PORT}/follower/inbox`,
      new Date().toISOString(),
    );

    // リレーを登録（admin として）
    const relayRes = await fetch(`${BASE}/api/admin/relays`, {
      method: 'POST',
      headers: auth(alice.token),
      body: JSON.stringify({ url: RELAY_INBOX }),
    });
    if (!relayRes.ok) throw new Error(`リレー登録に失敗: HTTP ${relayRes.status}`);
    // 承認済みにする
    const relayList = await (await fetch(`${BASE}/api/admin/relays`, { headers: auth(alice.token) })).json();
    const relayId = relayList[0]?.inbox_url ?? relayList[0]?.inboxUrl;
    if (!relayId) throw new Error(`リレーが見つかりません: ${JSON.stringify(relayList)}`);
    await fetch(`${BASE}/api/admin/relays/toggle-status`, {
      method: 'POST',
      headers: auth(alice.token),
      body: JSON.stringify({ inboxUrl: relayId, status: 'accepted' }),
    });
    console.log(`🔗 フォロワー(${FOLLOWER_ACTOR}) と リレー を登録完了\n`);

    // --- 投稿を用意 ---
    const followersOnlyId = await createPost(alice.token, 'ひみつのフォロワー限定ノート #himitsu12345', 'followers');
    const publicId = await createPost(alice.token, 'だれでも見られる公開ノート #koukai12345', 'public');
    const localId = await createPost(alice.token, 'ローカル限定ノート', 'local');
    await sleep(800); // 配送完了待ち

    // ------------------------------------------------------------------
    console.log('📡 [1] 配送: フォロワーには届き、リレーには届かない');
    const followerNotes = activitiesTo('/follower/inbox').map((a) => a.object);
    const relayNotes = activitiesTo('/relay/inbox').map((a) => a.object);
    const followerIds = followerNotes.map((n: any) => n?.id);
    check('フォロワーの Inbox に届いたノート数', followerNotes.length, 2); // public + followers
    check('フォロワーにフォロワー限定が届く', followerIds.includes(followersOnlyId), true);
    check('フォロワーに公開が届く', followerIds.includes(publicId), true);
    const relayIds = relayNotes.map((n: any) => n?.id);
    check('リレーに公開は届く', relayIds.includes(publicId), true);
    check('リレーにフォロワー限定は届かない', relayIds.includes(followersOnlyId), false);
    check('リレーにローカル限定は届かない', relayIds.includes(localId), false);

    // ------------------------------------------------------------------
    console.log('\n✉️  [2] 宛先: フォロワー限定の to/cc に Public が含まれない');
    const followerNote = followerNotes.find((n: any) => n?.id === followersOnlyId);
    const publicNote = followerNotes.find((n: any) => n?.id === publicId);
    const PUBLIC_URI = 'https://www.w3.org/ns/activitystreams#Public';
    check('フォロワー限定の to', followerNote?.to, [`${alice.actorUrl}/followers`]);
    check('フォロワー限定の cc', followerNote?.cc, []);
    check('フォロワー限定に Public が無い', JSON.stringify(followerNote).includes(PUBLIC_URI), false);
    check('公開の to に Public がある', Array.isArray(publicNote?.to) && publicNote.to.includes(PUBLIC_URI), true);

    // ------------------------------------------------------------------
    console.log('\n👁️  [3] 閲覧制御: タイムライン');
    const timelineIds = async (token: string | null, mode = 'all') => {
      const res = await fetch(`${BASE}/api/timeline?mode=${mode}&limit=100`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const rows = await res.json();
      return rows.map((r: any) => r.post_id ?? r.id);
    };
    check('本人のTLに含まれる', (await timelineIds(alice.token)).includes(followersOnlyId), true);
    check('フォロワーのTLに含まれる', (await timelineIds(bob.token)).includes(followersOnlyId), true);
    check('第三者のTLに含まれない', (await timelineIds(carol.token)).includes(followersOnlyId), false);
    check('未ログインの連合TLに含まれない', (await timelineIds(null)).includes(followersOnlyId), false);
    check('第三者のローカルTLに含まれない', (await timelineIds(carol.token, 'local')).includes(followersOnlyId), false);
    check('未ログインのローカルTLに含まれない', (await timelineIds(null, 'local')).includes(followersOnlyId), false);

    // ------------------------------------------------------------------
    console.log('\n👤 [4] 閲覧制御: プロフィール / 検索 / スレッド / タグ');
    const profileIds = async (token: string | null) => {
      const res = await fetch(`${BASE}/api/users/alice/posts?limit=100`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const rows = await res.json();
      return rows.map((r: any) => r.id);
    };
    check('本人のプロフィールに含まれる', (await profileIds(alice.token)).includes(followersOnlyId), true);
    check('第三者のプロフィールに含まれない', (await profileIds(carol.token)).includes(followersOnlyId), false);
    check('未ログインのプロフィールに含まれない', (await profileIds(null)).includes(followersOnlyId), false);

    const searchIds = async (token: string | null, q: string) => {
      const res = await fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json();
      return (data.posts || []).map((r: any) => r.id);
    };
    check('本人の検索で見つかる', (await searchIds(alice.token, 'himitsu12345')).includes(followersOnlyId), true);
    check('第三者の検索で見つからない', (await searchIds(carol.token, 'himitsu12345')).includes(followersOnlyId), false);
    check('未ログインの検索で見つからない', (await searchIds(null, 'himitsu12345')).includes(followersOnlyId), false);

    const threadPost = async (token: string | null) => {
      const res = await fetch(`${BASE}/api/posts/${encodeURIComponent(followersOnlyId)}/thread`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json();
      return data.post?.id ?? null;
    };
    check('本人のスレッドで取得できる', await threadPost(alice.token), followersOnlyId);
    check('第三者のスレッドでは null', await threadPost(carol.token), null);
    check('未ログインのスレッドでは null', await threadPost(null), null);

    const popularTags = await (await fetch(`${BASE}/api/tags/popular`)).json();
    const popularNames = (popularTags.tags || popularTags || []).map((t: any) => t.name ?? t.tag ?? t);
    check('トレンドタグに現れない', JSON.stringify(popularNames).includes('himitsu12345'), false);
    const autocomplete = await (await fetch(`${BASE}/api/autocomplete/tags?q=himitsu`)).json();
    check('タグ補完に現れない', JSON.stringify(autocomplete).includes('himitsu12345'), false);

    // ------------------------------------------------------------------
    console.log('\n🔒 [5] ActivityPub: dereference / outbox');
    // AP の dereference は /users/:username/posts/:postId（postId は数値部分）で解決される
    const shortId = (fullId: string) => fullId.split('/').pop() as string;
    const deref = await fetch(`${BASE}/users/alice/posts/${shortId(followersOnlyId)}`, {
      headers: { Accept: 'application/activity+json' },
    });
    check('未認証の Note 解決は 403', deref.status, 403);
    const derefActivity = await fetch(`${BASE}/users/alice/posts/${shortId(followersOnlyId)}/activity`, {
      headers: { Accept: 'application/activity+json' },
    });
    check('未認証の Create 解決は 403', derefActivity.status, 403);
    const publicDeref = await fetch(`${BASE}/users/alice/posts/${shortId(publicId)}`, {
      headers: { Accept: 'application/activity+json' },
    });
    check('公開ノートの解決は 200', publicDeref.status, 200);

    const outbox = await (await fetch(`${BASE}/users/alice/outbox`, { headers: { Accept: 'application/activity+json' } })).json();
    check('outbox の totalItems は公開のみ', outbox.totalItems, 1);
    check('outbox にフォロワー限定が含まれない', JSON.stringify(outbox).includes(followersOnlyId), false);

    // ------------------------------------------------------------------
    console.log('\n🚫 [6] 操作: 閲覧できない相手からの操作は拒否');
    const react = await fetch(`${BASE}/api/posts/${encodeURIComponent(followersOnlyId)}/react`, {
      method: 'POST', headers: auth(carol.token), body: JSON.stringify({ reaction: '⭐' }),
    });
    check('第三者のリアクションは 403', react.status, 403);
    const reactBob = await fetch(`${BASE}/api/posts/${encodeURIComponent(followersOnlyId)}/react`, {
      method: 'POST', headers: auth(bob.token), body: JSON.stringify({ reaction: '⭐' }),
    });
    check('フォロワーのリアクションは成功', reactBob.ok, true);
    const announce = await fetch(`${BASE}/api/posts/${encodeURIComponent(followersOnlyId)}/announce`, {
      method: 'POST', headers: auth(carol.token), body: JSON.stringify({}),
    });
    check('第三者のリノートは 403', announce.status, 403);
    const quote = await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: auth(carol.token),
      body: JSON.stringify({ content: '引用してみる', quote_id: followersOnlyId }),
    });
    check('第三者の引用は拒否(400)', quote.status, 400);
    const bookmark = await fetch(`${BASE}/api/bookmarks/toggle`, {
      method: 'POST', headers: auth(carol.token), body: JSON.stringify({ postId: followersOnlyId }),
    });
    check('第三者のブックマークは 403', bookmark.status, 403);

    // ------------------------------------------------------------------
    console.log('\n📺 [7] リアルタイム: SSE で全員に配信されない');
    const guestSse = await openSse(null);
    const carolSse = await openSse(carol.token);
    const bobSse = await openSse(bob.token);
    await sleep(600);
    const beforeCount = guestSse.events.length + carolSse.events.length + bobSse.events.length;
    await createPost(alice.token, 'SSE検証用のフォロワー限定ノート', 'followers');
    await sleep(1500);
    check('フォロワー限定はSSEで配信されない(未ログイン)', guestSse.events.includes('note'), false);
    check('フォロワー限定はSSEで配信されない(第三者)', carolSse.events.includes('note'), false);
    check('フォロワー限定はSSEで配信されない(フォロワー)', bobSse.events.includes('note'), false);
    await createPost(alice.token, 'SSE検証用の公開ノート', 'public');
    await sleep(1500);
    check('公開ノートはSSEで配信される(未ログイン)', guestSse.events.includes('note'), true);
    guestSse.close(); carolSse.close(); bobSse.close();
    void beforeCount;

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 フォロワー限定の可視性・配送検証: すべて成功');
    } else {
      console.error(`❌ フォロワー限定の可視性・配送検証: ${failures} 件失敗`);
      process.exitCode = 1;
    }
    console.log('====================================================');
  } catch (err) {
    console.error('❌ テスト実行エラー:', err);
    process.exitCode = 1;
  } finally {
    console.log('🧹 後片付け中...');
    if (testDb) {
      try { testDb.close(); } catch {}
    }
    if (server && server.pid) {
      try { spawn('taskkill', ['/pid', server.pid.toString(), '/f', '/t'], { shell: true }); } catch {}
    }
    if (capture) capture.close();
  }
}

run();
