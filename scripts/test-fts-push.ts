import path from 'node:path';
import fs from 'node:fs';

const TEST_DB_PATH = path.resolve(process.cwd(), 'server', 'data_test_fts_push.sqlite');

// テスト用DBクリーンアップ
[TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`].forEach((p) => {
  if (fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch {}
  }
});

process.env.DB_PATH = TEST_DB_PATH;
process.env.PORT = '3998';
process.env.ORIGIN = 'https://spica.test';
process.env.DOMAIN = 'spica.test';

async function runTest() {
  console.log('🧪 === FTS5全文検索 ＆ Web Push機能 総合検証テスト ===\n');

  const { db, initDatabase } = await import('../server/src/db.js');
  await initDatabase();

  const {
    getOrCreateVapidKeys,
    getVapidPublicKey,
    savePushSubscription,
    removePushSubscription,
    isUserSubscribed,
  } = await import('../server/src/pushService.js');

  // ==========================================
  // テスト 1: Web Push サービス
  // ==========================================
  console.log('--- 1. Web Push サービスの検証 ---');
  const vapidKeys = await getOrCreateVapidKeys();
  if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
    throw new Error('VAPIDキーの生成に失敗しました');
  }
  console.log(`✅ VAPID公開鍵生成成功: ${vapidKeys.publicKey.slice(0, 20)}...`);

  const pubKey = await getVapidPublicKey();
  if (pubKey !== vapidKeys.publicKey) {
    throw new Error('getVapidPublicKey が一致しません');
  }

  // テストユーザー作成 (外部キー制約)
  await db.prepare(`
    INSERT INTO users (id, name, summary, master_key_hash, role, is_frozen, public_key_pem, private_key_pem, created_at)
    VALUES ('testuser', 'テストユーザー', 'WebPush用', 'hash', 'user', 0, 'pub', 'priv', datetime('now'))
  `).run();

  // 端末の PushSubscription 登録
  const testSub = {
    userId: 'testuser',
    endpoint: 'https://fcm.googleapis.com/fcm/send/test-device-token-12345',
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QT9AcDnVwT3JhWuW5T8Lnk8rU1OvgwXh_9A2hB1n7G9j9vL0=',
    auth: 'tBHItJI5svbp5pwh6hG4nA==',
  };

  await savePushSubscription(testSub);
  if (!(await isUserSubscribed('testuser'))) {
    throw new Error('PushSubscription の登録確認に失敗しました');
  }
  console.log('✅ PushSubscription の登録と確認成功');

  await removePushSubscription(testSub.endpoint);
  if (await isUserSubscribed('testuser')) {
    throw new Error('PushSubscription の解除確認に失敗しました');
  }
  console.log('✅ PushSubscription の解除成功');

  // ==========================================
  // テスト 2: SQLite FTS5 trigram 全文検索
  // ==========================================
  console.log('\n--- 2. SQLite FTS5 (trigram) 全文検索の検証 ---');

  // テストユーザー作成
  await db.prepare(`
    INSERT INTO users (id, name, summary, master_key_hash, role, is_frozen, public_key_pem, private_key_pem, created_at)
    VALUES ('alice', 'アリス', 'テストユーザー', 'hash', 'user', 0, 'pub', 'priv', datetime('now'))
  `).run();

  // 投稿作成（トリガーにより posts_fts へ自動同期されるはず）
  await db.prepare(`
    INSERT INTO posts (id, user_id, author_name, author_url, author_handle, content, is_local, visibility, published_at)
    VALUES
      ('p1', 'alice', 'アリス', 'https://spica.test/users/alice', '@alice@spica.test', '今日は青い星Spicaを観測しました。とても美しい星光です。', 1, 'public', '2026-09-19T00:00:00Z'),
      ('p2', 'alice', 'アリス', 'https://spica.test/users/alice', '@alice@spica.test', '分散型SNSプロトコルActivityPubの実装テストを行っています。', 1, 'public', '2026-09-19T00:01:00Z'),
      ('p3', 'alice', 'アリス', 'https://spica.test/users/alice', '@alice@spica.test', 'TypeScriptとViteでフロントエンドを爆速ビルド！最高！', 1, 'public', '2026-09-19T00:02:00Z')
  `).run();

  // トリガーによって posts_fts に3件入っているか確認
  const ftsCount = (await db.prepare('SELECT COUNT(*) as c FROM posts_fts').get() as any).c;
  if (ftsCount !== 3) {
    throw new Error(`posts_fts にデータが自動同期されていません (期待: 3, 実際: ${ftsCount})`);
  }
  console.log(`✅ posts_fts への AFTER INSERT トリガー自動同期成功 (件数: ${ftsCount})`);

  // 3文字以上の単語検索 (FTS5 trigram): 「青い星」
  const res1 = await db.prepare(`
    SELECT p.id, p.content FROM posts_fts f
    JOIN posts p ON f.post_id = p.id
    WHERE posts_fts MATCH '"青い星"'
  `).all() as any[];
  if (res1.length !== 1 || res1[0].id !== 'p1') {
    throw new Error(`「青い星」の検索結果が不正です: ${JSON.stringify(res1)}`);
  }
  console.log('✅ 3文字以上の日本語単語検索「青い星」-> p1 が正確にヒット');

  // 単語検索: 「ActivityPub」
  const res2 = await db.prepare(`
    SELECT p.id, p.content FROM posts_fts f
    JOIN posts p ON f.post_id = p.id
    WHERE posts_fts MATCH '"ActivityPub"'
  `).all() as any[];
  if (res2.length !== 1 || res2[0].id !== 'p2') {
    throw new Error(`「ActivityPub」の検索結果が不正です: ${JSON.stringify(res2)}`);
  }
  console.log('✅ 英単語検索「ActivityPub」-> p2 が正確にヒット');

  // 複数単語 AND 検索: 「青い星」AND「美しい」
  const res3 = await db.prepare(`
    SELECT p.id, p.content FROM posts_fts f
    JOIN posts p ON f.post_id = p.id
    WHERE posts_fts MATCH '"青い星" "美しい"'
  `).all() as any[];
  if (res3.length !== 1 || res3[0].id !== 'p1') {
    throw new Error(`複数単語AND検索の結果が不正です: ${JSON.stringify(res3)}`);
  }
  console.log('✅ 複数単語AND検索「"青い星" "美しい"」-> p1 が正確にヒット');

  // 1〜2文字の単語（例: 「観測」）のハイブリッド検索ロジック検証 (LIKE フォールバック)
  const shortQuery = '観測';
  const resShort = await db.prepare(`
    SELECT id, content FROM posts
    WHERE content LIKE ?
  `).all(`%${shortQuery}%`) as any[];
  if (resShort.length !== 1 || resShort[0].id !== 'p1') {
    throw new Error(`短語フォールバック「観測」の検索結果が不正です: ${JSON.stringify(resShort)}`);
  }
  console.log('✅ 短語ハイブリッド補完（1〜2文字）「観測」-> p1 が正確にヒット');

  // トリガー検証: 投稿削除時に FTS から消去されるか
  await db.prepare('DELETE FROM posts WHERE id = ?').run('p3');
  const ftsCountAfterDel = (await db.prepare('SELECT COUNT(*) as c FROM posts_fts').get() as any).c;
  if (ftsCountAfterDel !== 2) {
    throw new Error(`削除トリガーが作動していません (期待: 2, 実際: ${ftsCountAfterDel})`);
  }
  console.log('✅ posts_ad (AFTER DELETE) トリガーによる FTS からの自動消去成功');

  // クリーンアップ
  await db.close();
  [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`].forEach((p) => {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  });

  console.log('\n🎉 すべての FTS5全文検索 ＆ Web Push 検証テストが合格しました！');
  process.exit(0);
}

runTest().catch((err) => {
  console.error('❌ テスト失敗:', err);
  process.exit(1);
});
