import { spawn, ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// 差別化機能の検証: 🔗 リンクプレビュー（OGPカード） / 🔔 メンション通知
//
//   1. 本文に URL を含む投稿で、OGP を取得してカード情報が返るか
//   2. OGP が無いページでも失敗して壊れないか
//   3. @user メンションでローカルユーザーに通知が飛ぶか
//   4. 重複・誤通知を避けているか（自分自身 / 存在しない相手 / 他ドメイン / 返信相手）
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_differentiation.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 4011;
const WEB_PORT = PORT + 1;
const BASE = `http://localhost:${PORT}`;
const ARTICLE_URL = `http://localhost:${WEB_PORT}/article`;

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
      `空きポートを指定して実行してください:  TEST_PORT=4020 npx tsx scripts/test-differentiation.ts`,
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

/** OGP 付きの記事ページと、OGP の無いページを配信するテスト用サーバー */
function startWebServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if ((req.url || '').startsWith('/article')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!DOCTYPE html><html><head>
<meta property="og:title" content="Spica の紹介記事" />
<meta property="og:description" content="ActivityPub でつながる軽量ノードの話" />
<meta property="og:image" content="/thumb.png" />
<meta property="og:site_name" content="Example Blog" />
<title>fallback title</title></head><body>hello</body></html>`);
        return;
      }
      if ((req.url || '').startsWith('/plain')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!DOCTYPE html><html><head></head><body>OGPなし</body></html>');
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    server.listen(WEB_PORT, '127.0.0.1', () => resolve(server));
  });
}

async function run() {
  console.log('====================================================');
  console.log('🧪 差別化機能の検証（リンクプレビュー / メンション通知）');
  console.log(`   server=${PORT} web=${WEB_PORT}`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;
  let web: http.Server | null = null;

  try {
    await assertPortFree(PORT);
    await assertPortFree(WEB_PORT);
    web = await startWebServer();

    server = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Differentiation Test',
        // この検査は OGP の解析結果（絶対 URL への解決）を見る。
        // 画像プロキシが有効だと応答の画像 URL が /proxy?url=... に置き換わるため、
        // ここでは無効にして素の OGP を見る（プロキシ自体は test:image-proxy が見る）
        IMAGE_PROXY: 'false',
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
    const alice = await register('alice');
    const bob = await register('bob');
    const auth = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

    const createPost = async (token: string, content: string, extra: Record<string, unknown> = {}) => {
      const res = await fetch(`${BASE}/api/posts`, {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ content, ...extra }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`投稿作成失敗: HTTP ${res.status} ${JSON.stringify(body)}`);
      return body.id as string;
    };

    const timelineItem = async (token: string, postId: string) => {
      const res = await fetch(`${BASE}/api/timeline?mode=all&limit=100`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const rows = await res.json();
      return rows.find((r: any) => (r.post_id ?? r.id) === postId);
    };

    // ------------------------------------------------------------------
    console.log('🔗 [1] リンクプレビュー（OGPカード）');
    const linkPostId = await createPost(alice.token, `Spica の紹介記事を書きました ${ARTICLE_URL}`);
    // 取得は非同期なので少し待つ
    await sleep(2500);
    const linkItem = await timelineItem(alice.token, linkPostId);
    check('link_preview が付与される', Boolean(linkItem?.link_preview), true);
    check('タイトルを取得', linkItem?.link_preview?.title, 'Spica の紹介記事');
    check('説明を取得', linkItem?.link_preview?.description, 'ActivityPub でつながる軽量ノードの話');
    check('サイト名を取得', linkItem?.link_preview?.site_name, 'Example Blog');
    check('画像URLが絶対URLに解決される', linkItem?.link_preview?.image_url, `http://localhost:${WEB_PORT}/thumb.png`);
    check('URLが保持される', linkItem?.link_preview?.url, ARTICLE_URL);

    const plainPostId = await createPost(alice.token, `OGPの無いページ ${BASE.replace(String(PORT), String(WEB_PORT))}/plain`);
    await sleep(2000);
    const plainItem = await timelineItem(alice.token, plainPostId);
    check('OGPが無い場合はプレビューを付けない', plainItem?.link_preview ?? null, null);
    check('OGPが無くても投稿は取得できる', Boolean(plainItem), true);

    const noLinkPostId = await createPost(alice.token, 'URLを含まない投稿です');
    await sleep(300);
    const noLinkItem = await timelineItem(alice.token, noLinkPostId);
    check('URLが無ければプレビューなし', noLinkItem?.link_preview ?? null, null);

    // ------------------------------------------------------------------
    console.log('\n🔔 [2] メンション通知');
    await createPost(bob.token, '@alice こんにちは！メンションのテストです');

    const aliceNotifs = async () => (await (await fetch(`${BASE}/api/notifications`, { headers: auth(alice.token) })).json()) as any[];
    const mentionNotifs = (await aliceNotifs()).filter((n) => n.type === 'mention');
    check('メンション通知が届く', mentionNotifs.length, 1);
    check('通知の相手', mentionNotifs[0]?.actor_id, 'bob');
    check('通知タイプ', mentionNotifs[0]?.type, 'mention');
    const filtered = await (await fetch(`${BASE}/api/notifications?filter=mention`, { headers: auth(alice.token) })).json();
    check('メンションでフィルタできる', filtered.length, 1);
    check('フィルタ結果のタイプ', filtered[0]?.type, 'mention');

    await createPost(bob.token, '@bob 自分自身へのメンション');
    const afterSelf = (await aliceNotifs()).filter((n) => n.type === 'mention');
    check('自分自身へのメンションは通知しない', afterSelf.length, 1);

    await createPost(bob.token, '@nobody 存在しないユーザーへのメンション');
    const afterMissing = (await aliceNotifs()).filter((n) => n.type === 'mention');
    check('存在しない相手には通知しない', afterMissing.length, 1);

    await createPost(bob.token, '@alice@example.com 他ドメインへのメンション');
    const afterForeign = (await aliceNotifs()).filter((n) => n.type === 'mention');
    check('他ドメイン宛のメンションは通知しない', afterForeign.length, 1);

    // 返信相手は reply 通知のみ（mention を重複させない）
    const alicePost = await createPost(alice.token, '返信テスト用の投稿');
    await createPost(bob.token, '@alice これは返信です', { in_reply_to: alicePost });
    const notifsAfterReply = await aliceNotifs();
    const mentionAfterReply = notifsAfterReply.filter((n) => n.type === 'mention').length;
    const replyAfterReply = notifsAfterReply.filter((n) => n.type === 'reply').length;
    check('返信相手には mention を重複通知しない', mentionAfterReply, 1);
    check('返信通知は届く', replyAfterReply, 1);

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 差別化機能の検証: すべて成功');
    } else {
      console.error(`❌ 差別化機能の検証: ${failures} 件失敗`);
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
    if (web) web.close();
  }
}

run();
