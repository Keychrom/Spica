import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================================
// 下書き・予約投稿の API 検査
//
//   [1] 下書き: 公開範囲・添付・アンケート・返信先・引用元が往復するか
//   [2] 下書き: 同じ id で更新できるか・削除できるか
//   [3] 予約投稿: 全項目が往復するか・本文なし（アンケートのみ）を許すか
//   [4] 予約投稿: 入力の検証（過去の日時・空の投稿）
//
// クライアント（Composer）の keepDraft / reserve はこの形を送る。
// ポートは TEST_PORT で変更可能（既定 3652）。
// ============================================================================

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_drafts.sqlite';
const PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 3652;
const BASE = `http://localhost:${PORT}`;
const DOMAIN = `localhost:${PORT}`;

[TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
  for (const p of [path.resolve(ROOT_DIR, f), path.resolve(ROOT_DIR, 'server', f)]) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
let checks = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
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
      `空きポートを指定して実行してください:  TEST_PORT=3652 npx tsx scripts/test-drafts.ts`,
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

const ATTACHMENTS = [
  { url: '/uploads/alice/a.png', mediaType: 'image/png', description: 'ひとつめ', width: 800, height: 600 },
  { url: '/uploads/alice/b.png', mediaType: 'image/png', thumbnailUrl: '/uploads/alice/b-thumb.jpg' },
];
const POLL_DRAFT = { choices: ['はい', 'いいえ'], multiple: true, expiresIn: 3600 };
const POLL_API = { choices: ['はい', 'いいえ'], multiple: true, expires_in: 3600 };
const REPLY_TO = 'https://remote.test/users/eve/posts/1001';
const QUOTE_OF = 'https://remote.test/users/eve/posts/1002';

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('🧪 下書き・予約投稿の API 検査');
  console.log(`   server=${PORT}`);
  console.log('====================================================\n');

  let server: ChildProcess | null = null;
  let completed = false;

  try {
    await assertPortFree(PORT);
    const tsxCli = path.resolve(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    server = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DOMAIN,
        PROTOCOL: 'http',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'Drafts Test',
        RATE_LIMIT_DISABLED: 'true',
      },
      stdio: 'pipe',
    });
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    if (!(await waitForServer(BASE))) throw new Error('サーバー起動失敗');

    const api = async (method: string, endpoint: string, token?: string, body?: unknown) => {
      const res = await fetch(`${BASE}${endpoint}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let data: any = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { status: res.status, data };
    };

    const reg = await api('POST', '/api/auth/register', undefined, { id: 'alice', name: 'Alice', agreedToRules: true });
    const token = String(reg.data?.sessionToken || '');
    if (!token) throw new Error(`alice を作れませんでした: ${JSON.stringify(reg.data)}`);

    // ======================================================================
    console.log('\n📝 [1] 下書き: 全項目の往復');
    const created = await api('POST', '/api/drafts', token, {
      content: '下書きの本文',
      cw: 'ネタバレ注意',
      visibility: 'followers',
      attachments: ATTACHMENTS,
      poll: POLL_DRAFT,
      in_reply_to: REPLY_TO,
      quote_id: QUOTE_OF,
    });
    check('下書きを作れる', created.status, 201);
    check('公開範囲が保存される', created.data?.visibility, 'followers');
    check('添付が保存される', created.data?.media_attachments?.length, 2);
    check('アンケートが保存される', created.data?.poll?.choices?.length, 2);
    check('アンケートの期限', created.data?.poll?.expiresIn, 3600);
    check('返信先が保存される', created.data?.in_reply_to, REPLY_TO);
    check('引用元が保存される', created.data?.quote_id, QUOTE_OF);

    const list = await api('GET', '/api/drafts', token);
    check('一覧に 1 件出る', list.data?.length, 1);
    const row = list.data?.[0] || {};
    check('一覧でも公開範囲が戻る', row.visibility, 'followers');
    check('一覧でも添付が戻る（JSON が配列に）', Array.isArray(row.media_attachments) && row.media_attachments.length, 2);
    check('一覧でもアンケートが戻る（JSON がオブジェクトに）', row.poll?.choices?.length, 2);
    check('一覧でも返信先が戻る', row.in_reply_to, REPLY_TO);
    check('一覧でも引用元が戻る', row.quote_id, QUOTE_OF);
    check('未認証では読めない', (await api('GET', '/api/drafts')).status, 401);

    // ======================================================================
    console.log('\n✏️ [2] 下書き: 更新と削除');
    const updated = await api('POST', '/api/drafts', token, {
      id: created.data.id,
      content: '書き直した本文',
      cw: '',
      visibility: 'public',
      attachments: [],
      poll: null,
      in_reply_to: '',
      quote_id: '',
    });
    check('同じ id で更新できる', updated.status, 200);
    check('本文が入れ替わる', updated.data?.content, '書き直した本文');
    check('添付が消える', updated.data?.media_attachments?.length, 0);
    check('アンケートが消える', updated.data?.poll, null);
    const afterUpdate = await api('GET', '/api/drafts', token);
    check('更新後も 1 件のまま', afterUpdate.data?.length, 1);
    check('更新が一覧に反映される', afterUpdate.data?.[0]?.content, '書き直した本文');
    check('削除できる', (await api('DELETE', `/api/drafts/${encodeURIComponent(created.data.id)}`, token)).status, 200);
    check('一覧から消える', (await api('GET', '/api/drafts', token)).data?.length, 0);

    // ======================================================================
    console.log('\n⏰ [3] 予約投稿: 全項目の往復');
    const when = new Date(Date.now() + 3600_000).toISOString();
    const sched = await api('POST', '/api/scheduled-posts', token, {
      content: '予約の本文',
      cw: 'CW',
      visibility: 'followers',
      attachments: ATTACHMENTS,
      poll: POLL_API,
      in_reply_to: REPLY_TO,
      quote_id: QUOTE_OF,
      scheduled_at: when,
    });
    check('予約できる', sched.status, 201);
    check('公開範囲が保存される', sched.data?.visibility, 'followers');
    check('添付が保存される', sched.data?.media_attachments?.length, 2);
    check('アンケートが保存される', sched.data?.poll?.choices?.length, 2);
    check('アンケートの期限', sched.data?.poll?.expires_in, 3600);
    check('返信先が保存される', sched.data?.in_reply_to, REPLY_TO);
    check('引用元が保存される', sched.data?.quote_id, QUOTE_OF);
    check('予約日時が保存される', sched.data?.scheduled_at, when);

    const schedList = await api('GET', '/api/scheduled-posts', token);
    check('予約一覧に 1 件出る', schedList.data?.length, 1);
    check('一覧でも添付が戻る', schedList.data?.[0]?.media_attachments?.length, 2);
    check('一覧でもアンケートが戻る', schedList.data?.[0]?.poll?.choices?.length, 2);

    // 本文なしでも、アンケート（選択肢 2 つ以上）があれば予約できる
    const pollOnly = await api('POST', '/api/scheduled-posts', token, {
      content: '',
      visibility: 'public',
      poll: { choices: ['はい', 'いいえ'], multiple: false },
      scheduled_at: when,
    });
    check('アンケートだけでも予約できる', pollOnly.status, 201);
    check('本文は空のまま', pollOnly.data?.content, '');
    check('アンケートが入る', pollOnly.data?.poll?.choices?.length, 2);

    // ======================================================================
    console.log('\n🧷 [4] 予約投稿: 入力の検証');
    check(
      '何も無い予約は 400',
      (await api('POST', '/api/scheduled-posts', token, { content: '', scheduled_at: when })).status,
      400,
    );
    check(
      '選択肢 1 つのアンケートだけでは 400',
      (await api('POST', '/api/scheduled-posts', token, {
        content: '', poll: { choices: ['はい', ''], multiple: false }, scheduled_at: when,
      })).status,
      400,
    );
    check(
      '過去の日時は 400',
      (await api('POST', '/api/scheduled-posts', token, { content: 'x', scheduled_at: new Date(Date.now() - 60_000).toISOString() })).status,
      400,
    );
    check(
      '予約日時が無ければ 400',
      (await api('POST', '/api/scheduled-posts', token, { content: 'x' })).status,
      400,
    );
    check('取り消せる', (await api('DELETE', `/api/scheduled-posts/${encodeURIComponent(sched.data.id)}`, token)).status, 200);
    check(
      '取り消し後は一覧に残らない',
      (await api('GET', '/api/scheduled-posts', token)).data?.some((item: any) => item.id === sched.data.id),
      false,
    );

    completed = true;
  } finally {
    console.log('');
    if (server) {
      server.kill('SIGTERM');
      for (let i = 0; i < 20; i++) {
        try { await assertPortFree(PORT); break; } catch { await sleep(300); }
      }
      if (!server.killed) {
        try { server.kill('SIGKILL'); } catch {}
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

  console.log('');
  if (!completed) {
    console.error('❌ テストを最後まで実行できませんでした（上のエラーを確認してください）');
  } else if (failures === 0) {
    console.log(`🎉 すべての確認に合格しました（${checks} 件）`);
  } else {
    console.error(`❌ ${checks} 件中 ${failures} 件の確認に失敗しました`);
  }
  process.exit(completed && failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('❌ テスト実行エラー:', err);
  process.exit(1);
});
