import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// 検索演算子の検証
//   from:user / before:YYYY-MM-DD / after:YYYY-MM-DD / has:media / -除外語
//   ・演算子が本文検索語から取り除かれるか
//   ・FTS 経路と LIKE 経路の両方で効くか
//   ・演算子のみの検索（本文なし）が動くか
//   ・公開範囲などの既存フィルタと併用できるか
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_search_ops.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 4411;
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
      `空きポートを指定して実行してください:  TEST_PORT=4420 npx tsx scripts/test-search-operators.ts`,
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
  console.log('🧪 検索演算子の検証');
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
        INSTANCE_NAME: 'Search Test',
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
      return { token: body.sessionToken as string };
    };
    const alice = await register('alice');
    const bob = await register('bob');
    const auth = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

    const createPost = async (token: string, content: string, extra: Record<string, unknown> = {}) => {
      const res = await fetch(`${BASE}/api/posts`, {
        method: 'POST', headers: auth(token),
        body: JSON.stringify({ content, ...extra }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`投稿作成失敗: ${JSON.stringify(body)}`);
      return body.id as string;
    };

    // 添付付き投稿を1件用意する（has:media 用）
    const mediaForm = new FormData();
    mediaForm.append('file', new Blob([new Uint8Array(64)], { type: 'image/png' }), 'pic.png');
    const mediaRes = await fetch(`${BASE}/api/media/upload`, { method: 'POST', headers: { Authorization: `Bearer ${alice.token}` }, body: mediaForm });
    const mediaAttachment = (await mediaRes.json()).attachment;

    const aliceSearchPost = await createPost(alice.token, '検索演算子のテスト投稿 alpha');
    const bobSearchPost = await createPost(bob.token, '検索演算子のテスト投稿 beta');
    const mediaPost = await createPost(alice.token, '検索演算子のテスト投稿 with-media', { attachments: [mediaAttachment] });
    const spoilerPost = await createPost(bob.token, '検索演算子のテスト投稿 spoiler含み');
    const followersPost = await createPost(bob.token, '検索演算子のテスト投稿 gamma', { visibility: 'followers' });

    // 検索を実行して投稿IDの配列を返す
    const search = async (query: string, token: string | null = null) => {
      const res = await fetch(`${BASE}/api/search?q=${encodeURIComponent(query)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json();
      return (data.posts || []).map((p: any) => p.id);
    };

    // ------------------------------------------------------------------
    console.log('🔎 [1] 演算子なし（従来どおりの全文検索）');
    const plain = await search('検索演算子のテスト投稿');
    check('全文検索で全件ヒット（公開分）', plain.length >= 4, true);

    // ------------------------------------------------------------------
    console.log('\n👤 [2] from:');
    const fromBob = await search('検索演算子のテスト投稿 from:bob');
    check('from:bob は bob の投稿のみ', fromBob.every((id: string) => id.includes('/users/bob/')), true);
    check('from:bob に alice の投稿が混ざらない', fromBob.includes(aliceSearchPost), false);
    check('from 指定で本文語も効く（spoiler含みが出る）', fromBob.includes(spoilerPost), true);

    const fromHandle = await search(`検索演算子 from:@bob@localhost:${PORT}`);
    check('from:@user@domain 形式も効く', fromHandle.every((id: string) => id.includes('/users/bob/')) && fromHandle.length > 0, true);

    // ------------------------------------------------------------------
    console.log('\n🖼️  [3] has:media');
    const hasMedia = await search('has:media 検索演算子のテスト投稿');
    check('添付付き投稿のみ', hasMedia.includes(mediaPost), true);
    check('添付なし投稿は除外', hasMedia.includes(aliceSearchPost), false);

    // ------------------------------------------------------------------
    console.log('\n➖ [4] 除外語 (-term)');
    const excluded = await search('検索演算子のテスト投稿 -spoiler');
    check('除外語を含む投稿が消える', excluded.includes(spoilerPost), false);
    check('それ以外は残る', excluded.includes(aliceSearchPost), true);

    // ------------------------------------------------------------------
    console.log('\n📅 [5] after: / before:');
    const future = await search('検索演算子のテスト投稿 after:2999-01-01');
    check('未来日付の after: は0件', future.length, 0);
    const past = await search('検索演算子のテスト投稿 before:2999-01-01');
    check('過去日付の before: はヒットする', past.length > 0, true);
    const ancient = await search('検索演算子のテスト投稿 before:2000-01-01');
    check('古すぎる before: は0件', ancient.length, 0);

    // ------------------------------------------------------------------
    console.log('\n🔗 [6] 演算子の併用と、演算子のみの検索');
    const combined = await search('検索演算子のテスト投稿 from:bob -spoiler');
    check('from: と除外語の併用', combined.every((id: string) => id.includes('/users/bob/')) && combined.includes(spoilerPost) === false, true);

    const onlyOperators = await search('has:media');
    check('演算子のみ（has:media）でも検索できる', onlyOperators.includes(mediaPost), true);

    // 公開範囲フィルタが併用される（フォロワー限定は第三者に出ない）
    const followersSearch = await search('検索演算子のテスト投稿 gamma');
    check('フォロワー限定は本人以外の検索に出ない', followersSearch.includes(followersPost), false);
    const followersSearchOwner = await search('検索演算子のテスト投稿 gamma', bob.token);
    check('本人の検索には出る', followersSearchOwner.includes(followersPost), true);

    // 存在しない語は0件
    const noHit = await search('存在しない語句xyzzy from:bob');
    check('ヒットしない語は0件', noHit.length, 0);

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 検索演算子の検証: すべて成功');
    } else {
      console.error(`❌ 検索演算子の検証: ${failures} 件失敗`);
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
