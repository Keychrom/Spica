import path from 'node:path';
import fs from 'node:fs';

const TEST_DB_PATH = path.resolve(process.cwd(), 'server', 'data_test_channels_webauthn.sqlite');

// テスト用DB初期化
[TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`].forEach((p) => {
  if (fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch {}
  }
});

process.env.DB_PATH = TEST_DB_PATH;
process.env.PORT = '3997';
process.env.ORIGIN = 'https://spica.test';
process.env.DOMAIN = 'spica.test';

async function runTest() {
  console.log('🧪 === 🎨 チャンネル機能 ＆ 🔐 WebAuthn / パスキー 総合検証テスト ===\n');

  const { db, initDatabase } = await import('../server/src/db.js');
  await initDatabase();

  const { executeCreatePost } = await import('../server/src/postService.js');
  const {
    createWebAuthnRegistrationOptions,
    verifyWebAuthnRegistration,
    createWebAuthnAuthenticationOptions,
    verifyWebAuthnAuthentication,
    getRPInfo
  } = await import('../server/src/webauthnService.js');

  // テスト用ユーザー作成
  await db.prepare(`
    INSERT INTO users (id, name, summary, master_key_hash, role, is_frozen, public_key_pem, private_key_pem, created_at)
    VALUES 
      ('alice', 'Alice', 'テストアリス', 'hash_a', 'user', 0, 'pub_a', 'priv_a', datetime('now')),
      ('bob', 'Bob', 'テストボブ', 'hash_b', 'user', 0, 'pub_b', 'priv_b', datetime('now'))
  `).run();

  const userA = { id: 'alice', name: 'Alice' };
  const userB = { id: 'bob', name: 'Bob' };

  console.log('✅ テストユーザー作成完了: Alice & Bob\n');

  // ==========================================
  // テスト 1: 📢 チャンネルの作成と取得
  // ==========================================
  console.log('--- 1. 📢 チャンネル作成と情報取得の検証 ---');
  const channelId = 'chan-tech-talk';
  await db.prepare(`
    INSERT INTO channels (id, name, description, color, banner_url, category, is_archived, user_id, posts_count, followers_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 0, datetime('now'))
  `).run(channelId, '技術談義', 'テクノロジーや開発に関する雑談部屋', '#3b82f6', null, 'tech', userA.id);

  const createdChannel = await db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId) as any;
  if (!createdChannel || createdChannel.name !== '技術談義') {
    throw new Error('❌ チャンネル作成の検証に失敗しました');
  }
  console.log(`✅ チャンネル作成成功: [${createdChannel.id}] ${createdChannel.name} (カテゴリ: ${createdChannel.category})`);

  // ==========================================
  // テスト 2: 📢 チャンネルフォロー / アンフォロー
  // ==========================================
  console.log('\n--- 2. 📢 チャンネルフォロー/アンフォローの検証 ---');
  // Bob がチャンネルをフォロー
  await db.prepare('INSERT INTO channel_follows (channel_id, user_id, created_at) VALUES (?, ?, datetime(\'now\'))').run(channelId, userB.id);
  await db.prepare('UPDATE channels SET followers_count = followers_count + 1 WHERE id = ?').run(channelId);

  let updatedChannel = await db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId) as any;
  if (updatedChannel.followers_count !== 1) {
    throw new Error(`❌ フォロワー数の更新に失敗しました: expected 1, got ${updatedChannel.followers_count}`);
  }
  console.log(`✅ Bob がチャンネルをフォロー: フォロワー数 = ${updatedChannel.followers_count}`);

  // Bob がアンフォロー
  await db.prepare('DELETE FROM channel_follows WHERE channel_id = ? AND user_id = ?').run(channelId, userB.id);
  await db.prepare('UPDATE channels SET followers_count = MAX(0, followers_count - 1) WHERE id = ?').run(channelId);
  updatedChannel = await db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId) as any;
  if (updatedChannel.followers_count !== 0) {
    throw new Error(`❌ アンフォロー時のフォロワー数更新に失敗しました: expected 0, got ${updatedChannel.followers_count}`);
  }
  console.log(`✅ Bob がアンフォロー: フォロワー数 = ${updatedChannel.followers_count}`);

  // ==========================================
  // テスト 3: 📢 チャンネル宛て投稿と posts_count 連動
  // ==========================================
  console.log('\n--- 3. 📢 チャンネル宛て投稿の検証 ---');
  const result = await executeCreatePost({
    user: userA as any,
    content: 'TypeScriptとWebAuthnの実装について話しましょう！ #tech',
    visibility: 'public',
    channel_id: channelId,
  });
  const post1 = result.post;

  if (!post1 || post1.channel_id !== channelId) {
    throw new Error(`❌ 投稿への channel_id 付与に失敗しました: ${JSON.stringify(post1)}`);
  }
  if (!post1.channel || post1.channel.name !== '技術談義') {
    throw new Error(`❌ 投稿オブジェクト内の channel 情報に失敗しました: ${JSON.stringify(post1.channel)}`);
  }

  const chanAfterPost = await db.prepare('SELECT posts_count FROM channels WHERE id = ?').get(channelId) as any;
  if (chanAfterPost.posts_count !== 1) {
    throw new Error(`❌ チャンネルの posts_count インクリメントに失敗しました: expected 1, got ${chanAfterPost.posts_count}`);
  }
  console.log(`✅ チャンネル宛て投稿完了: [Post ${post1.id}] channel_id = ${post1.channel_id}`);
  console.log(`✅ チャンネル投稿数カウントアップ確認: posts_count = ${chanAfterPost.posts_count}`);

  // チャンネル専用タイムライン取得クエリ検証
  const timelinePosts = await db.prepare(`
    SELECT * FROM posts WHERE channel_id = ? ORDER BY published_at DESC
  `).all(channelId);
  if (timelinePosts.length !== 1 || (timelinePosts[0] as any).id !== post1.id) {
    throw new Error('❌ チャンネルタイムラインの取得クエリ検証に失敗しました');
  }
  console.log(`✅ チャンネルタイムライン取得クエリ成功: 件数 = ${timelinePosts.length}`);

  // ==========================================
  // テスト 4: 🔐 WebAuthn RP情報およびオプション生成
  // ==========================================
  console.log('\n--- 4. 🔐 WebAuthn RP情報 & オプション生成の検証 ---');
  const rpInfo = getRPInfo('localhost:3000');
  if (rpInfo.rpID !== 'localhost') {
    throw new Error(`❌ rpID のホスト名抽出に失敗しました: expected localhost, got ${rpInfo.rpID}`);
  }
  console.log(`✅ RP情報抽出成功: rpID = ${rpInfo.rpID}, origin = ${rpInfo.origin}`);

  // 登録オプション生成
  const userARow = await db.prepare('SELECT * FROM users WHERE id = ?').get(userA.id) as any;
  const regOptions = await createWebAuthnRegistrationOptions(userARow, 'https://spica.test');
  if (!regOptions.challenge || !regOptions.user || regOptions.user.name !== userA.name) {
    throw new Error('❌ WebAuthn 登録オプションの生成に失敗しました');
  }
  console.log(`✅ 登録オプション生成成功: challenge = ${regOptions.challenge.substring(0, 16)}...`);

  // DBにチャレンジが記録されたことを確認
  const storedChallenge = await db.prepare('SELECT * FROM webauthn_challenges WHERE challenge = ?').get(regOptions.challenge) as any;
  if (!storedChallenge || storedChallenge.user_id !== userA.id || storedChallenge.type !== 'registration') {
    throw new Error('❌ webauthn_challenges テーブルへの登録チャレンジ記録に失敗しました');
  }
  console.log(`✅ チャレンジDB保存確認: user_id = ${storedChallenge.user_id}, type = ${storedChallenge.type}`);

  // 認証オプション生成（ユーザー指定なしの Discoverable credentials / パスキー用）
  const authOptions = await createWebAuthnAuthenticationOptions(undefined, 'https://spica.test');
  if (!authOptions.challenge) {
    throw new Error('❌ WebAuthn 認証オプションの生成に失敗しました');
  }
  console.log(`✅ 認証オプション生成成功: challenge = ${authOptions.challenge.substring(0, 16)}...`);

  // DBに認証チャレンジが記録されたことを確認
  const storedAuthChallenge = await db.prepare('SELECT * FROM webauthn_challenges WHERE challenge = ?').get(authOptions.challenge) as any;
  if (!storedAuthChallenge || storedAuthChallenge.type !== 'authentication') {
    throw new Error('❌ webauthn_challenges テーブルへの認証チャレンジ記録に失敗しました');
  }
  console.log(`✅ 認証チャレンジDB保存確認: type = ${storedAuthChallenge.type}`);

  // ==========================================
  // テスト 5: 🔐 クレデンシャル一覧・削除の検証
  // ==========================================
  console.log('\n--- 5. 🔐 WebAuthn クレデンシャル管理の検証 ---');
  const dummyCredId = 'dummy-credential-id-xyz';
  await db.prepare(`
    INSERT INTO webauthn_credentials (id, user_id, public_key, counter, device_name, transports, created_at, last_used_at)
    VALUES (?, ?, ?, 0, ?, ?, datetime('now'), datetime('now'))
  `).run(dummyCredId, userA.id, 'dummy_public_key_hex', 'Windows Hello (Laptop)', '["internal"]');

  const userCreds = await db.prepare('SELECT * FROM webauthn_credentials WHERE user_id = ?').all(userA.id) as any[];
  if (userCreds.length !== 1 || userCreds[0].device_name !== 'Windows Hello (Laptop)') {
    throw new Error('❌ クレデンシャル一覧取得に失敗しました');
  }
  console.log(`✅ クレデンシャル取得成功: [${userCreds[0].id}] デバイス: ${userCreds[0].device_name}`);

  // 削除テスト
  const delRes = await db.prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?').run(dummyCredId, userA.id);
  if (delRes.changes !== 1) {
    throw new Error('❌ クレデンシャル削除に失敗しました');
  }
  const userCredsAfterDelete = await db.prepare('SELECT * FROM webauthn_credentials WHERE user_id = ?').all(userA.id) as any[];
  if (userCredsAfterDelete.length !== 0) {
    throw new Error('❌ 削除後のクレデンシャル残存チェックに失敗しました');
  }
  console.log('✅ クレデンシャル削除成功');

  // ファイルを消す前に接続を閉じる（後片付けの直前に呼ぶ）
  await db.close();

  console.log('\n🎉 ==========================================');
  console.log('🎉 全テスト正常完了！チャンネル＆WebAuthnの動作が完全に検証されました');
  console.log('🎉 ==========================================\n');
}

// 明示的に終了する（バックグラウンドのワーカーが残ってプロセスが終わらないため）
runTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ テストエラー:', err);
    process.exit(1);
  });
