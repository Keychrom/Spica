import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// Misskey 互換 API（サードパーティ製クライアント向け）の検証
//
//   1. meta / i（本文の `i` でもトークンを渡せる）
//   2. ノート: create / show / conversation / delete / 公開範囲の変換（DM は拒否）
//   3. タイムライン: home・local・global と untilId / sinceId のページング
//   4. リアクション / お気に入り / ブースト（renote）
//   5. ユーザー: users/show / users/notes / following の作成と解除 / フォロワー一覧
//   6. 通知: i/notifications
//   7. ドライブ: drive/files/create（multipart）と fileIds 付き投稿
//   8. MiAuth: 承認 → トークン発行 → そのトークンで API が使える
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_misskey.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 4513;
const BASE = `http://localhost:${PORT}`;

[TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
  [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)].forEach((p) => {
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
      `空きポートを指定して実行してください:  TEST_PORT=4523 npx tsx scripts/test-misskey.ts`,
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

/** Misskey の API 呼び出し（トークンは本文の `i` で渡す） */
async function mk(pathname: string, body: Record<string, unknown> = {}, token?: string) {
  const res = await fetch(`${BASE}/api${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(token ? { ...body, i: token } : body),
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {}
  return { status: res.status, body: parsed };
}

async function run() {
  console.log('====================================================');
  console.log('🧪 Misskey 互換 API の検証');
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
        INSTANCE_NAME: 'Misskey API Test',
        RATE_LIMIT_DISABLED: 'true',
        AUTO_MAINTENANCE: 'false',
        AUTO_BACKUP: 'false',
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
        body: JSON.stringify({ id, name: `${id} さん`, summary: '', agreedToRules: true }),
      });
      const body = await res.json();
      if (!body?.sessionToken) throw new Error(`${id} の作成に失敗: ${JSON.stringify(body)}`);
      return { token: body.sessionToken as string };
    };
    const alice = await register('alice');
    const bob = await register('bob');

    // ------------------------------------------------------------------
    console.log('🌐 [1] meta と i');
    const meta = await mk('/meta');
    check('meta が返る', meta.status, 200);
    check('インスタンス名', meta.body.name, 'Misskey API Test');
    check('本文の長さ上限を返す', typeof meta.body.maxNoteTextLength, 'number');
    check('ストリーミング未対応を明示する', meta.body.features.streaming, false);

    const me = await mk('/i', {}, alice.token);
    check('i が返る', me.status, 200);
    check('自分のハンドル', me.body.handle, `@alice@localhost:${PORT}`);
    const meUnauth = await mk('/i');
    check('トークン無しは 401', meUnauth.status, 401);

    // ------------------------------------------------------------------
    console.log('\n📝 [2] ノートの作成・取得・削除');
    const created = await mk('/notes/create', { text: '最初のノートです', visibility: 'public' }, alice.token);
    check('作成できる', created.status, 200);
    const note = created.body.createdNote;
    check('createdNote が返る', Boolean(note?.id), true);
    check('本文', note.text, '最初のノートです');
    check('公開範囲', note.visibility, 'public');
    check('投稿者', note.user.handle, `@alice@localhost:${PORT}`);
    check('ID は 16 文字（時刻 + ハッシュ）', String(note.id).length, 16);

    const empty = await mk('/notes/create', { text: '   ' }, alice.token);
    check('空の投稿は 400', empty.status, 400);

    // DM（specified）は方針として受け付けない
    const dm = await mk('/notes/create', { text: 'ないしょ', visibility: 'specified' }, alice.token);
    check('DM（specified）は 400', dm.status, 400);
    check('DM の理由が返る', String(dm.body.error || '').includes('DM'), true);

    // localOnly はローカル限定（Misskey の home）になる
    const localOnly = await mk('/notes/create', { text: 'ローカル限定です', localOnly: true }, alice.token);
    check('localOnly の公開範囲', localOnly.body.createdNote.visibility, 'home');
    check('localOnly のフラグ', localOnly.body.createdNote.localOnly, true);

    const shown = await mk('/notes/show', { noteId: note.id });
    check('notes/show で取れる', shown.body.id, note.id);
    check('show の本文', shown.body.text, '最初のノートです');

    const canonical = await mk('/notes/show', { noteId: `https://spica.example/users/alice/posts/1` });
    check('存在しない ID は 400', canonical.status, 400);

    // 返信
    const reply = await mk('/notes/create', { text: '返信です', replyId: note.id }, bob.token);
    check('返信できる', reply.status, 200);
    check('返信の replyId が元ノートを指す', reply.body.createdNote.replyId, note.id);

    const conversation = await mk('/notes/conversation', { noteId: reply.body.createdNote.id });
    check('会話が取れる', conversation.status, 200);
    check('会話は 2 件（親 + 返信）', conversation.body.length, 2);
    check('先頭が親', conversation.body[0].id, note.id);

    const foreignDelete = await mk('/notes/delete', { noteId: note.id }, bob.token);
    check('他人のノートは消せない', foreignDelete.status, 403);

    // ------------------------------------------------------------------
    console.log('\n📜 [3] タイムラインとページング');
    const older = await mk('/notes/create', { text: '古いノート' }, alice.token);
    const newer = await mk('/notes/create', { text: '新しいノート' }, alice.token);

    const local = await mk('/notes/local-timeline', { limit: 10 });
    check('ローカルタイムラインが返る', local.status, 200);
    const ids = local.body.map((n: any) => n.id);
    check('新しい順に並ぶ', ids.indexOf(newer.body.createdNote.id) < ids.indexOf(older.body.createdNote.id), true);
    check('ID は文字列比較でも時刻順', newer.body.createdNote.id > older.body.createdNote.id, true);

    const paged = await mk('/notes/local-timeline', { limit: 10, untilId: newer.body.createdNote.id });
    const pagedIds = paged.body.map((n: any) => n.id);
    check('untilId で古い方だけになる', pagedIds.includes(newer.body.createdNote.id), false);
    check('untilId に古いノートは含まれる', pagedIds.includes(older.body.createdNote.id), true);

    const since = await mk('/notes/local-timeline', { limit: 10, sinceId: older.body.createdNote.id });
    const sinceIds = since.body.map((n: any) => n.id);
    check('sinceId で新しい方だけになる', sinceIds.includes(older.body.createdNote.id), false);
    check('sinceId に新しいノートは含まれる', sinceIds.includes(newer.body.createdNote.id), true);

    const global = await mk('/notes/global-timeline', { limit: 5 });
    check('連合タイムラインが返る', global.status, 200);
    const home = await mk('/notes/timeline', { limit: 5 }, alice.token);
    check('ホームタイムラインが返る', home.status, 200);

    // ------------------------------------------------------------------
    console.log('\n🎉 [4] リアクション / お気に入り / ブースト');
    const react = await mk('/notes/reactions/create', { noteId: note.id, reaction: 'star' }, bob.token);
    check('リアクションできる', react.status, 204);
    const afterReact = await mk('/notes/show', { noteId: note.id }, bob.token);
    check('リアクションが付く', afterReact.body.reactions.star, 1);
    check('自分のリアクションが分かる', afterReact.body.myReaction, 'star');
    const reactions = await mk('/notes/reactions', { noteId: note.id });
    check('リアクション一覧', reactions.body.length, 1);
    check('リアクションの種類', reactions.body[0].type, 'star');
    const unreact = await mk('/notes/reactions/delete', { noteId: note.id }, bob.token);
    check('リアクションを消せる', unreact.status, 204);
    check('消したら 0 になる', (await mk('/notes/show', { noteId: note.id }, bob.token)).body.myReaction, null);

    const fav = await mk('/notes/favorites/create', { noteId: note.id }, bob.token);
    check('お気に入りにできる', fav.status, 204);
    check('isFavorited が立つ', (await mk('/notes/show', { noteId: note.id }, bob.token)).body.isFavorited, true);
    const unfav = await mk('/notes/favorites/delete', { noteId: note.id }, bob.token);
    check('お気に入りを外せる', unfav.status, 204);
    check('isFavorited が下りる', (await mk('/notes/show', { noteId: note.id }, bob.token)).body.isFavorited, false);

    const boost = await mk('/notes/create', { renoteId: note.id }, bob.token);
    check('ブーストできる', boost.status, 200);
    check('renote が入る', Boolean(boost.body.createdNote?.renote?.id), true);
    check('renoteId が元ノート', boost.body.createdNote.renoteId, note.id);
    check('ブーストの投稿者はブーストした人', boost.body.createdNote.user.handle, `@bob@localhost:${PORT}`);

    // タイムラインで見たブーストをそのまま開けるか（ブーストの ID で notes/show を叩く）
    const boostId = boost.body.createdNote.id;
    const shownBoost = await mk('/notes/show', { noteId: boostId });
    check('ブーストの ID で開ける', shownBoost.status, 200);
    check('ブーストとして返る', shownBoost.body.renoteId, note.id);
    check('開いたときの投稿者もブーストした人', shownBoost.body.user.handle, `@bob@localhost:${PORT}`);

    // 2 回目のブーストは何も変えない（Spica の API はトグルなので、そのまま呼ぶと解除されてしまう）
    const boostAgain = await mk('/notes/create', { renoteId: boostId }, bob.token);
    check('ブーストの ID を渡しても元の投稿になる', boostAgain.status, 200);
    check('2 回目でも元の投稿のブーストのまま', boostAgain.body.createdNote.renoteId, note.id);
    // 元のノートのブースト数は 1 のまま（2 回目で解除されていない）
    check('元のノートのブースト数が 1 のまま', (await mk('/notes/show', { noteId: note.id })).body.renoteCount, 1);

    // ------------------------------------------------------------------
    console.log('\n👤 [5] ユーザーとフォロー');
    const userShow = await mk('/users/show', { username: 'alice' });
    check('users/show（ユーザー名）', userShow.body.id, 'alice');
    check('ローカルは host が null', userShow.body.host, null);
    const userNotes = await mk('/users/notes', { userId: 'alice', limit: 20 });
    check('users/notes が返る', userNotes.status, 200);
    check('自分のノートだけ', userNotes.body.every((n: any) => n.user.handle === `@alice@localhost:${PORT}`), true);
    const userSearch = await mk('/users/search', { query: 'bob' });
    check('users/search が返る', userSearch.body.some((u: any) => u.id === 'bob'), true);
    const noUser = await mk('/users/show', { username: 'nobody' });
    check('存在しないユーザーは 404', noUser.status, 404);

    const follow = await mk('/following/create', { userId: 'alice' }, bob.token);
    check('フォローできる', follow.status, 200);
    check('フォローしたユーザーが返る', follow.body.id, 'alice');
    const followers = await mk('/users/followers', { userId: 'alice' });
    check('フォロワー一覧に出る', followers.body.some((u: any) => u.id.startsWith('bob')), true);
    const following = await mk('/users/following', { userId: 'bob' });
    check('フォロー中一覧に出る', following.body.some((u: any) => u.id.startsWith('alice')), true);
    const unfollow = await mk('/following/delete', { userId: 'alice' }, bob.token);
    check('フォロー解除できる', unfollow.status, 200);
    check('フォロワーから消える', (await mk('/users/followers', { userId: 'alice' })).body.length, 0);

    // ------------------------------------------------------------------
    console.log('\n🔔 [6] 通知');
    await mk('/following/create', { userId: 'alice' }, bob.token); // 通知を作るためにフォローし直す
    const notifications = await mk('/i/notifications', { limit: 10 }, alice.token);
    check('通知が返る', notifications.status, 200);
    check('フォロー通知がある', notifications.body.some((n: any) => n.type === 'follow'), true);
    check('通知に相手が入る', Boolean(notifications.body[0]?.user?.handle), true);
    const unauthNotifications = await mk('/i/notifications', {});
    check('未認証は 401', unauthNotifications.status, 401);

    // ------------------------------------------------------------------
    console.log('\n🗂️ [7] ドライブ（ファイルアップロード）');
    // 1x1 の PNG
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const form = new FormData();
    form.append('file', new Blob([pngBytes], { type: 'image/png' }), 'test.png');
    const uploadRes = await fetch(`${BASE}/api/drive/files/create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` },
      body: form,
    });
    const uploaded = await uploadRes.json();
    check('アップロードできる', uploadRes.status, 200);
    check('ファイル URL が返る', String(uploaded.url || '').includes('/uploads/'), true);
    check('ファイル ID は URL', uploaded.id, uploaded.url);

    const withFile = await mk('/notes/create', { text: '画像つき', fileIds: [uploaded.id] }, alice.token);
    check('ファイル付きで投稿できる', withFile.status, 200);
    check('files が入る', withFile.body.createdNote.files.length, 1);
    check('fileIds も入る', withFile.body.createdNote.fileIds, [uploaded.id]);

    // ------------------------------------------------------------------
    console.log('\n🔐 [8] MiAuth（ブラウザ承認 → トークン）');
    const session = `test-session-${Date.now()}`;
    const pageRes = await fetch(`${BASE}/miauth/${session}?name=TestClient&callback=https://client.example/cb&permission=read:notes,write:notes`, {
      headers: { Accept: 'text/html' },
    });
    check('承認ページが HTML を返す', String(pageRes.headers.get('content-type') || '').includes('text/html'), true);

    const before = await mk(`/miauth/${session}/check`);
    check('承認前は ok: false', before.body.ok, false);
    const infoUnauth = await fetch(`${BASE}/api/miauth/${session}/info`);
    check('info は未認証だと 401', infoUnauth.status, 401);
    const info = await (await fetch(`${BASE}/api/miauth/${session}/info`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    })).json();
    check('info にアプリ名', info.name, 'TestClient');
    check('info に権限', info.permissions, ['read:notes', 'write:notes']);

    const approve = await fetch(`${BASE}/api/miauth/${session}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    check('承認できる', approve.status, 200);
    const after = await mk(`/miauth/${session}/check`);
    check('承認後は ok: true', after.body.ok, true);
    check('トークンが発行される', typeof after.body.token === 'string' && after.body.token.length > 20, true);

    const meByMiauthToken = await mk('/i', {}, after.body.token);
    check('発行されたトークンで API が使える', meByMiauthToken.body.id, 'alice');

    // 拒否したらトークンは渡らない
    const denied = `test-denied-${Date.now()}`;
    await fetch(`${BASE}/miauth/${denied}?name=BadClient`, { headers: { Accept: 'text/html' } });
    await fetch(`${BASE}/api/miauth/${denied}/deny`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    const deniedCheck = await mk(`/miauth/${denied}/check`);
    check('拒否すると ok: false のまま', deniedCheck.body.ok, false);

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎊 Misskey 互換 API の検証: すべて成功');
    } else {
      console.error(`❌ 検証: ${failures} 件失敗`);
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
