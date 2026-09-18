import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT_DIR = process.cwd();
const TEST_DB = 'data_test_relay.sqlite';

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
  console.log('🧪 リレー対応・タイムライン3層化・Misskeyフォロー検証');
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
        INSTANCE_NAME: 'AstraBit Relay Test',
      },
      stdio: 'pipe',
      shell: true,
    });

    server.stdout?.on('data', (d) => console.log(`[Server] ${d.toString().trim()}`));

    console.log('⏳ 起動待機中...');
    const ok = await waitForServer('http://localhost:3000');
    if (!ok) throw new Error('サーバー起動失敗');
    console.log('✅ サーバー起動完了！\n');

    // 1. 管理者アカウント作成
    console.log('👤 [ステップ 1] 管理者アカウント admin を作成...');
    const regRes = await fetch('http://localhost:3000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'admin', name: 'Astra Admin' }),
    });
    const admin = await regRes.json();
    console.log(`✅ 管理者作成完了: ${admin.user.handle}`);

    // 2. Misskey からの Follow Activity シミュレーション
    console.log('\n🤝 [ステップ 2] Misskey からのフォロー受信テスト (Shared Inbox: /inbox)...');
    const misskeyFollowActivity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: 'https://misskey.io/activities/9abc1234',
      type: 'Follow',
      actor: 'https://misskey.io/users/9xyz9876',
      object: 'https://spica.test/users/admin',
    };

    const followRes = await fetch('http://localhost:3000/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/activity+json' },
      body: JSON.stringify(misskeyFollowActivity),
    });
    console.log(`✅ Follow受信レスポンス: HTTP ${followRes.status}`);

    // フォロワー一覧を確認
    const followersRes = await fetch('http://localhost:3000/api/followers?userId=admin');
    const followers = await followersRes.json();
    console.log(`✅ adminのフォロワー数: ${followers.length}`);
    console.log(`✅ 登録されたフォロワーURL: ${followers[0]?.follower_url}`);

    if (followers.length === 0 || followers[0]?.follower_url !== 'https://misskey.io/users/9xyz9876') {
      throw new Error('Misskeyからのフォロワー登録が確認できませんでした。');
    }
    console.log('🎉 Misskeyからのフォロー判定・フォロワー登録が完全成功！');

    // 3. タイムライン 3層の検証
    console.log('\n📝 [ステップ 3] タイムライン 3層（ローカル / ホーム / 連合）の検証...');

    // A: ローカル投稿を作成
    await fetch('http://localhost:3000/api/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${admin.sessionToken}`,
      },
      body: JSON.stringify({ content: '【ローカル】AstraBitローカル投稿です🏠' }),
    });

    // B: フォロー中Misskeyユーザーの投稿を受信
    await fetch('http://localhost:3000/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/activity+json' },
      body: JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: 'https://misskey.io/notes/note1234/activity',
        type: 'Create',
        actor: 'https://misskey.io/users/9xyz9876',
        object: {
          id: 'https://misskey.io/notes/note1234',
          type: 'Note',
          attributedTo: 'https://misskey.io/users/9xyz9876',
          content: '【Misskeyフォロー中】Misskeyからの投稿です🐱',
          published: new Date().toISOString(),
        },
      }),
    });

    // C: リレーから流れてきた第三者の投稿（Announce / ブースト）を受信
    await fetch('http://localhost:3000/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/activity+json' },
      body: JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: 'https://relay.example.com/announce/4567',
        type: 'Announce',
        actor: 'https://relay.example.com/actor',
        object: {
          id: 'https://mastodon.social/users/someone/statuses/8888',
          type: 'Note',
          attributedTo: 'https://mastodon.social/users/someone',
          content: '【リレー連合】世界中のリレーから流れてきたMastodon投稿です🐘',
          published: new Date().toISOString(),
        },
      }),
    });

    // タイムラインの取得と検証
    // 1) ローカルタイムライン
    const localRes = await fetch('http://localhost:3000/api/timeline?mode=local');
    const localPosts = await localRes.json();
    console.log(`🏠 [ローカルTL件数]: ${localPosts.length} 件`);
    console.log(`   - 投稿内容: ${localPosts[0]?.content}`);
    if (localPosts.length !== 1 || !localPosts[0]?.content.includes('【ローカル】')) {
      throw new Error('ローカルタイムラインのフィルタリングが不正です。');
    }

    // 2) ホームタイムライン (ローカル + フォロー中Misskey)
    // admin が misskey ユーザーをフォローしている状態を DB に登録
    const now = new Date().toISOString();
    const followId = `${admin.user.actorUrl} -> https://misskey.io/users/9xyz9876`;
    // follows テーブルに直接挿入 (外部実サーバー不要で安定検証)
    const dbPath = path.resolve(ROOT_DIR, 'server', TEST_DB);
    const { DatabaseSync } = await import('node:sqlite');
    const testDb = new DatabaseSync(dbPath);
    testDb.prepare(`
      INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
      VALUES (?, ?, ?, 'https://misskey.io/inbox', 1, 'accepted', ?)
      ON CONFLICT(follower_url, following_url) DO NOTHING
    `).run(followId, admin.user.actorUrl, 'https://misskey.io/users/9xyz9876', now);

    const homeRes = await fetch('http://localhost:3000/api/timeline?mode=home', {
      headers: { Authorization: `Bearer ${admin.sessionToken}` },
    });
    const homePosts = await homeRes.json();
    console.log(`👥 [ホームTL件数]: ${homePosts.length} 件 (ローカル + フォロー中Misskey)`);
    if (homePosts.length !== 2) {
      throw new Error(`ホームタイムライン件数が不正です (期待値: 2, 実際: ${homePosts.length})`);
    }

    // 3) 連合タイムライン (リレー含む全件)
    const fedRes = await fetch('http://localhost:3000/api/timeline?mode=all');
    const fedPosts = await fedRes.json();
    console.log(`🌐 [連合TL件数]: ${fedPosts.length} 件 (リレーデータ含む全件)`);
    if (fedPosts.length !== 3) {
      throw new Error(`連合タイムライン件数が不正です (期待値: 3, 実際: ${fedPosts.length})`);
    }
    console.log('🎉 タイムラインの3層分離（ローカル / ホーム / 連合）が完全動作！');

    // 4. リレーサーバー管理 API テスト
    console.log('\n📡 [ステップ 4] リレーサーバー接続 API テスト...');
    const relayRes = await fetch('http://localhost:3000/api/admin/relays', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${admin.sessionToken}`,
      },
      body: JSON.stringify({ url: 'https://relay.test.net/inbox' }),
    });
    const relayData = await relayRes.json();
    console.log(`✅ リレー登録完了: ${relayData.inboxUrl} (status: ${relayData.status})`);

    // リレー一覧取得
    const relayListRes = await fetch('http://localhost:3000/api/admin/relays', {
      headers: { Authorization: `Bearer ${admin.sessionToken}` },
    });
    const relayList = await relayListRes.json();
    console.log(`✅ 登録済みリレー数: ${relayList.length}`);
    if (relayList.length !== 1) {
      throw new Error('リレー登録の反映が確認できませんでした。');
    }

    console.log('\n====================================================');
    console.log('🎊 リレー対応・タイムライン3層化・Misskeyフォロー全検証成功！');
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
