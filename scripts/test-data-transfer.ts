import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

/**
 * 設定「データ」の持ち出し・取り込みの契約
 *
 *  - インポートは multipart の `archive` フィールドで送る（`file` だと multer が 400）
 *  - エクスポートのダウンロードは Authorization 必須（`<a href>` では 401）
 *  - クライアントが `archive` を送り、fetch + Bearer でダウンロードしていること
 *  - ダウンロードは 1 回だけ（2 回目は 410）
 */
const ROOT = process.cwd();
const TEST_DB = 'data_test_data_transfer.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3537;
const BASE = `http://localhost:${PORT}`;

for (const suffix of ['', '-wal', '-shm']) {
  for (const dir of [ROOT, path.join(ROOT, 'server')]) {
    const file = path.join(dir, `${TEST_DB}${suffix}`);
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
      } catch {
        throw new Error(`テスト DB が使用中です（前回のサーバーが残っています）: ${file}`);
      }
    }
  }
}

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ✅ ${name}: ${String(actual)}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}: 期待値 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    throw new Error(`ポート ${port} は使用中です。TEST_PORT で空きポートを指定してください。`);
  }
}

async function waitForServer(url: string, maxRetries = 50): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

type ApiResult = { status: number; data: any };
async function api(method: string, endpoint: string, token?: string, body?: unknown): Promise<ApiResult> {
  const res = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

/** Mastodon の outbox.json（1 件だけ） */
function buildArchive() {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'OrderedCollection',
    totalItems: 1,
    orderedItems: [
      {
        type: 'Create',
        object: {
          id: 'https://old.example/users/migrator/statuses/1',
          type: 'Note',
          content: '<p>持ち出し・取り込みの検査</p>',
          published: '2024-01-05T10:00:00Z',
          to: ['https://www.w3.org/ns/activitystreams#Public'],
          cc: [],
        },
      },
    ],
  };
}

async function run(): Promise<void> {
  let server: ChildProcess | null = null;
  try {
    await assertPortFree(PORT);
    server = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.join(ROOT, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.join(ROOT, 'server', TEST_DB),
        INSTANCE_NAME: 'Data Transfer Test',
        RATE_LIMIT_DISABLED: 'true',
      },
      stdio: 'pipe',
      shell: true,
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    if (!(await waitForServer(`${BASE}/api/server-info`))) throw new Error('サーバー起動失敗');

    const reg = await api('POST', '/api/auth/register', undefined, {
      id: 'transferuser',
      name: 'Transfer User',
      agreedToRules: true,
    });
    const token = String(reg.data?.sessionToken || '');
    if (!token) throw new Error(`登録失敗: ${JSON.stringify(reg.data)}`);

    console.log('\n📥 [1] インポートのフィールド名');
    const good = new FormData();
    good.append('archive', new Blob([JSON.stringify(buildArchive())], { type: 'application/json' }), 'outbox.json');
    const goodRes = await fetch(`${BASE}/api/import/archive`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: good,
    });
    const goodBody = await goodRes.json().catch(() => null);
    check('archive フィールドなら取り込める', goodRes.status, 200);
    check('形式は mastodon', goodBody?.format, 'mastodon');

    const wrong = new FormData();
    wrong.append('file', new Blob([JSON.stringify(buildArchive())], { type: 'application/json' }), 'outbox.json');
    const wrongRes = await fetch(`${BASE}/api/import/archive`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: wrong,
    });
    check('file フィールドでは 400（クライアント側の不具合の再現）', wrongRes.status, 400);

    console.log('\n📤 [2] エクスポートのダウンロード');
    const started = await api('POST', '/api/user/export', token, { format: 'json' });
    check('エクスポートを受け付ける', started.status, 202);
    const jobId = String(started.data?.jobId || '');
    if (!jobId) throw new Error(`jobId がありません: ${JSON.stringify(started.data)}`);

    let status = '';
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const job = await api('GET', `/api/user/export/${encodeURIComponent(jobId)}`, token);
      status = String(job.data?.status || '');
      if (status === 'done' || status === 'failed') break;
      await sleep(500);
    }
    check('エクスポートが完成する', status, 'done');

    const noAuth = await fetch(`${BASE}/api/user/export/${encodeURIComponent(jobId)}/file`);
    check('Authorization 無しは 401', noAuth.status, 401);

    const withAuth = await fetch(`${BASE}/api/user/export/${encodeURIComponent(jobId)}/file`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    check('Authorization 付きは 200', withAuth.status, 200);
    check(
      'ダウンロードとして返す',
      String(withAuth.headers.get('content-disposition') || '').includes('attachment'),
      true,
    );
    const fileText = await withAuth.text();
    check('中身は JSON', (() => { try { JSON.parse(fileText); return true; } catch { return false; } })(), true);

    const second = await fetch(`${BASE}/api/user/export/${encodeURIComponent(jobId)}/file`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    check('2 回目は 410（1 回だけ）', second.status, 410);

    console.log('\n🧩 [3] クライアントの契約');
    const dataSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'settings', 'DataSection.tsx'), 'utf8');
    check("インポートは 'archive' を送る", dataSrc.includes("form.append('archive'"), true);
    check("'file' を送っていない", dataSrc.includes("form.append('file'"), false);
    check('ダウンロードは Bearer を付ける', dataSrc.includes('Authorization: `Bearer ${token}`'), true);
    check('<a href> で API を開かない', /href=\{['"]\/api\/user\/export/.test(dataSrc), false);
    const settingsSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'lib', 'settings.ts'), 'utf8');
    check(
      '状態取得でも jobId を保持する（ダウンロード導線が消えない）',
      settingsSrc.includes('return { ...(res.data as ExportJob), jobId };'),
      true,
    );
    const routerSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'lib', 'router.ts'), 'utf8');
    check('リンク横取りは /api を除外する', routerSrc.includes('(api|uploads|proxy)'), true);
  } catch (err) {
    console.error('❌ テスト失敗:', err);
    failed++;
  } finally {
    if (server?.pid) {
      try { spawnSync('taskkill', ['/pid', String(server.pid), '/f', '/t'], { shell: true, timeout: 10000 }); } catch {}
    }
    await sleep(500);
    for (const suffix of ['', '-wal', '-shm']) {
      for (const dir of [ROOT, path.join(ROOT, 'server')]) {
        const file = path.join(dir, `${TEST_DB}${suffix}`);
        if (fs.existsSync(file)) {
          try { fs.unlinkSync(file); } catch {}
        }
      }
    }
  }

  console.log('');
  console.log(`結果: ${passed} 件成功 / ${failed} 件失敗`);
  process.exit(failed > 0 ? 1 : 0);
}

void run();
