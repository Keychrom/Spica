import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import WebSocket from 'ws';

// ============================================================================
// Misskey 互換のストリーミング（WebSocket）の検証
//
//   1. 接続: `?i=<トークン>` の検証（無効なトークンは 401、`i` 無しは匿名）
//   2. チャンネル購読: connect → connected、disconnect、パラメータ変更（channel）
//   3. ノート配信: HTTP API で投稿 → 購読した localTimeline / homeTimeline に届く
//      （Misskey 形式のノートであること・返信の replyId が解決されること）
//   4. 匿名の制限: localTimeline / globalTimeline だけ購読でき、homeTimeline と main は拒否
//   5. 通知: フォローされると main チャンネルに notification イベントが届く
//   6. 無通信の切断: ping に応答しない接続はサーバー側から切られる
//   7. 後片付け: 切断してもサーバーが落ちない（その後の配信・HTTP が動く）
//   8. 他プロセスのイベント: handleRemoteStreamEvent（Redis 経由で届く形）でも WS に流れる
//
// サーバーは MISSKEY_PING_INTERVAL_MS を短くして起動する（既定は 30 秒）。
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_misskey_streaming.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 4514;
const BASE = `http://localhost:${PORT}`;
const WS_BASE = `ws://localhost:${PORT}`;
/** ping の間隔（検査用に 800ms へ短縮。応答が無い接続は 2 回目の間隔で切られる） */
const PING_INTERVAL_MS = 800;

// 段 [8] はサーバーモジュールをこのプロセスへ読み込むので、config を読む前に環境変数を確定させる
process.env.PORT = String(PORT);
process.env.DOMAIN = `localhost:${PORT}`;
process.env.PROTOCOL = 'http';
process.env.DB_PATH = path.resolve(ROOT_DIR, 'server', TEST_DB);
process.env.MISSKEY_PING_INTERVAL_MS = String(PING_INTERVAL_MS);

[TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
  [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)].forEach((p) => {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  });
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
  if (inUse) {
    throw new Error(
      `ポート ${port} では既にサーバーが応答しています。空きポートを指定して実行してください:  TEST_PORT=4524 npx tsx scripts/test-misskey-streaming.ts`,
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

/** 検査用の WebSocket クライアント（受信を溜めて、条件に合う 1 通を待てる） */
class WsClient {
  readonly ws: WebSocket;
  readonly received: any[] = [];
  closed: { code: number; reason: string } | null = null;
  /** ping に自動で pong を返すか（無通信の切断の検査では false にする） */
  autoPong = true;
  private waiters: { predicate: (msg: any) => boolean; resolve: (msg: any) => void }[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      let msg: any = null;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.received.push(msg);
      if (msg?.type === 'ping' && this.autoPong) this.send({ type: 'pong' });
      const still: typeof this.waiters = [];
      for (const waiter of this.waiters) {
        if (waiter.predicate(msg)) waiter.resolve(msg);
        else still.push(waiter);
      }
      this.waiters = still;
    });
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
    this.ws.on('error', () => {
      // 接続の成否は open() / closed で判定する
    });
  }

  send(payload: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  /** 接続できるまで待つ（true = 接続できた） */
  open(timeoutMs = 5000): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve(true);
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.ws.once('open', () => { clearTimeout(timer); resolve(true); });
      this.ws.once('close', () => { clearTimeout(timer); resolve(false); });
    });
  }

  /** 条件に合うメッセージを待つ（来なければ null） */
  waitFor(predicate: (msg: any) => boolean, timeoutMs = 5000): Promise<any | null> {
    const hit = this.received.find(predicate);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const waiter = {
        predicate,
        resolve: (msg: any) => { clearTimeout(timer); resolve(msg); },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** この時点から待っても条件に合うメッセージが来ないこと（true = 来なかった） */
  async quiet(predicate: (msg: any) => boolean, waitMs: number): Promise<boolean> {
    const before = this.received.filter(predicate).length;
    await sleep(waitMs);
    return this.received.filter(predicate).length === before;
  }

  close(): void {
    try { this.ws.close(); } catch {}
  }
}

/** ハンドシェイク前に返る HTTP ステータスを見る（無効なトークンの接続） */
function statusOnConnect(url: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (status: number) => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch {}
      resolve(status);
    };
    ws.on('unexpected-response', (_req, res) => finish(res.statusCode || 0));
    ws.on('open', () => finish(101));
    ws.on('error', () => finish(0));
    setTimeout(() => finish(0), 5000).unref?.();
  });
}

const clients: WsClient[] = [];

async function run() {
  console.log('====================================================');
  console.log('🧪 Misskey 互換ストリーミング（WebSocket）の検証');
  console.log(`   server=${PORT} / ping interval=${PING_INTERVAL_MS}ms`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;

  try {
    await assertPortFree(PORT);

    server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Misskey Streaming Test',
        RATE_LIMIT_DISABLED: 'true',
        AUTO_MAINTENANCE: 'false',
        AUTO_BACKUP: 'false',
        MISSKEY_PING_INTERVAL_MS: String(PING_INTERVAL_MS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    server.stdout?.on('data', (d: Buffer) => (log += d.toString()));
    server.stderr?.on('data', (d: Buffer) => (log += d.toString()));

    if (!(await waitForServer(`${BASE}/health`))) throw new Error(`サーバー起動失敗:\n${log}`);
    console.log('✅ サーバー起動完了\n');

    const register = async (id: string): Promise<string> => {
      const res = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: `${id} さん`, summary: '', agreedToRules: true }),
      });
      const body = (await res.json()) as any;
      if (!body?.sessionToken) throw new Error(`${id} の作成に失敗: ${JSON.stringify(body)}`);
      return body.sessionToken as string;
    };
    const aliceToken = await register('alice');
    const bobToken = await register('bob');

    /** Misskey のクライアントらしく投稿する（トークンは本文の `i`） */
    const mkNote = async (token: string, body: Record<string, unknown>) => {
      const res = await fetch(`${BASE}/api/notes/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, i: token }),
      });
      let parsed: any = null;
      try { parsed = await res.json(); } catch {}
      return { status: res.status, body: parsed };
    };

    // ------------------------------------------------------------------
    console.log('🔑 [1] 接続と認証');
    check('無効なトークンは 401 でハンドシェイクしない', await statusOnConnect(`${WS_BASE}/streaming?i=invalid-token`), 401);

    const alice = new WsClient(`${WS_BASE}/streaming?i=${encodeURIComponent(aliceToken)}`);
    clients.push(alice);
    check('トークン付きで接続できる（101）', await alice.open(), true);

    alice.send({ type: 'connect', body: { channel: 'localTimeline', id: 'local' } });
    check('connect に connected が返る', (await alice.waitFor((m) => m.type === 'connected'))?.body?.id, 'local');

    alice.send({ type: 'connect', body: { channel: 'homeTimeline', id: 'home' } });
    check('homeTimeline を購読できる（認証済み）', (await alice.waitFor((m) => m.type === 'connected' && m.body?.id === 'home'))?.body?.id, 'home');

    alice.send({ type: 'connect', body: { channel: 'main', id: 'main' } });
    check('main を購読できる（認証済み）', (await alice.waitFor((m) => m.type === 'connected' && m.body?.id === 'main'))?.body?.id, 'main');

    const healthWithWs = (await (await fetch(`${BASE}/health`)).json()) as any;
    check('health に WS 接続数が出る', healthWithWs.misskeyStreamClients >= 1, true);

    // ------------------------------------------------------------------
    console.log('\n📝 [2] ノートの配信（localTimeline / homeTimeline）');
    const created = await mkNote(aliceToken, { text: 'WS 配信のテスト', visibility: 'public' });
    check('HTTP API で投稿できる', created.status, 200);
    const createdNoteId = created.body?.createdNote?.id;

    const noteEvent = await alice.waitFor((m) => m.type === 'channel' && m.body?.type === 'note' && m.body?.body?.note?.text === 'WS 配信のテスト');
    check('type:"channel" のノートイベントが届く', noteEvent?.body?.type, 'note');
    check('購読 id が入る', noteEvent?.body?.id, 'local');
    check('Misskey 形式のノート（id）', noteEvent?.body?.body?.note?.id, createdNoteId);
    check('ノートの本文', noteEvent?.body?.body?.note?.text, 'WS 配信のテスト');
    check('ノートの投稿者', noteEvent?.body?.body?.note?.user?.username, 'alice');
    check('ローカルユーザーの host は null', noteEvent?.body?.body?.note?.user?.host, null);
    check('公開範囲', noteEvent?.body?.body?.note?.visibility, 'public');
    check('homeTimeline にも同じノートが届く', (await alice.waitFor((m) => m.type === 'channel' && m.body?.id === 'home' && m.body?.body?.note?.text === 'WS 配信のテスト')) !== null, true);

    // 返信は replyId が元ノートの Misskey ID に解決される（参照先の時刻を引いている）
    const reply = await mkNote(bobToken, { text: 'WS 配信への返信', replyId: createdNoteId });
    check('返信を投稿できる', reply.status, 200);
    const replyEvent = await alice.waitFor((m) => m.type === 'channel' && m.body?.type === 'note' && m.body?.body?.note?.text === 'WS 配信への返信');
    check('返信にも replyId が入る', replyEvent?.body?.body?.note?.replyId, createdNoteId);

    // ------------------------------------------------------------------
    console.log('\n🕶️ [3] 匿名接続の制限');
    const guest = new WsClient(`${WS_BASE}/streaming`);
    clients.push(guest);
    check('匿名でも接続できる', await guest.open(), true);

    guest.send({ type: 'connect', body: { channel: 'localTimeline', id: 'g-local' } });
    check('匿名は localTimeline を購読できる', (await guest.waitFor((m) => m.type === 'connected'))?.body?.id, 'g-local');

    guest.send({ type: 'connect', body: { channel: 'globalTimeline', id: 'g-global' } });
    check('匿名は globalTimeline を購読できる', (await guest.waitFor((m) => m.type === 'connected' && m.body?.id === 'g-global'))?.body?.id, 'g-global');

    guest.send({ type: 'connect', body: { channel: 'homeTimeline', id: 'g-home' } });
    const homeDenied = await guest.waitFor((m) => m.type === 'error' || (m.type === 'connected' && m.body?.id === 'g-home'));
    check('匿名の homeTimeline は拒否される（CREDENTIAL_REQUIRED）', [homeDenied?.type, homeDenied?.body?.code], ['error', 'CREDENTIAL_REQUIRED']);

    guest.send({ type: 'connect', body: { channel: 'main', id: 'g-main' } });
    const mainDenied = await guest.waitFor((m) => m.type === 'error' || (m.type === 'connected' && m.body?.id === 'g-main'));
    check('匿名の main は拒否される（CREDENTIAL_REQUIRED）', [mainDenied?.type, mainDenied?.body?.code], ['error', 'CREDENTIAL_REQUIRED']);

    guest.send({ type: 'connect', body: { channel: 'unknownChannel', id: 'g-unknown' } });
    check('知らないチャンネルは拒否される（NO_SUCH_CHANNEL）', (await guest.waitFor((m) => m.type === 'error' && m.body?.id === 'g-unknown'))?.body?.code, 'NO_SUCH_CHANNEL');

    const guestNote = await mkNote(aliceToken, { text: '匿名にも届くローカル投稿' });
    check('匿名にもノートが届く', guestNote.status === 200 && (await guest.waitFor((m) => m.type === 'channel' && m.body?.id === 'g-local' && m.body?.body?.note?.text === '匿名にも届くローカル投稿')) !== null, true);

    // ------------------------------------------------------------------
    console.log('\n🔔 [4] 通知（main チャンネル）');
    // [2] の返信でも通知が作られている（返信の通知が先に届いているはず）
    check('返信の通知もリアルタイムに届く', alice.received.some((m) =>
      m.type === 'channel' && m.body?.type === 'notification' && m.body?.body?.notification?.type === 'reply'), true);

    const follow = await fetch(`${BASE}/api/following/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'alice', i: bobToken }),
    });
    check('フォローできる', follow.status, 200);
    const notificationEvent = await alice.waitFor((m) =>
      m.type === 'channel' && m.body?.type === 'notification' && m.body?.body?.notification?.type === 'follow');
    check('main に notification イベントが届く', notificationEvent?.body?.id, 'main');
    check('通知の種類', notificationEvent?.body?.body?.notification?.type, 'follow');
    check('通知の相手', notificationEvent?.body?.body?.notification?.user?.username, 'bob');
    check('匿名には通知が届かない', await guest.quiet((m) => m.type === 'channel' && m.body?.type === 'notification', 300), true);

    // ------------------------------------------------------------------
    console.log('\n📨 [5] パラメータ変更と disconnect');
    // 購読中チャンネルのパラメータ変更（Spica はパラメータを使わないが、エラーにしない）
    alice.send({ type: 'channel', body: { id: 'local', params: { some: 'param' } } });
    const afterParams = await mkNote(aliceToken, { text: 'パラメータ変更後も届く' });
    check('パラメータ変更後も投稿できる', afterParams.status, 200);
    check('パラメータ変更後もノートが届く', (await alice.waitFor((m) => m.type === 'channel' && m.body?.id === 'local' && m.body?.body?.note?.text === 'パラメータ変更後も届く')) !== null, true);
    alice.send({ type: 'channel', body: { id: 'no-such', params: {} } });
    check('知らない id のパラメータ変更はエラー', (await alice.waitFor((m) => m.type === 'error' && m.body?.id === 'no-such'))?.body?.code, 'NO_SUCH_CHANNEL');

    alice.send({ type: 'disconnect', body: { id: 'local' } });
    await sleep(100);
    await mkNote(aliceToken, { text: 'disconnect 後の投稿' });
    check('disconnect した購読には届かない', await alice.quiet((m) => m.type === 'channel' && m.body?.id === 'local' && m.body?.body?.note?.text === 'disconnect 後の投稿', 1200), true);
    check('他の購読（home）には届く', (await alice.waitFor((m) => m.type === 'channel' && m.body?.id === 'home' && m.body?.body?.note?.text === 'disconnect 後の投稿')) !== null, true);

    // ------------------------------------------------------------------
    console.log('\n💤 [6] 無通信の切断（ping / pong）');
    // ping に応答しない接続は、ping の間隔 2 回ぶんほどでサーバーから切られる
    const silent = new WsClient(`${WS_BASE}/streaming`);
    silent.autoPong = false;
    clients.push(silent);
    check('無応答の接続もいったんは接続できる', await silent.open(), true);
    silent.send({ type: 'connect', body: { channel: 'localTimeline', id: 'silent' } });
    check('無応答の接続も購読できる', (await silent.waitFor((m) => m.type === 'connected'))?.body?.id, 'silent');
    const closeDeadline = Date.now() + PING_INTERVAL_MS * 6;
    while (!silent.closed && Date.now() < closeDeadline) await sleep(100);
    check('ping に応答しない接続は切られる', silent.closed !== null, true);
    check('切る理由は正常クローズ（1000）', silent.closed?.code, 1000);

    // pong を返す接続は切られない（alice のクライアントは自動で pong を返している）
    check('ping に応答する接続は切られない', alice.ws.readyState, WebSocket.OPEN);
    const stillAlive = await mkNote(aliceToken, { text: 'ping を越えて届く' });
    check('ping の間隔を越えても配信される', stillAlive.status, 200);
    check('ping の間隔を越えてもノートが届く', (await alice.waitFor((m) => m.type === 'channel' && m.body?.id === 'home' && m.body?.body?.note?.text === 'ping を越えて届く')) !== null, true);

    // ------------------------------------------------------------------
    console.log('\n🧹 [7] 後片付け（切断してもサーバーが落ちない）');
    for (const client of clients) client.close();
    await sleep(300);
    // 切断がサーバーに届いたあとに配信・HTTP が動くこと
    const afterClose = await mkNote(aliceToken, { text: '切断後の投稿' });
    check('切断後も投稿できる', afterClose.status, 200);
    const health = await fetch(`${BASE}/health`);
    const healthBody = (await health.json()) as any;
    check('切断後もサーバーは生きている', [health.status, healthBody.status], [200, 'ok']);

    // 途中で切れた接続（TCP を強制切断）でも落ちない
    const abrupt = new WsClient(`${WS_BASE}/streaming?i=${encodeURIComponent(bobToken)}`);
    clients.push(abrupt);
    await abrupt.open();
    abrupt.ws.terminate();
    await sleep(200);
    const afterAbrupt = await mkNote(bobToken, { text: '強制切断後の投稿' });
    check('TCP を強制切断してもサーバーは生きている', afterAbrupt.status, 200);
  } catch (err) {
    console.error('❌ テスト実行エラー:', err);
    failures++;
  } finally {
    console.log('🧹 サーバーを停止中...');
    for (const client of clients) {
      try { client.ws.terminate(); } catch {}
    }
    if (server && server.pid) {
      server.kill();
      const deadline = Date.now() + 8000;
      while (server.exitCode === null && Date.now() < deadline) await sleep(100);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
  }

  // ------------------------------------------------------------------
  // [8] 他プロセスから届いたイベント（Redis 経由の形）でも WS に流れること。
  //     `handleRemoteStreamEvent` は Redis の購読（index.ts が張る）から呼ばれる関数で、
  //     サーバーを立てずに直接呼べるので、ここで同じ経路を確かめる。
  console.log('\n🌐 [8] 他プロセスのイベント（handleRemoteStreamEvent）');
  let inbound: http.Server | null = null;
  let dbModule: any = null;
  try {
    const streaming = await import('../server/src/streaming.js');
    dbModule = await import('../server/src/db.js');

    inbound = http.createServer();
    streaming.attachMisskeyStreaming(inbound);
    await new Promise<void>((resolve) => inbound!.listen(0, '127.0.0.1', resolve));
    const inboundPort = (inbound.address() as net.AddressInfo).port;

    const relayed = new WsClient(`ws://127.0.0.1:${inboundPort}/streaming`);
    clients.push(relayed);
    check('別の HTTP サーバーでも /streaming を upgrade できる', await relayed.open(), true);
    relayed.send({ type: 'connect', body: { channel: 'localTimeline', id: 'relay-local' } });
    check('匿名で localTimeline を購読できる', (await relayed.waitFor((m) => m.type === 'connected'))?.body?.id, 'relay-local');

    // 他プロセスの deliverLocalEvent 相当（ローカル投稿は localTimeline へ）
    const nowIso = new Date().toISOString();
    const inboundNote = {
      id: `https://localhost:${PORT}/users/alice/posts/relayed-1`,
      user_id: 'alice',
      author_name: 'alice さん',
      author_url: `http://localhost:${PORT}/users/alice`,
      author_handle: `@alice@localhost:${PORT}`,
      author_icon: '',
      content: '別プロセスから届いたノート',
      cw: null,
      is_local: 1,
      visibility: 'public',
      media_attachments: [],
      reactions: [],
      in_reply_to: null,
      quote_id: null,
      published_at: nowIso,
      timeline_at: nowIso,
      renote: null,
      channel_id: null,
    };
    streaming.handleRemoteStreamEvent(JSON.stringify({
      k: 'event', e: 'note', d: inboundNote, r: { local: true, author: inboundNote.author_url, followers: [] },
    }));
    const relayedEvent = await relayed.waitFor((m) => m.type === 'channel' && m.body?.type === 'note' && m.body?.body?.note?.text === '別プロセスから届いたノート');
    check('handleRemoteStreamEvent のノートが WS に流れる', relayedEvent?.body?.id, 'relay-local');
    check('整形された Misskey ノートが入る', relayedEvent?.body?.body?.note?.user?.username, 'alice');

    // リモート投稿（routing.local = false）は localTimeline には流れない
    streaming.handleRemoteStreamEvent(JSON.stringify({
      k: 'event',
      e: 'note',
      d: { ...inboundNote, content: '別プロセスのリモートノート', is_local: 0, author_url: 'https://remote.example/users/x' },
      r: { local: false, author: 'https://remote.example/users/x', followers: [] },
    }));
    check('リモート投稿は localTimeline には流れない', await relayed.quiet((m) => m.body?.body?.note?.text === '別プロセスのリモートノート', 400), true);

    // 通知（k: 'user'）は本人にだけ届く（匿名クライアントには届かない）
    streaming.handleRemoteStreamEvent(JSON.stringify({
      k: 'user', u: 'alice', d: { id: 'notif_relayed', type: 'reaction', actor_id: 'bob', actor_name: 'bob', actor_handle: '@bob@localhost', actor_icon: '', post_id: null, post_content: '', is_read: 0, created_at: nowIso },
    }));
    check('他人宛の通知は匿名クライアントには届かない', await relayed.quiet((m) => m.type === 'channel' && m.body?.type === 'notification', 400), true);

    relayed.close();
  } catch (err) {
    console.error('❌ [8] でエラー:', err);
    failures++;
  } finally {
    for (const client of clients) {
      try { client.ws.terminate(); } catch {}
    }
    if (inbound) await new Promise<void>((resolve) => inbound!.close(() => resolve()));
    try {
      const streaming = await import('../server/src/streaming.js');
      streaming.closeAllStreams();
    } catch {}
    try { await dbModule?.db?.close(); } catch {}
  }

  console.log('');
  console.log('====================================================');
  if (failures === 0) {
    console.log('🎊 Misskey 互換ストリーミングの検証: すべて成功');
  } else {
    console.error(`❌ 検証: ${failures} 件失敗`);
  }
  console.log('====================================================');
  // in-process 検証で読み込んだモジュールの定期処理（ping・keepalive）が残るので明示的に終わる
  process.exit(failures === 0 ? 0 : 1);
}

run();
