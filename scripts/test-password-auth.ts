import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// Phase 2: パスワード方式（auth_mode = password）の検証
//   1. auth_mode の切替（master_key が既定 / password に変更できる）
//   2. password モードの登録: メール＋パスワード必須（形式・長さ・重複）
//   3. ログイン: ユーザーID＋パスワード / メールアドレス＋パスワード
//   4. 誤ったパスワードの拒否、マスターキーでもログイン可能（締め出し防止）
//   5. パスワードは平文で保存されない（scrypt ハッシュ）
//   6. master_key モードでは従来どおりパスワード無しで登録できる（後方互換）
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_password_auth.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 4911;
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
      `空きポートを指定して実行してください:  TEST_PORT=4920 npx tsx scripts/test-password-auth.ts`,
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
  console.log('🧪 Phase 2: パスワード方式の検証');
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
        INSTANCE_NAME: 'Password Auth Test',
      },
      stdio: 'pipe',
      shell: true,
    });
    server.stdout?.on('data', () => {});

    if (!(await waitForServer(BASE))) throw new Error('サーバー起動失敗');
    console.log('✅ サーバー起動完了\n');

    const json = { 'Content-Type': 'application/json' };
    const register = async (body: Record<string, unknown>) => {
      const res = await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: json, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const login = async (body: Record<string, unknown>) => {
      const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    // ------------------------------------------------------------------
    console.log('⚙️  [1] 既定はマスターキー方式（後方互換）');
    const statusDefault = await (await fetch(`${BASE}/api/auth/recovery/status`)).json();
    check('既定の認証方式', statusDefault.authMode, 'master_key');

    const legacy = await register({ id: 'legacy', name: 'legacy さん', agreedToRules: true });
    check('パスワード無しでも登録できる', legacy.status, 201);
    check('マスターキーが返る', String(legacy.body?.masterKey || '').startsWith('spica_sk_'), true);

    // ------------------------------------------------------------------
    console.log('\n🔐 [2] パスワード方式へ切替（管理者）');
    const adminAuth = { 'Content-Type': 'application/json', Authorization: `Bearer ${legacy.body.sessionToken}` };
    const switchRes = await fetch(`${BASE}/api/admin/auth-settings`, {
      method: 'POST', headers: adminAuth, body: JSON.stringify({ authMode: 'password' }),
    });
    check('切替のステータス', switchRes.status, 200);
    const statusAfter = await (await fetch(`${BASE}/api/auth/recovery/status`)).json();
    check('切替後の認証方式', statusAfter.authMode, 'password');

    const invalidMode = await fetch(`${BASE}/api/admin/auth-settings`, {
      method: 'POST', headers: adminAuth, body: JSON.stringify({ authMode: 'nonsense' }),
    });
    check('不正な値は 400', invalidMode.status, 400);

    // ------------------------------------------------------------------
    console.log('\n📝 [3] パスワード方式の登録（バリデーション）');
    const noEmail = await register({ id: 'p1', name: 'p1', agreedToRules: true, password: 'supersecret1' });
    check('メール無しは 400', noEmail.status, 400);

    const badEmail = await register({ id: 'p2', name: 'p2', agreedToRules: true, email: 'bad-email', password: 'supersecret1' });
    check('メール形式が不正なら 400', badEmail.status, 400);

    const shortPassword = await register({ id: 'p3', name: 'p3', agreedToRules: true, email: 'p3@example.com', password: 'short' });
    check('短いパスワードは 400', shortPassword.status, 400);

    const created = await register({ id: 'alice2', name: 'Alice2', agreedToRules: true, email: 'alice2@example.com', password: 'supersecret1' });
    check('正しい入力で登録できる', created.status, 201);
    check('マスターキーも返る（復元用）', String(created.body?.masterKey || '').startsWith('spica_sk_'), true);

    const duplicateEmail = await register({ id: 'alice3', name: 'Alice3', agreedToRules: true, email: 'alice2@example.com', password: 'supersecret1' });
    check('同じメールは 409', duplicateEmail.status, 409);

    // ------------------------------------------------------------------
    console.log('\n🔓 [4] パスワードでのログイン');
    const byId = await login({ id: 'alice2', password: 'supersecret1' });
    check('ユーザーID＋パスワードでログイン', byId.status, 200);
    check('セッションが発行される', String(byId.body?.sessionToken || '').startsWith('spica_sess_'), true);

    const byEmail = await login({ email: 'alice2@example.com', password: 'supersecret1' });
    check('メールアドレス＋パスワードでログイン', byEmail.status, 200);

    const wrongPassword = await login({ id: 'alice2', password: 'wrongpassword' });
    check('誤ったパスワードは 401', wrongPassword.status, 401);

    const unknownEmail = await login({ email: 'nobody@example.com', password: 'supersecret1' });
    check('存在しないメールは 401', unknownEmail.status, 401);

    const noCredential = await login({ id: 'alice2' });
    check('認証情報なしは 400', noCredential.status, 400);

    // マスターキーでもログインできる（締め出し防止）
    const byMasterKey = await login({ id: 'alice2', masterKey: created.body.masterKey });
    check('パスワード方式でもマスターキーでログインできる', byMasterKey.status, 200);

    // マスターキー方式の既存ユーザーはメールでもパスワードでも入れない
    const legacyByPassword = await login({ id: 'legacy', password: 'supersecret1' });
    check('パスワード未設定ユーザーはパスワードで入れない(401)', legacyByPassword.status, 401);

    // ------------------------------------------------------------------
    console.log('\n🔒 [5] パスワードは平文で保存されない');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.resolve(ROOT_DIR, 'server', TEST_DB), { readOnly: true });
    const row = db.prepare('SELECT password_hash, email FROM users WHERE id = ?').get('alice2') as { password_hash: string; email: string };
    db.close();
    check('ハッシュ形式が scrypt', String(row.password_hash).startsWith('scrypt$'), true);
    check('平文パスワードが含まれない', String(row.password_hash).includes('supersecret1'), false);
    check('メールが保存される', row.email, 'alice2@example.com');

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 Phase 2（パスワード方式）の検証: すべて成功');
    } else {
      console.error(`❌ 検証: ${failures} 件失敗`);
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
