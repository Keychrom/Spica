import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// ============================================================================
// 動画サムネイル（ffmpeg 連携）の検証
//
//   ffmpeg が入っていない環境が普通なので、モックの ffmpeg / ffprobe を用意して
//   パイプラインだけを検証する（実際のデコードは本物の ffmpeg が行う）。
//
//   1. ffmpeg があるとき: 動画アップロードでサムネイルが生成され、
//      ファイルとして保存され、URL・寸法・再生時間が返るか
//   2. ドライブの一覧にサムネイルが出るか
//   3. ffmpeg が無いとき: アップロードは成功し、サムネイルだけが付かないか
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_video_thumb.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3671;
const BASE = `http://localhost:${PORT}`;

[TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
  for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});

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
  if (inUse) throw new Error(`ポート ${port} は使用中です。TEST_PORT=3680 のように空きポートを指定してください。`);
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

/** 最小の WebP（1x1・透明）をバイト列で持つ。ffmpeg の代わりに書き出す中身 */
const TINY_WEBP = Buffer.from(
  'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
  'base64',
);

/** モックの ffmpeg: -version に応答し、出力パスが指定されていれば画像を書き出す */
function writeMockFfmpeg(dir: string): string {
  const script = path.join(dir, 'mock-ffmpeg.mjs');
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('-version')) {
  console.log('ffmpeg version 0.0.0-mock');
  process.exit(0);
}
const output = args[args.length - 1];
if (output && (output.endsWith('.webp') || output.endsWith('.png') || output.endsWith('.jpg'))) {
  fs.writeFileSync(output, Buffer.from(${JSON.stringify(TINY_WEBP.toString('base64'))}, 'base64'));
  process.exit(0);
}
process.exit(1);
`,
  );
  // Windows では .mjs を直接実行できないため .cmd ラッパー経由で呼ぶ（本体側も .cmd に対応している）
  const cmd = path.join(dir, 'mock-ffmpeg.cmd');
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  return cmd;
}

/** モックの ffprobe: 幅・高さ・再生時間を返す */
function writeMockFfprobe(dir: string): string {
  const script = path.join(dir, 'mock-ffprobe.mjs');
  fs.writeFileSync(
    script,
    `const args = process.argv.slice(2);
if (!args.length) process.exit(1);
console.log(JSON.stringify({ streams: [{ width: 640, height: 360, duration: '5.0' }], format: { duration: '5.0' } }));
process.exit(0);
`,
  );
  const cmd = path.join(dir, 'mock-ffprobe.cmd');
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  return cmd;
}

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('🧪 動画サムネイル（モック ffmpeg）検証テスト');
  console.log(`   server=${PORT}`);
  console.log('====================================================\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spica-thumb-test-'));
  const mockFfmpeg = writeMockFfmpeg(tmpDir);
  const mockFfprobe = writeMockFfprobe(tmpDir);
  const uploadDir = path.resolve(ROOT_DIR, 'server', 'data', 'uploads');
  const tsxCli = path.resolve(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  let server: ChildProcess | null = null;
  let completed = false;

  const startServer = async (env: Record<string, string>) => {
    const child = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Video Thumb Test',
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

  const stopServer = async (child: ChildProcess | null) => {
    if (!child) return;
    child.kill('SIGTERM');
    for (let i = 0; i < 20; i++) {
      try { await assertPortFree(PORT); break; } catch { await sleep(300); }
    }
    try { child.kill('SIGKILL'); } catch {}
  };

  try {
    await assertPortFree(PORT);

    // ================================================================
    console.log('🎞️ [1] ffmpeg がある場合（モック）');
    server = await startServer({ FFMPEG_PATH: mockFfmpeg, FFPROBE_PATH: mockFfprobe });
    console.log('✅ サーバー起動完了\n');

    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'alice', name: 'alice', agreedToRules: true }),
    });
    const alice = await reg.json();
    const token = alice.sessionToken as string;

    const form = new FormData();
    form.append('file', new File([Buffer.alloc(32 * 1024, 3)], 'movie.mp4', { type: 'video/mp4' }));
    const uploadRes = await fetch(`${BASE}/api/media/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const uploaded = await uploadRes.json();
    check('動画アップロードが成功する', uploadRes.status, 200);
    const media = uploaded.media?.[0];
    check('サムネイル URL が返る', typeof media?.thumbnailUrl === 'string' && media.thumbnailUrl.length > 0, true);
    check('サムネイルは webp で返る', typeof media?.thumbnailUrl === 'string' && media.thumbnailUrl.endsWith('.webp'), true);
    check('幅・高さが取得される', [media?.width, media?.height], [640, 360]);
    check('再生時間が取得される', media?.duration, 5);

    const thumbName = String(media.thumbnailUrl).split('/').pop()!;
    const thumbPath = path.join(uploadDir, 'alice', thumbName);
    check('サムネイルが実際に保存されている', fs.existsSync(thumbPath), true);
    check('サムネイルが空でない', fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0, true);
    check('動画本体も保存されている', fs.existsSync(path.join(uploadDir, 'alice', String(media.url).split('/').pop()!)), true);

    const drive = await (await fetch(`${BASE}/api/drive`, { headers: { Authorization: `Bearer ${token}` } })).json();
    check('ドライブに thumbnailUrl が出る', Boolean(drive.items?.[0]?.thumbnailUrl), true);
    check('ドライブに duration が出る', drive.items?.[0]?.duration, 5);

    // サムネイル削除も動くこと（メディアごと削除）
    const delRes = await fetch(`${BASE}/api/drive/${media.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    check('メディア削除が成功する', delRes.status, 200);
    check('サムネイルのファイルも消える', fs.existsSync(thumbPath), false);

    await stopServer(server);
    server = null;
    console.log('');

    // ================================================================
    console.log('🚫 [2] ffmpeg が無い場合（この環境の既定）');
    server = await startServer({ FFMPEG_PATH: path.join(tmpDir, 'no-such-ffmpeg'), FFPROBE_PATH: path.join(tmpDir, 'no-such-ffprobe') });
    console.log('✅ サーバー起動完了\n');

    const form2 = new FormData();
    form2.append('file', new File([Buffer.alloc(32 * 1024, 4)], 'movie2.mp4', { type: 'video/mp4' }));
    const upload2 = await fetch(`${BASE}/api/media/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form2,
    });
    const uploaded2 = await upload2.json();
    check('ffmpeg が無くてもアップロードは成功する', upload2.status, 200);
    check('サムネイルは付かない（空文字）', uploaded2.media?.[0]?.thumbnailUrl, '');
    check('動画本体は保存される', fs.existsSync(path.join(uploadDir, 'alice', String(uploaded2.media?.[0]?.url).split('/').pop()!)), true);

    const drive2 = await (await fetch(`${BASE}/api/drive`, { headers: { Authorization: `Bearer ${token}` } })).json();
    check('ドライブには動画が記録される', drive2.items.length, 1);
    check('thumbnailUrl は空', drive2.items[0].thumbnailUrl, '');

    completed = true;
  } finally {
    console.log('');
    if (!completed) console.error('❌ テストを最後まで実行できませんでした（上のエラーを参照）');
    else if (failures === 0) console.log('🎉 すべての確認に合格しました');
    else console.error(`❌ ${failures} 件の確認に失敗しました`);
    await stopServer(server);
    try { fs.rmSync(path.join(uploadDir, 'alice'), { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
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
