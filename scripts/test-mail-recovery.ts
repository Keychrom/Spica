import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// メールアドレス登録とマスターキー復元の検証
//   1. 管理者がメール登録を許可/不許可にできるか
//   2. メールアドレスの登録（確認コード送信→検証）
//   3. マスターキー紛失時の復元: ID+メール → 確認コード → 新キーをメールで受領
//   4. 新キーでログインでき、古いキーが無効になること
//   5. 存在秘匿（該当なしでも同じ応答）・誤ったコードの拒否
//
// SMTP はテスト内のモックサーバーで受信するため、実際のメール送信は不要。
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_mail_recovery.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 4811;
const SMTP_PORT = PORT + 1;
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
      `空きポートを指定して実行してください:  TEST_PORT=4820 npx tsx scripts/test-mail-recovery.ts`,
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

// --- モック SMTP サーバー（DATA の本文を記録する） ---
const receivedMails: string[] = [];
function startSmtpServer(): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = '';
      let inData = false;
      let current = '';
      socket.write('220 mock-smtp ready\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index: number;
        while ((index = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);

          if (inData) {
            if (line === '.') {
              inData = false;
              receivedMails.push(current);
              current = '';
              socket.write('250 OK queued\r\n');
            } else {
              current += `${line}\n`;
            }
            continue;
          }

          const cmd = line.toUpperCase();
          if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
            socket.write('250-mock-smtp\r\n250 AUTH LOGIN PLAIN\r\n');
          } else if (cmd.startsWith('AUTH')) {
            socket.write('235 Authentication successful\r\n');
          } else if (cmd.startsWith('MAIL FROM') || cmd.startsWith('RCPT TO')) {
            socket.write('250 OK\r\n');
          } else if (cmd.startsWith('DATA')) {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (cmd.startsWith('QUIT')) {
            socket.write('221 Bye\r\n');
            socket.end();
          } else {
            socket.write('250 OK\r\n');
          }
        }
      });
    });
    server.listen(SMTP_PORT, '127.0.0.1', () => resolve(server));
  });
}

/** quoted-printable をざっくり復号する（日本語ラベルを読むため） */
function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\r/g, '');
}

/** MIME 本文（base64 / quoted-printable / 平文）をテキストに復号する */
function decodeMailBody(raw: string): string {
  const separatorIndex = raw.search(/\r?\n\r?\n/);
  const headerPart = separatorIndex >= 0 ? raw.slice(0, separatorIndex) : '';
  const bodyPart = separatorIndex >= 0 ? raw.slice(separatorIndex).replace(/^\r?\n\r?\n/, '') : raw;

  if (/Content-Transfer-Encoding:\s*base64/i.test(headerPart)) {
    try {
      return Buffer.from(bodyPart.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      // 復号に失敗したら次の手段へ
    }
  }
  return decodeQuotedPrintable(raw);
}

/** 受信メールから確認コードを取り出す */
function extractCode(mail: string): string | null {
  const match = decodeMailBody(mail).match(/確認コード:\s*(\d{6})/);
  return match ? match[1] : null;
}

/** 受信メールから新しいマスターキーを取り出す */
function extractMasterKey(mail: string): string | null {
  const match = decodeMailBody(mail).match(/(spica_sk_[0-9a-f]{64})/);
  return match ? match[1] : null;
}

async function run() {
  console.log('====================================================');
  console.log('🧪 メールアドレス登録とマスターキー復元の検証');
  console.log(`   server=${PORT} smtp=${SMTP_PORT}`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;
  let smtp: net.Server | null = null;

  try {
    await assertPortFree(PORT);
    await assertPortFree(SMTP_PORT);
    smtp = await startSmtpServer();

    server = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Mail Test',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(SMTP_PORT),
        SMTP_FROM: 'no-reply@example.com',
        SMTP_SECURE: 'false',
      },
      stdio: 'pipe',
      shell: true,
    });
    server.stdout?.on('data', () => {});

    if (!(await waitForServer(BASE))) throw new Error('サーバー起動失敗');
    console.log('✅ サーバー起動完了\n');

    // 最初のユーザーは管理者
    const regRes = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'alice', name: 'alice さん', agreedToRules: true }),
    });
    const aliceBody = await regRes.json();
    const oldMasterKey = aliceBody.masterKey as string;
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceBody.sessionToken}` };
    check('管理者を作成', Boolean(oldMasterKey?.startsWith('spica_sk_')), true);

    // ------------------------------------------------------------------
    console.log('⚙️  [1] 管理者によるメール登録の可否');
    const statusInitial = await (await fetch(`${BASE}/api/auth/recovery/status`)).json();
    check('既定ではメール登録は不許可', statusInitial.allowEmailRegistration, false);
    check('SMTP は設定済みとして認識される', statusInitial.mailConfigured, true);
    check('既定では復元も不可', statusInitial.recoveryAvailable, false);

    const blockedRes = await fetch(`${BASE}/api/user/email`, {
      method: 'POST', headers: auth, body: JSON.stringify({ email: 'alice@example.com' }),
    });
    check('不許可時は 403', blockedRes.status, 403);

    const allowRes = await fetch(`${BASE}/api/admin/auth-settings`, {
      method: 'POST', headers: auth, body: JSON.stringify({ allowEmailRegistration: true }),
    });
    check('許可に変更できる', allowRes.status, 200);
    const statusAllowed = await (await fetch(`${BASE}/api/auth/recovery/status`)).json();
    check('許可後の復元可否', statusAllowed.recoveryAvailable, true);
    check('認証方式は master_key のまま', statusAllowed.authMode, 'master_key');

    // ------------------------------------------------------------------
    console.log('\n📧 [2] メールアドレスの登録と確認');
    const invalidMail = await fetch(`${BASE}/api/user/email`, {
      method: 'POST', headers: auth, body: JSON.stringify({ email: 'not-an-email' }),
    });
    check('形式が不正なら 400', invalidMail.status, 400);

    const beforeCount = receivedMails.length;
    const emailRes = await fetch(`${BASE}/api/user/email`, {
      method: 'POST', headers: auth, body: JSON.stringify({ email: 'alice@example.com' }),
    });
    check('登録リクエストのステータス', emailRes.status, 200);
    check('確認メールが1通届く', receivedMails.length, beforeCount + 1);
    const code = extractCode(receivedMails[receivedMails.length - 1]);
    check('確認コードが6桁で届く', Boolean(code && /^\d{6}$/.test(code)), true);

    const wrongCode = await fetch(`${BASE}/api/user/email/verify`, {
      method: 'POST', headers: auth, body: JSON.stringify({ email: 'alice@example.com', code: '000000' }),
    });
    check('誤ったコードは 400', wrongCode.status, 400);

    const verifyRes = await fetch(`${BASE}/api/user/email/verify`, {
      method: 'POST', headers: auth, body: JSON.stringify({ email: 'alice@example.com', code }),
    });
    check('正しいコードで確認完了', verifyRes.status, 200);

    // ------------------------------------------------------------------
    console.log('\n🔑 [3] マスターキー紛失からの復元');
    const unknownUser = await fetch(`${BASE}/api/auth/recovery/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'nobody', email: 'alice@example.com' }),
    });
    check('存在しないIDでも同じ応答(200)', unknownUser.status, 200);
    const mailsAfterUnknown = receivedMails.length;

    const wrongMail = await fetch(`${BASE}/api/auth/recovery/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'alice', email: 'other@example.com' }),
    });
    check('メール不一致でも同じ応答(200)', wrongMail.status, 200);
    check('メールは送られない（存在秘匿）', receivedMails.length, mailsAfterUnknown);

    const recoveryReq = await fetch(`${BASE}/api/auth/recovery/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'alice', email: 'alice@example.com' }),
    });
    check('正しい組み合わせで200', recoveryReq.status, 200);
    check('復元コードのメールが届く', receivedMails.length, mailsAfterUnknown + 1);
    const recoveryCode = extractCode(receivedMails[receivedMails.length - 1]);
    check('復元コードが6桁', Boolean(recoveryCode && /^\d{6}$/.test(recoveryCode)), true);

    const badRecovery = await fetch(`${BASE}/api/auth/recovery/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'alice', email: 'alice@example.com', code: '111111' }),
    });
    check('誤ったコードでは復元されない(400)', badRecovery.status, 400);

    const recoveryRes = await fetch(`${BASE}/api/auth/recovery/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'alice', email: 'alice@example.com', code: recoveryCode }),
    });
    check('正しいコードで復元', recoveryRes.status, 200);
    const keyMail = receivedMails[receivedMails.length - 1];
    const newMasterKey = extractMasterKey(keyMail);
    check('新しいマスターキーがメールで届く', Boolean(newMasterKey), true);
    check('以前とは別のキー', newMasterKey !== oldMasterKey, true);

    // ------------------------------------------------------------------
    console.log('\n🔓 [4] 新キーでのログインと旧キーの無効化');
    const loginNew = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'alice', masterKey: newMasterKey }),
    });
    check('新しいマスターキーでログインできる', loginNew.status, 200);

    const loginOld = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'alice', masterKey: oldMasterKey }),
    });
    check('古いマスターキーは無効(401)', loginOld.status, 401);

    // 復元後は既存セッションも無効化される
    const oldSession = await fetch(`${BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${aliceBody.sessionToken}` },
    });
    check('復元前のセッションは無効化される(401)', oldSession.status, 401);

    // ------------------------------------------------------------------
    console.log('\n📮 [5] SMTP 接続テストとメール削除');
    const newAuth = { 'Content-Type': 'application/json', Authorization: `Bearer ${(await loginNew.json()).sessionToken}` };
    const testRes = await fetch(`${BASE}/api/admin/mail-settings/test`, {
      method: 'POST', headers: newAuth, body: JSON.stringify({}),
    });
    check('SMTP 接続テストが成功する', testRes.status, 200);

    const deleteEmail = await fetch(`${BASE}/api/user/email`, { method: 'DELETE', headers: newAuth });
    check('メールアドレスを削除できる', deleteEmail.status, 200);

    const reqAfterDelete = await fetch(`${BASE}/api/auth/recovery/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'alice', email: 'alice@example.com' }),
    });
    const mailsAfterDelete = receivedMails.length;
    check('削除後は復元リクエストで送信されない', mailsAfterDelete, mailsAfterDelete);
    check('削除後も応答は200（存在秘匿）', reqAfterDelete.status, 200);

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 メールアドレス登録とマスターキー復元の検証: すべて成功');
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
    if (smtp) smtp.close();
  }
}

run();
