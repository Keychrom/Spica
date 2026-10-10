import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';

// ============================================================================
// 動画・音声の添付対応の検証
//   1. 動画 (video/mp4) / 音声 (audio/mpeg) をアップロードできるか
//   2. 拡張子と Content-Type が正しく保存・配信されるか
//   3. 動画・音声は1件まで / 画像は15MBまで / 非対応形式は拒否
//   4. 投稿に添付され、ActivityPub の Note にも Document として載るか
//   5. 添付は 1 投稿あたり 6 件まで（2026-10-10 に 4 件から増やした）
//   6. 受信: 連合先の Note が 4 件を超えても切り捨てない（相手の写真を消さない）
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_media_video.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 4311;
const BASE = `http://localhost:${PORT}`;
const REMOTE_ATTR = 'https://remote.test/users/eve';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

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
      `空きポートを指定して実行してください:  TEST_PORT=4320 npx tsx scripts/test-media-video.ts`,
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

/** 受信の検査用: リモートの鍵（署名はサーバーと同じ手順を再現する） */
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
  console.log('🧪 動画・音声の添付対応の検証');
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
        INSTANCE_NAME: 'Media Test',
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
    const headers = { Authorization: `Bearer ${alice.token}` };

    const uploadFile = async (name: string, type: string, bytes: number) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
      const res = await fetch(`${BASE}/api/media/upload`, { method: 'POST', headers, body: form });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    // ------------------------------------------------------------------
    console.log('🎬 [1] 動画・音声のアップロード');
    const video = await uploadFile('clip.mp4', 'video/mp4', 1024);
    check("動画アップロードのステータス", video.status, 200);
    check('拡張子が mp4 になる', String(video.body?.attachment?.url || '').endsWith('.mp4'), true);
    check("mediaType が video/mp4", video.body?.attachment?.mediaType, "video/mp4");

    const audio = await uploadFile('voice.m4a', 'audio/mp4', 512);
    check("音声アップロードのステータス", audio.status, 200);
    check('拡張子が m4a になる', String(audio.body?.attachment?.url || '').endsWith('.m4a'), true);
    check("mediaType が audio/mp4", audio.body?.attachment?.mediaType, "audio/mp4");

    // 配信される Content-Type
    const fetchVideo = await fetch(`${BASE}${new URL(video.body.attachment.url).pathname}`);
    check('配信ステータス', fetchVideo.status, 200);
    check('配信 Content-Type', String(fetchVideo.headers.get('content-type') || '').split(';')[0], 'video/mp4');
    check('nosniff ヘッダ', fetchVideo.headers.get('x-content-type-options'), 'nosniff');

    // ------------------------------------------------------------------
    console.log('\n🚫 [2] 上限と形式のチェック');
    const twoVideos = new FormData();
    twoVideos.append('file', new Blob([new Uint8Array(100)], { type: 'video/mp4' }), 'a.mp4');
    twoVideos.append('file', new Blob([new Uint8Array(100)], { type: 'video/mp4' }), 'b.mp4');
    const twoVideoRes = await fetch(`${BASE}/api/media/upload`, { method: 'POST', headers, body: twoVideos });
    check('動画2件は 400', twoVideoRes.status, 400);
    check('動画2件のメッセージ', (await twoVideoRes.json()).error, '動画・音声は1件まで添付できます。');

    const bigImage = await uploadFile('big.png', 'image/png', 16 * 1024 * 1024);
    check('16MBの画像は 400', bigImage.status, 400);
    check('画像サイズ上限のメッセージ', bigImage.body?.error, '画像サイズが大きすぎます (最大15MBまで)。');

    const bigVideo = await uploadFile('big.mp4', 'video/mp4', 51 * 1024 * 1024);
    check('51MBの動画は 400', bigVideo.status, 400);

    const pdf = await uploadFile('doc.pdf', 'application/pdf', 128);
    check('非対応形式は 400', pdf.status, 400);
    check('非対応形式のメッセージが返る', String(pdf.body?.error || '').includes('対応していないファイル形式'), true);

    // 添付は 1 投稿あたり 6 件まで（2026-10-10 に 4 件から増やした）
    const makeForm = (count: number) => {
      const form = new FormData();
      for (let i = 1; i <= count; i++) {
        form.append('file', new Blob([new Uint8Array(64)], { type: 'image/png' }), `pic${i}.png`);
      }
      return form;
    };
    const sixRes = await fetch(`${BASE}/api/media/upload`, { method: 'POST', headers, body: makeForm(6) });
    const sixBody = await sixRes.json();
    check('6件の同時アップロードは 200', sixRes.status, 200);
    check('6件すべて返る', sixBody.media?.length, 6);

    const sevenRes = await fetch(`${BASE}/api/media/upload`, { method: 'POST', headers, body: makeForm(7) });
    check('7件は 400', sevenRes.status, 400);
    check('7件のメッセージ', (await sevenRes.json()).error, '一度にアップロードできるファイルは最大6件までです。');

    // ------------------------------------------------------------------
    console.log('\n📝 [3] 投稿への添付と ActivityPub');
    const postRes = await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '動画を添付しました', attachments: [video.body.attachment] }),
    });
    check('投稿のステータス', postRes.status, 201);
    const post = await postRes.json();
    check('添付が1件ある', post.media_attachments?.length, 1);
    check('添付の mediaType', post.media_attachments?.[0]?.mediaType, 'video/mp4');

    const tl = await (await fetch(`${BASE}/api/timeline?mode=all&limit=20`, { headers })).json();
    const tlPost = tl.find((p: any) => (p.post_id ?? p.id) === post.id);
    check("タイムラインに添付が含まれる", tlPost?.media_attachments?.[0]?.url, video.body.attachment.url);

    // ActivityPub の Note に Document として載る
    const noteId = String(post.id).split('/').pop();
    const apRes = await fetch(`${BASE}/users/alice/posts/${noteId}`, { headers: { Accept: 'application/activity+json' } });
    const note = await apRes.json();
    check('AP Note の添付が Document', note.attachment?.[0]?.type, 'Document');
    check('AP Note の mediaType', note.attachment?.[0]?.mediaType, 'video/mp4');
    check("AP Note の URL", note.attachment?.[0]?.url, video.body.attachment.url);

    // 6 件つきの投稿（保存・タイムライン・外向きの Note のすべてに 6 件載る）
    const sixPostRes = await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '6枚の画像', attachments: sixBody.media }),
    });
    check('6件つきで投稿できる', sixPostRes.status, 201);
    const sixPost = await sixPostRes.json();
    check('6件すべて保存される', sixPost.media_attachments?.length, 6);

    const sixTl = await (await fetch(`${BASE}/api/timeline?mode=all&limit=20`, { headers })).json();
    const sixTlPost = sixTl.find((p: any) => (p.post_id ?? p.id) === sixPost.id);
    check('タイムラインにも 6 件', sixTlPost?.media_attachments?.length, 6);

    const sixNote = await (await fetch(`${BASE}/users/alice/posts/${String(sixPost.id).split('/').pop()}`, {
      headers: { Accept: 'application/activity+json' },
    })).json();
    check('外向きの AP Note にも 6 件載る', sixNote.attachment?.length, 6);

    // 直に API を叩かれても増えない（画面の上限とサーバーの上限を揃えておく）
    const sevenPostRes = await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '7枚は弾かれる', attachments: [...sixBody.media, video.body.attachment] }),
    });
    check('7件での投稿は 6 件に丸められる', (await sevenPostRes.json()).media_attachments?.length, 6);

    // ------------------------------------------------------------------
    console.log('\n📥 [4] 受信: 連合先の 5 枚目以降も消さない');
    // 相手（リモート）のアクターとフォロー関係を仕込んでから、署名つきで Note を届ける
    const keys = generateTestKeyPair();
    const seedDb = createAsyncDatabase({
      driver: process.env.DB_DRIVER,
      connectionString: process.env.DATABASE_URL,
      dbPath: path.resolve(ROOT_DIR, 'server', TEST_DB),
    });
    await seedDb.exec('PRAGMA busy_timeout = 10000');
    await seedDb.prepare(
      `INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
       VALUES (?, 'eve', 'remote.test', 'Eve', '', '', '', ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET public_key_pem = excluded.public_key_pem`,
    ).run(REMOTE_ATTR, `${REMOTE_ATTR}/inbox`, `${REMOTE_ATTR}#main-key`, keys.publicKeyPem, new Date().toISOString());
    await seedDb.prepare(
      `INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
       VALUES ('f-eve', ?, ?, ?, 1, 'accepted', ?)
       ON CONFLICT(follower_url, following_url) DO UPDATE SET status = 'accepted'`,
    ).run(alice.actorUrl, REMOTE_ATTR, `${REMOTE_ATTR}/inbox`, new Date().toISOString());

    const remoteNoteId = `${REMOTE_ATTR}/notes/six`;
    const incoming = {
      '@context': ['https://www.w3.org/ns/activitystreams'],
      id: `${REMOTE_ATTR}/activities/six`,
      type: 'Create',
      actor: REMOTE_ATTR,
      to: [PUBLIC],
      object: {
        id: remoteNoteId,
        type: 'Note',
        attributedTo: REMOTE_ATTR,
        content: '<p>6 枚の写真</p>',
        published: new Date().toISOString(),
        to: [PUBLIC],
        attachment: Array.from({ length: 6 }, (_, i) => ({
          type: 'Document',
          mediaType: 'image/png',
          url: `https://remote.test/media/pic${i + 1}.png`,
          name: `${i + 1} 枚目`,
        })),
      },
    };
    const incomingBody = JSON.stringify(incoming);
    const delivered = await fetch(`${BASE}/inbox`, {
      method: 'POST',
      headers: signInboxRequest(incomingBody, `${REMOTE_ATTR}#main-key`, keys.privateKeyPem),
      body: incomingBody,
    });
    check('署名つきの受信は通る', [200, 201, 202].includes(delivered.status), true);

    // 取り込みは非同期のことがあるので、少し待ってから見る
    let remoteRow: any = null;
    for (let i = 0; i < 12 && !remoteRow; i++) {
      await sleep(400);
      const rows = await (await fetch(`${BASE}/api/timeline?mode=all&limit=30`, { headers })).json();
      remoteRow = (rows.find((p: any) => p.id === remoteNoteId) as any) || null;
    }
    check('リモートの投稿が届く', Boolean(remoteRow), true);
    check('6 件すべて残っている（4 件で切らない）', remoteRow?.media_attachments?.length, 6);
    check('5 枚目の説明も残る', remoteRow?.media_attachments?.[4]?.description ?? remoteRow?.media_attachments?.[4]?.name, '5 枚目');
    check('6 枚目の URL も残る', String(remoteRow?.media_attachments?.[5]?.url || '').includes(encodeURIComponent('https://remote.test/media/pic6.png')), true);
    await seedDb.close?.();

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 動画・音声の添付対応の検証: すべて成功');
    } else {
      console.error(`❌ 動画・音声の添付対応の検証: ${failures} 件失敗`);
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
