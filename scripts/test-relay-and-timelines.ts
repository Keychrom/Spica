import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ポートは TEST_PORT で変更可能（既定 3000）。稼働中の開発サーバーと衝突させずに実行できる。
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3000;
const BASE = `http://localhost:${PORT}`;
const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_relay.sqlite';

const MISSKEY_ACTOR = 'https://misskey.io/users/9xyz9876';
const RELAY_ACTOR = 'https://relay.example.com/actor';

// テストDBのクリーンアップ
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

// 稼働中のサーバーへ誤ってリクエストを送らないためのガード。
// bind の成否は Windows では当てにならない（0.0.0.0 で待受中でも 127.0.0.1 へ bind できてしまう）ため、
// 実際に TCP 接続できるかどうかで判定する。接続のみでデータは送信しない。
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
      `空きポートを指定して実行してください:  TEST_PORT=3410 npx tsx scripts/test-relay-and-timelines.ts`,
    );
  }
}

async function waitForServer(url: string, maxRetries = 30): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

// --- リモートサーバーを模した署名ヘルパー ---

function generateTestKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey as unknown as string, privateKeyPem: privateKey as unknown as string };
}

function signInboxRequest(params: { body: string; keyId: string; privateKeyPem: string }): Record<string, string> {
  const host = `localhost:${PORT}`;
  const date = new Date().toUTCString();
  const digest = `SHA-256=${crypto.createHash('sha256').update(Buffer.from(params.body, 'utf8')).digest('base64')}`;
  const contentType = 'application/activity+json';
  const signedHeaderNames = ['(request-target)', 'host', 'date', 'digest', 'content-type'];

  const signingString = [
    '(request-target): post /inbox',
    `host: ${host}`,
    `date: ${date}`,
    `digest: ${digest}`,
    `content-type: ${contentType}`,
  ].join('\n');

  const signer = crypto.createSign('sha256');
  signer.update(signingString);
  const signature = signer.sign(params.privateKeyPem, 'base64');

  return {
    Host: host,
    Date: date,
    Digest: digest,
    'Content-Type': contentType,
    Signature: `keyId="${params.keyId}",algorithm="rsa-sha256",headers="${signedHeaderNames.join(' ')}",signature="${signature}"`,
  };
}

async function run() {
  console.log('====================================================');
  console.log('🧪 リレー対応・タイムライン3層化・Misskeyフォロー検証');
  console.log(`   port=${PORT}`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;
  const misskeyKeys = generateTestKeyPair();
  const relayKeys = generateTestKeyPair();

  try {
    await assertPortFree(PORT);

    console.log(`▶️ サーバーを起動中 (Port ${PORT})...`);
    server = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: 'spica.test',
        PROTOCOL: 'https',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'AstraBit Relay Test',
      },
      stdio: 'pipe',
      shell: true,
    });

    server.stdout?.on('data', (d) => console.log(`[Server] ${d.toString().trim()}`));

    console.log('⏳ 起動待機中...');
    const ok = await waitForServer(BASE);
    if (!ok) throw new Error('サーバー起動失敗');
    console.log('✅ サーバー起動完了！\n');

    // 1. 管理者アカウント作成
    console.log('👤 [ステップ 1] 管理者アカウント admin を作成...');
    const regRes = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'admin', name: 'Astra Admin' }),
    });
    const admin = await regRes.json();
    if (!admin?.user?.handle) {
      throw new Error(`管理者作成に失敗: ${JSON.stringify(admin)}`);
    }
    console.log(`✅ 管理者作成完了: ${admin.user.handle}`);

    // リモートサーバーを模すため、remote_actors に公開鍵を事前登録する
    // （実サーバー不要で鍵解決がキャッシュヒットするようにする）
    const dbPath = path.resolve(ROOT_DIR, 'server', TEST_DB);
    const { DatabaseSync } = await import('node:sqlite');
    const testDb = new DatabaseSync(dbPath);
    const seedRemoteActor = async (actorUrl: string, publicKeyPem: string, inboxUrl: string) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          testDb.prepare(`
            INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
            VALUES (?, ?, ?, 'Remote Actor', '', '', '', ?, NULL, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET public_key_pem = excluded.public_key_pem
          `).run(
            actorUrl,
            actorUrl.split('/').pop() || 'user',
            new URL(actorUrl).host,
            inboxUrl,
            `${actorUrl}#main-key`,
            publicKeyPem,
            new Date().toISOString(),
          );
          return;
        } catch (err) {
          if (attempt === 9) throw err;
          await sleep(200); // SQLite のロック競合をリトライ
        }
      }
    };
    await seedRemoteActor(MISSKEY_ACTOR, misskeyKeys.publicKeyPem, 'https://misskey.io/inbox');
    await seedRemoteActor(RELAY_ACTOR, relayKeys.publicKeyPem, 'https://relay.example.com/inbox');
    console.log('🗝️ リモートアクターの公開鍵を登録完了\n');

    // 2. Misskey からの Follow Activity シミュレーション（署名付き）
    console.log('\n🤝 [ステップ 2] Misskey からのフォロー受信テスト (Shared Inbox: /inbox)...');
    const misskeyFollowBody = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: 'https://misskey.io/activities/9abc1234',
      type: 'Follow',
      actor: MISSKEY_ACTOR,
      object: `https://spica.test/users/admin`,
    });

    const followRes = await fetch(`${BASE}/inbox`, {
      method: 'POST',
      headers: signInboxRequest({
        body: misskeyFollowBody,
        keyId: `${MISSKEY_ACTOR}#main-key`,
        privateKeyPem: misskeyKeys.privateKeyPem,
      }),
      body: misskeyFollowBody,
    });
    console.log(`✅ Follow受信レスポンス: HTTP ${followRes.status}`);
    if (followRes.status !== 202) {
      throw new Error(`署名付き Follow が受理されませんでした (HTTP ${followRes.status})`);
    }

    // フォロワー一覧を確認
    const followersRes = await fetch(`${BASE}/api/followers?userId=admin`);
    const followers = await followersRes.json();
    console.log(`✅ adminのフォロワー数: ${followers.length}`);
    console.log(`✅ 登録されたフォロワーURL: ${followers[0]?.follower_url}`);

    if (followers.length === 0 || followers[0]?.follower_url !== MISSKEY_ACTOR) {
      throw new Error('Misskeyからのフォロワー登録が確認できませんでした。');
    }
    console.log('🎉 Misskeyからのフォロー判定・フォロワー登録が完全成功！');

    // 3. タイムライン 3層の検証
    console.log('\n📝 [ステップ 3] タイムライン 3層（ローカル / ホーム / 連合）の検証...');

    // A: ローカル投稿を作成
    await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${admin.sessionToken}`,
      },
      body: JSON.stringify({ content: '【ローカル】AstraBitローカル投稿です🏠' }),
    });

    // B: フォロー中Misskeyユーザーの投稿を受信（署名付き）
    const misskeyNoteBody = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: 'https://misskey.io/notes/note1234/activity',
      type: 'Create',
      actor: MISSKEY_ACTOR,
      object: {
        id: 'https://misskey.io/notes/note1234',
        type: 'Note',
        attributedTo: MISSKEY_ACTOR,
        content: '【Misskeyフォロー中】Misskeyからの投稿です🐱',
        published: new Date().toISOString(),
      },
    });
    const misskeyNoteRes = await fetch(`${BASE}/inbox`, {
      method: 'POST',
      headers: signInboxRequest({
        body: misskeyNoteBody,
        keyId: `${MISSKEY_ACTOR}#main-key`,
        privateKeyPem: misskeyKeys.privateKeyPem,
      }),
      body: misskeyNoteBody,
    });
    if (misskeyNoteRes.status !== 201) {
      throw new Error(`署名付き Create が受理されませんでした (HTTP ${misskeyNoteRes.status})`);
    }

    // C: リレーから流れてきた第三者の投稿（Announce / ブースト）を受信（署名付き）
    const relayAnnounceBody = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: 'https://relay.example.com/announce/4567',
      type: 'Announce',
      actor: RELAY_ACTOR,
      object: {
        id: 'https://mastodon.social/users/someone/statuses/8888',
        type: 'Note',
        attributedTo: 'https://mastodon.social/users/someone',
        content: '【リレー連合】世界中のリレーから流れてきたMastodon投稿です🐘',
        published: new Date().toISOString(),
      },
    });
    const relayAnnounceRes = await fetch(`${BASE}/inbox`, {
      method: 'POST',
      headers: signInboxRequest({
        body: relayAnnounceBody,
        keyId: `${RELAY_ACTOR}#main-key`,
        privateKeyPem: relayKeys.privateKeyPem,
      }),
      body: relayAnnounceBody,
    });
    console.log(`✅ リレー Announce 受信レスポンス: HTTP ${relayAnnounceRes.status}`);
    if (relayAnnounceRes.status !== 200) {
      throw new Error(`署名付き Announce が受理されませんでした (HTTP ${relayAnnounceRes.status})`);
    }

    // タイムラインの取得と検証
    // 1) ローカルタイムライン
    const localRes = await fetch(`${BASE}/api/timeline?mode=local`);
    const localPosts = await localRes.json();
    console.log(`🏠 [ローカルTL件数]: ${localPosts.length} 件`);
    console.log(`   - 投稿内容: ${localPosts[0]?.content}`);
    if (localPosts.length !== 1 || !localPosts[0]?.content.includes('【ローカル】')) {
      throw new Error('ローカルタイムラインのフィルタリングが不正です。');
    }

    // 2) ホームタイムライン (ローカル + フォロー中Misskey)
    // admin が misskey ユーザーをフォローしている状態を DB に登録
    const now = new Date().toISOString();
    const followId = `${admin.user.actorUrl} -> ${MISSKEY_ACTOR}`;
    // follows テーブルに直接挿入 (外部実サーバー不要で安定検証)
    testDb.prepare(`
      INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
      VALUES (?, ?, ?, 'https://misskey.io/inbox', 1, 'accepted', ?)
      ON CONFLICT(follower_url, following_url) DO NOTHING
    `).run(followId, admin.user.actorUrl, MISSKEY_ACTOR, now);

    const homeRes = await fetch(`${BASE}/api/timeline?mode=home`, {
      headers: { Authorization: `Bearer ${admin.sessionToken}` },
    });
    const homePosts = await homeRes.json();
    console.log(`👥 [ホームTL件数]: ${homePosts.length} 件 (ローカル + フォロー中Misskey)`);
    if (homePosts.length !== 2) {
      throw new Error(`ホームタイムライン件数が不正です (期待値: 2, 実際: ${homePosts.length})`);
    }

    // 3) 連合タイムライン (リレー含む全件)
    const fedRes = await fetch(`${BASE}/api/timeline?mode=all`);
    const fedPosts = await fedRes.json();
    console.log(`🌐 [連合TL件数]: ${fedPosts.length} 件 (リレーデータ含む全件)`);
    // 投稿3件（ローカル / Misskey / リレー元ノート）+ リレーAnnounceのリノート表示1件。
    // タイムラインは UNION ALL のため、リノートは「リノートした人」の情報付きで別エントリとして並ぶ
    // （Misskey / Mastodon のブースト表示と同じ挙動）。
    if (fedPosts.length !== 4) {
      throw new Error(`連合タイムライン件数が不正です (期待値: 4, 実際: ${fedPosts.length})`);
    }
    const relayedEntry = fedPosts.find((p: any) => p.renote?.url === RELAY_ACTOR);
    if (!relayedEntry) {
      throw new Error('リレーAnnounceのリノート情報が連合タイムラインに反映されていません。');
    }
    console.log(`🔁 リレーAnnounceのリノート表示: ${relayedEntry.renote.handle} → ${relayedEntry.content?.slice(0, 20)}...`);
    console.log('🎉 タイムラインの3層分離（ローカル / ホーム / 連合）が完全動作！');

    // 4. リレーサーバー管理 API テスト
    console.log('\n📡 [ステップ 4] リレーサーバー接続 API テスト...');
    const relayRes = await fetch(`${BASE}/api/admin/relays`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${admin.sessionToken}`,
      },
      body: JSON.stringify({ url: 'https://relay.test.net/inbox' }),
    });
    const relayData = await relayRes.json();
    console.log(`✅ リレー登録完了: ${relayData.inboxUrl} (status: ${relayData.status})`);

    // リレー一覧取得
    const relayListRes = await fetch(`${BASE}/api/admin/relays`, {
      headers: { Authorization: `Bearer ${admin.sessionToken}` },
    });
    const relayList = await relayListRes.json();
    console.log(`✅ 登録済みリレー数: ${relayList.length}`);
    if (relayList.length !== 1) {
      throw new Error('リレー登録の反映が確認できませんでした。');
    }

    console.log('\n====================================================');
    console.log('🎊 リレー対応・タイムライン3層化・Misskeyフォロー全検証成功！');
    console.log('====================================================');

    try { testDb.close(); } catch {}

  } catch (err) {
    console.error('❌ テスト失敗:', err);
    process.exitCode = 1;
  } finally {
    console.log('🧹 サーバープロセスを終了中...');
    if (server && server.pid) {
      try { spawn('taskkill', ['/pid', server.pid.toString(), '/f', '/t'], { shell: true }); } catch {}
    }
  }
}

run();
