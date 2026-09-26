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
    await createPost('#discoverytest タグ付きの投稿');

    // ------------------------------------------------------------------
    console.log('📡 [1] RSS フィード');
    const feedRes = await fetch(`${BASE}/users/alice/feed.xml`);
    const feed = await feedRes.text();
    check('ユーザーフィードのステータス', feedRes.status, 200);
    check('Content-Type', String(feedRes.headers.get('content-type') || '').split(';')[0], 'application/rss+xml');
    check('RSS 宣言がある', feed.includes('<rss version="2.0"'), true);
    check('チャンネル名にユーザー名が入る', feed.includes('@alice@localhost:' + PORT), true);
    check('公開投稿が含まれる', feed.includes('RSSに出る公開投稿です'), true);
    check('ローカル限定は含まれない', feed.includes('ローカル限定なので出ない'), false);
    check('フォロワー限定は含まれない', feed.includes('フォロワー限定なので出ない'), false);
    check('アイテム数', (feed.match(/<item>/g) || []).length, 3);
    // ローカル投稿のリンクは正規 URL（＝パーマリンク）で案内する（以前は ?post= 形式だった）
    check('ローカル投稿はパーマリンクで案内する', feed.includes(`${BASE}/users/alice/posts/`), true);

    const siteFeedRes = await fetch(`${BASE}/feed.xml`);
    const siteFeed = await siteFeedRes.text();
    check('サイトフィードのステータス', siteFeedRes.status, 200);
    check('サイトフィードに公開投稿が含まれる', siteFeed.includes('RSSに出る公開投稿です'), true);

    const missingFeed = await fetch(`${BASE}/users/nobody/feed.xml`);
    check('存在しないユーザーは 404', missingFeed.status, 404);

    // タグ別フィード（タグページと対になる）
    const tagFeedRes = await fetch(`${BASE}/tags/discoverytest/feed.xml`);
    const tagFeed = await tagFeedRes.text();
    check('タグフィードのステータス', tagFeedRes.status, 200);
    check('タグフィードの Content-Type', String(tagFeedRes.headers.get('content-type') || '').split(';')[0], 'application/rss+xml');
    check('タグ付き投稿が含まれる', tagFeed.includes('タグ付きの投稿'), true);
    check('タグのない投稿は含まれない', tagFeed.includes('RSSに出る公開投稿です'), false);
    check('タグフィードの self リンク', tagFeed.includes(`href="${BASE}/tags/discoverytest/feed.xml"`), true);

    // ------------------------------------------------------------------
    console.log('\n🧩 [2] oEmbed');
    const oembedRes = await fetch(`${BASE}/api/oembed?url=${encodeURIComponent(`${BASE}/?post=${publicPost}`)}`);
    const oembed = await oembedRes.json();
    check('oEmbed のステータス', oembedRes.status, 200);
    check('type は rich', oembed.type, 'rich');
    check('provider_name', oembed.provider_name, 'Discovery Test');
    check('html に本文が入る', String(oembed.html || '').includes('RSSに出る公開投稿'), true);
    check('author_name が入る', oembed.author_name, 'alice さん');

    // パーマリンク形式（/users/<user>/posts/<id>）でも解決できる
    const oembedPretty = await fetch(`${BASE}/api/oembed?url=${encodeURIComponent(publicPost)}`);
    check('パーマリンク形式の oEmbed', oembedPretty.status, 200);
    check('パーマリンク形式の html に URL が入る', String((await oembedPretty.json()).html || '').includes(publicPost), true);

    const oembedNoUrl = await fetch(`${BASE}/api/oembed`);
    check('url なしは 400', oembedNoUrl.status, 400);
    const oembedMissing = await fetch(`${BASE}/api/oembed?url=${encodeURIComponent(`${BASE}/?post=https://example.com/nope`)}`);
    check('存在しない投稿は 404', oembedMissing.status, 404);

    // ローカル限定は oEmbed にも出さない
    const localPostId = await createPost('ローカル限定の埋め込みは拒否', 'local');
    const oembedLocal = await fetch(`${BASE}/api/oembed?url=${encodeURIComponent(localPostId)}`);
    check('ローカル限定は oEmbed で 404', oembedLocal.status, 404);

    // ------------------------------------------------------------------
    console.log('\n🔗 [3] OGP メタの注入');
    const htmlRes = await fetch(`${BASE}/?post=${encodeURIComponent(publicPost)}`, { headers: { Accept: 'text/html' } });
    const html = await htmlRes.text();
    check('HTMLのステータス', htmlRes.status, 200);
    check('og:title に投稿者名とハンドル', html.includes(`property="og:title" content="alice さん (@alice@localhost:${PORT}) のノート"`), true);
    check('og:description に本文', html.includes('RSSに出る公開投稿です'), true);
    check('og:type は article', html.includes('property="og:type" content="article"'), true);
    // ?post= で開いても、正規 URL はパーマリンクに一本化する
    check('canonical がパーマリンク', html.includes(`rel="canonical" href="${publicPost}"`), true);
    check('meta description がある', html.includes('name="description"'), true);
    // index.html 側の既定値と二重にならないこと（クローラは最初の 1 つだけを読む）
    check('meta description が 1 つだけ', (html.match(/<meta\s+name="description"/gi) || []).length, 1);
    check('description が投稿のもの', html.includes('RSSに出る公開投稿です'), true);
    check('twitter:card がある', html.includes('name="twitter:card"'), true);
    check('RSS 自動発見リンクがある', html.includes('type="application/rss+xml"'), true);
    check('oEmbed 自動発見リンクがある', html.includes('type="application/json+oembed"'), true);

    // パーマリンク（/users/<user>/posts/<id>）でも同じメタが出る
    const permalinkRes = await fetch(publicPost, { headers: { Accept: 'text/html' } });
    const permalinkHtml = await permalinkRes.text();
    check('パーマリンクが HTML を返す', permalinkRes.status, 200);
    check('パーマリンクの og:url', permalinkHtml.includes(`property="og:url" content="${publicPost}"`), true);
    check('パーマリンクの canonical', permalinkHtml.includes(`rel="canonical" href="${publicPost}"`), true);

    // AP クライアント（Accept: activity+json）には同じ URL でも AP の JSON を返す
    const apPostRes = await fetch(publicPost, { headers: { Accept: 'application/activity+json' } });
    check('パーマリンクの AP 応答', String(apPostRes.headers.get('content-type') || '').includes('activity+json'), true);

    // ローカル限定の投稿は noindex（検索エンジンに載せない）
    const localHtml = await (await fetch(`${BASE}/?post=${encodeURIComponent(localPostId)}`, { headers: { Accept: 'text/html' } })).text();
    check('ローカル限定は noindex', localHtml.includes('name="robots" content="noindex'), true);

    const profileHtmlRes = await fetch(`${BASE}/users/alice`, { headers: { Accept: 'text/html' } });
    const profileHtml = await profileHtmlRes.text();
    check('プロフィールHTMLのステータス', profileHtmlRes.status, 200);
    check('プロフィールの og:title', profileHtml.includes(`property="og:title" content="alice さん (@alice@localhost:${PORT})"`), true);
    check('プロフィールの og:description', profileHtml.includes('プロフィール概要'), true);
    check('og:image がアイコン', profileHtml.includes('property="og:image"'), true);
    check('プロフィールの og:type は profile', profileHtml.includes('property="og:type" content="profile"'), true);
    check('プロフィールのフィード案内', profileHtml.includes(`href="${BASE}/users/alice/feed.xml"`), true);

    // タグページ
    const tagHtmlRes = await fetch(`${BASE}/tags/discoverytest`, { headers: { Accept: 'text/html' } });
    const tagHtml = await tagHtmlRes.text();
    check('タグページのステータス', tagHtmlRes.status, 200);
    check('タグページのタイトル', tagHtml.includes(`property="og:title" content="#discoverytest - Discovery Test"`), true);
    check('タグページの canonical', tagHtml.includes(`href="${BASE}/tags/discoverytest"`), true);
    check('タグページのフィード案内', tagHtml.includes(`${BASE}/tags/discoverytest/feed.xml`), true);

    const siteHtml = await fetch(`${BASE}/`, { headers: { Accept: 'text/html' } });
    const siteHtmlText = await siteHtml.text();
    check('サイト既定の og:title', siteHtmlText.includes('property="og:title" content="Discovery Test - 分散型ソーシャルネットワーク"'), true);

    // AP クライアント（Accept: activity+json）にはHTMLを返さない
    const apRes = await fetch(`${BASE}/users/alice`, { headers: { Accept: 'application/activity+json' } });
    check('AP リクエストは HTML にならない', String(apRes.headers.get('content-type') || '').includes('activity+json'), true);

    // ------------------------------------------------------------------
    console.log('\n🤖 [4] クローラ向け（robots / sitemap / security.txt）');
    const robotsRes = await fetch(`${BASE}/robots.txt`);
    const robots = await robotsRes.text();
    check('robots.txt のステータス', robotsRes.status, 200);
    check('robots.txt の Content-Type', String(robotsRes.headers.get('content-type') || '').split(';')[0], 'text/plain');
    check('robots.txt が HTML ではない', robots.includes('<html'), false);
    check('Sitemap を案内する', robots.includes(`Sitemap: ${BASE}/sitemap.xml`), true);
    check('管理画面を除外する', robots.includes('Disallow: /admin'), true);

    const sitemapRes = await fetch(`${BASE}/sitemap.xml`);
    const sitemap = await sitemapRes.text();
    check('sitemap.xml のステータス', sitemapRes.status, 200);
    check('sitemap の Content-Type', String(sitemapRes.headers.get('content-type') || '').split(';')[0], 'application/xml');
    check('urlset 宣言がある', sitemap.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'), true);
    check('ユーザーを列挙する', sitemap.includes(`<loc>${BASE}/users/alice</loc>`), true);
    check('公開投稿を列挙する', sitemap.includes(`<loc>${publicPost}</loc>`), true);
    check('ローカル限定の投稿は載せない', sitemap.includes(localPostId), false);
    check('タグを列挙する', sitemap.includes(`<loc>${BASE}/tags/discoverytest</loc>`), true);
    check('XML として読める（閉じタグ）', sitemap.trim().endsWith('</urlset>'), true);

    // security.txt は contact_url が未設定なら 404（空の Contact を配らない）
    const securityRes = await fetch(`${BASE}/.well-known/security.txt`);
    check('contact_url 未設定なら 404', securityRes.status, 404);

    // ------------------------------------------------------------------
    console.log('\n↪️ [5] 旧形式の共有 URL（/posts/<正規ID>）のリダイレクト');
    const legacyRes = await fetch(`${BASE}/posts/${encodeURIComponent(publicPost)}`, { redirect: 'manual' });
    check('旧形式のステータス', legacyRes.status, 301);
    check('パーマリンクへ転送する', String(legacyRes.headers.get('location') || ''), publicPost);

    // ------------------------------------------------------------------
    console.log('\n🪪 [6] Actor 文書の discoverable');
    const actor = await (await fetch(`${BASE}/users/alice`, { headers: { Accept: 'application/activity+json' } })).json();
    check('discoverable が true（ディレクトリ掲載）', actor.discoverable, true);


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
