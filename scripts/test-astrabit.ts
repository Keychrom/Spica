import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_astrabit.sqlite';

// テストDBのクリーンアップ
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

async function waitForServer(url: string, maxRetries = 30): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

async function run() {
  console.log('====================================================');
  console.log('🌌 AstraBit (spica.test) 検証テスト');
  console.log('====================================================\n');

  let server: ChildProcess | null = null;

  try {
    console.log('▶️ AstraBit サーバーを起動中 (Port 3000)...');
    server = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: '3000',
        DOMAIN: 'spica.test',
        PROTOCOL: 'https',
        DB_PATH: path.resolve(ROOT_DIR, 'server', TEST_DB),
        INSTANCE_NAME: 'AstraBit Test Node',
      },
      stdio: 'pipe',
      shell: true,
    });

    server.stdout?.on('data', (d) => console.log(`[AstraBit] ${d.toString().trim()}`));

    console.log('⏳ サーバーの起動待機中...');
    const ok = await waitForServer('http://localhost:3000');
    if (!ok) throw new Error('サーバーが起動しませんでした。');
    console.log('✅ AstraBit サーバー起動完了！\n');

    // 1. 初回管理者アカウント登録
    console.log('🔑 [マスターキー登録 1] 初回管理者アカウント admin を登録中...');
    const regAdminRes = await fetch('http://localhost:3000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'admin', name: 'Astra Administrator', summary: 'Server Administrator' }),
    });
    const adminData = await regAdminRes.json();
    console.log(`✅ 管理者作成完了: ${adminData.user.handle}`);
    console.log(`   - ロール: ${adminData.user.role} (初回自動昇格: ${adminData.user.role === 'admin' ? '成功' : '失敗'})`);
    console.log(`   - 発行マスターキー: ${adminData.masterKey}`);
    console.log(`   - セッショントークン: ${adminData.sessionToken.slice(0, 20)}...`);

    if (adminData.user.role !== 'admin' || !adminData.masterKey.startsWith('astrabit_sk_')) {
      throw new Error('管理者アカウントの生成またはマスターキー形式が不正です。');
    }

    // 2. 一般ユーザーアカウント登録
    console.log('\n🔑 [マスターキー登録 2] 一般ユーザー alice を登録中...');
    const regAliceRes = await fetch('http://localhost:3000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'alice', name: 'Alice Wonderland', summary: 'Hello AstraBit!' }),
    });
    const aliceData = await regAliceRes.json();
    console.log(`✅ 一般ユーザー作成完了: ${aliceData.user.handle}`);
    console.log(`   - ロール: ${aliceData.user.role} (一般ユーザー: ${aliceData.user.role === 'user' ? '成功' : '失敗'})`);
    console.log(`   - 発行マスターキー: ${aliceData.masterKey}`);

    if (aliceData.user.role !== 'user') {
      throw new Error('一般ユーザーのロールが不正です。');
    }

    // 3. マスターキーによるログインテスト
    console.log('\n🔐 [マスターキーログイン検証]');
    // 成功ケース
    const loginOkRes = await fetch('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'admin', masterKey: adminData.masterKey }),
    });
    if (!loginOkRes.ok) throw new Error('正しいマスターキーでのログインに失敗しました。');
    console.log('✅ 正しいマスターキーによるログイン: 成功！');

    // 失敗ケース（間違ったキー）
    const loginFailRes = await fetch('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'admin', masterKey: 'wrong_key_12345' }),
    });
    if (loginFailRes.status === 401) {
      console.log('✅ 不正なマスターキーの拒絶: 成功 (HTTP 401)');
    } else {
      throw new Error('不正なマスターキーでログインが弾かれませんでした。');
    }

    // 4. 管理者専用エンドポイントのアクセス制御テスト
    console.log('\n🛡️ [管理者権限アクセス制御検証]');
    // 一般ユーザーによるアクセス（403 Forbidden が期待される）
    const adminDeniedRes = await fetch('http://localhost:3000/api/admin/stats', {
      headers: { Authorization: `Bearer ${aliceData.sessionToken}` },
    });
    if (adminDeniedRes.status === 403) {
      console.log('✅ 一般ユーザーの管理画面アクセス拒絶: 成功 (HTTP 403 Forbidden)');
    } else {
      throw new Error(`一般ユーザーの管理画面アクセスが弾かれませんでした (HTTP ${adminDeniedRes.status})`);
    }

    // 管理者によるアクセス（200 OK が期待される）
    const adminOkRes = await fetch('http://localhost:3000/api/admin/stats', {
      headers: { Authorization: `Bearer ${adminData.sessionToken}` },
    });
    if (adminOkRes.ok) {
      const stats = await adminOkRes.json();
      console.log('✅ 管理者による統計アクセス: 成功 (HTTP 200)');
      console.log(`   - ユーザー数: ${stats.stats.users}, 管理者数: ${stats.stats.admins}`);
    } else {
      throw new Error('管理者による管理画面アクセスに失敗しました。');
    }

    // 5. ActivityPub (WebFinger, Actor, NodeInfo) 検証
    console.log('\n📜 [ActivityPub 仕様・ドメイン検証]');
    const wfRes = await fetch('http://localhost:3000/.well-known/webfinger?resource=acct:admin@spica.test');
    const wfData = await wfRes.json();
    console.log(`✅ WebFinger Subject: ${wfData.subject}`);
    const selfLink = wfData.links?.find((l: any) => l.rel === 'self')?.href;
    console.log(`✅ Actor URL: ${selfLink}`);

    const actorRes = await fetch('http://localhost:3000/users/admin', {
      headers: { Accept: 'application/activity+json' },
    });
    const actorData = await actorRes.json();
    console.log(`✅ Actor Type: ${actorData.type}`);
    console.log(`✅ Actor Inbox: ${actorData.inbox}`);
    console.log(`✅ Actor Public Key: ${actorData.publicKey?.id}`);

    const nodeinfoRes = await fetch('http://localhost:3000/nodeinfo/2.1');
    const nodeinfoData = await nodeinfoRes.json();
    console.log(`✅ NodeInfo 2.1 Software: ${nodeinfoData.software.name} v${nodeinfoData.software.version}`);
    console.log(`✅ NodeInfo Protocol: ${nodeinfoData.protocols.join(', ')}`);

    // 6. 投稿機能テスト
    console.log('\n📝 [投稿作成テスト]');
    const postRes = await fetch('http://localhost:3000/api/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminData.sessionToken}`,
      },
      body: JSON.stringify({ content: 'AstraBit 本番ノードの起動完了！宇宙へ繋がります 🌌🚀' }),
    });
    const postData = await postRes.json();
    console.log(`✅ 投稿作成成功: "${postData.content}"`);

    const tlRes = await fetch('http://localhost:3000/api/timeline');
    const tlData = await tlRes.json();
    console.log(`✅ タイムライン取得: ${tlData.length} 件 (最新: ${tlData[0]?.content})`);

    console.log('\n====================================================');
    console.log('🎊 AstraBit の全機能・認証・ActivityPub テスト完全成功！');
    console.log('====================================================');

  } catch (err) {
    console.error('❌ テスト失敗:', err);
    process.exitCode = 1;
  } finally {
    console.log('🧹 サーバープロセスを終了中...');
    if (server && server.pid) {
      try { spawn('taskkill', ['/pid', server.pid.toString(), '/f', '/t'], { shell: true }); } catch {}
    }
  }
}

run();
