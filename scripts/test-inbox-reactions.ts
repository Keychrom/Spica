import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';

// ============================================================================
// 受信した絵文字リアクション（Like / EmojiReact）と、その取り消し（Undo）の検査
//
//   1. Like（content なし = ❤️）が保存され、投稿者に通知が飛ぶ
//   2. EmojiReact（💯）が保存され、API が両方を返す
//   3. Akkoma 形の Undo（object に活動を埋め込む）は「その 1 件」だけ消す
//      ← 2026-10-04 の修正の回帰検査。以前は (人, 投稿) 単位で全部消していた
//   4. Mastodon 形の Undo（object = 活動 id の文字列）も 1 件だけ消す
//   5. 他人の活動 id を指定した Undo は何も消さない（user スコープ）
//   6. 活動 id が未知でも content があれば絵文字で特定して消す
//   7. object が投稿 URL の文字列（古い Misskey 形）は投稿単位で消す
//   8. Undo しても通知は残る（通知は「起きたこと」の記録なので消さない）
//
// ポートは TEST_PORT で変更可能（既定 3322）。稼働中の開発サーバーと衝突しない。
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_inbox_reactions.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3322;
const ORIGIN = `http://localhost:${PORT}`;
// 署名は「相手が指定してくる公開ドメイン」で行う（リバースプロキシ構成の再現）
const PUBLIC_HOST = 'tunnel.test';
const PUBLIC_ORIGIN = `http://${PUBLIC_HOST}`;

const A_ACTOR = 'https://akkoma.test/users/a';
const B_ACTOR = 'https://misskey.test/users/b';
const A_INBOX = 'https://akkoma.test/inbox';
const B_INBOX = 'https://misskey.test/inbox';

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

/** 稼働中のサーバーへ誤ってリクエストを送らないためのガード（bind の成否は Windows では当てにならない） */
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
      `空きポートを指定して実行してください:  TEST_PORT=3323 npx tsx scripts/test-inbox-reactions.ts`,
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

// PostgreSQL でも回せるように、DB は共通のドライバ工場で開く
// （以前は node:sqlite を直に開いていたので PG では「no such table: remote_actors」で落ちていた）
const USE_PG =
  (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'postgres' && Boolean(process.env.TEST_DATABASE_URL);

async function withDb<T>(fn: (conn: ReturnType<typeof createAsyncDatabase>) => Promise<T>): Promise<T> {
  const conn = USE_PG
    ? createAsyncDatabase({ driver: 'postgres', connectionString: process.env.TEST_DATABASE_URL as string })
    : createAsyncDatabase({ driver: 'sqlite', dbPath: path.resolve(ROOT_DIR, 'server', TEST_DB) });
  try {
    return await fn(conn);
  } finally {
    await conn.close().catch(() => {});
  }
}

const exec = (sql: string, ...params: any[]): Promise<void> => withDb((c) => c.prepare(sql).run(...params).then(() => {}));
const row = (sql: string, ...params: any[]): Promise<any> => withDb((c) => c.prepare(sql).get(...params));
const rows = async (sql: string, ...params: any[]): Promise<any[]> =>
  (await withDb((c) => c.prepare(sql).all(...params))) as any[];

// --- 署名ヘルパー（サーバ実装に依存せず、仕様どおりに署名する）---

function generateTestKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey as unknown as string, privateKeyPem: privateKey as unknown as string };
}

function signInboxRequest(params: { body: string; keyId: string; privateKeyPem: string }): Record<string, string> {
  const digest = `SHA-256=${crypto.createHash('sha256').update(Buffer.from(params.body, 'utf8')).digest('base64')}`;
  const contentType = 'application/activity+json';
  const date = new Date().toUTCString();
  const signedHeaderNames = ['(request-target)', 'host', 'date', 'digest', 'content-type'];
  const signingString = [
    '(request-target): post /inbox',
    `host: ${PUBLIC_HOST}`,
    `date: ${date}`,
    `digest: ${digest}`,
    `content-type: ${contentType}`,
  ].join('\n');

  const signer = crypto.createSign('sha256');
  signer.update(signingString);
  const signature = signer.sign(params.privateKeyPem, 'base64');

  return {
    Host: PUBLIC_HOST,
    Date: date,
    Digest: digest,
    'Content-Type': contentType,
    Signature: `keyId="${params.keyId}",algorithm="rsa-sha256",headers="${signedHeaderNames.join(' ')}",signature="${signature}"`,
  };
}

async function postInbox(body: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  const res = await fetch(`${ORIGIN}/inbox`, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}

// --- テスト本体 ---

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    console.log(`  ✅ ${name}: ${actual}`);
  } else {
    console.error(`  ❌ ${name}: 期待値 ${expected} / 実際 ${actual}`);
    failures++;
  }
}

async function run() {
  console.log('====================================================');
  console.log('🧪 受信リアクション（Like / EmojiReact / Undo）テスト');
  console.log(`   port=${PORT} origin=${ORIGIN}`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;
  const aKeys = generateTestKeyPair();
  const bKeys = generateTestKeyPair();

  try {
    await assertPortFree(PORT);

    console.log(`▶️ テストサーバーを起動中 (Port ${PORT})...`);
    server = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: PUBLIC_HOST,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Inbox Reactions Test',
      },
      stdio: 'pipe',
      shell: true,
    });
    server.stdout?.on('data', (d) => console.log(`[Server] ${d.toString().trim()}`));

    if (!(await waitForServer(ORIGIN))) {
      throw new Error('サーバー起動失敗');
    }
    console.log('✅ サーバー起動完了\n');

    // 投稿者（ローカル）を作る
    const regRes = await fetch(`${ORIGIN}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'admin', name: 'Reaction Admin' }),
    });
    const admin = await regRes.json();
    const token = admin?.sessionToken;
    if (!token) throw new Error(`管理者作成に失敗: ${JSON.stringify(admin)}`);

    // リアクションの対象になるローカル投稿
    const postRes = await fetch(`${ORIGIN}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: 'リアクションの受け取りテスト用投稿', visibility: 'public' }),
    });
    const post = await postRes.json();
    if (!post?.id) throw new Error(`投稿作成に失敗: ${JSON.stringify(post)}`);
    const postId: string = post.id;
    console.log(`📝 対象の投稿: ${postId}\n`);

    // リモートの actor を鍵つきで登録（外向き fetch を起こさず署名検証を成立させる）
    const seedActor = async (actorUrl: string, publicKeyPem: string, inboxUrl: string) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          await exec(
            `INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
             VALUES (?, ?, ?, ?, '', '', '', ?, NULL, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET public_key_pem = excluded.public_key_pem`,
            actorUrl,
            actorUrl.split('/').pop() || 'user',
            new URL(actorUrl).host,
            'Test Actor',
            inboxUrl,
            `${actorUrl}#main-key`,
            publicKeyPem,
            new Date().toISOString(),
          );
          return;
        } catch (err) {
          if (attempt === 9) throw err;
          await sleep(200);
        }
      }
    };
    await seedActor(A_ACTOR, aKeys.publicKeyPem, A_INBOX);
    await seedActor(B_ACTOR, bKeys.publicKeyPem, B_INBOX);
    console.log('🗝️ remote_actors に 2 人ぶんの公開鍵を登録\n');

    const send = async (actor: string, payload: Record<string, unknown>, keys: { privateKeyPem: string }) => {
      const body = JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', actor, ...payload });
      return postInbox(body, signInboxRequest({ body, keyId: `${actor}#main-key`, privateKeyPem: keys.privateKeyPem }));
    };

    const reactionsOf = async (): Promise<any[]> =>
      (await rows('SELECT id, user_id, reaction, is_local FROM reactions WHERE post_id = ? ORDER BY reaction, user_id', postId)) as any[];
    const rowsFor = async (actorUrl: string) => (await reactionsOf()).filter((r) => r.user_id === actorUrl);
    const notificationCount = async (content?: string): Promise<any> =>
      content
        ? await row("SELECT count(*) AS c FROM notifications WHERE type = 'reaction' AND post_id = ? AND content = ?", postId, content)
        : await row("SELECT count(*) AS c FROM notifications WHERE type = 'reaction' AND post_id = ?", postId);

    // ------------------------------------------------------------------
    console.log('❤️ [1] Like（content なし）は ❤️ として保存されるか');
    const likeId = `${A_ACTOR}/activities/like-1`;
    const likeRes = await send(A_ACTOR, {
      id: likeId,
      type: 'Like',
      object: postId,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    }, aKeys);
    check('Like のステータス', likeRes.status, 200);
    check('保存された件数', (await reactionsOf()).length, 1);
    check('絵文字', (await reactionsOf())[0]?.reaction, '❤️');
    check('リモートからのリアクション（is_local=0）', (await reactionsOf())[0]?.is_local, 0);
    check('投稿者への通知', (await notificationCount('❤️')).c, 1);

    // ------------------------------------------------------------------
    console.log('\n💯 [2] EmojiReact は絵文字つきで保存され、API が両方を返すか');
    const emojiId = `${A_ACTOR}/activities/react-1`;
    const emojiRes = await send(A_ACTOR, {
      id: emojiId,
      type: 'EmojiReact',
      object: postId,
      content: '💯',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    }, aKeys);
    check('EmojiReact のステータス', emojiRes.status, 200);
    check('保存された件数', (await reactionsOf()).length, 2);

    const timelineRes = await fetch(`${ORIGIN}/api/users/admin/posts?limit=10`);
    const timeline = await timelineRes.json();
    const timelineItems: any[] = Array.isArray(timeline) ? timeline : timeline.items || [];
    const apiPost = timelineItems.find((p: any) => p.id === postId);
    const apiReactions = new Map<string, number>((apiPost?.reactions || []).map((r: any) => [r.reaction, r.count]));
    check('API のリアクション数', apiReactions.size, 2);
    check('API ❤️ の数', apiReactions.get('❤️'), 1);
    check('API 💯 の数', apiReactions.get('💯'), 1);

    // ------------------------------------------------------------------
    console.log('\n↩️ [3] Akkoma 形の Undo（活動の埋め込み）は 1 件だけ消すか');
    const akkomaUndoRes = await send(A_ACTOR, {
      id: `${A_ACTOR}/activities/undo-1`,
      type: 'Undo',
      object: { id: emojiId, type: 'EmojiReact', object: postId, content: '💯', actor: A_ACTOR },
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    }, aKeys);
    check('Undo のステータス', akkomaUndoRes.status, 200);
    check('残った件数（❤️ だけ残る）', (await rowsFor(A_ACTOR)).length, 1);
    check('残った絵文字', (await rowsFor(A_ACTOR))[0]?.reaction, '❤️');

    // ------------------------------------------------------------------
    console.log('\n↩️ [4] Mastodon 形の Undo（object = 活動 id の文字列）も 1 件だけ消すか');
    const mastodonUndoRes = await send(A_ACTOR, {
      id: `${A_ACTOR}/activities/undo-2`,
      type: 'Undo',
      object: likeId,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    }, aKeys);
    check('Undo のステータス', mastodonUndoRes.status, 200);
    check('残った件数', (await rowsFor(A_ACTOR)).length, 0);
    check('通知は残る（仕様）', (await notificationCount()).c, 2);

    // ------------------------------------------------------------------
    console.log('\n🤝 [5] 他人の活動 id を指定した Undo は何も消さないか');
    const bLikeId = `${B_ACTOR}/activities/like-1`;
    await send(B_ACTOR, {
      id: bLikeId,
      type: 'Like',
      object: postId,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    }, bKeys);
    const aEmoji2 = `${A_ACTOR}/activities/react-2`;
    await send(A_ACTOR, {
      id: aEmoji2,
      type: 'EmojiReact',
      object: postId,
      content: '👍',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    }, aKeys);
    check('B の ❤️ と A の 👍 が保存されている', (await reactionsOf()).length, 2);

    // A が B の活動 id を Undo しても、A の行は消えない（user スコープで守られる）
    await send(A_ACTOR, {
      id: `${A_ACTOR}/activities/undo-3`,
      type: 'Undo',
      object: bLikeId,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    }, aKeys);
    check('B のリアクションは無事', (await rowsFor(B_ACTOR)).length, 1);
    check('A のリアクションも無事', (await rowsFor(A_ACTOR)).length, 1);

    // ------------------------------------------------------------------
    console.log('\n🔎 [6] 活動 id が未知でも content があれば絵文字で特定できるか');
    await send(A_ACTOR, {
      id: `${A_ACTOR}/activities/react-3`,
      type: 'EmojiReact',
      object: postId,
      content: '🎉',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    }, aKeys);
    await send(A_ACTOR, {
      id: `${A_ACTOR}/activities/undo-4`,
      type: 'Undo',
      object: { id: `${A_ACTOR}/activities/unknown-1`, type: 'EmojiReact', object: postId, content: '🎉', actor: A_ACTOR },
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    }, aKeys);
    check('A の残り（👍 だけ）', (await rowsFor(A_ACTOR)).map((r) => r.reaction).join(','), '👍');

    // ------------------------------------------------------------------
    console.log('\n🔎 [7] object が投稿 URL の文字列（古い Misskey 形）は投稿単位で消すか');
    await send(A_ACTOR, {
      id: `${A_ACTOR}/activities/undo-5`,
      type: 'Undo',
      object: postId,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    }, aKeys);
    check('A のリアクションが消えた', (await rowsFor(A_ACTOR)).length, 0);
    check('B のリアクションは残る', (await rowsFor(B_ACTOR)).length, 1);

    console.log('');
  } catch (err: any) {
    console.error(`\n❌ テスト実行中にエラー: ${err?.message || err}`);
    failures++;
  } finally {
    if (server && server.pid) {
      if (process.platform === 'win32') {
        // Windows では shell:true の殻（cmd）だけを止めても中の node が残り、
        // ポートを握ったまま次の実行が「起動失敗」になる。ツリーごと止める。
        try {
          spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {}
      } else {
        server.kill();
        await sleep(300);
        try { server.kill('SIGKILL'); } catch {}
      }
    }
  }

  console.log('====================================================');
  if (failures === 0) {
    console.log('✅ すべて成功');
  } else {
    console.error(`❌ ${failures} 件失敗`);
  }
  console.log('====================================================');
  process.exit(failures === 0 ? 0 : 1);
}

void run();
