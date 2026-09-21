import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// ============================================================================
// 運用の自動化の検証
//
//   1. /health（未認証は最小限・認証時は詳細）と /api/health
//   2. 管理API: 容量・メンテナンス状況（DB サイズ・件数・方針・自動実行の設定）
//   3. 自動整理（バックアップ＋保持期間削除）を管理APIから実行できる
//   4. 毎日 1 回だけ実行される（実行済みフラグ）
//   5. バックアップの作成と世代管理
//   6. グレースフルシャットダウン（SIGTERM で終了し、WAL が畳まれる）
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_ops.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3711;
const BASE = `http://localhost:${PORT}`;

[TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
  for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});
const backupDir = path.resolve(ROOT_DIR, 'server', 'data', 'backups');
// テストで作るバックアップだけを消す（既存があれば退避せず、テスト用の名前で作られる）
const TEST_BACKUP_PREFIX = path.basename(TEST_DB).replace(/\.sqlite$/, '');

// テストプロセス内で server/src を読み込む場合に備え、必ずテスト用DBを指す
process.env.DB_PATH = path.resolve(ROOT_DIR, 'server', TEST_DB);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** WAL ファイルのパス（テスト用DB） */
const walPathOf = (name: string) => path.resolve(ROOT_DIR, 'server', `${name}-wal`);
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
  if (inUse) throw new Error(`ポート ${port} は使用中です。TEST_PORT=3720 のように空きポートを指定してください。`);
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

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('🧪 運用の自動化 検証テスト');
  console.log(`   server=${PORT}`);
  console.log('====================================================\n');

  const tsxCli = path.resolve(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  let server: ChildProcess | null = null;
  let completed = false;
  const createdBackups: string[] = [];

  try {
    await assertPortFree(PORT);
    // SIGTERM をアプリ本体（1 プロセス）に届けたいので、tsx の CLI ではなく
    // `node --import tsx src/index.ts` の形で直接起動する
    server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Ops Test',
        RATE_LIMIT_DISABLED: 'true',
        AUTO_MAINTENANCE: 'true',
        AUTO_MAINTENANCE_HOUR: '0',
        BACKUPS_KEEP: '2',
      },
      stdio: 'pipe',
    });
    const serverLog: string[] = [];
    server.stdout?.on('data', (d) => serverLog.push(d.toString()));
    server.stderr?.on('data', (d) => serverLog.push(d.toString()));
    if (!(await waitForServer(`${BASE}/health`))) throw new Error('サーバー起動失敗');
    console.log('✅ サーバー起動完了\n');

    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'admin', name: 'admin', agreedToRules: true }),
    });
    const admin = await reg.json();
    const token = admin.sessionToken as string;
    const auth = { Authorization: `Bearer ${token}` };

    // ------------------------------------------------------------------
    console.log('❤️ [1] ヘルスチェック');
    const health = await fetch(`${BASE}/health`);
    const healthBody = await health.json();
    check('/health は 200', health.status, 200);
    check('status は ok', healthBody.status, 'ok');
    check('DB 応答が ok', healthBody.db.ok, true);
    check('未認証では詳細を返さない（sizeBytes なし）', healthBody.db.sizeBytes, undefined);
    const healthApi = await fetch(`${BASE}/api/health`);
    check('/api/health も 200', healthApi.status, 200);
    const healthAuth = await fetch(`${BASE}/health`, { headers: auth });
    const healthAuthBody = await healthAuth.json();
    check('認証ありは DB サイズを返す', typeof healthAuthBody.db.sizeBytes === 'number', true);
    check('認証ありは配送キューの状況を返す', typeof healthAuthBody.deliveryQueue, 'object');
    check('認証ありは自動整理の設定を返す', typeof healthAuthBody.automation, 'object');

    // ------------------------------------------------------------------
    console.log('\n📊 [2] 管理API: 容量・メンテナンス状況');
    const statsRes = await fetch(`${BASE}/api/admin/maintenance`, { headers: auth });
    const stats = await statsRes.json();
    check('取得できる', statsRes.status, 200);
    check('DB サイズが数値', typeof stats.db.sizeBytes === 'number', true);
    check('方針が含まれる', typeof stats.policy.ftsIndexScope, 'string');
    check('自動整理が有効', stats.automation.enabled, true);
    check('実行時刻が反映される（0 時）', stats.automation.hour, 0);
    check('保持期間が含まれる', typeof stats.policy.retentionDays, 'number');
    check('バックアップ世代数を数えている', typeof stats.backups.count, 'number');
    const anon = await fetch(`${BASE}/api/admin/maintenance`);
    check('未認証は拒否される', anon.status === 401 || anon.status === 403, true);

    // ------------------------------------------------------------------
    console.log('\n🛠️ [3] リモート投稿を用意して自動整理を実行');
    const keys = generateTestKeyPair();
    const REMOTE_ACTOR = 'https://remote.test/users/eve';
    const db = new DatabaseSync(path.resolve(ROOT_DIR, 'server', TEST_DB));
    db.exec('PRAGMA busy_timeout = 10000');
    db.prepare(
      `INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
       VALUES (?, 'eve', 'remote.test', 'Eve', '', '', '', ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET public_key_pem = excluded.public_key_pem`,
    ).run(REMOTE_ACTOR, `${REMOTE_ACTOR}/inbox`, `${REMOTE_ACTOR}#main-key`, keys.publicKeyPem, new Date().toISOString());

    const deliverOldNote = async (id: string, daysAgo: number) => {
      const published = new Date(Date.now() - daysAgo * 86400_000).toISOString();
      const activity = {
        '@context': ['https://www.w3.org/ns/activitystreams'],
        id: `${REMOTE_ACTOR}/activities/${encodeURIComponent(id)}`,
        type: 'Create',
        actor: REMOTE_ACTOR,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        object: {
          id,
          type: 'Note',
          attributedTo: REMOTE_ACTOR,
          content: '古いリモート投稿',
          published,
          to: ['https://www.w3.org/ns/activitystreams#Public'],
        },
      };
      const body = JSON.stringify(activity);
      await fetch(`${BASE}/inbox`, {
        method: 'POST',
        headers: signInboxRequest(body, `${REMOTE_ACTOR}#main-key`, keys.privateKeyPem),
        body,
      });
    };
    for (let i = 0; i < 3; i++) await deliverOldNote(`${REMOTE_ACTOR}/notes/old${i}`, 60);
    await deliverOldNote(`${REMOTE_ACTOR}/notes/fresh`, 0);
    await sleep(600);

    const before = await (await fetch(`${BASE}/api/admin/maintenance`, { headers: auth })).json();
    check('削除対象（保持期間超え）が検出される', before.posts.prunableRemote >= 3, true);

    const runRes = await fetch(`${BASE}/api/admin/maintenance/run`, { method: 'POST', headers: auth });
    const runBody = await runRes.json();
    check('自動整理を実行できる', runRes.status, 200);
    check('古いリモート投稿が削除された', runBody.result.removedPosts >= 3, true);
    check('バックアップが作られた', Boolean(runBody.result.backup?.path), true);
    check('実行後の統計が返る', typeof runBody.stats.posts.remote, 'number');
    if (runBody.result.backup?.path) createdBackups.push(runBody.result.backup.path);

    const remoteAfter = Number((db.prepare('SELECT COUNT(*) AS c FROM posts WHERE is_local = 0').get() as any).c);
    check('新しいリモート投稿は残っている', remoteAfter, 1);
    // 以降の検証はサーバー経由なので、テスト側の接続は閉じる
    // （開いたままだとサーバー終了時の WAL チェックポイントが完了できない）
    db.close();

    console.log('\n🗓️ [4] 自動実行は 1 日 1 回だけ');
    const { maybeRunScheduledMaintenance, getLastAutoMaintenanceAt } = await import('../server/src/maintenanceService.js');
    // スケジューラが呼ぶのと同じ関数を明示的に 2 回呼んで、1 日 1 回の判定を確認する
    const firstRun = await maybeRunScheduledMaintenance(new Date());
    check('予定時刻を過ぎていれば実行する', firstRun, true);
    check('実行済みフラグが記録された', Boolean(getLastAutoMaintenanceAt()), true);
    const secondRun = await maybeRunScheduledMaintenance(new Date());
    check('同じ日には 2 回目を実行しない', secondRun, false);

    // ------------------------------------------------------------------
    console.log('\n💾 [5] バックアップの世代管理');
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${BASE}/api/admin/maintenance/run`, { method: 'POST', headers: auth });
      const body = await res.json();
      if (body.result?.backup?.path) createdBackups.push(body.result.backup.path);
    }
    const backupFiles = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter((f) => f.startsWith(TEST_BACKUP_PREFIX))
      : [];
    check('バックアップは世代数（2）までに整理される', backupFiles.length <= 2, true);
    check('バックアップファイルが存在する', backupFiles.length >= 1, true);
    const backupSizes = backupFiles.map((f) => fs.statSync(path.join(backupDir, f)).size);
    check('バックアップが空でない', backupSizes.every((s) => s > 0), true);

    // ------------------------------------------------------------------
    console.log('\n🛑 [6] グレースフルシャットダウン');
    // SSE を 1 本つないだ状態で止める（接続が残っていても終了できること）
    const sseController = new AbortController();
    const ssePromise = fetch(`${BASE}/api/streaming?token=${encodeURIComponent(token)}`, { signal: sseController.signal }).catch(() => null);
    await sleep(500);
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 12000);
      server!.on('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
      server!.kill('SIGTERM');
    });
    check('SIGTERM で 12 秒以内に終了する', exited, true);
    sseController.abort();
    await ssePromise;
    server = null;

    // Windows では外部からシグナルを配送できない（TerminateProcess になる）ため、
    // シャットダウン処理を直接呼んで「受付停止 → 接続クローズ → checkpoint → 終了コード0」を検証する。
    // ※ Linux（本番の PM2 / systemd）ではこの処理が SIGTERM / SIGINT で呼ばれる
    const { createGracefulShutdown } = await import('../server/src/shutdown.js');
    const { setServerSetting: writeSetting, getServerSetting } = await import('../server/src/db.js');
    // 書き込みを作ってからチェックポイントさせる
    writeSetting('probe_before_shutdown', new Date().toISOString());
    check('シャットダウン前の書き込みが読める', Boolean(getServerSetting('probe_before_shutdown', '')), true);

    let serverClosed = false;
    let connectionsClosed = false;
    let exitCode: number | null = null;
    const shutdown = createGracefulShutdown({
      server: {
        close: () => { serverClosed = true; },
        closeAllConnections: () => { connectionsClosed = true; },
      },
      exit: (code) => { exitCode = code; },
    });
    shutdown('SIGTERM');
    await sleep(300);

    check('サーバーの受付を止める', serverClosed, true);
    check('開いている接続を閉じる', connectionsClosed, true);
    check('終了コード 0 で終わる', exitCode, 0);

    const walPath = walPathOf(TEST_DB);
    const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    check('WAL が畳まれる（チェックポイント）', walSize, 0);
    const dbCheck = new DatabaseSync(path.resolve(ROOT_DIR, 'server', TEST_DB), { readOnly: true });
    check('DB は整合性を保っている', (dbCheck.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok');
    check('書き込みは失われていない', Boolean((dbCheck.prepare("SELECT value FROM server_settings WHERE key = 'probe_before_shutdown'").get() as any)?.value), true);
    dbCheck.close();

    completed = true;
  } finally {
    console.log('');
    if (!completed) console.error('❌ テストを最後まで実行できませんでした（上のエラーを参照）');
    else if (failures === 0) console.log('🎉 すべての確認に合格しました');
    else console.error(`❌ ${failures} 件の確認に失敗しました`);
    if (server && !server.killed) {
      server.kill('SIGTERM');
      await sleep(1200);
      try { server.kill('SIGKILL'); } catch {}
    }
    // テストで作ったバックアップとDBを片付ける
    for (const file of createdBackups) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
    }
    if (fs.existsSync(backupDir)) {
      for (const f of fs.readdirSync(backupDir)) {
        if (f.startsWith(TEST_BACKUP_PREFIX)) {
          try { fs.unlinkSync(path.join(backupDir, f)); } catch {}
        }
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
