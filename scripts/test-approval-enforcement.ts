import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';
import { generateTotpCode } from '../server/src/totp.js';

/**
 * 承認制（approval_status）の強制の検査
 *
 *  - 承認待ち・却下のアカウントは、既存セッション（getUserFromToken）で API へ入れない
 *  - 発行済みのストリームチケット（consumeStreamTicket）も使えない
 *  - パスキーを持っていてもログインできない（verifyWebAuthnAuthentication）
 *  - パスキー後の 2段階認証の続き（/authenticate/totp）でもセッションを作らない
 *  - ユーザー検索（/api/autocomplete/users・/api/search・Misskey の users/search）に
 *    未承認・却下・凍結のアカウントを出さない
 */
const ROOT = process.cwd();
const TEST_DB = 'data_test_approval_enforcement.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3536;
const BASE = `http://localhost:${PORT}`;
const RP_ID = new URL(BASE).hostname;

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

const USE_PG =
  (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'postgres' && Boolean(process.env.TEST_DATABASE_URL);
const openDb = (): ReturnType<typeof createAsyncDatabase> =>
  USE_PG
    ? createAsyncDatabase({ driver: 'postgres', connectionString: process.env.TEST_DATABASE_URL as string })
    : createAsyncDatabase({ driver: 'sqlite', dbPath: path.join(ROOT, 'server', TEST_DB) });

async function exec(sql: string, ...params: any[]): Promise<void> {
  const conn = openDb();
  try {
    await conn.prepare(sql).run(...params);
  } finally {
    await conn.close().catch(() => {});
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** SSE の入口を開いて、ステータスだけ見てすぐ閉じる（チケットの検証用） */
async function streamStatus(query: string): Promise<number> {
  const controller = new AbortController();
  try {
    const res = await fetch(`${BASE}/api/streaming?${query}`, { signal: controller.signal });
    return res.status;
  } catch {
    return 0;
  } finally {
    controller.abort();
  }
}

/** ソフトウェア認証器（P-256 の鍵を 1 組作り、COSE の公開鍵を DB に入れる） */
function makeCredential() {
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
}

/** 本物の assertion を作る（authenticatorData + clientDataJSON に ES256 で署名する） */
function buildAssertion(
  cred: ReturnType<typeof makeCredential>,
  challenge: string,
  origin: string,
  rpId: string,
  counter: number,
) {
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
        INSTANCE_NAME: 'Approval Enforcement Test',
        RATE_LIMIT_DISABLED: 'true',
      },
      stdio: 'pipe',
      shell: true,
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    if (!(await waitForServer(`${BASE}/api/server-info`))) throw new Error('サーバー起動失敗');

    const register = async (id: string): Promise<{ token: string; masterKey: string }> => {
      const res = await api('POST', '/api/auth/register', undefined, {
        id,
        name: `ApprovalMarker ${id}`,
        agreedToRules: true,
      });
      if (!res.data?.sessionToken || !res.data?.masterKey) throw new Error(`${id} の登録失敗: ${JSON.stringify(res.data)}`);
      return { token: res.data.sessionToken as string, masterKey: res.data.masterKey as string };
    };

    await register('root');
    const alpha = await register('alphaok');
    const beta = await register('betapending');
    const gamma = await register('gammarejected');
    const delta = await register('deltafrozen');

    console.log('\n🧾 [0] 承認済みのうちに、セッション・チケット・パスキー・2FA を用意する');
    check('承認済みは /api/auth/me が 200', (await api('GET', '/api/auth/me', alpha.token)).status, 200);

    const ticketOf = async (token: string): Promise<string> => {
      const res = await api('POST', '/api/streaming/ticket', token, {});
      if (!res.data?.ticket) throw new Error(`チケット発行失敗: ${JSON.stringify(res.data)}`);
      return res.data.ticket as string;
    };
    const alphaTicket = await ticketOf(alpha.token);
    const betaTicket = await ticketOf(beta.token);
    const gammaTicket = await ticketOf(gamma.token);
    const deltaTicket = await ticketOf(delta.token);
    check('承認済みのチケットは使える', await streamStatus(`ticket=${encodeURIComponent(alphaTicket)}`), 200);

    // パスキー（alpha / beta / gamma）
    const alphaCred = makeCredential();
    const betaCred = makeCredential();
    const gammaCred = makeCredential();
    const insertCredential = (userId: string, cred: ReturnType<typeof makeCredential>) =>
      exec(
        'INSERT INTO webauthn_credentials (id, user_id, public_key, counter, device_name, transports, created_at, last_used_at) VALUES (?,?,?,?,?,?,?,?)',
        cred.id, userId, cred.publicKeyCose, 0, '検査用', '[]', new Date().toISOString(), null,
      );
    await insertCredential('alphaok', alphaCred);
    await insertCredential('betapending', betaCred);
    await insertCredential('gammarejected', gammaCred);

    // beta は 2段階認証も有効にしておく（パスキー後のコード継続の検査用）
    const setup = await api('POST', '/api/me/totp/setup', beta.token, {});
    const betaTotpSecret = String(setup.data?.secret || '');
    if (!betaTotpSecret) throw new Error(`TOTP 秘密の取得失敗: ${JSON.stringify(setup.data)}`);
    const enable = await api('POST', '/api/me/totp/enable', beta.token, { code: generateTotpCode(betaTotpSecret) });
    check('beta は 2段階認証を有効にできる', enable.status, 200);

    // 承認状態を変える（beta=pending / gamma=rejected / delta=frozen）
    await exec("UPDATE users SET approval_status = 'pending' WHERE id = ?", 'betapending');
    await exec("UPDATE users SET approval_status = 'rejected' WHERE id = ?", 'gammarejected');
    await exec('UPDATE users SET is_frozen = 1 WHERE id = ?', 'deltafrozen');

    console.log('\n🔒 [1] 既存セッションは承認待ち・却下・凍結で無効になる');
    check('承認済みは残る', (await api('GET', '/api/auth/me', alpha.token)).status, 200);
    check('承認待ちは 401', (await api('GET', '/api/auth/me', beta.token)).status, 401);
    check('却下は 401', (await api('GET', '/api/auth/me', gamma.token)).status, 401);
    check('凍結は 401', (await api('GET', '/api/auth/me', delta.token)).status, 401);
    check(
      '承認待ちはログインも 403（従来どおり）',
      (await api('POST', '/api/auth/login', undefined, { id: 'betapending', masterKey: beta.masterKey })).status,
      403,
    );

    console.log('\n🎟️ [2] 発行済みのストリームチケットも使えない');
    check('承認済みのチケットは引き続き使える', await streamStatus(`ticket=${encodeURIComponent(await ticketOf(alpha.token))}`), 200);
    check('承認待ちのチケットは 401', await streamStatus(`ticket=${encodeURIComponent(betaTicket)}`), 401);
    check('却下のチケットは 401', await streamStatus(`ticket=${encodeURIComponent(gammaTicket)}`), 401);
    check('凍結のチケットは 401', await streamStatus(`ticket=${encodeURIComponent(deltaTicket)}`), 401);
    check('承認待ちは新しいチケットも発行できない', (await api('POST', '/api/streaming/ticket', beta.token, {})).status, 401);

    console.log('\n🔑 [3] パスキーを持っていてもログインできない');
    const passkeyLogin = async (userId: string, cred: ReturnType<typeof makeCredential>) => {
      const optionsRes = await api('POST', '/api/webauthn/authenticate/options', undefined, { user_id: userId });
      const challenge = String(optionsRes.data?.challenge || '');
      cred.counter += 1;
      const credential = buildAssertion(cred, challenge, BASE, RP_ID, cred.counter);
      return api('POST', '/api/webauthn/authenticate/verify', undefined, {
        credential,
        expectedChallenge: challenge,
      });
    };

    const alphaLogin = await passkeyLogin('alphaok', alphaCred);
    check('承認済みはパスキーで入れる', alphaLogin.status, 200);
    check('セッションが発行される', String(alphaLogin.data?.token || '').startsWith('spica_sess_'), true);

    const betaLogin = await passkeyLogin('betapending', betaCred);
    check('承認待ちはパスキーで入れない', betaLogin.status, 401);
    check('承認待ちだと分かるメッセージ', String(betaLogin.data?.error || '').includes('承認待ち'), true);
    const gammaLogin = await passkeyLogin('gammarejected', gammaCred);
    check('却下はパスキーで入れない', gammaLogin.status, 401);
    check('却下だと分かるメッセージ', String(gammaLogin.data?.error || '').includes('承認されていません'), true);

    console.log('\n🔢 [4] パスキー後の 2段階認証の続きでもセッションを作らない');
    const pendingTotpToken = crypto.randomBytes(32).toString('base64url');
    await exec(
      'INSERT INTO webauthn_challenges (challenge, user_id, type, expires_at) VALUES (?,?,?,?)',
      pendingTotpToken, 'betapending', 'totp', Date.now() + 5 * 60 * 1000,
    );
    const totpContinue = await api('POST', '/api/webauthn/authenticate/totp', undefined, {
      pendingToken: pendingTotpToken,
      totpCode: generateTotpCode(betaTotpSecret),
    });
    check('承認待ちはコードを入れても 401', totpContinue.status, 401);
    check('セッションは発行されない', totpContinue.data?.token, undefined);

    console.log('\n🔎 [5] ユーザー検索に未承認・却下・凍結を出さない');
    const autocomplete = await api('GET', '/api/autocomplete/users?q=ApprovalMarker');
    const autoIds = (autocomplete.data || []).map((u: any) => u.id);
    check('補完に承認済みは出る', autoIds.includes('alphaok'), true);
    check('補完に承認待ちは出ない', autoIds.includes('betapending'), false);
    check('補完に却下は出ない', autoIds.includes('gammarejected'), false);
    check('補完に凍結は出ない', autoIds.includes('deltafrozen'), false);

    const misskeySearch = await api('POST', '/api/users/search', undefined, { query: 'ApprovalMarker', limit: 50 });
    const misskeyJson = JSON.stringify(misskeySearch.data);
    check('Misskey 検索に承認済みは出る', misskeyJson.includes('alphaok'), true);
    check('Misskey 検索に承認待ちは出ない', misskeyJson.includes('betapending'), false);
    check('Misskey 検索に却下は出ない', misskeyJson.includes('gammarejected'), false);
    check('Misskey 検索に凍結は出ない', misskeyJson.includes('deltafrozen'), false);

    const search = await api('GET', '/api/search?q=ApprovalMarker');
    const searchIds = (search.data?.users || []).map((u: any) => u.id);
    check('検索に承認済みは出る', searchIds.includes('alphaok'), true);
    check('検索に承認待ちは出ない', searchIds.includes('betapending'), false);
    check('検索に却下は出ない', searchIds.includes('gammarejected'), false);
    check('検索に凍結は出ない', searchIds.includes('deltafrozen'), false);
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
