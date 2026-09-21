import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// ドライブ（自分のアップロード管理）の検証
//
//   1. アップロードしたメディアが台帳に記録され、一覧・使用量に出るか
//   2. 投稿に添付すると「使用中」になり、削除が拒否されるか
//   3. 投稿を削除すると紐づけが外れ、削除できるようになるか（ファイルも消えるか）
//   4. 容量上限（MEDIA_QUOTA_MB）を超えるアップロードが 413 で拒否されるか
//   5. 他人のメディアは削除できないか / 未認証は 401 か
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_drive.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3651;
const BASE = `http://localhost:${PORT}`;
const QUOTA_MB = 1;

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
  if (inUse) throw new Error(`ポート ${port} は使用中です。TEST_PORT=3660 のように空きポートを指定してください。`);
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

/** アップロード用のダミー画像（中身は任意でよい。実画像でなくても保存は成功する） */
function fakeFile(size: number, name = 'test.png', type = 'image/png'): File {
  const bytes = Buffer.alloc(size, 7);
  return new File([bytes], name, { type });
}

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('🧪 ドライブ（アップロード管理）検証テスト');
  console.log(`   server=${PORT} quota=${QUOTA_MB}MB`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;
  let completed = false;
  const uploadDir = path.resolve(ROOT_DIR, 'server', 'data', 'uploads');

  try {
    await assertPortFree(PORT);
    const tsxCli = path.resolve(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    server = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Drive Test',
        RATE_LIMIT_DISABLED: 'true',
        MEDIA_QUOTA_MB: String(QUOTA_MB),
        FFMPEG_PATH: 'nonexistent-ffmpeg-for-test',
      },
      stdio: 'pipe',
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    if (!(await waitForServer(BASE))) throw new Error('サーバー起動失敗');
    console.log('✅ サーバー起動完了\n');

    const register = async (id: string) => {
      const res = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: id, agreedToRules: true }),
      });
      const body = await res.json();
      if (!body?.sessionToken) throw new Error(`${id} の作成に失敗: ${JSON.stringify(body)}`);
      return body.sessionToken as string;
    };
    const alice = await register('alice');
    const bob = await register('bob');
    const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

    const upload = async (token: string, file: File) => {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${BASE}/api/media/upload`, { method: 'POST', headers: auth(token), body: form });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    // ------------------------------------------------------------------
    console.log('🗂️ [1] アップロードと一覧・使用量');
    const up = await upload(alice, fakeFile(2048));
    check('アップロードが成功する', up.status, 200);
    const mediaId = up.body?.media?.[0]?.id as string;
    check('台帳 ID が返る', typeof mediaId === 'string' && mediaId.startsWith('media_'), true);
    const mediaUrl = up.body?.media?.[0]?.url as string;
    check('URL が返る', typeof mediaUrl === 'string' && mediaUrl.includes('/uploads/alice/'), true);

    let drive = await (await fetch(`${BASE}/api/drive`, { headers: auth(alice) })).json();
    check('一覧に 1 件出る', drive.items.length, 1);
    check('使用量（件数）が 1', drive.stats.count, 1);
    check('使用量（サイズ）が 0 より大きい', drive.stats.bytes > 0, true);
    check('容量上限が返る', drive.stats.quotaBytes, QUOTA_MB * 1024 * 1024);
    check('未添付なので postId は null', drive.items[0].postId, null);

    const bobDrive = await (await fetch(`${BASE}/api/drive`, { headers: auth(bob) })).json();
    check('他人のドライブには出ない', bobDrive.items.length, 0);

    const anon = await fetch(`${BASE}/api/drive`);
    check('未認証は 401', anon.status, 401);

    // ------------------------------------------------------------------
    console.log('\n📎 [2] 投稿に添付すると「使用中」になる');
    const postRes = await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(alice) },
      body: JSON.stringify({ content: 'ドライブのテスト投稿', attachments: up.body.media }),
    });
    const post = await postRes.json();
    check('投稿が作成できる (201)', postRes.status, 201);

    drive = await (await fetch(`${BASE}/api/drive`, { headers: auth(alice) })).json();
    check('使用中の投稿 ID が入る', drive.items[0].postId, post.id);
    const delInUse = await fetch(`${BASE}/api/drive/${mediaId}`, { method: 'DELETE', headers: auth(alice) });
    check('使用中のメディア削除は 409', delInUse.status, 409);
    check('理由が inUse で返る', (await delInUse.json()).inUse, true);

    const bobDel = await fetch(`${BASE}/api/drive/${mediaId}`, { method: 'DELETE', headers: auth(bob) });
    check('他人のメディア削除は 404', bobDel.status, 404);

    // ------------------------------------------------------------------
    console.log('\n🗑️ [3] 投稿を削除すると紐づけが外れて削除できる');
    const fileName = mediaUrl.split('/').pop()!;
    const filePath = path.join(uploadDir, 'alice', fileName);
    check('保存先にファイルがある', fs.existsSync(filePath), true);

    await fetch(`${BASE}/api/posts/${encodeURIComponent(post.id)}`, { method: 'DELETE', headers: auth(alice) });
    drive = await (await fetch(`${BASE}/api/drive`, { headers: auth(alice) })).json();
    check('投稿を消すと postId が外れる', drive.items[0].postId, null);

    const del = await fetch(`${BASE}/api/drive/${mediaId}`, { method: 'DELETE', headers: auth(alice) });
    check('削除できる', del.status, 200);
    check('ファイルが消える', fs.existsSync(filePath), false);
    const afterDel = await (await fetch(`${BASE}/api/drive`, { headers: auth(alice) })).json();
    check('一覧から消える', afterDel.items.length, 0);
    check('使用量が 0 に戻る', afterDel.stats.count, 0);

    // ------------------------------------------------------------------
    console.log('\n📦 [4] 容量上限（クォータ）');
    const big = await upload(alice, fakeFile(QUOTA_MB * 1024 * 1024 + 1024, 'big.png'));
    check('上限を超えるアップロードは 413', big.status, 413);
    check('上限の案内が返る', String(big.body?.error || '').includes('容量上限'), true);

    const okUpload = await upload(alice, fakeFile(4096));
    check('上限内なら成功する', okUpload.status, 200);
    const stats2 = await (await fetch(`${BASE}/api/drive/stats`, { headers: auth(alice) })).json();
    check('使用量が 1 件に増える', stats2.count, 1);

    completed = true;
  } finally {
    console.log('');
    if (!completed) console.error('❌ テストを最後まで実行できませんでした（上のエラーを参照）');
    else if (failures === 0) console.log('🎉 すべての確認に合格しました');
    else console.error(`❌ ${failures} 件の確認に失敗しました`);
    if (server) {
      server.kill('SIGTERM');
      for (let i = 0; i < 20; i++) {
        try { await assertPortFree(PORT); break; } catch { await sleep(300); }
      }
      try { server.kill('SIGKILL'); } catch {}
    }
    // テストで作ったアップロードとDBを片付ける
    try { fs.rmSync(path.join(uploadDir, 'alice'), { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.join(uploadDir, 'bob'), { recursive: true, force: true }); } catch {}
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
