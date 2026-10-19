import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { appScopeDenial } from '../server/src/appScopes.js';

/**
 * MiAuth のスコープ検査
 *
 *  - 承認時に要求権限がスコープへ正規化され、セッションに保存される
 *  - 許可した書き込みは通り、許可していない書き込みは 403（コード INSUFFICIENT_SCOPE）
 *  - 読み取りは read が必要
 *  - アカウントの安全に関わる操作（セッション・管理 API・/admin 等）は常に 403
 *  - 旧トークン（scopes='legacy'）は通常の読み書きができるが、安全操作は 403
 *  - 設定のセッション一覧にアプリ名とスコープが出る
 */
const ROOT = process.cwd();
const TEST_DB = 'data_test_miauth_scopes.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3531;
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
    await new Promise((resolve) => setTimeout(resolve, 400));
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

/** Misskey 互換 WebSocket に繋いで、開けたか / ハンドシェイクのステータスを見る */
function websocketStatus(token?: string): Promise<{ ok: boolean; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `ws://localhost:${PORT}/streaming${token ? `?i=${encodeURIComponent(token)}` : ''}`,
    );
    let settled = false;
    const finish = (result: { ok: boolean; status?: number }) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, status: 0 }), 5000);
    timer.unref?.();
    ws.once('open', () => {
      clearTimeout(timer);
      finish({ ok: true });
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      res.resume();
      finish({ ok: false, status: res.statusCode });
    });
    ws.once('error', () => {
      clearTimeout(timer);
      finish({ ok: false });
    });
  });
}

async function startMiauth(session: string, name: string, permission: string): Promise<void> {
  const query = new URLSearchParams({ name, callback: 'http://localhost/cb', permission });
  const res = await fetch(`${BASE}/miauth/${session}?${query}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`MiAuth セッション作成失敗: HTTP ${res.status}`);
}

async function approveAndGetToken(session: string, userToken: string): Promise<string> {
  const approve = await api('POST', `/api/miauth/${session}/approve`, userToken, {});
  if (approve.status !== 200) {
    throw new Error(`MiAuth 承認失敗: HTTP ${approve.status} ${JSON.stringify(approve.data)}`);
  }
  const checkRes = await api('POST', `/api/miauth/${session}/check`);
  const token = checkRes.data?.token;
  if (!token) throw new Error(`MiAuth トークン取得失敗: ${JSON.stringify(checkRes.data)}`);
  return token;
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
        INSTANCE_NAME: 'MiAuth Scope Test',
      },
      stdio: 'pipe',
      shell: true,
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    if (!(await waitForServer(`${BASE}/api/server-info`))) throw new Error('サーバー起動失敗');

    const register = async (id: string): Promise<string> => {
      const res = await api('POST', '/api/auth/register', undefined, { id, name: id, agreedToRules: true });
      if (!res.data?.sessionToken) throw new Error(`${id} の登録失敗: ${JSON.stringify(res.data)}`);
      return res.data.sessionToken as string;
    };
    const alice = await register('alice');
    await register('bob');

    console.log('\n📝 [1] 承認時のスコープ正規化');
    await startMiauth('notes-app', 'NotesApp', 'read:account,write:notes,write:pages');
    const info = await api('GET', '/api/miauth/notes-app/info', alice);
    check('アプリ名が返る', info.data?.name, 'NotesApp');
    check('要求権限がスコープへ正規化される', info.data?.scopes, ['read', 'write:notes']);
    check('未対応の書き込み権限は unknown に出る', info.data?.unknown, ['write:pages']);
    const notesToken = await approveAndGetToken('notes-app', alice);

    console.log('\n✅ [2] 許可した操作は通り、許可していない書き込みは 403');
    check('read: タイムラインは 200', (await api('GET', '/api/timeline?mode=local', notesToken)).status, 200);
    const postRes = await api('POST', '/api/posts', notesToken, { content: 'from app', visibility: 'public' });
    check('write:notes で投稿できる', postRes.status < 300, true);
    const followDenied = await api('POST', '/api/follow', notesToken, { targetHandle: `@bob@localhost:${PORT}` });
    check('write:follows が無いとフォローは 403', followDenied.status, 403);
    check('必要なスコープが分かる', followDenied.data?.required, 'write:follows');
    check('コードが INSUFFICIENT_SCOPE', followDenied.data?.code, 'INSUFFICIENT_SCOPE');
    check(
      'Misskey の notes/create も write:notes で通る',
      (await api('POST', '/api/notes/create', notesToken, { text: 'via misskey' })).status,
      200,
    );
    check(
      '本文の i で渡したトークンにもスコープ検査が効く',
      (await api('POST', '/api/notes/create', undefined, { i: notesToken, text: 'via body token' })).status,
      200,
    );

    console.log('\n🔒 [3] 安全に関わる操作はアプリでは常に 403');
    check('セッション一覧は 403', (await api('GET', '/api/sessions', notesToken)).status, 403);
    check('管理 API は 403', (await api('GET', '/api/admin/stats', notesToken)).status, 403);
    check('パスワード変更は 403', (await api('POST', '/api/user/password', notesToken, {})).status, 403);
    const me = await api('GET', '/api/auth/me', notesToken);
    check('auth/me は読める', me.status, 200);
    check('auth/me にメールを返さない', me.data?.email, undefined);
    check('auth/me にパスワード状態を返さない', me.data?.hasPassword, undefined);
    check('auth/me に TOTP 状態を返さない', me.data?.totp_enabled, undefined);

    console.log('\n👍 [4] write:follows だけを持つアプリ');
    await startMiauth('follows-app', 'FollowApp', 'read:account,write:following');
    const followsToken = await approveAndGetToken('follows-app', alice);
    const followOk = await api('POST', '/api/follow', followsToken, { targetHandle: `@bob@localhost:${PORT}` });
    check('write:follows でフォローできる', followOk.status, 200);
    check('write:notes が無いと投稿は 403', (await api('POST', '/api/posts', followsToken, { content: 'no' })).status, 403);
    check(
      'Misskey の notes/create も write:notes が無いと 403',
      (await api('POST', '/api/notes/create', followsToken, { text: 'no' })).status,
      403,
    );

    console.log('\n📖 [4-b] read を持たないアプリ');
    await startMiauth('write-only-app', 'WriteOnlyApp', 'write:notes');
    const writeOnlyToken = await approveAndGetToken('write-only-app', alice);
    check('read が無いと認証付き読み取りは 403', (await api('GET', '/api/auth/me', writeOnlyToken)).status, 403);
    check(
      'write:notes の投稿は通る',
      (await api('POST', '/api/posts', writeOnlyToken, { content: 'write only' })).status < 300,
      true,
    );

    console.log('\n🕰️ [5] 旧トークン（scopes=legacy）');
    const legacyToken = 'spica_sess_legacy_test_1234';
    const db = new DatabaseSync(path.join(ROOT, 'server', TEST_DB));
    try {
      db.prepare(
        'INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent, app_name, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        legacyToken,
        'alice',
        new Date().toISOString(),
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        'LegacyAgent',
        'OldApp',
        'legacy',
      );
    } finally {
      db.close();
    }
    check('旧トークンの通常の投稿は通る', (await api('POST', '/api/posts', legacyToken, { content: 'legacy' })).status < 300, true);
    check('旧トークンでもセッション一覧は 403', (await api('GET', '/api/sessions', legacyToken)).status, 403);

    console.log('\n🧭 [5-b] スコープ定義の漏れ（ルート表）');
    const asApp = (scopes: string[]) => ({ sessionKind: 'app', sessionScopes: scopes });
    const allows = (scopes: string[], method: string, p: string) => appScopeDenial(asApp(scopes), method, p) === null;
    check('write:blocks で REST のブロック', allows(['write:blocks'], 'POST', '/api/users/bob/block'), true);
    check('write:blocks でアンブロック', allows(['write:blocks'], 'POST', '/api/users/bob/unblock'), true);
    check('write:blocks でミュート', allows(['write:blocks'], 'POST', '/api/users/bob/mute'), true);
    check('write:blocks で /api/mute', allows(['write:blocks'], 'POST', '/api/mute'), true);
    check('write:notes で下書き', allows(['write:notes'], 'POST', '/api/drafts'), true);
    check('write:notes で予約投稿', allows(['write:notes'], 'POST', '/api/scheduled-posts'), true);
    check('read で channels/show', allows(['read'], 'POST', '/api/channels/show'), true);
    check('read で channels/timeline', allows(['read'], 'POST', '/api/channels/timeline'), true);
    check('read で channels/featured', allows(['read'], 'POST', '/api/channels/featured'), true);
    check('read で channels/followed', allows(['read'], 'POST', '/api/channels/followed'), true);
    check('read で drive', allows(['read'], 'POST', '/api/drive'), true);
    check('read で drive/files/show', allows(['read'], 'POST', '/api/drive/files/show'), true);
    check('read で drive/stream', allows(['read'], 'POST', '/api/drive/stream'), true);
    check('read で users/lists/show', allows(['read'], 'POST', '/api/users/lists/show'), true);
    check('read で stream/ticket', allows(['read'], 'POST', '/api/stream/ticket'), true);
    check('write:notes で notes/unrenote', allows(['write:notes'], 'POST', '/api/notes/unrenote'), true);
    check('write:notes で users/report-abuse', allows(['write:notes'], 'POST', '/api/users/report-abuse'), true);
    check(
      'write:blocks が無いとブロックは拒否',
      appScopeDenial(asApp(['read']), 'POST', '/api/users/bob/block')?.required,
      'write:blocks',
    );

    console.log('\n🧱 [5-c] ブロック・ミュート・下書きが REST でも通る');
    await startMiauth('blocks-app', 'BlocksApp', 'read:account,write:blocks');
    const blocksToken = await approveAndGetToken('blocks-app', alice);
    await startMiauth('read-app', 'ReadApp', 'read:account');
    const readToken = await approveAndGetToken('read-app', alice);
    check('write:blocks でブロックできる', (await api('POST', '/api/users/bob/block', blocksToken, {})).status, 200);
    check('write:blocks でミュートできる', (await api('POST', '/api/users/bob/mute', blocksToken, {})).status, 200);
    check('write:blocks でブロックを解除できる', (await api('POST', '/api/users/bob/unblock', blocksToken, {})).status, 200);
    check('write:notes だけではブロックは 403', (await api('POST', '/api/users/bob/block', notesToken, {})).status, 403);
    check('write:notes で下書きを作れる', (await api('POST', '/api/drafts', notesToken, { content: 'app draft' })).status, 201);
    check('read だけでは下書きは 403', (await api('POST', '/api/drafts', readToken, { content: 'x' })).status, 403);

    console.log('\n📎 [5-d] multipart の i（/drive/files/create）');
    await startMiauth('drive-app', 'DriveApp', 'read:account,write:drive');
    const driveToken = await approveAndGetToken('drive-app', alice);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    );
    const uploadForm = new FormData();
    uploadForm.append('file', new Blob([png], { type: 'image/png' }), 'tiny.png');
    uploadForm.append('i', driveToken); // ファイルより後ろに置く（multer 後に読むことの確認）
    const upload = await fetch(`${BASE}/api/drive/files/create`, { method: 'POST', body: uploadForm });
    const uploadBody = await upload.json().catch(() => null);
    check('本文 i の multipart でアップロードできる', upload.status, 200);
    check('URL が返る', typeof uploadBody?.url, 'string');

    const deniedForm = new FormData();
    deniedForm.append('file', new Blob([png], { type: 'image/png' }), 'tiny.png');
    deniedForm.append('i', readToken);
    const deniedUpload = await fetch(`${BASE}/api/drive/files/create`, { method: 'POST', body: deniedForm });
    check('write:drive が無い multipart は 403', deniedUpload.status, 403);

    console.log('\n🔌 [5-e] Misskey WebSocket の read スコープ');
    check('read を持つアプリは接続できる', (await websocketStatus(notesToken)).ok, true);
    const writeOnlyWs = await websocketStatus(writeOnlyToken);
    check('write:notes だけでは接続できない', writeOnlyWs.ok, false);
    check('403 で拒否される', writeOnlyWs.status, 403);
    check('legacy は接続できる', (await websocketStatus(legacyToken)).ok, true);
    check('未認証は公開タイムライン用に接続できる', (await websocketStatus()).ok, true);

    console.log('\n🗝️ [5-f] 設定から API キーを発行・失効');
    const createKey = await api('POST', '/api/api-keys', alice, { name: 'My Misskey', scopes: ['read', 'write:notes'] });
    check('API キーを発行できる', createKey.status, 201);
    const keyToken = String(createKey.data?.token || '');
    check('トークンが返る', keyToken.startsWith('spica_sess_'), true);
    check('キーとして認証できる', (await api('GET', '/api/auth/me', keyToken)).status, 200);
    check('write:notes の範囲で投稿できる', (await api('POST', '/api/posts', keyToken, { content: 'from api key' })).status < 300, true);
    check(
      'write:follows は無いのでフォローは 403',
      (await api('POST', '/api/follow', keyToken, { targetHandle: `@bob@localhost:${PORT}` })).status,
      403,
    );
    const keyList = await api('GET', '/api/api-keys', alice);
    const keyItem = (keyList.data?.keys || []).find((k: any) => k.name === 'My Misskey');
    check('一覧に出る', keyItem?.name, 'My Misskey');
    check('スコープが一覧に出る', keyItem?.scopes, ['read', 'write:notes']);
    check('MiAuth のアプリは API キー一覧に出ない', (keyList.data?.keys || []).some((k: any) => k.name === 'NotesApp'), false);
    check('空の権限は 400', (await api('POST', '/api/api-keys', alice, { name: 'x', scopes: [] })).status, 400);
    check('知らない権限は 400', (await api('POST', '/api/api-keys', alice, { name: 'x', scopes: ['legacy'] })).status, 400);
    check('名前なしは 400', (await api('POST', '/api/api-keys', alice, { name: '  ', scopes: ['read'] })).status, 400);
    check('アプリのトークンでは一覧できない', (await api('GET', '/api/api-keys', notesToken)).status, 403);
    check(
      'アプリのトークンでは発行できない',
      (await api('POST', '/api/api-keys', notesToken, { name: 'x', scopes: ['read'] })).status,
      403,
    );
    const sessionsWithKey = await api('GET', '/api/sessions', alice);
    check(
      'セッション一覧にもアプリとして出る',
      (sessionsWithKey.data?.sessions || []).some((s: any) => s.app_name === 'My Misskey' && s.kind === 'app'),
      true,
    );
    check('失効できる', (await api('DELETE', `/api/api-keys/${keyItem?.id}`, alice)).status, 200);
    check('失効したキーは使えない', (await api('GET', '/api/auth/me', keyToken)).status, 401);

    console.log('\n🗂️ [6] 設定のセッション一覧と失効');
    const list = await api('GET', '/api/sessions', alice);
    const notesSession = (list.data?.sessions || []).find((s: any) => s.app_name === 'NotesApp');
    check('アプリ名が一覧に出る', notesSession?.app_name, 'NotesApp');
    check('種別が app', notesSession?.kind, 'app');
    check('スコープが一覧に出る', notesSession?.scopes, ['read', 'write:notes']);
    const oldSession = (list.data?.sessions || []).find((s: any) => s.app_name === 'OldApp');
    check('旧トークンもアプリとして見える', oldSession?.scopes, ['legacy']);
    const revoke = await api('DELETE', `/api/sessions/${notesSession?.id}`, alice);
    check('アプリのセッションを解除できる', revoke.status, 200);
    check('解除したトークンは使えない', (await api('GET', '/api/auth/me', notesToken)).status, 401);
  } catch (err) {
    console.error('❌ テスト失敗:', err);
    failed++;
  } finally {
    if (server?.pid) {
      // 同期でプロセスツリーを止める（非同期だと次の実行が DB を掴んだまま始まる）
      try { spawnSync('taskkill', ['/pid', String(server.pid), '/f', '/t'], { shell: true, timeout: 10000 }); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log('');
  console.log(`結果: ${passed} 件成功 / ${failed} 件失敗`);
  process.exit(failed > 0 ? 1 : 0);
}

void run();
