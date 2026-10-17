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

    // 9. 壊れた入力でもプロセスが落ちない
    //    受信のルートは署名検証・ドメイン判定・ゲート待ちを await してから try に入る。
    //    ここで例外が出ると未処理の Promise 拒否になり、**プロセスごと落ちて全停止**する
    //    （2026-09-30 まで生の async ハンドラだった）。asyncHandler で包んだうえで、
    //    変な入力を投げても応答が返り、ノードが生きていることを確かめる。
    console.log('\n── 9. 壊れた入力でも落ちない ──────────');
    const brokenCases: Array<[string, string, Record<string, string>]> = [
      ['JSON として壊れた本文', '{ this is not json', { 'Content-Type': 'application/activity+json' }],
      ['type が数値', JSON.stringify({ type: 123, actor: VICTIM_ACTOR }), { 'Content-Type': 'application/activity+json' }],
      ['actor が配列', JSON.stringify({ type: 'Create', actor: [1, 2, 3] }), { 'Content-Type': 'application/activity+json' }],
      ['actor が変な URL', JSON.stringify({ type: 'Create', actor: 'not-a-url' }), { 'Content-Type': 'application/activity+json' }],
      [
        '署名ヘッダーが壊れている',
        JSON.stringify({ type: 'Create', actor: VICTIM_ACTOR }),
        { 'Content-Type': 'application/activity+json', Signature: 'keyId="<<<",headers=?,signature=' },
      ],
      [
        'Date が解釈できない',
        JSON.stringify({ type: 'Create', actor: VICTIM_ACTOR }),
        { 'Content-Type': 'application/activity+json', Signature: 'keyId="x",headers="(request-target) date",signature="zzz"', Date: 'not a date' },
      ],
    ];
    let answered = 0;
    for (const [label, body, headers] of brokenCases) {
      try {
        const res = await postInbox(body, headers);
        if (res.status >= 400 && res.status < 600) answered++;
        else console.log(`     （${label}: ${res.status}）`);
      } catch (err: any) {
        console.error(`     ❌ ${label}: 応答が返らなかった (${err?.message || err})`);
      }
    }
    check('変な入力にも応答が返る（接続が切れない）', answered, brokenCases.length);

    const healthAfter = await fetch(`${ORIGIN}/health`).catch(() => null);
    check('ノードは生きている（/health が応答する）', healthAfter?.status, 200);
    const stillHasTimeline = await fetch(`${ORIGIN}/api/timeline?mode=all`).catch(() => null);
    check('受信以外の機能も動いている', stillHasTimeline?.status, 200);

    // ------------------------------------------------------------------
    // 11. 所有権の検証（Delete / Create の著者 / 埋め込みノート / Accept）
    //     2026-10-16: 受信箱が actor を見ずに投稿を消していた（任意の投稿を消せる）。
    //     Create の attributedTo・Announce の埋め込みノートも鵜呑みにしていた（なりすまし）。
    // ------------------------------------------------------------------
    console.log('\n🔐 [11] 所有権の検証（Delete・Create・埋め込みノート・Accept）');
    const OTHER_REMOTE = 'https://other.test/users/bob';
    const STRANGER = 'https://stranger.test/users/zoe';
    const otherKeys = generateTestKeyPair();
    const strangerKeys = generateTestKeyPair();
    const spooferKeys = generateTestKeyPair();
    // なりすまし役。ATTACKER_ACTOR は「鍵が引けない actor」の検査で使っていて失敗が
    // キャッシュされる（＝署名が 401 になる）ため、署名が通る別の actor を用意する
    const SPOOFER_ACTOR = 'https://spoofer.test/users/mallory';
    await seedActor(OTHER_REMOTE, otherKeys.publicKeyPem);
    await seedActor(STRANGER, strangerKeys.publicKeyPem);
    await seedActor(SPOOFER_ACTOR, spooferKeys.publicKeyPem);

    const signAndPost = (body: string, keyId: string, pem: string) =>
      postInbox(body, signInboxRequest({ body, keyId, privateKeyPem: pem }));
    const noteBody = (actor: string, id: string, attributedTo: string, content: string) =>
      JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${actor}/activities/${encodeURIComponent(id)}`,
        type: 'Create',
        actor,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        object: {
          id,
          type: 'Note',
          attributedTo,
          content,
          published: new Date().toISOString(),
          to: ['https://www.w3.org/ns/activitystreams#Public'],
        },
      });
    const postRow = (id: string) =>
      testDb.prepare('SELECT content, is_local FROM posts WHERE id = ?').get(id) as { content: string; is_local: number } | undefined;

    // ローカル投稿（管理者）を 1 件作る
    const localPostRes = await fetch(`${ORIGIN}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.sessionToken}` },
      body: JSON.stringify({ content: '所有権テスト用のローカル投稿', visibility: 'public' }),
    });
    const localPost = await localPostRes.json();
    check('ローカル投稿を用意', typeof localPost?.id, 'string');

    // リモート投稿（bob の投稿）を DB に用意する
    const remotePostId = `${OTHER_REMOTE}/notes/own-1`;
    testDb.prepare(`
      INSERT INTO posts (id, user_id, author_name, author_url, author_handle, content, is_local, visibility, published_at)
      VALUES (?, ?, 'Bob', ?, '@bob@other.test', 'bob の投稿', 0, 'public', ?)
      ON CONFLICT(id) DO NOTHING
    `).run(remotePostId, OTHER_REMOTE, OTHER_REMOTE, new Date().toISOString());

    // (a) 第三者がローカル投稿を消そうとする → 消えない
    const delLocal = await signAndPost(
      JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${SPOOFER_ACTOR}/activities/del-1`, type: 'Delete', actor: SPOOFER_ACTOR, object: localPost.id }),
      `${SPOOFER_ACTOR}#main-key`,
      spooferKeys.privateKeyPem,
    );
    check('第三者の Delete（ローカル投稿）は 200 で無視', delLocal.status, 200);
    check('ローカル投稿は消えない', Boolean(postRow(localPost.id)), true);

    // (b) 第三者が他人のリモート投稿を消そうとする → 消えない
    await signAndPost(
      JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${SPOOFER_ACTOR}/activities/del-2`, type: 'Delete', actor: SPOOFER_ACTOR, object: remotePostId }),
      `${SPOOFER_ACTOR}#main-key`,
      spooferKeys.privateKeyPem,
    );
    check('第三者の Delete（他人のリモート投稿）は消えない', Boolean(postRow(remotePostId)), true);

    // (c) 作者本人の Delete は通る（＋墓標が立つ）
    await signAndPost(
      JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${OTHER_REMOTE}/activities/del-3`, type: 'Delete', actor: OTHER_REMOTE, object: remotePostId }),
      `${OTHER_REMOTE}#main-key`,
      otherKeys.privateKeyPem,
    );
    check('作者本人の Delete は通る', Boolean(postRow(remotePostId)), false);
    // 墓標があるので、同じ ID の Create が再送されても復活しない
    await signAndPost(noteBody(OTHER_REMOTE, remotePostId, OTHER_REMOTE, 'bob の投稿（再送）'), `${OTHER_REMOTE}#main-key`, otherKeys.privateKeyPem);
    check('削除済みの投稿は再送されても復活しない', Boolean(postRow(remotePostId)), false);

    // (d) 手元に無い他人のサーバーの ID に Delete を送っても墓標は立たない（あとから来る本物を取り込める）
    const futureId = `${OTHER_REMOTE}/notes/future-1`;
    await signAndPost(
      JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${SPOOFER_ACTOR}/activities/del-4`, type: 'Delete', actor: SPOOFER_ACTOR, object: futureId }),
      `${SPOOFER_ACTOR}#main-key`,
      spooferKeys.privateKeyPem,
    );
    await signAndPost(noteBody(OTHER_REMOTE, futureId, OTHER_REMOTE, 'あとから届く本物の投稿'), `${OTHER_REMOTE}#main-key`, otherKeys.privateKeyPem);
    check('他人の ID への空振り Delete で本物を黙らせられない', postRow(futureId)?.content, 'あとから届く本物の投稿');

    // (e) Create の attributedTo が actor と違う → 取り込まない（なりすまし）
    const spoofCreate = await signAndPost(
      noteBody(SPOOFER_ACTOR, `${SPOOFER_ACTOR}/notes/spoof-1`, localActor, '管理者が書いたことにする投稿'),
      `${SPOOFER_ACTOR}#main-key`,
      spooferKeys.privateKeyPem,
    );
    check('著者が actor と違う Create は 200 で無視', spoofCreate.status, 200);
    check('なりすまし投稿は保存されない', Boolean(postRow(`${SPOOFER_ACTOR}/notes/spoof-1`)), false);
    // 正しい Create は通る（回帰）
    const okCreate = await signAndPost(
      noteBody(SPOOFER_ACTOR, `${SPOOFER_ACTOR}/notes/ok-1`, SPOOFER_ACTOR, '正しい著者の投稿'),
      `${SPOOFER_ACTOR}#main-key`,
      spooferKeys.privateKeyPem,
    );
    check('著者と actor が一致する Create は通る', okCreate.status, 201);
    check('その投稿は保存される', Boolean(postRow(`${SPOOFER_ACTOR}/notes/ok-1`)), true);

    // (f) Announce に埋め込まれたノート: フォロー外の相手からのものは取り込まない
    const strangerEmbedded = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${STRANGER}/activities/ann-1`,
      type: 'Announce',
      actor: STRANGER,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: {
        id: 'https://mastodon.example/notes/stranger-1',
        type: 'Note',
        attributedTo: 'https://mastodon.example/users/someone',
        content: 'フォロー外の告知に埋め込まれた本文',
        published: new Date().toISOString(),
      },
    });
    await signAndPost(strangerEmbedded, `${STRANGER}#main-key`, strangerKeys.privateKeyPem);
    check('フォロー外の埋め込みノートは取り込まない', Boolean(postRow('https://mastodon.example/notes/stranger-1')), false);

    // (g) 承認済みリレーからの埋め込みノートは取り込む（正規の経路）
    const relayEmbedded = (id: string, content: string) =>
      JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${FORWARDER_RELAY}/activities/${encodeURIComponent(id)}`,
        type: 'Announce',
        actor: FORWARDER_RELAY,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        object: {
          id,
          type: 'Note',
          attributedTo: 'https://mastodon.example/users/someone',
          content,
          published: new Date().toISOString(),
        },
      });
    const relayNoteId = 'https://mastodon.example/notes/relay-ok-1';
    await signAndPost(relayEmbedded(relayNoteId, 'リレーが転送した本文'), `${FORWARDER_RELAY}#main-key`, forwarderKeys.privateKeyPem);
    check('リレーの埋め込みノートは取り込む', postRow(relayNoteId)?.content, 'リレーが転送した本文');
    // 既にある投稿は転送で上書きされない
    await signAndPost(relayEmbedded(relayNoteId, '転送で上書きされた本文'), `${FORWARDER_RELAY}#main-key`, forwarderKeys.privateKeyPem);
    check('既にある投稿は転送で上書きされない', postRow(relayNoteId)?.content, 'リレーが転送した本文');
    // ローカル利用者を名乗る埋め込みノートは受け付けない
    const relayClaimingLocal = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${FORWARDER_RELAY}/activities/local-claim-1`,
      type: 'Announce',
      actor: FORWARDER_RELAY,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: {
        id: `${localActor}/posts/fake-local-1`,
        type: 'Note',
        attributedTo: localActor,
        content: 'ローカル利用者が書いたことにする投稿',
        published: new Date().toISOString(),
      },
    });
    await signAndPost(relayClaimingLocal, `${FORWARDER_RELAY}#main-key`, forwarderKeys.privateKeyPem);
    check('ローカル利用者を名乗る埋め込みノートは取り込まない', Boolean(postRow(`${localActor}/posts/fake-local-1`)), false);

    // (h) Accept は本人からだけ
    testDb.prepare(`
      INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
      VALUES ('follow-pending-1', ?, ?, ?, 1, 'pending', ?)
    `).run(localActor, VICTIM_ACTOR, VICTIM_INBOX, new Date().toISOString());
    const acceptBody = (actor: string) =>
      JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${actor}/activities/accept-1`,
        type: 'Accept',
        actor,
        object: { id: `${PUBLIC_ORIGIN}/users/admin#follows/1`, type: 'Follow', actor: localActor, object: VICTIM_ACTOR },
      });
    const followStatus = () =>
      (testDb.prepare("SELECT status FROM follows WHERE follower_url = ? AND following_url = ?").get(localActor, VICTIM_ACTOR) as { status: string } | undefined)?.status;
    await signAndPost(acceptBody(SPOOFER_ACTOR), `${SPOOFER_ACTOR}#main-key`, spooferKeys.privateKeyPem);
    check('第三者からの Accept では承認されない', followStatus(), 'pending');
    await signAndPost(acceptBody(VICTIM_ACTOR), `${VICTIM_ACTOR}#main-key`, victimKeys.privateKeyPem);
    check('本人からの Accept で承認される', followStatus(), 'accepted');

    // ------------------------------------------------------------------
    // 12. Accept / Reject は「承認・拒否された本人」のフォローだけを変えるか
    //     following_url だけで一括更新すると、同じ相手へ申請中の他のローカル利用者まで動く
    // ------------------------------------------------------------------
    console.log('\n🎯 [12] Accept / Reject の対象は本人のフォローだけか');
    const nowIso = new Date().toISOString();
    for (const [id, name] of [['alice', 'Alice'], ['bob', 'Bob']] as const) {
      try {
        testDb.prepare(`
          INSERT INTO users (id, name, summary, master_key_hash, role, is_frozen, public_key_pem, private_key_pem, created_at)
          VALUES (?, ?, '', ?, 'user', 0, 'k', 'k', ?)
        `).run(id, name, `hash_${id}`, nowIso);
      } catch {
        // 既に居れば何もしない
      }
    }
    const aliceFollow = `${PUBLIC_ORIGIN}/users/alice`;
    const bobFollow = `${PUBLIC_ORIGIN}/users/bob`;
    const seedPending = async (follower: string, following: string) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          testDb.prepare(`
            INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
            VALUES (?, ?, ?, ?, 1, 'pending', ?)
            ON CONFLICT(follower_url, following_url) DO UPDATE SET status = 'pending'
          `).run(`${follower} -> ${following}`, follower, following, VICTIM_INBOX, nowIso);
          return;
        } catch (err) {
          if (attempt === 9) throw err;
          await sleep(200); // SQLite のロック競合をリトライ
        }
      }
    };
    const statusOf = (follower: string, following: string) =>
      (testDb.prepare('SELECT status FROM follows WHERE follower_url = ? AND following_url = ?').get(follower, following) as
        | { status: string }
        | undefined)?.status ?? null;

    await seedPending(aliceFollow, VICTIM_ACTOR);
    await seedPending(bobFollow, VICTIM_ACTOR);

    // (a) 誰宛てか分からない Accept（埋め込みなし・共有 Inbox）→ 誰も承認しない
    const vagueAccept = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${VICTIM_ACTOR}/activities/accept-2`,
      type: 'Accept',
      actor: VICTIM_ACTOR,
      object: VICTIM_ACTOR,
    });
    await signAndPost(vagueAccept, `${VICTIM_ACTOR}#main-key`, victimKeys.privateKeyPem);
    check('曖昧な Accept では alice を承認しない', statusOf(aliceFollow, VICTIM_ACTOR), 'pending');
    check('曖昧な Accept では bob を承認しない', statusOf(bobFollow, VICTIM_ACTOR), 'pending');

    // (b) 埋め込み Follow が alice を指す Accept → alice だけ
    const aliceAccept = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${VICTIM_ACTOR}/activities/accept-3`,
      type: 'Accept',
      actor: VICTIM_ACTOR,
      object: { type: 'Follow', actor: aliceFollow, object: VICTIM_ACTOR },
    });
    await signAndPost(aliceAccept, `${VICTIM_ACTOR}#main-key`, victimKeys.privateKeyPem);
    check('本人の Accept で alice は承認される', statusOf(aliceFollow, VICTIM_ACTOR), 'accepted');
    check('同じ相手を申請中の bob は保留のまま', statusOf(bobFollow, VICTIM_ACTOR), 'pending');

    // (c) 個人 Inbox 宛て（埋め込みなし）→ 宛先の bob だけを承認する
    const bobPersonalAccept = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${VICTIM_ACTOR}/activities/accept-4`,
      type: 'Accept',
      actor: VICTIM_ACTOR,
      object: VICTIM_ACTOR,
    });
    const bobInboxRes = await fetch(`${ORIGIN}/users/bob/inbox`, {
      method: 'POST',
      headers: signInboxRequest({
        body: bobPersonalAccept,
        keyId: `${VICTIM_ACTOR}#main-key`,
        privateKeyPem: victimKeys.privateKeyPem,
        inboxPath: '/users/bob/inbox',
      }),
      body: bobPersonalAccept,
    });
    check('個人 Inbox 宛ての Accept は受理される', bobInboxRes.status, 200);
    check('宛先の bob は承認される', statusOf(bobFollow, VICTIM_ACTOR), 'accepted');

    // (d) Reject も同じ: 第三者では消えず、本人からの分だけその利用者の保留が消える
    await seedPending(aliceFollow, OTHER_REMOTE);
    await seedPending(bobFollow, OTHER_REMOTE);
    const rejectBody = (actor: string) =>
      JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${actor}/activities/reject-1`,
        type: 'Reject',
        actor,
        object: { type: 'Follow', actor: aliceFollow, object: OTHER_REMOTE },
      });
    await signAndPost(rejectBody(SPOOFER_ACTOR), `${SPOOFER_ACTOR}#main-key`, spooferKeys.privateKeyPem);
    check('第三者からの Reject では alice の保留は消えない', statusOf(aliceFollow, OTHER_REMOTE), 'pending');
    check('第三者からの Reject では bob の保留は消えない', statusOf(bobFollow, OTHER_REMOTE), 'pending');
    await signAndPost(rejectBody(OTHER_REMOTE), `${OTHER_REMOTE}#main-key`, otherKeys.privateKeyPem);
    check('本人からの Reject で alice の保留は消える', statusOf(aliceFollow, OTHER_REMOTE), null);
    check('同じ相手を申請中の bob は残る', statusOf(bobFollow, OTHER_REMOTE), 'pending');

    // (e) 宛先の居ない Follow は 404（管理者へフォールバックしない）
    const ghostFollow = await signAndPost(
      JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${STRANGER}/activities/follow-ghost`,
        type: 'Follow',
        actor: STRANGER,
        object: `${PUBLIC_ORIGIN}/users/nobody`,
      }),
      `${STRANGER}#main-key`,
      strangerKeys.privateKeyPem,
    );
    check('存在しない宛先の Follow は 404', ghostFollow.status, 404);
    const adminFollowersNow = await (await fetch(`${ORIGIN}/api/followers?userId=admin`)).json();
    check(
      '管理者のフォロワーに追加されない',
      Array.isArray(adminFollowersNow) && adminFollowersNow.some((f: any) => f.follower_url === STRANGER),
      false,
    );

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
