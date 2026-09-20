import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// 動画・音声の添付対応の検証
//   1. 動画 (video/mp4) / 音声 (audio/mpeg) をアップロードできるか
//   2. 拡張子と Content-Type が正しく保存・配信されるか
//   3. 動画・音声は1件まで / 画像は15MBまで / 非対応形式は拒否
//   4. 投稿に添付され、ActivityPub の Note にも Document として載るか
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_media_video.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 4311;
const BASE = `http://localhost:${PORT}`;

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
