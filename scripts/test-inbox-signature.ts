import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// Inbox HTTP Signature 強制の検証テスト
//
//   1. 署名なしの Activity               -> 401 (拒否)
//   2. 第三者の鍵で署名し actor を詐称   -> 401 (拒否)
//   3. 正しく署名された Activity         -> 202 (受理)
//   4. 署名は正しいが body を改ざん      -> 401 (拒否)
//   5. 署名は正しいが Date が古すぎる    -> 401 (拒否)
//   6. 鍵を取得できない未知の actor      -> 401 (拒否)
//   7. 正しく署名された Create           -> 202 + タイムラインに反映
//
// ポートは TEST_PORT で変更可能（既定 3311）。稼働中の開発サーバーと衝突しない。
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_inbox_signature.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3311;
// サーバーへの接続先（プロキシ内部からの見え方）
const ORIGIN = `http://localhost:${PORT}`;
// 署名時に相手が指定してくる公開ドメイン。
// Cloudflare Tunnel 等のリバースプロキシは Host ヘッダーをローカルオリジンへ
// 書き換えるため、「受信した Host」と「署名された Host」が食い違う。
// 本テストはその実運用構成を再現する。
const PUBLIC_HOST = 'tunnel.test';
const PUBLIC_ORIGIN = `http://${PUBLIC_HOST}`;

const VICTIM_ACTOR = 'https://remote.test/users/alice';
const VICTIM_INBOX = 'https://remote.test/inbox';
const ATTACKER_ACTOR = 'https://attacker.test/users/eve';
const UNKNOWN_ACTOR = 'https://unknown.test/users/ghost';
// 管理画面で accepted 済みのリレー（代理転送を許可する相手）
const FORWARDER_RELAY = 'https://relay-forwarder.test/actor';

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
      `空きポートを指定して実行してください:  TEST_PORT=3320 npx tsx scripts/test-inbox-signature.ts`,
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

// --- テスト用の署名ヘルパー（サーバ実装に依存せず、仕様どおりに署名する）---

function generateTestKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey as unknown as string, privateKeyPem: privateKey as unknown as string };
}

function buildDigest(body: string): string {
  return `SHA-256=${crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('base64')}`;
}

function signInboxRequest(params: {
  body: string;
  keyId: string;
  privateKeyPem: string;
  inboxPath?: string;
  date?: string;
  host?: string;
}): Record<string, string> {
  const inboxPath = params.inboxPath ?? '/inbox';
  const host = params.host ?? PUBLIC_HOST;
  const date = params.date ?? new Date().toUTCString();
  const digest = buildDigest(params.body);
  const contentType = 'application/activity+json';

  const signedHeaderNames = ['(request-target)', 'host', 'date', 'digest', 'content-type'];
  const signingString = [
    `(request-target): post ${inboxPath}`,
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

async function postInbox(body: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  const res = await fetch(`${ORIGIN}/inbox`, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}

// --- テスト本体 ---

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
  console.log('🧪 Inbox HTTP Signature 強制テスト');
  console.log(`   port=${PORT} origin=${ORIGIN}`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;
  const victimKeys = generateTestKeyPair();
  const attackerKeys = generateTestKeyPair();

  try {
    await assertPortFree(PORT);

    console.log(`▶️ テストサーバーを起動中 (Port ${PORT})...`);
    server = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: PUBLIC_HOST, // 公開ドメイン（受信する Host ヘッダーとは異なる）
        PROTOCOL: 'http', // ローカル連合テストのため http（= プライベート宛 fetch を許可）
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Inbox Signature Test',
        INBOX_SIGNATURE_MODE: 'strict',
      },
      stdio: 'pipe',
      shell: true,
    });

    server.stdout?.on('data', (d) => console.log(`[Server] ${d.toString().trim()}`));

    if (!(await waitForServer(ORIGIN))) {
      throw new Error('サーバー起動失敗');
    }
    console.log('✅ サーバー起動完了\n');

    // 管理者を作成（最初のユーザーは自動的に管理者）
    const regRes = await fetch(`${ORIGIN}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'admin', name: 'Inbox Admin' }),
    });
    const admin = await regRes.json();
    if (!admin?.user?.handle) {
      throw new Error(`管理者作成に失敗: ${JSON.stringify(admin)}`);
    }
    console.log(`👤 管理者作成完了: ${admin.user.handle}\n`);

    // 検証対象の actor を remote_actors に事前登録しておく
    // （実サーバー不要で鍵解決を成立させるため。キャッシュヒットするので外向き fetch は発生しない）
    const dbPath = path.resolve(ROOT_DIR, 'server', TEST_DB);
    const { DatabaseSync } = await import('node:sqlite');
    const testDb = new DatabaseSync(dbPath);
    const seedActor = async (actorUrl: string, publicKeyPem: string) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          testDb.prepare(`
            INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
            VALUES (?, ?, ?, ?, '', '', '', ?, NULL, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET public_key_pem = excluded.public_key_pem
          `).run(
            actorUrl,
            actorUrl.split('/').pop() || 'user',
            new URL(actorUrl).host,
            'Test Actor',
            VICTIM_INBOX,
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
    await seedActor(VICTIM_ACTOR, victimKeys.publicKeyPem);
    console.log(`🗝️ remote_actors に公開鍵を登録: ${VICTIM_ACTOR}`);

    // 登録済みリレー（管理画面で accepted 済み）を用意する。
    // リレーは他サーバーの Activity を自分の鍵で代理転送するため、その経路を再現する。
    const forwarderKeys = generateTestKeyPair();
    await seedActor(FORWARDER_RELAY, forwarderKeys.publicKeyPem);
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        testDb.prepare(`
          INSERT INTO relays (inbox_url, actor_url, status, created_at)
          VALUES (?, ?, 'accepted', ?)
          ON CONFLICT(inbox_url) DO UPDATE SET status = 'accepted'
        `).run(`${FORWARDER_RELAY.replace(/\/actor$/, '')}/inbox`, FORWARDER_RELAY, new Date().toISOString());
        break;
      } catch (err) {
        if (attempt === 9) throw err;
        await sleep(200);
      }
    }
    console.log(`📡 登録済みリレーを用意: ${FORWARDER_RELAY}\n`);

    const victimKeyId = `${VICTIM_ACTOR}#main-key`;
    const attackerKeyId = `${ATTACKER_ACTOR}#main-key`;

    // ------------------------------------------------------------------
    // 1. 署名なし -> 401
    // ------------------------------------------------------------------
    console.log('🔒 [1] 署名なしの Activity は拒否されるか');
    const unsignedBody = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${ATTACKER_ACTOR}/activities/1`,
      type: 'Create',
      actor: VICTIM_ACTOR,
      object: {
        id: 'https://remote.test/notes/1',
        type: 'Note',
        attributedTo: VICTIM_ACTOR,
        content: 'unsigned spoofed note',
        published: new Date().toISOString(),
      },
    });
    const unsignedRes = await postInbox(unsignedBody, { 'Content-Type': 'application/activity+json' });
    check('署名なし Create のステータス', unsignedRes.status, 401);

    // ------------------------------------------------------------------
    // 2. 攻撃者の鍵で署名しつつ actor を詐称 -> 401
    // ------------------------------------------------------------------
    console.log('\n🎭 [2] 第三者の鍵で署名した actor 詐称は拒否されるか');
    const spoofBody = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${ATTACKER_ACTOR}/activities/2`,
      type: 'Create',
      actor: VICTIM_ACTOR,
      object: {
        id: 'https://remote.test/notes/2',
        type: 'Note',
        attributedTo: VICTIM_ACTOR,
        content: 'spoofed by attacker key',
        published: new Date().toISOString(),
      },
    });
    const spoofRes = await postInbox(
      spoofBody,
      signInboxRequest({ body: spoofBody, keyId: attackerKeyId, privateKeyPem: attackerKeys.privateKeyPem }),
    );
    check('actor 詐称 Create のステータス', spoofRes.status, 401);

    // ------------------------------------------------------------------
    // 3. 正しく署名された Follow -> 202
    // ------------------------------------------------------------------
    console.log('\n✅ [3] 正しく署名された Follow は受理されるか');
    const followBody = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${VICTIM_ACTOR}/activities/follow-1`,
      type: 'Follow',
      actor: VICTIM_ACTOR,
      object: `${PUBLIC_ORIGIN}/users/admin`,
    });
    const followRes = await postInbox(
      followBody,
      signInboxRequest({ body: followBody, keyId: victimKeyId, privateKeyPem: victimKeys.privateKeyPem }),
    );
    check('正規署名 Follow のステータス', followRes.status, 202);

    const followersRes = await fetch(`${ORIGIN}/api/followers?userId=admin`);
    const followers = await followersRes.json();
    check('フォロワーとして登録された件数', Array.isArray(followers) ? followers.length : -1, 1);

    // ------------------------------------------------------------------
    // 4. 署名は正しいが body を改ざん -> 401 (digest 不一致)
    // ------------------------------------------------------------------
    console.log('\n✏️  [4] 署名後に body を改ざんした Activity は拒否されるか');
    const originalBody = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${VICTIM_ACTOR}/activities/3`,
      type: 'Create',
      actor: VICTIM_ACTOR,
      object: {
        id: 'https://remote.test/notes/3',
        type: 'Note',
        attributedTo: VICTIM_ACTOR,
        content: 'original content',
        published: new Date().toISOString(),
      },
    });
    const signedHeaders = signInboxRequest({
      body: originalBody,
      keyId: victimKeyId,
      privateKeyPem: victimKeys.privateKeyPem,
    });
    const tamperedBody = originalBody.replace('original content', 'tampered content');
    const tamperedRes = await postInbox(tamperedBody, signedHeaders);
    check('改ざん Create のステータス', tamperedRes.status, 401);

    // ------------------------------------------------------------------
    // 5. 署名は正しいが Date が古すぎる -> 401 (リプレイ対策)
    // ------------------------------------------------------------------
    console.log('\n⏰ [5] Date が許容幅を超えて古い署名は拒否されるか');
    const staleBody = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${VICTIM_ACTOR}/activities/4`,
      type: 'Create',
      actor: VICTIM_ACTOR,
      object: {
        id: 'https://remote.test/notes/4',
        type: 'Note',
        attributedTo: VICTIM_ACTOR,
        content: 'replayed content',
        published: new Date().toISOString(),
      },
    });
    const staleDate = new Date(Date.now() - 13 * 60 * 60 * 1000).toUTCString();
    const staleRes = await postInbox(
      staleBody,
      signInboxRequest({
        body: staleBody,
        keyId: victimKeyId,
        privateKeyPem: victimKeys.privateKeyPem,
        date: staleDate,
      }),
    );
    check('古い Date の Create のステータス', staleRes.status, 401);

    // ------------------------------------------------------------------
    // 6. 鍵を取得できない未知の actor -> 401
    // ------------------------------------------------------------------
    console.log('\n❓ [6] 公開鍵を解決できない actor は拒否されるか');
    const unknownKeys = generateTestKeyPair();
    const unknownBody = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${UNKNOWN_ACTOR}/activities/5`,
      type: 'Create',
      actor: UNKNOWN_ACTOR,
      object: {
        id: 'https://unknown.test/notes/5',
        type: 'Note',
        attributedTo: UNKNOWN_ACTOR,
        content: 'ghost actor content',
        published: new Date().toISOString(),
      },
    });
    const unknownRes = await postInbox(
      unknownBody,
      signInboxRequest({
        body: unknownBody,
        keyId: `${UNKNOWN_ACTOR}#main-key`,
        privateKeyPem: unknownKeys.privateKeyPem,
      }),
    );
    check('未知の actor の Create のステータス', unknownRes.status, 401);

    // ------------------------------------------------------------------
    // 7. 正しく署名された Create -> 202 + タイムライン反映
    // ------------------------------------------------------------------
    console.log('\n📝 [7] 正しく署名された Create がタイムラインに反映されるか');
    const createBody = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${VICTIM_ACTOR}/activities/create-1`,
      type: 'Create',
      actor: VICTIM_ACTOR,
      object: {
        id: 'https://remote.test/notes/valid-1',
        type: 'Note',
        attributedTo: VICTIM_ACTOR,
        content: 'legitimate federated note',
        published: new Date().toISOString(),
      },
    });
    const createRes = await postInbox(
      createBody,
      signInboxRequest({ body: createBody, keyId: victimKeyId, privateKeyPem: victimKeys.privateKeyPem }),
    );
    check('正規署名 Create のステータス', createRes.status, 201);

    const tlRes = await fetch(`${ORIGIN}/api/timeline?mode=all`);
    const timeline = await tlRes.json();
    const found = Array.isArray(timeline) && timeline.some((p: any) => p.content?.includes('legitimate federated note'));
    check('タイムラインへの反映', found, true);

    // ------------------------------------------------------------------
    // 8. 登録済みリレーによる代理転送 -> 201 (受理)
    //    リレーは「他サーバーの Activity」を自分の鍵で転送するため、
    //    keyId の持ち主と actor が一致しない。信頼済みリレーからの転送は受理する。
    // ------------------------------------------------------------------
    console.log('\n📡 [8] 登録済みリレーからの代理転送は受理されるか');
    const forwardedBody = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${FORWARDER_RELAY}/activities/forward-1`,
      type: 'Create',
      actor: VICTIM_ACTOR, // 元の投稿者（転送元リレーではない）
      object: {
        id: 'https://remote.test/notes/forwarded-1',
        type: 'Note',
        attributedTo: VICTIM_ACTOR,
        content: 'relayed note via registered relay',
        published: new Date().toISOString(),
      },
    });
    const forwardedRes = await postInbox(
      forwardedBody,
      signInboxRequest({
        body: forwardedBody,
        keyId: `${FORWARDER_RELAY}#main-key`,
        privateKeyPem: forwarderKeys.privateKeyPem,
      }),
    );
    check('登録済みリレー経由の代理転送 Create のステータス', forwardedRes.status, 201);

    const tlRes2 = await fetch(`${ORIGIN}/api/timeline?mode=all`);
    const timeline2 = await tlRes2.json();
    const forwardedSaved = Array.isArray(timeline2) &&
      timeline2.some((p: any) => p.content?.includes('relayed note via registered relay'));
    check('代理転送された投稿の保存', forwardedSaved, true);

    // 拒否された Activity が保存されていないことも確認する
    const leaked = Array.isArray(timeline2) && timeline2.some((p: any) =>
      p.content?.includes('unsigned spoofed note') ||
      p.content?.includes('spoofed by attacker key') ||
      p.content?.includes('tampered content') ||
      p.content?.includes('replayed content') ||
      p.content?.includes('ghost actor content'));
    check('拒否された Activity が保存されていない', leaked, false);

    // ------------------------------------------------------------------
    // 9. 別ドメイン向けに署名された Activity -> 401
    //    host 候補を公開ドメインに広げても、無関係なドメインの署名は通らないこと
    // ------------------------------------------------------------------
    console.log('\n🌐 [9] 無関係なドメイン向けに署名された Activity は拒否されるか');
    const wrongHostBody = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${VICTIM_ACTOR}/activities/wronghost-1`,
      type: 'Create',
      actor: VICTIM_ACTOR,
      object: {
        id: 'https://remote.test/notes/wrong-host-1',
        type: 'Note',
        attributedTo: VICTIM_ACTOR,
        content: 'wrong host signed note',
        published: new Date().toISOString(),
      },
    });
    const wrongHostRes = await postInbox(
      wrongHostBody,
      signInboxRequest({
        body: wrongHostBody,
        keyId: victimKeyId,
        privateKeyPem: victimKeys.privateKeyPem,
        host: 'attacker-controlled.example',
      }),
    );
    check('別ドメイン向け署名のステータス', wrongHostRes.status, 401);

    const tlRes3 = await fetch(`${ORIGIN}/api/timeline?mode=all`);
    const timeline3 = await tlRes3.json();
    const wrongHostSaved = Array.isArray(timeline3) &&
      timeline3.some((p: any) => p.content?.includes('wrong host signed note'));
    check('別ドメイン向け署名の投稿が保存されていない', wrongHostSaved, false);

    // ------------------------------------------------------------------
    // 10. 自分のローカル利用者を名乗る Activity は無視される
    //    リレーは自分の投稿も購読者へ転送するため、発信元である自分にも戻ってくる。
    //    これを受理すると同じ投稿が「連合受信」＝他人の投稿として二重に並ぶ。
    // ------------------------------------------------------------------
    console.log('\n🏠 [10] 自分のローカル利用者を名乗る Activity は無視されるか');
    const localActor = `${PUBLIC_ORIGIN}/users/admin`; // サーバーが名乗る公開ドメイン側のローカル利用者
    const localEchoBody = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${localActor}/activities/echo-1`,
      type: 'Create',
      actor: localActor,
      object: {
        id: `${localActor}/posts/echo-1`,
        type: 'Note',
        attributedTo: localActor,
        content: 'local actor echoed note',
        published: new Date().toISOString(),
      },
    });
    // 署名は付けない（自分の actor を名乗る時点で、署名の有無に関わらず処理しない）
    const localEchoRes = await postInbox(localEchoBody, { 'Content-Type': 'application/activity+json' });
    check('ローカルの actor を名乗る Create は 202（無視）', localEchoRes.status, 202);
    check('無視したことが分かる応答', localEchoRes.text.includes('local actor'), true);

    const tlRes4 = await fetch(`${ORIGIN}/api/timeline?mode=all`);
    const timeline4 = await tlRes4.json();
    const echoedSaved = Array.isArray(timeline4) &&
      timeline4.some((p: any) => p.content?.includes('local actor echoed note'));
    check('折り返された投稿が保存されていない', echoedSaved, false);

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 Inbox 署名強制テスト: すべて成功');
    } else {
      console.error(`❌ Inbox 署名強制テスト: ${failures} 件失敗`);
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
