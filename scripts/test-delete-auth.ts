import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { generateTotpCode } from '../server/src/totp.js';

/**
 * 退会 API（POST /api/user/delete-me）の本人確認
 *
 *  - 資格情報（マスターキー / パスワード）が無いだけでは退会できない
 *  - 空文字・空白だけのマスターキーも「無い」と同じに扱う
 *  - 誤ったマスターキー / パスワードは 401 で、アカウントは残る
 *  - 確認用ユーザーIDが違えば 400
 *  - 正しいパスワード / マスターキーなら退会できる（セッションは即時失効）
 *  - 2段階認証が有効なら、資格情報が正しくてもコード（またはリカバリーコード）が要る
 *  - 退会の試行で新しいセッションが増えない（以前は /api/auth/login で確認していた）
 */
const ROOT = process.cwd();
const TEST_DB = 'data_test_delete_auth.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3533;
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

/** 退会リクエスト（資格情報は呼び出し側が決める） */
function deleteMe(token: string, body: Record<string, unknown>): Promise<ApiResult> {
  return api('POST', '/api/user/delete-me', token, body);
}

/** 6桁のコードから、確実に別の6桁コードを作る */
function wrongTotpCode(secret: string): string {
  const correct = generateTotpCode(secret);
  return String((Number(correct) + 1) % 1000000).padStart(6, '0');
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
        INSTANCE_NAME: 'Delete Auth Test',
        // 総当たり対策のレート制限（10 回/分）でテスト自体が止まらないようにする
        RATE_LIMIT_DISABLED: 'true',
      },
      stdio: 'pipe',
      shell: true,
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    if (!(await waitForServer(`${BASE}/api/server-info`))) throw new Error('サーバー起動失敗');

    const register = async (id: string): Promise<{ token: string; masterKey: string }> => {
      const res = await api('POST', '/api/auth/register', undefined, { id, name: id, agreedToRules: true });
      if (!res.data?.sessionToken || !res.data?.masterKey) {
        throw new Error(`${id} の登録失敗: HTTP ${res.status} ${JSON.stringify(res.data)}`);
      }
      return { token: res.data.sessionToken as string, masterKey: res.data.masterKey as string };
    };

    // 最初の登録者は管理者になる（最後の管理者は退会できないため、管理者は別に用意する）
    await register('root');
    const alice = await register('alice');
    const bob = await register('bob');
    const carol = await register('carol');

    // bob はパスワード方式、carol は 2段階認証を有効にして検証する
    const setPassword = await api('POST', '/api/user/password', bob.token, {
      masterKey: bob.masterKey,
      newPassword: 'bob-password-123',
    });
    check('パスワードを設定できる', setPassword.status, 200);

    const totpSetup = await api('POST', '/api/me/totp/setup', carol.token, {});
    const totpSecret = String(totpSetup.data?.secret || '');
    if (!totpSecret) throw new Error(`TOTP 秘密の取得失敗: ${JSON.stringify(totpSetup.data)}`);
    const totpEnable = await api('POST', '/api/me/totp/enable', carol.token, {
      code: generateTotpCode(totpSecret),
    });
    check('2段階認証を有効にできる', totpEnable.status, 200);

    const sessionCount = async (token: string): Promise<number> => {
      const res = await api('GET', '/api/sessions', token);
      return Array.isArray(res.data?.sessions) ? res.data.sessions.length : -1;
    };

    console.log('\n🚫 [1] 資格情報が無いだけでは退会できない');
    const sessionsBefore = await sessionCount(alice.token);
    const noCredential = await deleteMe(alice.token, { confirmUserId: 'alice' });
    check('資格情報なしは 401', noCredential.status, 401);
    check('資格情報が必要だと分かる', noCredential.data?.credential_required, true);
    check('アカウントは残る', (await api('GET', '/api/auth/me', alice.token)).status, 200);
    const blankKey = await deleteMe(alice.token, { confirmUserId: 'alice', masterKey: '   ' });
    check('空白だけのマスターキーは 401', blankKey.status, 401);
    check('空白でもアカウントは残る', (await api('GET', '/api/auth/me', alice.token)).status, 200);
    check('退会の試行でセッションが増えない', await sessionCount(alice.token), sessionsBefore);

    console.log('\n🔑 [2] 誤った資格情報は拒否する');
    const wrongKey = await deleteMe(alice.token, { confirmUserId: 'alice', masterKey: 'spica_sk_wrong' });
    check('誤ったマスターキーは 401', wrongKey.status, 401);
    const wrongPassword = await deleteMe(alice.token, { confirmUserId: 'alice', password: 'wrong-password' });
    check('パスワード未設定ユーザーのパスワードは 401', wrongPassword.status, 401);
    const wrongId = await deleteMe(alice.token, { confirmUserId: 'bob', masterKey: alice.masterKey });
    check('確認用ユーザーIDが違えば 400', wrongId.status, 400);
    check('誤った試行のあともアカウントは残る', (await api('GET', '/api/auth/me', alice.token)).status, 200);

    console.log('\n🔓 [3] 正しいパスワードで退会できる');
    const bobWrong = await deleteMe(bob.token, { confirmUserId: 'bob', password: 'not-bob-password' });
    check('誤ったパスワードは 401', bobWrong.status, 401);
    check('誤ったパスワードではアカウントは残る', (await api('GET', '/api/auth/me', bob.token)).status, 200);
    const bobDelete = await deleteMe(bob.token, { confirmUserId: 'bob', password: 'bob-password-123' });
    check('正しいパスワードで退会できる', bobDelete.status, 200);
    check('退会後はセッションが失効する', (await api('GET', '/api/auth/me', bob.token)).status, 401);
    check('他のユーザーは残る', (await api('GET', '/api/auth/me', alice.token)).status, 200);

    console.log('\n🔓 [4] 正しいマスターキーで退会できる');
    const aliceDelete = await deleteMe(alice.token, { confirmUserId: 'alice', masterKey: alice.masterKey });
    check('正しいマスターキーで退会できる', aliceDelete.status, 200);
    check('退会後はセッションが失効する', (await api('GET', '/api/auth/me', alice.token)).status, 401);

    console.log('\n🔐 [5] 2段階認証が有効ならコードも必要');
    const noCode = await deleteMe(carol.token, { confirmUserId: 'carol', masterKey: carol.masterKey });
    check('コードなしは 401', noCode.status, 401);
    check('コードが必要だと分かる', noCode.data?.totp_required, true);
    check('コードなしではアカウントは残る', (await api('GET', '/api/auth/me', carol.token)).status, 200);
    const wrongCode = await deleteMe(carol.token, {
      confirmUserId: 'carol',
      masterKey: carol.masterKey,
      totpCode: wrongTotpCode(totpSecret),
    });
    check('誤ったコードは 401', wrongCode.status, 401);
    check('誤ったコードでもアカウントは残る', (await api('GET', '/api/auth/me', carol.token)).status, 200);
    const carolDelete = await deleteMe(carol.token, {
      confirmUserId: 'carol',
      masterKey: carol.masterKey,
      totpCode: generateTotpCode(totpSecret),
    });
    check('正しいコードなら退会できる', carolDelete.status, 200);
    check('2FA ユーザーも退会後はセッション失効', (await api('GET', '/api/auth/me', carol.token)).status, 401);

    console.log('\n🧾 [6] クライアントは退会確認にログイン API を使わない');
    const securitySource = fs.readFileSync(
      path.join(ROOT, 'client', 'src', 'components', 'settings', 'SecuritySection.tsx'),
      'utf8',
    );
    check(
      'SecuritySection は /api/auth/login を呼ばない',
      securitySource.includes("api.post('/api/auth/login'") || securitySource.includes('verifyPassword'),
      false,
    );
    check('SecuritySection は退会 API へ直接送る', securitySource.includes('/api/user/delete-me'), true);
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
