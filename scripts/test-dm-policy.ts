import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// DM（1対1メッセージ）を扱わない方針の検証
//
// Spica は電気通信事業法の観点から DM を実装しない（README「DM を実装しない方針」）。
// 受信側でも 1 対 1 のメッセージを「フォロワー限定投稿」として保存してしまうと、
// 送信者が意図しない相手に見えてしまうため、保存しないことを確認する。
//
//   1. 特定の相手だけが宛先（Public なし・フォロワーコレクションなし）→ 保存しない
//   2. フォロワー限定（フォロワーコレクション宛）→ 従来どおり保存する
//   3. 公開（Public を含む）→ 従来どおり公開で保存する
//   4. Public を cc に含む unlisted → 公開として保存する（誤って捨てない）
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_dm_policy.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3631;
const BASE = `http://localhost:${PORT}`;
const REMOTE_ACTOR = 'https://remote.test/users/eve';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

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
  if (inUse) {
    throw new Error(
      `ポート ${port} では既にサーバーが応答しています。稼働中のインスタンスへ書き込まないよう中断しました。\n` +
      `空きポートを指定して実行してください:  TEST_PORT=3640 npx tsx scripts/test-dm-policy.ts`,
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

function generateTestKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey as unknown as string, privateKeyPem: privateKey as unknown as string };
}

/** 受信側と同じ書式で HTTP Signature を付ける */
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

async function waitForPortFree(port: number, maxRetries = 20): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await assertPortFree(port);
      return;
    } catch {
      await sleep(300);
    }
  }
}

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('🧪 DM（1対1メッセージ）非対応の方針検証テスト');
  console.log(`   server=${PORT}`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;
  let seedDb: { close: () => void } | null = null;
  let completed = false;

  try {
    await assertPortFree(PORT);

    // npx + shell 経由だと kill がシェルに当たり、本体の node が残ってポートを握り続けるため、
    // tsx の CLI を node で直接起動する（後始末で確実に止められるように）
    const tsxCli = path.resolve(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    server = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'DM Policy Test',
        RATE_LIMIT_DISABLED: 'true',
      },
      stdio: 'pipe',
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    if (!(await waitForServer(BASE))) throw new Error('サーバー起動失敗');
    console.log('✅ サーバー起動完了\n');

    // --- ローカルユーザー ---
    const registerRes = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'alice', name: 'Alice', agreedToRules: true }),
    });
    const alice = await registerRes.json();
    if (!alice?.sessionToken) throw new Error(`alice の作成に失敗: ${JSON.stringify(alice)}`);
    const aliceActorUrl = alice.user.actorUrl as string;

    // --- リモートアクターをシード（署名鍵を固定するため直接投入） ---
    const keys = generateTestKeyPair();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.resolve(ROOT_DIR, 'server', TEST_DB));
    seedDb = db;
    for (let i = 0; i < 10; i++) {
      try {
        db.prepare(
          `INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
           VALUES (?, 'eve', 'remote.test', 'Eve', '', '', '', ?, NULL, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET public_key_pem = excluded.public_key_pem`,
        ).run(
          REMOTE_ACTOR,
          `https://remote.test/inbox`,
          `${REMOTE_ACTOR}#main-key`,
          keys.publicKeyPem,
          new Date().toISOString(),
        );
        break;
      } catch (err) {
        if (i === 9) throw err;
        await sleep(200);
      }
    }
    console.log('✅ リモートアクター ' + REMOTE_ACTOR + ' を登録\n');

    // --- 受信させる Create(Note) ---
    const deliver = async (noteId: string, to: string[], cc: string[], content: string) => {
      const activity = {
        '@context': ['https://www.w3.org/ns/activitystreams'],
        id: `${REMOTE_ACTOR}/activities/${encodeURIComponent(noteId)}`,
        type: 'Create',
        actor: REMOTE_ACTOR,
        to,
        cc,
        object: {
          id: noteId,
          type: 'Note',
          attributedTo: REMOTE_ACTOR,
          content,
          published: new Date().toISOString(),
          to,
          cc,
        },
      };
      const body = JSON.stringify(activity);
      const res = await fetch(`${BASE}/inbox`, {
        method: 'POST',
        headers: signInboxRequest(body, `${REMOTE_ACTOR}#main-key`, keys.privateKeyPem),
        body,
      });
      return res.status;
    };

    console.log('📡 [1] DM（特定の相手だけが宛先）は保存しない');
    const dmToLocal = await deliver(`${REMOTE_ACTOR}/notes/dm1`, [aliceActorUrl], [], 'これはローカルユーザー宛てのDMです');
    check('DM 宛の受信は 202（受理するが保存しない）', dmToLocal, 202);
    const dmToRemote = await deliver(`${REMOTE_ACTOR}/notes/dm2`, ['https://remote.test/users/other'], [], 'これはリモートユーザー宛てのDMです');
    check('リモート宛のDMも 202', dmToRemote, 202);

    console.log('\n📡 [2] フォロワー限定（フォロワーコレクション宛）は保存する');
    const followersOnly = await deliver(`${REMOTE_ACTOR}/notes/fo1`, [`${REMOTE_ACTOR}/followers`], [], 'フォロワー限定のノート');
    check('フォロワー限定は受理される', followersOnly >= 200 && followersOnly < 300, true);

    console.log('\n📡 [3] 公開ノートは保存する');
    const publicNote = await deliver(`${REMOTE_ACTOR}/notes/pub1`, [PUBLIC], [], '公開ノート');
    check('公開ノートは受理される', publicNote >= 200 && publicNote < 300, true);

    console.log('\n📡 [4] unlisted（to=フォロワー, cc=Public）は公開として保存する');
    const unlisted = await deliver(`${REMOTE_ACTOR}/notes/un1`, [`${REMOTE_ACTOR}/followers`], [PUBLIC], 'unlisted のノート');
    check('unlisted も受理される', unlisted >= 200 && unlisted < 300, true);

    await sleep(600);

    // --- DB を直接確認 ---
    console.log('\n🗄️  保存結果');
    const row = (id: string): { visibility: string } | undefined =>
      db.prepare('SELECT visibility FROM posts WHERE id = ?').get(id) as { visibility: string } | undefined;
    check('DM1 は保存されていない', row(`${REMOTE_ACTOR}/notes/dm1`), undefined);
    check('DM2 は保存されていない', row(`${REMOTE_ACTOR}/notes/dm2`), undefined);
    check('フォロワー限定は followers として保存', row(`${REMOTE_ACTOR}/notes/fo1`)?.visibility, 'followers');
    check('公開ノートは public として保存', row(`${REMOTE_ACTOR}/notes/pub1`)?.visibility, 'public');
    check('unlisted は public として保存', row(`${REMOTE_ACTOR}/notes/un1`)?.visibility, 'public');

    const total = (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as any).c as number;
    check('保存されたリモート投稿は 3 件のみ', total, 3);
    completed = true;
  } finally {
    console.log('');
    if (!completed) {
      console.error('❌ テストを最後まで実行できませんでした（上のエラーを確認してください）');
    } else if (failures === 0) {
      console.log('🎉 すべての確認に合格しました');
    } else {
      console.error(`❌ ${failures} 件の確認に失敗しました`);
    }
    try { seedDb?.close(); } catch {}
    if (server) {
      server.kill('SIGTERM');
      // 終了を待ってから抜ける（次の実行がポートを掴めるように）
      await waitForPortFree(PORT, 6);
      if (!server.killed) {
        try { server.kill('SIGKILL'); } catch {}
      }
    }
    [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
      for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
        if (fs.existsSync(p)) {
          try { fs.unlinkSync(p); } catch {}
        }
      }
    });
  }
  process.exit(completed && failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('❌ テスト実行エラー:', err);
  process.exit(1);
});
