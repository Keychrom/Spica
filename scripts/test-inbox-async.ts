/**
 * 🧪 受信の非同期処理（`INBOX_ASYNC=true`）の検証
 *
 * 受信の中身（DB と FTS への書き込み・アンテナの照合・通知・配信の積み込み）を
 * キューに積んでワーカーに任せるモードの検査です。確かめるのは 4 つ:
 *
 *   1. **受理の意味** — 署名検証と形式の検査だけリクエスト内で済ませ、**202 を返す**。
 *      中身は後で処理され、投稿は（少し遅れて）タイムラインに出る。
 *   2. **順序** — 同じアクターの Create → Delete は入れ替わらない（Delete が勝つ）。
 *      `jobs.group_key` の FIFO が効いていること。
 *   3. **墓標** — Delete の後に同じ投稿が再送されてきても復活しない。
 *   4. **署名は前段** — 署名が通らないものは 401 で、キューにも積まれない。
 *
 * さらに PostgreSQL で回したときは、**別プロセス（web と worker）**に分けたときも
 * キューを介して処理されることを確かめます（SQLite は 1 ファイルを複数プロセスで
 * 共有しない方針なのでスキップします）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';

const ROOT_DIR = process.cwd();
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3821;
const BASE = `http://localhost:${PORT}`;
const TEST_DB = 'data_test_inbox_async.sqlite';
const USE_PG =
  (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'postgres' && Boolean(process.env.TEST_DATABASE_URL);

const ACTOR = 'https://remote-async.test/users/alice';
const ACTOR_INBOX = 'https://remote-async.test/inbox';

process.env.PORT = String(PORT);
process.env.DOMAIN = `localhost:${PORT}`;
process.env.PROTOCOL = 'http';
if (!USE_PG) process.env.DB_PATH = path.resolve(ROOT_DIR, 'server', TEST_DB);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const openDb = (): ReturnType<typeof createAsyncDatabase> =>
  USE_PG
    ? createAsyncDatabase({ driver: 'postgres', connectionString: process.env.TEST_DATABASE_URL as string })
    : createAsyncDatabase({ driver: 'sqlite', dbPath: path.resolve(ROOT_DIR, 'server', TEST_DB) });

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✅' : '❌'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期待値 ${JSON.stringify(expected)})`}`);
  if (ok) passed++;
  else failed++;
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(150);
  }
  return predicate();
}

// --- 署名のヘルパー（仕様どおりに署名する。サーバ実装には依存しない）---

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

async function postInbox(body: object, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE}/inbox`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

const procs: ChildProcess[] = [];
function spawnNode(extraEnv: Record<string, string>): ChildProcess {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.resolve(ROOT_DIR, 'server'),
    env: {
      ...(process.env as Record<string, string>),
      PORT: String(PORT),
      BIND_HOST: '127.0.0.1',
      AUTO_MAINTENANCE: 'false',
      AUTO_BACKUP: 'false',
      RATE_LIMIT_DISABLED: 'true',
      INBOX_ASYNC: 'true',
      INBOX_SIGNATURE_MODE: 'strict',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(proc);
  proc.stdout?.on('data', () => {});
  proc.stderr?.on('data', () => {});
  return proc;
}

async function waitForHttp(port = PORT, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.status === 200 || res.status === 503) return;
    } catch {
      // まだ起動していない
    }
    await sleep(300);
  }
  throw new Error(`ノードが起動しませんでした (port ${port})`);
}

/** アクターを鍵つきで先に登録しておく（鍵解決のための外向き fetch を発生させない） */
async function seedActor(keyId: string, publicKeyPem: string): Promise<void> {
  const db = openDb();
  const now = new Date().toISOString();
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await db
          .prepare(
            `INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
             VALUES (?, ?, ?, ?, '', '', '', ?, NULL, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET public_key_pem = excluded.public_key_pem`,
          )
          .run(ACTOR, 'alice', 'remote-async.test', 'Async Alice', ACTOR_INBOX, keyId, publicKeyPem, now);
        return;
      } catch (err) {
        if (attempt === 9) throw err;
        await sleep(200);
      }
    }
  } finally {
    await db.close().catch(() => {});
  }
}

async function postExistsInDb(postId: string): Promise<boolean> {
  const db = openDb();
  try {
    const row = await db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
    return Boolean(row);
  } finally {
    await db.close().catch(() => {});
  }
}

async function tombstoneExists(postId: string): Promise<boolean> {
  const db = openDb();
  try {
    const row = await db.prepare('SELECT id FROM deleted_remote_posts WHERE id = ?').get(postId);
    return Boolean(row);
  } finally {
    await db.close().catch(() => {});
  }
}

async function queueStats(): Promise<{ pending: number; running: number; failed: number }> {
  const db = openDb();
  try {
    const one = async (status: string): Promise<number> =>
      Number(
        (
          (await db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE kind = 'inbox_activity' AND status = ?").get(status)) as {
            c: number;
          }
        ).c,
      );
    return { pending: await one('pending'), running: await one('running'), failed: await one('failed') };
  } finally {
    await db.close().catch(() => {});
  }
}

console.log('🧪 === 🧰 受信の非同期処理（INBOX_ASYNC） ===');
console.log(`   port=${PORT} / DB: ${USE_PG ? 'PostgreSQL' : 'SQLite'}\n`);

const keys = generateTestKeyPair();
const keyId = `${ACTOR}#main-key`;
let node: ChildProcess | null = null;

try {
  // ── 1. 受理してから処理する（202 → 後で出る）────────────────────
  console.log('── 1. 202 で受理し、中身は後で処理される ──────────');
  const db = openDb();
  await db.exec('SELECT 1').catch(() => {});
  await db.close().catch(() => {});
  node = spawnNode({});
  await waitForHttp();
  await seedActor(keyId, keys.publicKeyPem);

  const noteId = `https://remote-async.test/notes/${Date.now()}`;
  const createBody = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${noteId}#create`,
    type: 'Create',
    actor: ACTOR,
    object: {
      id: noteId,
      type: 'Note',
      attributedTo: ACTOR,
      content: '非同期で処理される投稿',
      published: new Date().toISOString(),
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    },
  };
  const createRes = await postInbox(createBody, signInboxRequest(JSON.stringify(createBody), keyId, keys.privateKeyPem));
  check('Create は 202（受理）で返る', createRes.status, 202);
  const queued = await queueStats();
  check('キューに積まれている（まだ処理していない）', queued.pending + queued.running >= 1, true);

  const appeared = await waitUntil(() => postExistsInDb(noteId));
  check('しばらくすると投稿が取り込まれる', appeared, true);

  // ── 2. 同じアクターの Create → Delete は入れ替わらない ──────────
  console.log('\n── 2. 同じアクターの順序（Create → Delete）──────────');
  const orderedNoteId = `https://remote-async.test/notes/ordered-${Date.now()}`;
  const orderedCreate = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${orderedNoteId}#create`,
    type: 'Create',
    actor: ACTOR,
    object: {
      id: orderedNoteId,
      type: 'Note',
      attributedTo: ACTOR,
      content: 'すぐ消される投稿',
      published: new Date().toISOString(),
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    },
  };
  const orderedDelete = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${orderedNoteId}#delete`,
    type: 'Delete',
    actor: ACTOR,
    object: { id: orderedNoteId, type: 'Note' },
  };
  // 2 件を続けて流す（ワーカーの間隔より短くして、両方が待機中になるようにする）
  const orderedCreateRes = await postInbox(
    orderedCreate,
    signInboxRequest(JSON.stringify(orderedCreate), keyId, keys.privateKeyPem),
  );
  const orderedDeleteRes = await postInbox(
    orderedDelete,
    signInboxRequest(JSON.stringify(orderedDelete), keyId, keys.privateKeyPem),
  );
  check('Create は 202', orderedCreateRes.status, 202);
  check('Delete も 202', orderedDeleteRes.status, 202);

  const drained = await waitUntil(async () => (await queueStats()).pending === 0, 20000);
  check('キューが捌ける', drained, true);
  check('Delete が勝つ（投稿は残らない）', await postExistsInDb(orderedNoteId), false);
  check('墓標が残っている', await tombstoneExists(orderedNoteId), true);

  // ── 3. 墓標: 消した投稿が再送されても復活しない ─────────────────
  console.log('\n── 3. 墓標（Delete の後に再送されても復活しない）──────────');
  const resend = {
    ...orderedCreate,
    id: `${orderedNoteId}#create-resend`,
    object: { ...orderedCreate.object },
  };
  const resendRes = await postInbox(resend, signInboxRequest(JSON.stringify(resend), keyId, keys.privateKeyPem));
  check('再送も 202 で受理される', resendRes.status, 202);
  await waitUntil(async () => (await queueStats()).pending === 0, 20000);
  await sleep(300);
  check('投稿は復活しない', await postExistsInDb(orderedNoteId), false);

  // ── 4. 署名は前段で弾く（キューに積まない）──────────────────────
  console.log('\n── 4. 署名が通らないものは受理しない ──────────');
  const unsigned = await postInbox(createBody, { 'Content-Type': 'application/activity+json' });
  check('署名なしは 401', unsigned.status, 401);

  const attackerKeys = generateTestKeyPair();
  // (a) 鍵の持ち主が違う（署名鍵は攻撃者・Activity の actor は本物）→ なりすましとして 401
  const impersonating = await postInbox(
    createBody,
    signInboxRequest(JSON.stringify(createBody), 'https://attacker-async.test/users/eve#main-key', attackerKeys.privateKeyPem),
  );
  check('鍵の持ち主が違うものは 401', impersonating.status, 401);

  // (b) keyId は本物のまま、署名だけ別の鍵 → 検証に失敗して 401
  //     ※ 攻撃者の鍵を **本物の actor の行に** 入れてはいけない（以降の検査が全部 401 になる）
  const wrongSignature = await postInbox(
    createBody,
    signInboxRequest(JSON.stringify(createBody), keyId, attackerKeys.privateKeyPem),
  );
  check('別の鍵で署名したものは 401', wrongSignature.status, 401);

  const afterRejects = await queueStats();
  check('弾いたものはキューに積まれていない', afterRejects.pending, 0);
  check('失敗としても残っていない', afterRejects.failed, 0);

  // ── 5. 自分のローカルアクターを名乗る Activity は積まない ────────
  console.log('\n── 5. ローカルアクターの折り返しは静かに落とす ──────────');
  // 生存しているローカル利用者を作る（`isLocalActorUrl` は実在の利用者だけを local と見る）
  const register = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'async-user', name: 'Async User', agreedToRules: true }),
  });
  check('ローカル利用者を作れる', register.status, 201);
  const localEcho = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `https://example.test/activities/echo-${Date.now()}`,
    type: 'Create',
    actor: `${BASE}/users/async-user`,
    object: {
      id: `${BASE}/users/async-user/posts/echo-1`,
      type: 'Note',
      attributedTo: `${BASE}/users/async-user`,
      content: '折り返し',
      published: new Date().toISOString(),
    },
  };
  const localEchoRes = await postInbox(localEcho, signInboxRequest(JSON.stringify(localEcho), keyId, keys.privateKeyPem));
  check('ローカルアクターを名乗る Create は 202（無視）', localEchoRes.status, 202);
  await sleep(600);
  check('キューには積まれない', (await queueStats()).pending, 0);

  // ── 6. /health にキューの滞留が出る ────────────────────────────
  console.log('\n── 6. 運用から見える ──────────');
  const health = (await (await fetch(`${BASE}/health`)).json()) as any;
  check('/health に inboxQueue が出る', typeof health?.inboxQueue?.pending, 'number');
  check('処理し終えたら滞留は 0', health?.inboxQueue?.pending, 0);

  // ── 7. 別プロセスの worker が処理する（PostgreSQL のみ）─────────
  console.log('\n── 7. プロセスを分けたとき（PostgreSQL のみ）──────────');
  if (!USE_PG) {
    console.log('  ⏭️  web と worker を分けた検査: スキップ（SQLite は 1 ファイルを複数プロセスで共有しない方針）');
  } else {
    // web 側は既に起動している。worker（ポートを開かない）を別プロセスで立てる
    const worker = spawnNode({ PROCESS_ROLE: 'worker' });
    await sleep(3000);
    const crossNoteId = `https://remote-async.test/notes/cross-${Date.now()}`;
    const crossBody = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${crossNoteId}#create`,
      type: 'Create',
      actor: ACTOR,
      object: {
        id: crossNoteId,
        type: 'Note',
        attributedTo: ACTOR,
        content: '別プロセスの worker が処理する投稿',
        published: new Date().toISOString(),
        to: ['https://www.w3.org/ns/activitystreams#Public'],
      },
    };
    const crossRes = await postInbox(crossBody, signInboxRequest(JSON.stringify(crossBody), keyId, keys.privateKeyPem));
    check('web は 202 を返す', crossRes.status, 202);
    check('別プロセスの worker が取り込む', await waitUntil(() => postExistsInDb(crossNoteId), 20000), true);
    worker.kill();
  }
} catch (err: any) {
  console.error('\n❌ 検査中にエラー:', err?.message || err);
  failed++;
} finally {
  for (const proc of procs) {
    if (proc.exitCode === null) {
      proc.kill();
      const deadline = Date.now() + 8000;
      while (proc.exitCode === null && Date.now() < deadline) await sleep(100);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
  }
  if (!USE_PG) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(path.resolve(ROOT_DIR, 'server', `${TEST_DB}${suffix}`), { force: true });
      } catch {
        // 消せなくても続行
      }
    }
  }
}

console.log('\n====================================================');
console.log(`  成功 ${passed} / 失敗 ${failed}`);
if (failed > 0) {
  console.log('❌ 受信の非同期処理: 失敗がありました');
  process.exit(1);
}
console.log('🎊 受信の非同期処理: すべて成功');
process.exit(0);
