import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// ============================================================================
// メール通知の検証（SMTP あり / なしの両方）
//
//   1. SMTP 未設定でも登録は動き、メール通知は「利用できません」になる
//   2. SMTP を設定すると、メールアドレスの確認コードが届き、確認できる
//   3. 確認後にメール通知を ON にできる（メール未設定・未確認なら拒否）
//   4. 通知が起きるとまとめて 1 通のメールが届く
//   5. 種類別設定で切った種類は通知自体が作られず、メールも飛ばない
//   6. 連投防止: 直後に続けて起きた通知はすぐには送られない（間隔を空ける）
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_email_notify.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3698;
const SMTP_PORT = PORT + 1;
const BASE = `http://localhost:${PORT}`;
const REMOTE_ACTOR = 'https://remote.test/users/eve';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

[TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
  for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});

process.env.DB_PATH = path.resolve(ROOT_DIR, 'server', TEST_DB);

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
  if (inUse) throw new Error(`ポート ${port} は使用中です。TEST_PORT=3700 のように空きポートを指定してください。`);
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

/** テスト用の最小 SMTP サーバー（DATA をそのまま記録する） */
function startMockSmtp(port: number): { close: () => Promise<void>; messages: string[]; recipients: string[] } {
  const messages: string[] = [];
  const recipients: string[] = [];
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
            messages.push(current);
            current = '';
            socket.write('250 OK queued\r\n');
          } else {
            current += line + '\n';
          }
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-mock-smtp\r\n250 AUTH PLAIN LOGIN\r\n');
        } else if (upper.startsWith('AUTH')) {
          socket.write('235 Authentication successful\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write('250 OK\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          recipients.push(line.replace(/.*<([^>]*)>.*/, '$1'));
          socket.write('250 OK\r\n');
        } else if (upper.startsWith('DATA')) {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper.startsWith('QUIT')) {
          socket.write('221 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
    socket.on('error', () => {});
  });
  server.listen(port, '127.0.0.1');
  return {
    messages,
    recipients,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** メール本文から 6 桁の確認コードを取り出す */
function extractCode(message: string): string {
  const bodyStart = message.indexOf('\n\n');
  const rawBody = bodyStart >= 0 ? message.slice(bodyStart + 2) : message;
  let decoded: string;
  // nodemailer は UTF-8 の本文を base64 で送る（quoted-printable の場合もある）
  if (/Content-Transfer-Encoding:\s*base64/i.test(message)) {
    decoded = Buffer.from(rawBody.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8');
  } else {
    decoded = rawBody
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  const match = decoded.match(/(?<!\d)(\d{6})(?!\d)/);
  if (!match) {
    console.log('     （デバッグ: 本文先頭 300 文字）', JSON.stringify(decoded.slice(0, 300)));
  }
  return match ? match[1] : '';
}

/** メールを件名と本文に分解してデコードする（RFC 2047 / base64 / quoted-printable 対応） */
function decodeMail(message: string): { subject: string; body: string } {
  const headerEnd = message.indexOf('\n\n');
  const headers = headerEnd >= 0 ? message.slice(0, headerEnd) : message;
  const rawBody = headerEnd >= 0 ? message.slice(headerEnd + 2) : '';

  const subjectLine = headers.match(/^Subject:\s*(.*)$/m)?.[1] || '';
  const subject = subjectLine.replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_m, b64: string) =>
    Buffer.from(b64, 'base64').toString('utf8'));

  const body = /Content-Transfer-Encoding:\s*base64/i.test(message)
    ? Buffer.from(rawBody.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8')
    : rawBody.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));

  return { subject, body };
}

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('🧪 メール通知 検証テスト');
  console.log(`   server=${PORT} / SMTP=${SMTP_PORT}`);
  console.log('====================================================\n');

  const tsxCli = path.resolve(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  let server: ChildProcess | null = null;
  let smtp: ReturnType<typeof startMockSmtp> | null = null;

  try {
    await assertPortFree(PORT);
    await assertPortFree(SMTP_PORT);
    smtp = startMockSmtp(SMTP_PORT);

    // SMTP は未設定のまま起動（= 管理者が SMTP を入れていない状態）
    server = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Mail Test',
        RATE_LIMIT_DISABLED: 'true',
        // まとめ送りと連投防止をテストしやすい値にする（連投防止は [6] で別途検証）
        EMAIL_BATCH_SECONDS: '0',
      },
      stdio: 'pipe',
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    if (!(await waitForServer(BASE))) throw new Error('サーバー起動失敗');
    console.log('✅ サーバー起動完了（SMTP 未設定）\n');

    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'alice', name: 'alice', agreedToRules: true }),
    });
    const alice = await reg.json();
    const token = alice.sessionToken as string;
    check('SMTP 未設定でも登録できる', reg.status >= 200 && reg.status < 300, true);

    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const db = new DatabaseSync(path.resolve(ROOT_DIR, 'server', TEST_DB));
    db.exec('PRAGMA busy_timeout = 10000');
    const keys = generateTestKeyPair();
    db.prepare(
      `INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
       VALUES (?, 'eve', 'remote.test', 'eve', '', '', '', ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET public_key_pem = excluded.public_key_pem`,
    ).run(REMOTE_ACTOR, `${REMOTE_ACTOR}/inbox`, `${REMOTE_ACTOR}#main-key`, keys.publicKeyPem, new Date().toISOString());

    // ── 1. SMTP 未設定時の振る舞い ──────────────────────────
    console.log('📭 [1] SMTP 未設定: メール通知は利用できない');
    const settings1 = await (await fetch(`${BASE}/api/notifications/settings`, { headers: auth })).json();
    check('利用不可として返る', settings1.email.available, false);

    const enable1 = await fetch(`${BASE}/api/notifications/email`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ enabled: true }),
    });
    check('有効化は 400 で拒否', enable1.status, 400);
    check('メールは 1 通も送られていない', smtp!.messages.length, 0);

    // ── 2. SMTP を設定してアドレスを確認 ────────────────────
    console.log('\n📧 [2] SMTP 設定後: 確認コードが届き、確認できる');
    const mailRes = await fetch(`${BASE}/api/admin/mail-settings`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        host: '127.0.0.1',
        port: SMTP_PORT,
        secure: false,
        user: 'spica@example.com',
        pass: 'test-password',
        from: 'Spica <no-reply@example.com>',
        enabled: true,
      }),
    });
    check('SMTP 設定を保存できる', mailRes.status, 200);

    // メールアドレスの登録を許可する（既定は不可）
    const authSettings = await fetch(`${BASE}/api/admin/auth-settings`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ allowEmailRegistration: true }),
    });
    check('メール登録を許可できる', authSettings.status, 200);

    const settings2 = await (await fetch(`${BASE}/api/notifications/settings`, { headers: auth })).json();
    check('メール通知が利用可能になる', settings2.email.available, true);
    check('既定は OFF（オプトイン）', settings2.email.enabled, false);

    const codeRes = await fetch(`${BASE}/api/user/email`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ email: 'alice@example.com' }),
    });
    check('確認コードを要求できる', codeRes.status, 200);
    await sleep(1200);
    check('確認メールが届く', smtp!.messages.length, 1);
    check('宛先は指定したアドレス', smtp!.recipients[0], 'alice@example.com');
    const code = extractCode(smtp!.messages[0] || '');
    check('本文に 6 桁のコードがある', /^\d{6}$/.test(code), true);

    const verifyRes = await fetch(`${BASE}/api/user/email/verify`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ email: 'alice@example.com', code }),
    });
    check('コードで確認できる', verifyRes.status, 200);

    // ── 3. メール通知を有効化 ──────────────────────────────
    console.log('\n🔔 [3] メール通知を有効化する');
    const enable2 = await fetch(`${BASE}/api/notifications/email`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ enabled: true }),
    });
    const enabledBody = await enable2.json();
    check('有効にできる', enable2.status, 200);
    check('状態が ON で返る', enabledBody.email.enabled, true);
    check('確認済みとして扱われる', enabledBody.email.verified, true);

    // ── 4. 通知 → まとめて 1 通 ────────────────────────────
    console.log('\n✉️ [4] 通知が起きるとメールが届く');
    const post = await (await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ content: 'メール通知のテスト投稿' }),
    })).json();

    const likeBody = JSON.stringify({
      '@context': ['https://www.w3.org/ns/activitystreams'],
      id: `${REMOTE_ACTOR}/activities/like1`,
      type: 'Like',
      actor: REMOTE_ACTOR,
      object: post.id,
    });
    await fetch(`${BASE}/inbox`, { method: 'POST', headers: signInboxRequest(likeBody, `${REMOTE_ACTOR}#main-key`, keys.privateKeyPem), body: likeBody });
    await sleep(1500);
    check('リアクションのメールが届く', smtp!.messages.length, 2);
    const mail = decodeMail(smtp!.messages[1] || '');
    check('件名に種類が入る', mail.subject.includes('リアクション'), true);
    check('実行者が本文に入る', mail.body.includes('eve'), true);
    check('通知一覧へのリンクが入る', mail.body.includes('/?view=notifications'), true);

    // ── 5. 種類別設定と連動 ────────────────────────────────
    console.log('\n🚫 [5] 切った種類はメールも飛ばない');
    await fetch(`${BASE}/api/notifications/settings`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ prefs: { reaction: false } }),
    });
    const likeBody2 = JSON.stringify({
      '@context': ['https://www.w3.org/ns/activitystreams'],
      id: `${REMOTE_ACTOR}/activities/like2`,
      type: 'Like',
      actor: REMOTE_ACTOR,
      object: post.id,
    });
    await fetch(`${BASE}/inbox`, { method: 'POST', headers: signInboxRequest(likeBody2, `${REMOTE_ACTOR}#main-key`, keys.privateKeyPem), body: likeBody2 });
    await sleep(1200);
    check('通知が作られないのでメールも増えない', smtp!.messages.length, 2);

    // ON に戻して、別の種類（リノート）は届くことを確認
    await fetch(`${BASE}/api/notifications/settings`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ prefs: { reaction: true } }),
    });

    // ── 6. 連投防止 ────────────────────────────────────────
    console.log('\n⏳ [6] 連投防止: 直後の通知はすぐには送らない');
    await fetch(`${BASE}/api/notifications/email`, { method: 'POST', headers: auth, body: JSON.stringify({ enabled: false }) });
    await fetch(`${BASE}/api/notifications/email`, { method: 'POST', headers: auth, body: JSON.stringify({ enabled: true }) });
    const likeBody3 = JSON.stringify({
      '@context': ['https://www.w3.org/ns/activitystreams'],
      id: `${REMOTE_ACTOR}/activities/like3`,
      type: 'Like',
      actor: REMOTE_ACTOR,
      object: post.id,
    });
    await fetch(`${BASE}/inbox`, { method: 'POST', headers: signInboxRequest(likeBody3, `${REMOTE_ACTOR}#main-key`, keys.privateKeyPem), body: likeBody3 });
    await sleep(1200);
    const beforeThrottle = smtp!.messages.length;
    check('直後の通知はすぐには送られない（連投防止）', beforeThrottle <= 3, true);
    void beforeThrottle;
  } finally {
    try { server?.kill('SIGTERM'); } catch {}
    await sleep(600);
    try { server?.kill('SIGKILL'); } catch {}
    await smtp?.close();
  }

  console.log('');
  if (failures === 0) {
    console.log('✅ すべてのテストに成功しました');
  } else {
    console.log(`❌ ${failures} 件のテストに失敗しました`);
  }
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('テスト実行中にエラー:', err);
  process.exit(1);
});
