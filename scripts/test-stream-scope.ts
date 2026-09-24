/**
 * 🧪 リアルタイム配信（SSE）の宛先判定の検証
 *
 *   1. ストリームの申告のパース（`?streams=local,home,tag:foo`）
 *   2. 投稿ごとの配信可否（ローカル / ホーム / 連合 / タグ / チャンネル / 自分の投稿）
 *   3. フォロワーの引き当て（実 DB・キャッシュつき）
 *   4. プロセスをまたいだメッセージ（Redis から届いた形）でも同じ判定が効くこと
 *   5. 実際にサーバーを立てて、`streams` を申告したクライアントにだけ届くこと
 *
 * 以前は「接続中の全員に全部」配っていた（クライアント側で捨てていた）。リレーを購読していると
 * 1 日に数万件のリモート投稿が届くため、サーバー側で必要な人だけに絞る。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT_DIR = process.cwd();
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3767;
const BASE = `http://localhost:${PORT}`;
const TEST_DB = 'data_test_stream_scope.sqlite';

// サーバーを立てる前に、同じ設定で in-process の DB を開けるようにしておく
process.env.PORT = String(PORT);
process.env.DOMAIN = `localhost:${PORT}`;
process.env.PROTOCOL = 'http';
process.env.DB_PATH = path.resolve(ROOT_DIR, 'server', TEST_DB);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✅' : '❌'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期待値 ${JSON.stringify(expected)})`}`);
  if (ok) passed++;
  else failed++;
}

/** 偽の SSE クライアント（`res.write` を捕まえて、何が届いたか見る） */
function fakeStream(clientId: string) {
  const received: string[] = [];
  return {
    received,
    res: {
      writeHead: () => {},
      write: (chunk: string) => {
        received.push(chunk);
        return true;
      },
      end: () => {},
    } as any,
    notes: () => received.filter((chunk) => chunk.startsWith('event: note')),
    text: () => received.join(''),
    id: clientId,
  };
}

console.log('🧪 === 📡 リアルタイム配信（SSE）の宛先判定 ===');
console.log(`   port=${PORT}\n`);

for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
  for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // 消せなくても続行
    }
  }
}

const routing = await import('../server/src/streamRouting.js');
const streaming = await import('../server/src/streaming.js');
const dbModule = await import('../server/src/db.js');
const { config } = await import('../server/src/config.js');

let server: ChildProcess | null = null;
const localClientIds: string[] = [];

try {
  // ── 1. ストリームの申告のパース ─────────────────────────────
  console.log('── 1. 申告のパース ──────────');
  const setOf = (v: unknown) => [...routing.parseStreams(v)].sort();
  check('未指定なら全部（今までどおり）', setOf(undefined), ['*']);
  check('空文字も全部', setOf(''), ['*']);
  check('local と home', setOf('local,home'), ['home', 'local']);
  check('タグは小文字にそろえる', setOf('tag:Foo'), ['tag:foo']);
  check('チャンネルは大文字小文字を保つ', setOf('channel:Ch_1'), ['channel:Ch_1']);
  check('知らない種類は捨てる', setOf('bogus,local'), ['local']);
  check('長すぎる値は捨てる', setOf(`tag:${'x'.repeat(200)}`), ['*']);

  // ── 2. 配信可否の判定 ──────────────────────────────────────
  console.log('\n── 2. 配信可否（クライアントごと）──────────');
  const localNote = { is_local: 1, user_id: 'alice', author_url: `${config.origin}/users/alice`, content: 'こんにちは #spica', channel_id: null };
  const remoteNote = { is_local: 0, user_id: 'https://remote.example/users/r', author_url: 'https://remote.example/users/r', content: 'リモートの投稿', channel_id: null };
  const localRouting = await routing.buildNoteRouting(localNote);
  const remoteRouting = { local: false, author: remoteNote.author_url, followers: ['alice'] };
  const target = (userId: string | null, streams: string[]) => ({ userId, streams: new Set(streams) });

  check('* は何でも受け取る', routing.shouldDeliverNote(target(null, ['*']), remoteNote, remoteRouting), true);
  check('ローカル投稿は local へ届く', routing.shouldDeliverNote(target(null, ['local']), localNote, localRouting), true);
  check('ローカル投稿は home へ届く（home の定義にローカルが含まれる）', routing.shouldDeliverNote(target('bob', ['home']), localNote, localRouting), true);
  check('ローカル投稿は tag だけの購読者には届かない', routing.shouldDeliverNote(target(null, ['tag:nomatch']), localNote, localRouting), false);
  check('リモート投稿は all へ届く', routing.shouldDeliverNote(target(null, ['all']), remoteNote, remoteRouting), true);
  check('リモート投稿はフォロー中の home へ届く', routing.shouldDeliverNote(target('alice', ['home']), remoteNote, remoteRouting), true);
  check('リモート投稿はフォローしていない home には届かない', routing.shouldDeliverNote(target('bob', ['home']), remoteNote, remoteRouting), false);
  check('リモート投稿は local だけの購読者には届かない', routing.shouldDeliverNote(target('alice', ['local']), remoteNote, remoteRouting), false);
  check('自分の投稿は必ず届く', routing.shouldDeliverNote(target('https://remote.example/users/r', ['tag:nomatch']), remoteNote, remoteRouting), true);
  check('タグが本文にあれば tag 購読者へ届く', routing.shouldDeliverNote(target(null, ['tag:spica']), localNote, localRouting), true);
  check('タグリンク（/tags/）でも届く', routing.shouldDeliverNote(target(null, ['tag:spica']), { ...localNote, content: 'リンク /tags/spica' }, localRouting), true);
  check('チャンネルが一致すれば届く', routing.shouldDeliverNote(target(null, ['channel:ch1']), { ...localNote, channel_id: 'ch1' }, localRouting), true);
  check('チャンネルが違えば届かない', routing.shouldDeliverNote(target(null, ['channel:ch2']), { ...localNote, channel_id: 'ch1' }, localRouting), false);

  // ── 3. フォロワーの引き当て（実 DB）────────────────────────
  console.log('\n── 3. フォロワーの引き当て ──────────');
  await dbModule.initDatabase();
  const { db } = dbModule;
  const now = new Date().toISOString();
  // follows は URL の対応表なので、ユーザー行が無くても引ける（アクター URL から ID を取り出す）
  await db
    .prepare(
      `INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
       VALUES (?, ?, ?, ?, 1, 'accepted', ?)`,
    )
    .run('f1', `${config.origin}/users/alice`, remoteNote.author_url, `${remoteNote.author_url}/inbox`, now);

  routing.clearFollowerCache();
  check('フォローしている人が引ける', await routing.getFollowerUserIds(remoteNote.author_url), ['alice']);
  check('フォローが無ければ空', await routing.getFollowerUserIds('https://nobody.example/users/x'), []);

  // キャッシュが効いていること（消さない限り、DB を足しても古い値を返す）
  await db
    .prepare(
      `INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
       VALUES (?, ?, ?, ?, 1, 'accepted', ?)`,
    )
    .run('f2', `${config.origin}/users/bob`, remoteNote.author_url, `${remoteNote.author_url}/inbox`, now);
  check('キャッシュ中は古い値を返す（DB を引き直さない）', await routing.getFollowerUserIds(remoteNote.author_url), ['alice']);
  routing.clearFollowerCache();
  check('キャッシュを消せば新しい値を返す', (await routing.getFollowerUserIds(remoteNote.author_url)).sort(), ['alice', 'bob']);

  // ── 4. プロセスをまたいだメッセージでも同じ判定 ─────────────
  console.log('\n── 4. Redis 経由のメッセージ（受信側の判定）──────────');
  routing.clearFollowerCache();
  const alice = fakeStream('alice');
  const bob = fakeStream('bob');
  const guest = fakeStream('guest');
  localClientIds.push(
    streaming.addStreamClient(alice.res, 'alice', routing.parseStreams('home')),
    streaming.addStreamClient(bob.res, 'bob', routing.parseStreams('home')),
    streaming.addStreamClient(guest.res, 'guest-placeholder', routing.parseStreams('local')),
  );
  check('接続数が増える', streaming.getStreamClientCount(), 3);

  streaming.handleRemoteStreamEvent(
    JSON.stringify({ k: 'event', e: 'note', d: remoteNote, r: remoteRouting }),
  );
  check('フォロー中の home には届く', alice.notes().length, 1);
  check('フォローしていない home には届かない', bob.notes().length, 0);
  check('local だけの購読者には届かない', guest.notes().length, 0);

  // ローカル投稿は home / local の両方へ
  streaming.handleRemoteStreamEvent(
    JSON.stringify({ k: 'event', e: 'note', d: localNote, r: localRouting }),
  );
  check('ローカル投稿は home に届く', alice.notes().length, 2);
  check('ローカル投稿もフォロー外の home に届く', bob.notes().length, 1);
  check('ローカル投稿は local にも届く', guest.notes().length, 1);

  // routing が無いメッセージ（古い経路・note 以外）は今までどおり全員へ
  streaming.handleRemoteStreamEvent(JSON.stringify({ k: 'event', e: 'reaction', d: { postId: 'x' } }));
  check('routing の無いイベントは全員へ届く', [alice.text().includes('event: reaction'), bob.text().includes('event: reaction'), guest.text().includes('event: reaction')], [true, true, true]);

  for (const id of localClientIds) streaming.removeStreamClient(id);
  check('切断すると減る', streaming.getStreamClientCount(), 0);

  // ── 5. 実際のサーバーで（HTTP + SSE）───────────────────────
  console.log('\n── 5. サーバー越しの確認 ──────────');
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.resolve(ROOT_DIR, 'server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DOMAIN: `localhost:${PORT}`,
      PROTOCOL: 'http',
      DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
      INSTANCE_NAME: 'Stream Scope Test',
      RATE_LIMIT_DISABLED: 'true',
      AUTO_MAINTENANCE: 'false',
      AUTO_BACKUP: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout?.on('data', (d) => (log += d.toString()));
  server.stderr?.on('data', (d) => (log += d.toString()));
  const deadline = Date.now() + 45000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.status === 200 || res.status === 503) {
        up = true;
        break;
      }
    } catch {
      // まだ
    }
    await sleep(250);
  }
  if (!up) throw new Error(`サーバーが起動しませんでした:\n${log}`);

  const register = async (id: string) => {
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: `${id} さん`, agreedToRules: true }),
    });
    const body = (await res.json()) as any;
    if (!body?.sessionToken) throw new Error(`${id} の作成に失敗: ${JSON.stringify(body)}`);
    return body.sessionToken as string;
  };
  const adminToken = await register('admin');

  const createPost = async (content: string) => {
    const res = await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error(`投稿に失敗: HTTP ${res.status}`);
  };

  /** SSE を開いて、条件に合うイベントが来るまで待つ */
  const waitForNote = async (query: string, timeoutMs: number): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE}/api/streaming?${query}`, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
      const reader = res.body?.getReader();
      if (!reader) return false;
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) return false;
        buffer += Buffer.from(value).toString('utf8');
        if (buffer.includes('event: note')) return true;
      }
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };

  // local を申告したクライアントはローカル投稿を受け取る
  const localWatcher = waitForNote('streams=local', 8000);
  await sleep(500);
  await createPost('配信範囲の検証用ローカル投稿 その 1');
  check('local を申告したクライアントにローカル投稿が届く', await localWatcher, true);

  // tag だけを申告したクライアントは（一致しないので）受け取らない
  const tagWatcher = waitForNote('streams=tag:nomatch', 2500);
  await sleep(500);
  await createPost('配信範囲の検証用ローカル投稿 その 2');
  check('一致しないタグだけを申告したクライアントには届かない', await tagWatcher, false);

  // tag が一致すれば届く
  const tagWatcher2 = waitForNote('streams=tag:streamscope', 8000);
  await sleep(500);
  await createPost('配信範囲の検証用ローカル投稿 その 3 #streamscope');
  check('一致するタグを申告したクライアントには届く', await tagWatcher2, true);

  // 申告なし（古いクライアント）は今までどおり全部受け取る
  const legacyWatcher = waitForNote('', 8000);
  await sleep(500);
  await createPost('配信範囲の検証用ローカル投稿 その 4');
  check('申告が無いクライアントは今までどおり受け取る', await legacyWatcher, true);
} catch (err: any) {
  console.error('\n❌ 検査中にエラー:', err?.message || err);
  failed++;
} finally {
  for (const id of localClientIds) streaming.removeStreamClient(id);
  if (server && server.exitCode === null) {
    server.kill();
    const deadline = Date.now() + 8000;
    while (server.exitCode === null && Date.now() < deadline) await sleep(100);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  try {
    await dbModule.db.close();
  } catch {
    // 握る
  }
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      fs.rmSync(path.resolve(ROOT_DIR, 'server', f), { force: true });
    } catch {
      // 消せなくても続行
    }
  }
}

console.log('');
console.log('====================================================');
if (failed === 0) {
  console.log(`🎊 リアルタイム配信の宛先判定: ${passed} 件成功`);
  process.exit(0);
}
console.log(`❌ ${passed} 件成功 / ${failed} 件失敗`);
process.exit(1);
