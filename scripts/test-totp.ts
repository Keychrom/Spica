import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';
import { generateTotpCode, base32Decode } from '../server/src/totp.js';

// ============================================================================
// 2段階認証（TOTP）の検査
//
//   [1] アルゴリズム（RFC 6238 のテストベクタと一致すること）
//   [2] 設定の流れ（setup → enable）とリカバリーコード
//   [3] ログイン（コード必須・誤りは拒否・リカバリーコードは一度だけ）
//   [4] 無効化・再発行（現在のコードが必要）
//   [5] 他のログイン手段を壊していないこと
//   [6] パスキー（WebAuthn）でもコードを要求すること
//
// ポートは TEST_PORT で変更可能（既定 3646）。
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_totp.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3646;
const BASE = `http://localhost:${PORT}`;
const DOMAIN = `localhost:${PORT}`;

[TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
  for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});

/** PostgreSQL でも回せる（run-suites-pg.sh から呼ばれたときは DB_DRIVER=postgres） */
const USE_PG =
  (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'postgres' && Boolean(process.env.TEST_DATABASE_URL);

const openDb = (): ReturnType<typeof createAsyncDatabase> =>
  USE_PG
    ? createAsyncDatabase({ driver: 'postgres', connectionString: process.env.TEST_DATABASE_URL as string })
    : createAsyncDatabase({ driver: 'sqlite', dbPath: path.resolve(ROOT_DIR, 'server', TEST_DB) });

async function exec(sql: string, ...params: any[]): Promise<void> {
  const conn = openDb();
  try {
    await conn.prepare(sql).run(...params);
  } finally {
    await conn.close().catch(() => {});
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
let checks = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
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
  if (inUse) {
    throw new Error(
      `ポート ${port} では既にサーバーが応答しています。稼働中のインスタンスへ書き込まないよう中断しました。\n` +
      `空きポートを指定して実行してください:  TEST_PORT=3646 npx tsx scripts/test-totp.ts`,
    );
  }
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

async function waitForPortFree(port: number, maxRetries = 20): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await assertPortFree(port);
      return;
    } catch {
      await sleep(300);
    }
  }
}

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('🧪 2段階認証（TOTP）の検査');
  console.log(`   server=${PORT}`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;
  let completed = false;
  const dbPath = path.resolve(ROOT_DIR, 'server', TEST_DB);

  try {
    // ======================================================================
    console.log('📐 [1] アルゴリズム（RFC 6238 のテストベクタ）');
    const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
    check('base32 のデコード', base32Decode(rfcSecret).toString(), '12345678901234567890');
    check('59 秒時点', generateTotpCode(rfcSecret, 59_000), '287082');
    check('1111111109 秒時点', generateTotpCode(rfcSecret, 1_111_111_109_000), '081804');
    check('1234567890 秒時点', generateTotpCode(rfcSecret, 1_234_567_890_000), '005924');
    check('2000000000 秒時点', generateTotpCode(rfcSecret, 2_000_000_000_000), '279037');

    await assertPortFree(PORT);
    const tsxCli = path.resolve(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    server = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN,
        PROTOCOL: 'http',
        DB_PATH: dbPath,
        INSTANCE_NAME: 'TOTP Test',
        RATE_LIMIT_DISABLED: 'true',
      },
      stdio: 'pipe',
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    if (!(await waitForServer(BASE))) throw new Error('サーバー起動失敗');
    console.log('\n✅ サーバー起動完了\n');

    const api = async (
      method: string,
      endpoint: string,
      token?: string,
      body?: unknown,
    ): Promise<{ status: number; data: any }> => {
      const res = await fetch(`${BASE}${endpoint}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let data: any = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { status: res.status, data };
    };

    const aliceReg = await api('POST', '/api/auth/register', undefined, { id: 'alice', name: 'Alice', agreedToRules: true });
    check('登録できる', aliceReg.status, 201);
    const aliceToken = aliceReg.data.sessionToken as string;
    const aliceKey = aliceReg.data.masterKey as string;
    const meBefore = await api('GET', '/api/auth/me', aliceToken);
    check('最初は2段階認証が無効', meBefore.data?.totp_enabled, 0);
    check('設定画面の状態も無効', (await api('GET', '/api/me/totp', aliceToken)).data?.enabled, false);

    // ======================================================================
    console.log('\n🔐 [2] 設定の流れ（setup → enable）');

    const setup = await api('POST', '/api/me/totp/setup', aliceToken);
    check('秘密が発行される', typeof setup.data?.secret, 'string');
    check('base32 として読める', base32Decode(String(setup.data?.secret || '')).length, 20);
    check('otpauth URI が返る', String(setup.data?.otpauth_uri || '').startsWith('otpauth://totp/'), true);
    check('まだ有効にはならない', (await api('GET', '/api/me/totp', aliceToken)).data?.enabled, false);

    const wrongEnable = await api('POST', '/api/me/totp/enable', aliceToken, { code: '000000' });
    check('誤ったコードでは有効化できない', wrongEnable.status, 400);
    check('コードの誤りだと分かる', String(wrongEnable.data?.error || '').includes('コード'), true);

    const secret = String(setup.data.secret);
    const enable = await api('POST', '/api/me/totp/enable', aliceToken, { code: generateTotpCode(secret) });
    check('正しいコードで有効化できる', enable.status, 200);
    const recoveryCodes: string[] = enable.data?.recovery_codes || [];
    check('リカバリーコードが10個返る', recoveryCodes.length, 10);
    check('設定画面でも有効になる', (await api('GET', '/api/me/totp', aliceToken)).data?.enabled, true);
    check('残りのリカバリーコード数', (await api('GET', '/api/me/totp', aliceToken)).data?.remainingCodes, 10);
    check('auth/me にも反映される', (await api('GET', '/api/auth/me', aliceToken)).data?.totp_enabled, 1);

    // ======================================================================
    console.log('\n🚪 [3] ログイン');

    const noCode = await api('POST', '/api/auth/login', undefined, { id: 'alice', masterKey: aliceKey });
    check('コード無しでは入れない', noCode.status, 401);
    check('コードが必要だと分かる', noCode.data?.totp_required, true);

    const badCode = await api('POST', '/api/auth/login', undefined, { id: 'alice', masterKey: aliceKey, totpCode: '123456' });
    check('誤ったコードでは入れない', badCode.status, 401);
    check('再入力できる（totp_required）', badCode.data?.totp_required, true);

    const goodCode = await api('POST', '/api/auth/login', undefined, { id: 'alice', masterKey: aliceKey, totpCode: generateTotpCode(secret) });
    check('正しいコードで入れる', goodCode.status, 200);
    check('セッションが発行される', typeof goodCode.data?.sessionToken, 'string');

    // リカバリーコードは一度だけ使える
    const byRecovery = await api('POST', '/api/auth/login', undefined, { id: 'alice', masterKey: aliceKey, totpCode: recoveryCodes[0] });
    check('リカバリーコードでも入れる', byRecovery.status, 200);
    check('使った分だけ減る', (await api('GET', '/api/me/totp', aliceToken)).data?.remainingCodes, 9);

    const reuseRecovery = await api('POST', '/api/auth/login', undefined, { id: 'alice', masterKey: aliceKey, totpCode: recoveryCodes[0] });
    check('同じリカバリーコードは二度使えない', reuseRecovery.status, 401);

    // ======================================================================
    console.log('\n♻️ [4] 無効化・再発行');

    const badDisable = await api('POST', '/api/me/totp/disable', aliceToken, { code: '000000' });
    check('誤ったコードでは無効化できない', badDisable.status, 401);
    check('無効化されていない', (await api('GET', '/api/me/totp', aliceToken)).data?.enabled, true);

    const regen = await api('POST', '/api/me/totp/recovery-codes', aliceToken, { code: generateTotpCode(secret) });
    check('リカバリーコードを再発行できる', regen.status, 200);
    check('新しいコードが10個', (regen.data?.recovery_codes || []).length, 10);
    check('古いコードは無効になる', (await api('POST', '/api/auth/login', undefined, { id: 'alice', masterKey: aliceKey, totpCode: recoveryCodes[1] })).status, 401);

    const disable = await api('POST', '/api/me/totp/disable', aliceToken, { code: generateTotpCode(secret) });
    check('正しいコードで無効化できる', disable.status, 200);
    check('無効になった', (await api('GET', '/api/me/totp', aliceToken)).data?.enabled, false);

    const afterDisable = await api('POST', '/api/auth/login', undefined, { id: 'alice', masterKey: aliceKey });
    check('無効化後はコード無しで入れる', afterDisable.status, 200);
    check('古い秘密では入れない（コードが不要なので通る）', typeof afterDisable.data?.sessionToken, 'string');

    // ======================================================================
    console.log('\n🧩 [5] 他の経路を壊していないか');

    const bobReg = await api('POST', '/api/auth/register', undefined, { id: 'bob', name: 'Bob', agreedToRules: true });
    const bobKey = bobReg.data.masterKey as string;
    check('2段階認証を使わない人はそのまま入れる', (await api('POST', '/api/auth/login', undefined, { id: 'bob', masterKey: bobKey })).status, 200);
    check('bob の設定は無効のまま', (await api('GET', '/api/auth/me', bobReg.data.sessionToken)).data?.totp_enabled, 0);
    check('未ログインでは設定 API を使えない', (await api('POST', '/api/me/totp/setup')).status, 401);

    // ======================================================================
    console.log('\n🔑 [6] パスキー（WebAuthn）でもコードを要求する');

    // alice は [4] で無効にしたので、もう一度有効にする
    const setup2 = await api('POST', '/api/me/totp/setup', aliceToken);
    const secret2 = String(setup2.data.secret);
    const enable2 = await api('POST', '/api/me/totp/enable', aliceToken, { code: generateTotpCode(secret2) });
    check('もう一度有効にできる', enable2.status, 200);
    const recovery2: string[] = enable2.data?.recovery_codes || [];

    // ソフトウェア認証器（P-256 の鍵を 1 組作り、COSE の公開鍵を DB に入れる）
    const makeCredential = () => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const jwk = publicKey.export({ format: 'jwk' }) as { x?: string; y?: string };
      const x = Buffer.from(String(jwk.x), 'base64url');
      const y = Buffer.from(String(jwk.y), 'base64url');
      // CBOR: map(5) { 1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y }
      const cose = Buffer.from([
        0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01,
        0x21, 0x58, 0x20, ...x,
        0x22, 0x58, 0x20, ...y,
      ]);
      return {
        id: crypto.randomBytes(32).toString('base64url'),
        publicKeyCose: cose.toString('base64'),
        privateKey,
        counter: 0,
      };
    };

    const insertCredential = async (userId: string, cred: { id: string; publicKeyCose: string }) => {
      await exec(
        'INSERT INTO webauthn_credentials (id, user_id, public_key, counter, device_name, transports, created_at, last_used_at) VALUES (?,?,?,?,?,?,?,?)',
        cred.id, userId, cred.publicKeyCose, 0, '検査用', '[]', new Date().toISOString(), null,
      );
    };

    /** 本物の assertion を作る（authenticatorData + clientDataJSON に ES256 で署名する） */
    const buildAssertion = (cred: ReturnType<typeof makeCredential>, challenge: string, origin: string, rpId: string, counter: number) => {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }), 'utf8');
      const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
      const counterBuf = Buffer.alloc(4);
      counterBuf.writeUInt32BE(counter, 0);
      const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x05 /* UP|UV */]), counterBuf]);
      const signature = crypto.sign(
        'sha256',
        Buffer.concat([authenticatorData, crypto.createHash('sha256').update(clientDataJSON).digest()]),
        { key: cred.privateKey, dsaEncoding: 'der' },
      );
      return {
        id: cred.id,
        rawId: cred.id,
        type: 'public-key',
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          authenticatorData: authenticatorData.toString('base64url'),
          signature: signature.toString('base64url'),
        },
        clientExtensionResults: {},
      };
    };

    const aliceCred = makeCredential();
    const bobCred = makeCredential();
    await insertCredential('alice', aliceCred);
    await insertCredential('bob', bobCred);

    /** パスキーログインを 1 回試す（options → assertion → verify） */
    const passkeyLogin = async (userId: string, cred: ReturnType<typeof makeCredential>, totpCode?: string) => {
      const optionsRes = await api('POST', '/api/webauthn/authenticate/options', undefined, { user_id: userId });
      const options = optionsRes.data as any;
      cred.counter += 1;
      const credential = buildAssertion(cred, String(options.challenge), BASE, DOMAIN, cred.counter);
      const verify = await api('POST', '/api/webauthn/authenticate/verify', undefined, {
        credential,
        expectedChallenge: options.challenge,
        ...(totpCode !== undefined ? { totpCode } : {}),
      });
      return { options, verify };
    };

    const aliceOptions = (await api('POST', '/api/webauthn/authenticate/options', undefined, { user_id: 'alice' })).data as any;
    check('2段階認証が有効なら options がコードを予告する', aliceOptions?.totp_required, true);
    check('コード無しのパスキーログインは通らない', (await passkeyLogin('alice', aliceCred)).verify.status, 401);
    const aliceNoCode = await passkeyLogin('alice', aliceCred);
    check('コードが必要だと分かる（パスキー）', aliceNoCode.verify.data?.totp_required, true);

    const aliceBadCode = await passkeyLogin('alice', aliceCred, '123456');
    check('誤ったコードではパスキーでも入れない', aliceBadCode.verify.status, 401);
    check('再入力できる（パスキー）', aliceBadCode.verify.data?.totp_required, true);

    const aliceOk = await passkeyLogin('alice', aliceCred, generateTotpCode(secret2));
    check('正しいコードならパスキーで入れる', aliceOk.verify.status, 200);
    check('セッションが発行される（パスキー）', typeof aliceOk.verify.data?.token, 'string');

    const aliceRecovery = await passkeyLogin('alice', aliceCred, recovery2[0]);
    check('リカバリーコードでもパスキーで入れる', aliceRecovery.verify.status, 200);
    check('使った分だけ減る（パスキー経由）', (await api('GET', '/api/me/totp', aliceToken)).data?.remainingCodes, 9);

    // 2段階認証を使っていない人のパスキーログインは今までどおり
    const bobOptions = (await api('POST', '/api/webauthn/authenticate/options', undefined, { user_id: 'bob' })).data as any;
    check('2段階認証が無効なら予告も出ない', Boolean(bobOptions?.totp_required), false);
    const bobLogin = await passkeyLogin('bob', bobCred);
    check('2段階認証なしのパスキーログインはコード不要', bobLogin.verify.status, 200);
    check('セッションが発行される（bob）', typeof bobLogin.verify.data?.token, 'string');

    completed = true;
  } finally {
    console.log('');
    if (server) {
      server.kill('SIGTERM');
      await waitForPortFree(PORT, 6);
      if (!server.killed) {
        try { server.kill('SIGKILL'); } catch {}
      }
    }
  }

  [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
    for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
  });

  console.log('');
  if (!completed) {
    console.error('❌ テストを最後まで実行できませんでした（上のエラーを確認してください）');
  } else if (failures === 0) {
    console.log(`🎉 すべての確認に合格しました（${checks} 件）`);
  } else {
    console.error(`❌ ${checks} 件中 ${failures} 件の確認に失敗しました`);
  }
  process.exit(completed && failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('❌ テスト実行エラー:', err);
  process.exit(1);
});
