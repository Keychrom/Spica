import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// 発見性（F）の検証: RSS フィード / oEmbed / OGP メタ注入
//   1. /feed.xml と /users/:username/feed.xml が正しい RSS を返すか
//   2. フォロワー限定・ローカル限定の投稿がフィードに混ざらないか
//   3. /api/oembed が投稿URLから埋め込み情報を返すか（非公開投稿は 404）
//   4. HTMLに OGP / Twitter Card が注入されるか（投稿・プロフィール・サイト既定）
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_discovery.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 4511;
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
      `空きポートを指定して実行してください:  TEST_PORT=4520 npx tsx scripts/test-discovery.ts`,
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
  console.log('🧪 発見性（RSS / oEmbed / OGP）の検証');
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
        INSTANCE_NAME: 'Discovery Test',
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
        body: JSON.stringify({ id, name: `${id} さん`, summary: 'プロフィール概要', agreedToRules: true }),
      });
      const body = await res.json();
      if (!body?.sessionToken) throw new Error(`${id} の作成に失敗: ${JSON.stringify(body)}`);
      return { token: body.sessionToken as string };
    };
    const alice = await register('alice');
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` };

    const createPost = async (content: string, visibility?: string) => {
      const res = await fetch(`${BASE}/api/posts`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ content, ...(visibility ? { visibility } : {}) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`投稿作成失敗: ${JSON.stringify(body)}`);
      return body.id as string;
    };

    const publicPost = await createPost('RSSに出る公開投稿です');
    const cwPost = await createPost('CW付きの投稿', undefined);
    await createPost('ローカル限定なので出ない', 'local');
    await createPost('フォロワー限定なので出ない', 'followers');

    // ------------------------------------------------------------------
    console.log('📡 [1] RSS フィード');
    const feedRes = await fetch(`${BASE}/users/alice/feed.xml`);
    const feed = await feedRes.text();
    check('ユーザーフィードのステータス', feedRes.status, 200);
    check('Content-Type', String(feedRes.headers.get('content-type') || '').split(';')[0], 'application/rss+xml');
    check('RSS 宣言がある', feed.includes('<rss version="2.0"'), true);
    check('チャンネル名にユーザー名が入る', feed.includes('@alice@localhost:' + PORT), true);
    check('公開投稿が含まれる', feed.includes(encodeURIComponent(publicPost)), true);
    check('ローカル限定は含まれない', feed.includes('ローカル限定なので出ない'), false);
    check('フォロワー限定は含まれない', feed.includes('フォロワー限定なので出ない'), false);
    check('アイテム数', (feed.match(/<item>/g) || []).length, 2);

    const siteFeedRes = await fetch(`${BASE}/feed.xml`);
    const siteFeed = await siteFeedRes.text();
    check('サイトフィードのステータス', siteFeedRes.status, 200);
    check('サイトフィードに公開投稿が含まれる', siteFeed.includes('RSSに出る公開投稿です'), true);

    const missingFeed = await fetch(`${BASE}/users/nobody/feed.xml`);
    check('存在しないユーザーは 404', missingFeed.status, 404);

    // ------------------------------------------------------------------
    console.log('\n🧩 [2] oEmbed');
    const oembedRes = await fetch(`${BASE}/api/oembed?url=${encodeURIComponent(`${BASE}/?post=${publicPost}`)}`);
    const oembed = await oembedRes.json();
    check('oEmbed のステータス', oembedRes.status, 200);
    check('type は rich', oembed.type, 'rich');
    check('provider_name', oembed.provider_name, 'Discovery Test');
    check('html に本文が入る', String(oembed.html || '').includes('RSSに出る公開投稿'), true);
    check('author_name が入る', oembed.author_name, 'alice さん');

    const oembedNoUrl = await fetch(`${BASE}/api/oembed`);
    check('url なしは 400', oembedNoUrl.status, 400);
    const oembedMissing = await fetch(`${BASE}/api/oembed?url=${encodeURIComponent(`${BASE}/?post=https://example.com/nope`)}`);
    check('存在しない投稿は 404', oembedMissing.status, 404);

    // ------------------------------------------------------------------
    console.log('\n🔗 [3] OGP メタの注入');
    const htmlRes = await fetch(`${BASE}/?post=${encodeURIComponent(publicPost)}`, { headers: { Accept: 'text/html' } });
    const html = await htmlRes.text();
    check('HTMLのステータス', htmlRes.status, 200);
    check('og:title が投稿者名', html.includes('property="og:title" content="alice さん のノート"'), true);
    check('og:description に本文', html.includes('RSSに出る公開投稿です'), true);
    check('og:url が投稿URL', html.includes(`property="og:url" content="${BASE}/?post=`), true);
    check('twitter:card がある', html.includes('name="twitter:card"'), true);

    const profileHtmlRes = await fetch(`${BASE}/users/alice`, { headers: { Accept: 'text/html' } });
    const profileHtml = await profileHtmlRes.text();
    check('プロフィールHTMLのステータス', profileHtmlRes.status, 200);
    check('プロフィールの og:title', profileHtml.includes(`property="og:title" content="alice さん (@alice@localhost:${PORT})"`), true);
    check('プロフィールの og:description', profileHtml.includes('プロフィール概要'), true);
    check('og:image がアイコン', profileHtml.includes('property="og:image"'), true);

    const siteHtml = await fetch(`${BASE}/`, { headers: { Accept: 'text/html' } });
    const siteHtmlText = await siteHtml.text();
    check('サイト既定の og:title', siteHtmlText.includes('property="og:title" content="Discovery Test - 分散型ソーシャルネットワーク"'), true);

    // AP クライアント（Accept: activity+json）にはHTMLを返さない
    const apRes = await fetch(`${BASE}/users/alice`, { headers: { Accept: 'application/activity+json' } });
    check('AP リクエストは HTML にならない', String(apRes.headers.get('content-type') || '').includes('activity+json'), true);

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 発見性（RSS / oEmbed / OGP）の検証: すべて成功');
    } else {
      console.error(`❌ 発見性の検証: ${failures} 件失敗`);
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
