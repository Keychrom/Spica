import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// ストリーミングのワンタイムチケットの検証
//
//   1. 発行はログインが必要（未認証は 401）
//   2. チケットで接続できる（text/event-stream）
//   3. 同じチケットは 2 回使えない
//   4. でたらめなチケットは通らない
//   5. 旧来の ?token= も互換で動く（アプリ本体は使わない）
//   6. 未認証でも公開ストリームにはつなげる
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_stream_ticket.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 5225;
const BASE = `http://localhost:${PORT}`;

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
  if (inUse) throw new Error(`ポート ${port} は使用中です。TEST_PORT=5226 のように指定してください。`);
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

/** SSE は本文を読み続けるので、ヘッダだけ確認して切る */
async function connectStream(query: string): Promise<{ status: number; contentType: string | null }> {
  const controller = new AbortController();
  try {
    const res = await fetch(`${BASE}/api/streaming?${query}`, { signal: controller.signal });
    const contentType = res.headers.get('content-type');
    controller.abort();
    return { status: res.status, contentType };
  } catch (err: any) {
    controller.abort();
    // ヘッダが返る前に切れた場合
    return { status: 0, contentType: err?.message || null };
  }
}

async function main() {
  await assertPortFree(PORT);

  let server: ChildProcess | null = null;
  try {
    console.log('🚀 テスト用サーバーを起動します...');
    server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Stream Ticket Test',
        RATE_LIMIT_DISABLED: 'true',
        AUTO_MAINTENANCE: 'false',
      },
      stdio: 'pipe',
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', (d: Buffer) => process.stderr.write(d));

    if (!(await waitForServer(`${BASE}/health`))) throw new Error('サーバーが起動しませんでした');
    await sleep(600);

    // 1. ユーザー登録（トークンを得る）
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'streamuser', name: 'ストリーム', summary: '', agreedToRules: true }),
    });
    const regData: any = await reg.json();
    const token: string = regData.sessionToken;
    check('登録できる', Boolean(token), true);

    // 2. チケットの発行（未認証は 401）
    const noAuth = await fetch(`${BASE}/api/streaming/ticket`, { method: 'POST' });
    check('未認証ではチケットを発行しない', noAuth.status, 401);

    const issue = await fetch(`${BASE}/api/streaming/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const issueData: any = await issue.json();
    check('チケットを発行できる', issue.status === 200 && typeof issueData.ticket === 'string', true);
    check('有効期限は 60 秒', issueData.expiresIn, 60);

    // 3. チケットで接続できる
    const ok = await connectStream(`ticket=${encodeURIComponent(issueData.ticket)}&streams=local`);
    check('チケットで接続できる', ok.status, 200);
    check('イベントストリームが返る', String(ok.contentType || '').startsWith('text/event-stream'), true);

    // 4. 同じチケットは 2 回使えない
    const reuse = await connectStream(`ticket=${encodeURIComponent(issueData.ticket)}&streams=local`);
    check('同じチケットの使い回しは弾く（1 回で使い切る）', reuse.status, 401);

    // 5. でたらめなチケットは未認証扱い（つながるがユーザーは付かない）
    const bogus = await connectStream('ticket=totally-bogus&streams=local');
    check('でたらめなチケットは弾く', bogus.status, 401);

    // 6. 旧来の ?token= は互換で通る（アプリ本体はもう使わない）
    const legacy = await connectStream(`token=${encodeURIComponent(token)}&streams=local`);
    check('旧来の token 経路も動く（互換）', legacy.status, 200);

    // 7. 未認証でも公開ストリームにはつなげる
    const anon = await connectStream('streams=local');
    check('未認証でも公開ストリームにつなげる', anon.status, 200);

    // 8. 期限切れのチケットは通らない（DB を直接いじって期限を過去にする）
    const issue2 = await fetch(`${BASE}/api/streaming/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const ticket2 = (await issue2.json() as any).ticket;
    const { DatabaseSync } = await import('node:sqlite');
    if ((process.env.DB_DRIVER || 'sqlite').toLowerCase() !== 'postgres') {
      const db = new DatabaseSync(path.resolve(ROOT_DIR, 'server', TEST_DB));
      db.prepare('UPDATE stream_tickets SET expires_at = ? WHERE ticket = ?').run(new Date(Date.now() - 1000).toISOString(), ticket2);
      db.close();
      const expired = await connectStream(`ticket=${encodeURIComponent(ticket2)}&streams=local`);
      check('期限切れのチケットは弾く', expired.status, 401);
      const row = new DatabaseSync(path.resolve(ROOT_DIR, 'server', TEST_DB)).prepare('SELECT used FROM stream_tickets WHERE ticket = ?').get(ticket2) as any;
      check('期限切れは使用済みにされない', Number(row?.used), 0);
    }

    console.log(failures === 0 ? '\n✅ すべて成功しました' : `\n❌ ${failures} 件失敗しました`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await sleep(800);
      if (!server.killed) server.kill('SIGKILL');
    }
  }
}

main().catch((err) => {
  console.error('❌ テストが例外で落ちました:', err);
  process.exit(1);
});
