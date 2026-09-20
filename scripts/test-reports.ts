import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// 通報（Report / Flag）とレート制限の検証テスト
//
//   1. ローカル通報: ユーザー通報 / 投稿通報が管理画面のキューに入るか
//   2. 権限: 非管理者は通報一覧を見られないか
//   3. 連投防止: 同一対象への再通報が弾かれるか
//   4. 対応: resolve / reject / reopen でステータスが変わるか
//   5. リモート通報: 対象サーバーへ Flag が配送されるか（宛先・内容）
//   6. 受信 Flag: 他サーバーからの通報をキューに取り込めるか
//   7. レート制限: 上限を超えると 429 を返すか（通常 API は影響を受けないか）
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_reports.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3711;
const CAPTURE_PORT = PORT + 1;
const BASE = `http://localhost:${PORT}`;

const REMOTE_ACTOR = 'https://remote.test/users/dave';

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
      `空きポートを指定して実行してください:  TEST_PORT=3720 npx tsx scripts/test-reports.ts`,
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

const captured: any[] = [];
function startCaptureServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try { captured.push(JSON.parse(raw)); } catch { captured.push(raw); }
        res.statusCode = 202;
        res.end('{}');
      });
    });
    server.listen(CAPTURE_PORT, '127.0.0.1', () => resolve(server));
  });
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

async function run() {
  console.log('====================================================');
  console.log('🧪 通報（Report / Flag）とレート制限の検証テスト');
  console.log(`   server=${PORT} capture=${CAPTURE_PORT}`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;
  let capture: http.Server | null = null;

  try {
    await assertPortFree(PORT);
    await assertPortFree(CAPTURE_PORT);
    capture = await startCaptureServer();

    server = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Reports Test',
      },
      stdio: 'pipe',
      shell: true,
    });
    server.stdout?.on('data', () => {});

    if (!(await waitForServer(BASE))) throw new Error('サーバー起動失敗');
    console.log('✅ サーバー起動完了\n');

    const register = async (id: string) => {
      const res = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: `${id} さん`, agreedToRules: true }),
      });
      const body = await res.json();
      if (!body?.sessionToken) throw new Error(`${id} の作成に失敗: ${JSON.stringify(body)}`);
      return { token: body.sessionToken as string, actorUrl: body.user.actorUrl as string };
    };
    const alice = await register('alice'); // 最初のユーザー = 管理者
    const bob = await register('bob');
    const carol = await register('carol');
    const auth = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

    // リモートアクターをシード（Flag の配送先を捕捉サーバーに向ける）
    const daveKeys = generateTestKeyPair();
    const { DatabaseSync } = await import('node:sqlite');
    const seedDb = new DatabaseSync(path.resolve(ROOT_DIR, 'server', TEST_DB));
    const seed = (sql: string, ...args: any[]) => {
      for (let i = 0; i < 10; i++) {
        try { seedDb.prepare(sql).run(...args); return; } catch (e) { if (i === 9) throw e; }
      }
    };
    seed(
      `INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
       VALUES (?, 'dave', 'remote.test', 'Dave', '', '', '', ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET inbox_url = excluded.inbox_url, public_key_pem = excluded.public_key_pem`,
      REMOTE_ACTOR,
      `http://localhost:${CAPTURE_PORT}/remote/inbox`,
      `${REMOTE_ACTOR}#main-key`,
      daveKeys.publicKeyPem,
      new Date().toISOString(),
    );

    // ------------------------------------------------------------------
    console.log('🚩 [1] ローカル通報（ユーザー / 投稿）');
    const carolPostId = await (async () => {
      const res = await fetch(`${BASE}/api/posts`, {
        method: 'POST', headers: auth(carol.token), body: JSON.stringify({ content: '通報対象の投稿です' }),
      });
      return (await res.json()).id as string;
    })();

    const reportUser = await fetch(`${BASE}/api/reports`, {
      method: 'POST', headers: auth(bob.token),
      body: JSON.stringify({ targetUserId: 'carol', category: 'spam', comment: 'スパム行為を確認しました' }),
    });
    check('ユーザー通報のステータス', reportUser.status, 201);

    const reportPost = await fetch(`${BASE}/api/reports`, {
      method: 'POST', headers: auth(bob.token),
      body: JSON.stringify({ targetPostId: carolPostId, category: 'abuse', comment: '誹謗中傷' }),
    });
    check('投稿通報のステータス', reportPost.status, 201);

    const selfReport = await fetch(`${BASE}/api/reports`, {
      method: 'POST', headers: auth(bob.token),
      body: JSON.stringify({ targetUserId: 'bob', category: 'other' }),
    });
    check('自分自身への通報は 400', selfReport.status, 400);

    const dupReport = await fetch(`${BASE}/api/reports`, {
      method: 'POST', headers: auth(bob.token),
      body: JSON.stringify({ targetUserId: 'carol', category: 'spam', comment: '再送' }),
    });
    check('同一対象への再通報は 409', dupReport.status, 409);

    // ------------------------------------------------------------------
    console.log('\n📋 [2] 管理画面の通報キュー');
    const listRes = await fetch(`${BASE}/api/admin/reports`, { headers: auth(alice.token) });
    const list = await listRes.json();
    check('通報一覧のステータス', listRes.status, 200);
    check('通報件数', list.reports.length, 2);
    check('未対応件数', list.counts.open, 2);
    const postReportRow = list.reports.find((r: any) => r.target_post_id === carolPostId);
    check('投稿通報に投稿IDが記録される', Boolean(postReportRow), true);
    check('投稿通報に本文スニペットが記録される', String(postReportRow?.target_post_content || '').includes('通報対象の投稿'), true);
    check('通報者が記録される', postReportRow?.reporter_user_id, 'bob');
    check('対象ユーザーが記録される', postReportRow?.target_user_id, 'carol');

    const forbidden = await fetch(`${BASE}/api/admin/reports`, { headers: auth(carol.token) });
    check('非管理者は一覧を取得できない(403)', forbidden.status, 403);
    const countRes = await fetch(`${BASE}/api/admin/reports/count`, { headers: auth(alice.token) });
    check('未対応件数API', (await countRes.json()).open, 2);

    // ------------------------------------------------------------------
    console.log('\n✅ [3] 対応（resolve / reject / reopen）');
    const targetReportId = list.reports[0].id;
    const resolveRes = await fetch(`${BASE}/api/admin/reports/${targetReportId}/resolve`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ action: 'resolve', note: '対応しました' }),
    });
    check('resolve のステータス', resolveRes.status, 200);
    check('resolve 後の status', (await resolveRes.json()).report.status, 'resolved');
    check('未対応件数が減る', (await (await fetch(`${BASE}/api/admin/reports/count`, { headers: auth(alice.token) })).json()).open, 1);

    const rejectRes = await fetch(`${BASE}/api/admin/reports/${targetReportId}/resolve`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ action: 'reject' }),
    });
    check('reject 後の status', (await rejectRes.json()).report.status, 'rejected');

    const reopenRes = await fetch(`${BASE}/api/admin/reports/${targetReportId}/resolve`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ action: 'reopen' }),
    });
    check('reopen 後の status', (await reopenRes.json()).report.status, 'open');

    const invalidAction = await fetch(`${BASE}/api/admin/reports/${targetReportId}/resolve`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ action: 'unknown' }),
    });
    check('不正な action は 400', invalidAction.status, 400);
    const missingReport = await fetch(`${BASE}/api/admin/reports/does-not-exist/resolve`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ action: 'resolve' }),
    });
    check('存在しない通報は 404', missingReport.status, 404);

    // ------------------------------------------------------------------
    console.log('\n📤 [4] リモート通報: 相手サーバーへ Flag を配送');
    const remoteReport = await fetch(`${BASE}/api/reports`, {
      method: 'POST', headers: auth(bob.token),
      body: JSON.stringify({ targetUserId: REMOTE_ACTOR, category: 'spam', comment: 'リモートのスパム' }),
    });
    const remoteReportBody = await remoteReport.json();
    check('リモート通報のステータス', remoteReport.status, 201);
    check('Flag 転送済みフラグ', remoteReportBody.forwarded, true);
    await sleep(500);
    const flag = captured.find((a) => a?.type === 'Flag');
    check('Flag が配送された', Boolean(flag), true);
    check('Flag の type', flag?.type, 'Flag');
    check('Flag の対象', flag?.object, [REMOTE_ACTOR]);
    check('Flag にコメントが入る', String(flag?.content || '').includes('リモートのスパム'), true);

    // ------------------------------------------------------------------
    console.log('\n📥 [5] 受信 Flag: 他サーバーからの通報を取り込む');
    const flagBody = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${REMOTE_ACTOR}/flags/1`,
      type: 'Flag',
      actor: REMOTE_ACTOR,
      object: [carol.actorUrl, carolPostId],
      content: 'こちらのサーバーの投稿を通報します',
    });
    const flagRes = await fetch(`${BASE}/inbox`, {
      method: 'POST',
      headers: signInboxRequest(flagBody, `${REMOTE_ACTOR}#main-key`, daveKeys.privateKeyPem),
      body: flagBody,
    });
    check('受信 Flag のステータス', flagRes.status, 200);

    const listAfterInbound = await (await fetch(`${BASE}/api/admin/reports`, { headers: auth(alice.token) })).json();
    const inboundReport = listAfterInbound.reports.find((r: any) => r.reporter_actor_url === REMOTE_ACTOR && r.is_remote === 1);
    check('受信通報がキューに入る', Boolean(inboundReport), true);
    check('受信通報の対象ユーザー', inboundReport?.target_user_id, 'carol');
    check('受信通報のコメント', inboundReport?.comment, 'こちらのサーバーの投稿を通報します');

    // ------------------------------------------------------------------
    console.log('\n🚦 [6] レート制限');
    let rateLimitedAt = 0;
    for (let i = 1; i <= 25; i++) {
      const res = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'nobody', masterKey: 'invalid' }),
      });
      if (res.status === 429) { rateLimitedAt = i; break; }
    }
    check('ログイン試行が 429 で止まる', rateLimitedAt > 0 && rateLimitedAt <= 21, true);
    const retryAfter = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'nobody', masterKey: 'invalid' }),
    });
    check('Retry-After ヘッダが付く', Boolean(retryAfter.headers.get('retry-after')), true);
    check('429 のステータス', retryAfter.status, 429);

    // 通常 API は別バケットなので影響を受けない
    const normalApi = await fetch(`${BASE}/api/timeline?mode=all&limit=1`, { headers: auth(alice.token) });
    check('通常の API は影響を受けない', normalApi.status, 200);
    const adminStillWorks = await fetch(`${BASE}/api/admin/reports/count`, { headers: auth(alice.token) });
    check('管理 API も影響を受けない', adminStillWorks.status, 200);

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 通報・レート制限の検証: すべて成功');
    } else {
      console.error(`❌ 通報・レート制限の検証: ${failures} 件失敗`);
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
    if (capture) capture.close();
  }
}

run();
