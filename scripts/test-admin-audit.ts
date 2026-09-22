import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { createAsyncDatabase } from '../server/src/db/asyncDriver.js';

// ============================================================================
// 複数人運用のための3機能の検証
//
//   1. 監査ログ: 管理操作が記録され、一覧 API で読める（拒否された操作は記録しない）
//      ・パスワード等の秘密は残らない
//   2. 権限ベースの管理パネル: 'moderate' ロールで通報・凍結・ブロックはできて、
//      ユーザー一覧や設定変更は 403（/auth/me が permissions を返す）
//   3. 通報の新着通知: 通報すると admin / moderate に type='report' の通知が届く
//      （通報者自身には届かない・種類別設定で切れる）
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_admin_audit.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3701;
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

process.env.DB_PATH = path.resolve(ROOT_DIR, 'server', TEST_DB);

/**
 * seed 用の接続。DB_DRIVER / DATABASE_URL をそのまま使うので、
 * SQLite でも PostgreSQL でも同じ検査が流せる（PostgreSQL のときは
 * 実行前に `npm run db:pg:init -- --dsn "$TEST_DATABASE_URL" --reset` で作り直すこと）。
 */
const seedDb = createAsyncDatabase({
  driver: process.env.DB_DRIVER,
  connectionString: process.env.DATABASE_URL,
  dbPath: path.resolve(ROOT_DIR, 'server', TEST_DB),
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
  if (inUse) throw new Error(`ポート ${port} は使用中です。TEST_PORT=3700 のように空きポートを指定してください。`);
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
  console.log('🧪 監査ログ / 権限 / 通報通知 検証テスト');
  console.log(`   server=${PORT}`);
  console.log('====================================================\n');

  const tsxCli = path.resolve(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  let server: ChildProcess | null = null;

  try {
    await assertPortFree(PORT);
    server = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN: `localhost:${PORT}`,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Audit Test',
        RATE_LIMIT_DISABLED: 'true',
      },
      stdio: 'pipe',
    });
    server.stdout?.on('data', () => {});
    // サーバー側のエラーは診断に必要なので、失敗時に読めるよう残す
    const serverLog: string[] = [];
    server.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString();
      serverLog.push(line);
      if (/error|Error/.test(line)) console.error(`   [server] ${line.trim()}`);
    });
    if (!(await waitForServer(BASE))) throw new Error('サーバー起動失敗');
    console.log('✅ サーバー起動完了\n');

    // ── 準備: 管理者 / モデレーター / 一般ユーザー ──────────────
    const register = async (id: string) => {
      const res = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: id, agreedToRules: true }),
      });
      return res.json();
    };

    const admin = await register('alice');
    const modUser = await register('moder');
    const normal = await register('bob');

    // seed はアプリと同じドライバで行う（PostgreSQL でも同じ手順で検証できるように）
    await seedDb.exec('PRAGMA busy_timeout = 10000');

    // モデレーターのロールを作って付与する（UI と同じ経路: /api/admin/roles → /users/:id/roles）
    const adminAuth = { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.sessionToken}` };

    // ── [2] 権限: ロール付与と permissions の返却 ────────────────
    console.log('🎭 [2] 権限ベースの管理パネル');
    const roleRes = await fetch(`${BASE}/api/admin/roles`, {
      method: 'POST',
      headers: adminAuth,
      body: JSON.stringify({ name: 'モデレーター', color: '#f59e0b', permissions: ['moderate'] }),
    });
    const roleBody = await roleRes.json();
    check('ロールを作成できる', roleRes.status >= 200 && roleRes.status < 300, true);
    const roleId = roleBody.id;

    const assignRes = await fetch(`${BASE}/api/admin/users/${modUser.user.id}/roles`, {
      method: 'POST',
      headers: adminAuth,
      body: JSON.stringify({ roleIds: [roleId] }),
    });
    check('ロールを付与できる', assignRes.status >= 200 && assignRes.status < 300, true);

    const modMe = await (await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${modUser.sessionToken}` } })).json();
    check('moderate 権限が /auth/me で返る', Array.isArray(modMe.permissions) && modMe.permissions.includes('moderate'), true);
    check('admin は含まれない', modMe.permissions.includes('admin'), false);

    const adminMe = await (await fetch(`${BASE}/api/auth/me`, { headers: adminAuth })).json();
    check('管理者は admin 権限を持つ', adminMe.permissions.includes('admin'), true);

    const modAuth = { 'Content-Type': 'application/json', Authorization: `Bearer ${modUser.sessionToken}` };
    const normalAuth = { 'Content-Type': 'application/json', Authorization: `Bearer ${normal.sessionToken}` };

    const modReports = await fetch(`${BASE}/api/admin/reports`, { headers: modAuth });
    check('モデレーターは通報一覧を読める', modReports.status, 200);
    const modBlocks = await fetch(`${BASE}/api/admin/blocks`, { headers: modAuth });
    check('モデレーターはブロック一覧を読める', modBlocks.status, 200);
    const modUsers = await fetch(`${BASE}/api/admin/users`, { headers: modAuth });
    check('モデレーターはユーザー一覧を読めない（403）', modUsers.status, 403);
    const modSettings = await fetch(`${BASE}/api/admin/server-settings`, { headers: modAuth });
    check('モデレーターはサーバー設定を触れない（403）', modSettings.status, 403);
    const modAudit = await fetch(`${BASE}/api/admin/audit`, { headers: modAuth });
    check('モデレーターは監査ログを読めない（403）', modAudit.status, 403);

    // 凍結はモデレーターでも可能
    const freeze = await fetch(`${BASE}/api/admin/users/bob/freeze`, {
      method: 'POST',
      headers: modAuth,
      body: JSON.stringify({ frozen: true, reason: 'テスト' }),
    });
    check('モデレーターはユーザーを凍結できる', freeze.status >= 200 && freeze.status < 300, true);

    // ── [3] 通報の新着通知 ────────────────────────────────────
    console.log('\n🚩 [3] 通報の新着を運営に通知');
    // bob は凍結中なので解除してから通報させる
    await fetch(`${BASE}/api/admin/users/bob/freeze`, {
      method: 'POST',
      headers: adminAuth,
      body: JSON.stringify({ frozen: false }),
    });

    const keys = generateTestKeyPair();
    await seedDb.prepare(
      `INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
       VALUES (?, 'eve', 'remote.test', 'eve', '', '', '', ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET public_key_pem = excluded.public_key_pem`,
    ).run(REMOTE_ACTOR, `${REMOTE_ACTOR}/inbox`, `${REMOTE_ACTOR}#main-key`, keys.publicKeyPem, new Date().toISOString());

    // リモートから投稿を届けて、それを bob が通報する
    const noteId = `${REMOTE_ACTOR}/notes/spam1`;
    const activity = {
      '@context': ['https://www.w3.org/ns/activitystreams'],
      id: `${REMOTE_ACTOR}/activities/spam1`,
      type: 'Create',
      actor: REMOTE_ACTOR,
      to: [PUBLIC],
      object: { id: noteId, type: 'Note', attributedTo: REMOTE_ACTOR, content: 'スパムな投稿です', published: new Date().toISOString(), to: [PUBLIC] },
    };
    const body = JSON.stringify(activity);
    await fetch(`${BASE}/inbox`, { method: 'POST', headers: signInboxRequest(body, `${REMOTE_ACTOR}#main-key`, keys.privateKeyPem), body });
    await sleep(600);

    const reportRes = await fetch(`${BASE}/api/reports`, {
      method: 'POST',
      headers: normalAuth,
      body: JSON.stringify({ targetPostId: noteId, category: 'spam', comment: '宣伝目的の連投です' }),
    });
    if (!(reportRes.status >= 200 && reportRes.status < 300)) {
      console.log(`     ↳ 通報の応答: ${reportRes.status} ${await reportRes.text().catch(() => '')}`.trim());
      console.log(`     ↳ サーバーログ末尾: ${serverLog.join('').trim().split('\n').slice(-6).join(' | ')}`);
    }
    check('通報できる', reportRes.status >= 200 && reportRes.status < 300, true);
    await sleep(600);

    const adminNotifs = await (await fetch(`${BASE}/api/notifications`, { headers: adminAuth })).json();
    const adminReportNotif = (Array.isArray(adminNotifs) ? adminNotifs : []).find((n: any) => n.type === 'report');
    check('管理者に通報通知が届く', Boolean(adminReportNotif), true);
    check('通知の内容に種別が入る', String(adminReportNotif?.content || '').includes('スパム'), true);
    check('実行者は通報者', adminReportNotif?.actor_id, normal.user.id);

    const modNotifs = await (await fetch(`${BASE}/api/notifications`, { headers: modAuth })).json();
    check('モデレーターにも通報通知が届く', (Array.isArray(modNotifs) ? modNotifs : []).some((n: any) => n.type === 'report'), true);

    const reporterNotifs = await (await fetch(`${BASE}/api/notifications`, { headers: normalAuth })).json();
    check('通報者自身には通知しない', (Array.isArray(reporterNotifs) ? reporterNotifs : []).some((n: any) => n.type === 'report'), false);

    // 種類別設定で切れる
    await fetch(`${BASE}/api/notifications/settings`, {
      method: 'POST',
      headers: modAuth,
      body: JSON.stringify({ prefs: { report: false } }),
    });
    const modList = await (await fetch(`${BASE}/api/notifications`, { headers: modAuth })).json();
    check('設定で切った通報通知は一覧から消える', (Array.isArray(modList) ? modList : []).some((n: any) => n.type === 'report'), false);
    const notifSettings = await (await fetch(`${BASE}/api/notifications/settings`, { headers: modAuth })).json();
    check('通知設定に通報の種類が出る', (notifSettings.types || []).some((t: any) => t.type === 'report'), true);

    // ── [1] 監査ログ ──────────────────────────────────────────
    console.log('\n🧾 [1] 管理操作の監査ログ');
    const auditRes = await fetch(`${BASE}/api/admin/audit?limit=50`, { headers: adminAuth });
    const audit = await auditRes.json();
    check('監査ログを取得できる', auditRes.status, 200);
    const actions = Array.isArray(audit.actions) ? audit.actions : [];
    check('操作が記録されている', actions.length > 0, true);

    const actionsList = actions.map((a: any) => a.action);
    check('ロール作成が記録される', actionsList.includes('create_role'), true);
    check('ロール付与が記録される', actionsList.includes('assign_roles'), true);
    check('凍結が記録される', actionsList.includes('freeze_user'), true);

    const freezeRows = actions.filter((a: any) => a.action === 'freeze_user');
    check('実行者が記録される', freezeRows.some((r: any) => r.actor_id === 'moder'), true);
    check('対象ユーザーが記録される', freezeRows.some((r: any) => r.target_id === 'bob'), true);
    check('表示用ラベルが付く', freezeRows.every((r: any) => typeof r.label === 'string' && r.label.length > 0), true);

    // 秘密が残らないこと（メール設定にパスワードを入れて確認）
    await fetch(`${BASE}/api/admin/mail-settings`, {
      method: 'POST',
      headers: adminAuth,
      body: JSON.stringify({ host: 'smtp.example.com', port: 587, user: 'spica', pass: 'SuperSecretPassword123', from: 'a@example.com', enabled: true }),
    });
    await sleep(300);
    const audit2 = await (await fetch(`${BASE}/api/admin/audit?limit=50`, { headers: adminAuth })).json();
    const mailRow = (audit2.actions || []).find((a: any) => a.action === 'mail_settings');
    check('メール設定の変更が記録される', Boolean(mailRow), true);
    check('パスワードは記録されない', String(mailRow?.detail_json || '').includes('SuperSecretPassword123'), false);
    check('伏せ字になる', String(mailRow?.detail_json || '').includes('***'), true);

    // 失敗した操作は記録しない（モデレーターが触れない設定変更 = 403）
    const before403 = (await (await fetch(`${BASE}/api/admin/audit?limit=100`, { headers: adminAuth })).json()).actions.length;
    await fetch(`${BASE}/api/admin/server-settings`, {
      method: 'POST',
      headers: modAuth,
      body: JSON.stringify({ name: '乗っ取り' }),
    });
    await sleep(300);
    const after403 = (await (await fetch(`${BASE}/api/admin/audit?limit=100`, { headers: adminAuth })).json()).actions.length;
    check('拒否された操作は記録しない', after403, before403);

    // フィルタとページング
    const filtered = await (await fetch(`${BASE}/api/admin/audit?action=freeze_user`, { headers: adminAuth })).json();
    check('操作でフィルタできる', (filtered.actions || []).every((a: any) => a.action === 'freeze_user'), true);
    check('種類の一覧が返る', Array.isArray(filtered.kinds) && filtered.kinds.length > 0, true);
    const paged = await (await fetch(`${BASE}/api/admin/audit?limit=2`, { headers: adminAuth })).json();
    check('件数制限が効く', (paged.actions || []).length <= 2, true);
    check('続きがある場合カーソルが返る', typeof paged.nextCursor === 'string' || paged.nextCursor === null, true);

    // 監査ログの削除
    const prune = await fetch(`${BASE}/api/admin/audit/prune`, {
      method: 'POST',
      headers: adminAuth,
      body: JSON.stringify({ days: 3650 }),
    });
    const pruneBody = await prune.json();
    check('古い監査ログを削除できる', prune.status, 200);
    check('削除件数が返る', typeof pruneBody.removed === 'number', true);

    // 一般ユーザーは監査ログに触れない
    const normalAudit = await fetch(`${BASE}/api/admin/audit`, { headers: normalAuth });
    check('一般ユーザーは監査ログを読めない（403）', normalAudit.status, 403);
  } finally {
    try { server?.kill('SIGTERM'); } catch {}
    await sleep(700);
    try { server?.kill('SIGKILL'); } catch {}
    await seedDb.close().catch(() => {});
  }

  console.log('');
  if (failures === 0) {
    console.log('✅ すべてのテストに成功しました');
  } else {
    console.log(`❌ ${failures} 件のテストに失敗しました`);
  }
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('テスト実行中にエラー:', err);
  process.exit(1);
});
