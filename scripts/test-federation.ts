import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT_DIR = process.cwd();

// テスト用DBを初期化・クリーンアップ
['data_3000.sqlite', 'data_3001.sqlite', 'data_3000.sqlite-wal', 'data_3001.sqlite-wal', 'data_3000.sqlite-shm', 'data_3001.sqlite-shm'].forEach((f) => {
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

async function waitForServer(url: string, maxRetries = 40): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.log(`📡 [waitForServer] ${url} is ready (HTTP ${res.status})`);
        return true;
      }
    } catch (e: any) {
      // 接続待機中
    }
    await sleep(500);
  }
  console.error(`❌ [waitForServer] Timed out waiting for ${url}`);
  return false;
}

async function run() {
  console.log('====================================================');
  console.log('🧪 ActivityPub マルチノード・フェデレーション疎通テスト');
  console.log('====================================================\n');

  let nodeA: ChildProcess | null = null;
  let nodeB: ChildProcess | null = null;

  try {
    // 1. Node A (Port 3000) 起動
    console.log('▶️ Node A (Port 3000) を起動中...');
    nodeA = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: '3000',
        DOMAIN: 'localhost:3000',
        INSTANCE_NAME: 'Node-A',
      },
      stdio: 'pipe',
      shell: true,
    });

    // 2. Node B (Port 3001) 起動
    console.log('▶️ Node B (Port 3001) を起動中...');
    nodeB = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.resolve(ROOT_DIR, 'server'),
      env: {
        ...process.env,
        PORT: '3001',
        DOMAIN: 'localhost:3001',
        INSTANCE_NAME: 'Node-B',
      },
      stdio: 'pipe',
      shell: true,
    });

    nodeA.stdout?.on('data', (d) => console.log(`[Node A] ${d.toString().trim()}`));
    nodeB.stdout?.on('data', (d) => console.log(`[Node B] ${d.toString().trim()}`));

    console.log('⏳ サーバーの起動待機中...');
    const okA = await waitForServer('http://localhost:3000');
    const okB = await waitForServer('http://localhost:3001');

    if (!okA || !okB) {
      throw new Error('サーバーの起動に失敗しました。');
    }
    console.log('✅ 両ノードの起動完了！\n');

    // 3. Node A に Alice を作成
    console.log('👤 [Node A] ユーザー Alice を作成中...');
    const resAlice = await fetch('http://localhost:3000/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'alice', name: 'Alice Wonderland', summary: 'Hello from Node A!' }),
    });
    const alice = await resAlice.json();
    console.log(`✅ Alice 作成成功: ${alice.handle} (${alice.actorUrl})`);

    // 4. Node B に Bob を作成
    console.log('👤 [Node B] ユーザー Bob を作成中...');
    const resBob = await fetch('http://localhost:3001/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'bob', name: 'Bob Builder', summary: 'Hello from Node B!' }),
    });
    const bob = await resBob.json();
    console.log(`✅ Bob 作成成功: ${bob.handle} (${bob.actorUrl})\n`);

    // 5. WebFinger 検証
    console.log('🔍 [WebFinger 検証] Node A から Bob の WebFinger を解決...');
    const wfRes = await fetch('http://localhost:3001/.well-known/webfinger?resource=acct:bob@localhost:3001');
    const wfData = await wfRes.json();
    console.log(`✅ WebFinger 応答: subject=${wfData.subject}`);
    const selfLink = wfData.links?.find((l: any) => l.rel === 'self');
    console.log(`✅ Actor URL: ${selfLink?.href}\n`);

    // 6. Actor JSON-LD 検証
    console.log('📜 [Actor 検証] Bob の Actor JSON-LD を取得...');
    const actorRes = await fetch(selfLink.href, {
      headers: { Accept: 'application/activity+json' },
    });
    const actorData = await actorRes.json();
    console.log(`✅ Actor Type: ${actorData.type}`);
    console.log(`✅ Inbox: ${actorData.inbox}`);
    console.log(`✅ Public Key ID: ${actorData.publicKey?.id}\n`);

    // 7. フォローリクエスト検証: Alice (Node A) -> Bob (Node B)
    console.log('🤝 [Follow 検証] Alice (@Node A) が Bob (@Node B) をフォロー...');
    const followRes = await fetch('http://localhost:3000/api/follow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'alice', targetHandle: '@bob@localhost:3001' }),
    });
    const followData = await followRes.json();
    console.log('✅ Follow レスポンス:', followData);

    // Accept の非同期配送を少し待機
    await sleep(2000);

    // Node B 側で Alice がフォロワーとして記録されているか確認
    const followersRes = await fetch('http://localhost:3001/api/followers?userId=bob');
    const followersData = await followersRes.json();
    console.log(`✅ Node B の Bob のフォロワー数: ${followersData.length}`);
    console.log('✅ フォロワー詳細:', followersData[0]?.follower_url);

    if (followersData.length === 0) {
      throw new Error('フォロワーの登録が確認できませんでした。');
    }
    console.log('🎉 フォロー＆Acceptフェデレーション成功！\n');

    // 8. 投稿＆連合配信検証: Bob (Node B) が投稿 -> Alice (Node A) のタイムラインに届くか
    console.log('📝 [Federation 投稿検証] Bob が Node B で投稿...');
    const postContent = '分散型SNS SN-SNSの世界へようこそ！🚀 ActivityPubで繋がっています！';
    const postRes = await fetch('http://localhost:3001/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'bob', content: postContent }),
    });
    const postData = await postRes.json();
    console.log('✅ Bob の投稿完了:', postData.content);

    // 連合配送の完了を少し待機
    await sleep(2500);

    // Node A のタイムラインを取得して Bob の投稿が保存されているか確認！
    console.log('📡 [Node A タイムライン確認] Alice (Node A) の連合タイムラインを確認...');
    const tlRes = await fetch('http://localhost:3000/api/timeline');
    const tlPosts = await tlRes.json();
    console.log(`✅ Node A のタイムライン件数: ${tlPosts.length}`);
    
    const federatedPost = tlPosts.find((p: any) => p.content.includes('分散型SNS'));
    if (!federatedPost) {
      throw new Error('Node A に Bob の連合投稿が届いていませんでした。');
    }

    console.log('🎉 連合投稿を正常に受信しました！');
    console.log(`   - 投稿者: ${federatedPost.author_name} (${federatedPost.author_handle})`);
    console.log(`   - 本文: ${federatedPost.content}`);
    console.log(`   - is_local: ${federatedPost.is_local} (0 = 連合受信)`);
    console.log(`   - 受信日時: ${federatedPost.published_at}\n`);

    console.log('====================================================');
    console.log('🎊 すべての ActivityPub 疎通テストが完全成功しました！');
    console.log('====================================================');

  } catch (err) {
    console.error('❌ テスト失敗:', err);
    process.exitCode = 1;
  } finally {
    console.log('🧹 サーバープロセスを終了中...');
    if (nodeA && nodeA.pid) {
      try { spawn('taskkill', ['/pid', nodeA.pid.toString(), '/f', '/t'], { shell: true }); } catch {}
    }
    if (nodeB && nodeB.pid) {
      try { spawn('taskkill', ['/pid', nodeB.pid.toString(), '/f', '/t'], { shell: true }); } catch {}
    }
  }
}

run();
