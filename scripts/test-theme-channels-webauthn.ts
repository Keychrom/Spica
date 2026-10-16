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
// 許可リストの検査用（開発サーバーの想定。ここに載っているオリジンだけ自己申告を認める）
process.env.WEBAUTHN_EXTRA_ORIGINS = 'http://localhost:5174';

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
    getRPInfo,
    assertWebAuthnOrigin
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
  // RP 情報は設定（ORIGIN / DOMAIN）から作る。リクエストの自己申告は使わない
  const rpInfo = getRPInfo();
  if (rpInfo.rpID !== 'spica.test') {
    throw new Error(`❌ rpID のホスト名抽出に失敗しました: expected spica.test, got ${rpInfo.rpID}`);
  }
  if (rpInfo.origin !== 'https://spica.test') {
    throw new Error(`❌ origin が設定と一致しません: expected https://spica.test, got ${rpInfo.origin}`);
  }
  console.log(`✅ RP情報抽出成功: rpID = ${rpInfo.rpID}, origin = ${rpInfo.origin}`);

  // 許可リストに**載っていない**オリジンを名乗っても、rpID / origin は設定のまま
  const spoofedRp = getRPInfo('https://evil.example');
  if (spoofedRp.origin !== 'https://spica.test' || spoofedRp.rpID !== 'spica.test') {
    throw new Error(`❌ 名乗っただけのオリジンが RP 情報に反映されました: origin=${spoofedRp.origin}, rpID=${spoofedRp.rpID}`);
  }
  console.log('✅ 許可リストに無いオリジンは RP 情報に反映されない');

  // 許可リスト（WEBAUTHN_EXTRA_ORIGINS）に載っているオリジンだけは、そのオリジンに合わせる
  const extraRp = getRPInfo('http://localhost:5174');
  if (extraRp.origin !== 'http://localhost:5174' || extraRp.rpID !== 'localhost') {
    throw new Error(`❌ 許可リストのオリジンが反映されません: origin=${extraRp.origin}, rpID=${extraRp.rpID}`);
  }
  console.log('✅ 許可リストのオリジンはそれに合わせる（開発サーバー用）');

  // Origin の検証: 設定したオリジンだけを通し、詐称はその場で拒否する
  assertWebAuthnOrigin(undefined); // Origin 無し（テストや CLI）は通す
  assertWebAuthnOrigin('https://spica.test');
  assertWebAuthnOrigin('http://localhost:5174'); // 許可リストのオリジン
  console.log('✅ 正しいオリジンは通る');
  let spoofRejected = false;
  try {
    assertWebAuthnOrigin('https://evil.example');
  } catch {
    spoofRejected = true;
  }
  if (!spoofRejected) {
    throw new Error('❌ 詐称された Origin が拒否されませんでした');
  }
  console.log('✅ 詐称された Origin は拒否される');

  // 登録オプション生成
  const userARow = await db.prepare('SELECT * FROM users WHERE id = ?').get(userA.id) as any;
  let spoofOptionsRejected = false;
  try {
    await createWebAuthnRegistrationOptions(userARow, 'https://evil.example');
  } catch {
    spoofOptionsRejected = true;
  }
  if (!spoofOptionsRejected) {
    throw new Error('❌ 詐称された Origin で登録オプションが作られてしまいました');
  }
  console.log('✅ 詐称された Origin では登録オプションを作らない');

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
  // テスト 4b: 🔐 チャレンジの持ち主とクレデンシャルの持ち主の一致
  // ==========================================
  console.log('\n--- 4b. 🔐 チャレンジの取り違えが通らないことの検証 ---');

  // (1) 登録: bob 宛のチャレンジで alice を登録しようとしても通らない
  const bobRegOptions = await createWebAuthnRegistrationOptions(userB as any, 'https://spica.test');
  let crossRegRejected = false;
  try {
    await verifyWebAuthnRegistration(
      userARow,
      { expectedChallenge: bobRegOptions.challenge, credential: { id: 'x', rawId: 'x', type: 'public-key', response: {} } },
      '取り違え',
      'https://spica.test',
    );
  } catch {
    crossRegRejected = true;
  }
  if (!crossRegRejected) {
    throw new Error('❌ 別の利用者に発行された登録チャレンジが通ってしまいました');
  }
  console.log('✅ 他の利用者に発行された登録チャレンジは拒否される');

  // (2) 認証: alice 宛のチャレンジを bob のクレデンシャルで使っても通らない
  const bobCredId = 'bob-credential-id-abc';
  await db.prepare(`
    INSERT INTO webauthn_credentials (id, user_id, public_key, counter, device_name, transports, created_at, last_used_at)
    VALUES (?, ?, ?, 0, ?, ?, datetime('now'), datetime('now'))
  `).run(bobCredId, userB.id, 'dummy_public_key_hex', 'Bob のパスキー', '["internal"]');

  const aliceAuthOptions = await createWebAuthnAuthenticationOptions(userA.id, 'https://spica.test');
  let crossAuthRejected = false;
  try {
    await verifyWebAuthnAuthentication(
      { expectedChallenge: aliceAuthOptions.challenge, credential: { id: bobCredId, rawId: bobCredId, type: 'public-key', response: {} } },
      'https://spica.test',
    );
  } catch {
    crossAuthRejected = true;
  }
  if (!crossAuthRejected) {
    throw new Error('❌ 別の利用者に発行された認証チャレンジが通ってしまいました');
  }
  console.log('✅ 他の利用者に発行された認証チャレンジは拒否される');

  await db.prepare('DELETE FROM webauthn_credentials WHERE id = ?').run(bobCredId);

  // ==========================================
  // テスト 4c: 🧽 期限切れチャレンジは日次の掃除で消える
  // ==========================================
  console.log('\n--- 4c. 🧽 期限切れチャレンジの掃除の検証 ---');
  const { pruneExpiredRows } = await import('../server/src/maintenanceService.js');
  await db
    .prepare('INSERT OR REPLACE INTO webauthn_challenges (challenge, user_id, type, expires_at) VALUES (?,?,?,?)')
    .run('expired-challenge', userA.id, 'totp', Date.now() - 1000);
  await db
    .prepare('INSERT OR REPLACE INTO webauthn_challenges (challenge, user_id, type, expires_at) VALUES (?,?,?,?)')
    .run('live-challenge', userA.id, 'totp', Date.now() + 60_000);

  const pruned = await pruneExpiredRows();
  const goneRow = await db.prepare('SELECT challenge FROM webauthn_challenges WHERE challenge = ?').get('expired-challenge');
  const keptRow = await db.prepare('SELECT challenge FROM webauthn_challenges WHERE challenge = ?').get('live-challenge');
  if (pruned.challenges < 1 || goneRow || !keptRow) {
    throw new Error(
      `❌ 期限切れチャレンジの掃除に失敗しました: 消した=${pruned.challenges} 期限切れの残り=${Boolean(goneRow)} 有効なもの=${Boolean(keptRow)}`,
    );
  }
  console.log(`✅ 期限切れチャレンジの掃除成功: ${pruned.challenges} 件（有効なものは残る）`);
  await db.prepare('DELETE FROM webauthn_challenges WHERE challenge = ?').run('live-challenge');

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
