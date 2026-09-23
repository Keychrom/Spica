import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const TEST_DB_PATH = path.resolve(process.cwd(), 'server', 'data_test_deletion.sqlite');

// テスト用DB初期化
[TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`].forEach((p) => {
  if (fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch {}
  }
});

process.env.DB_PATH = TEST_DB_PATH;
process.env.PORT = '3999';
process.env.ORIGIN = 'https://spica.test';
process.env.DOMAIN = 'spica.test';

async function runTest() {
  console.log('🧪 === アカウント削除機能 総合検証テスト ===');

  const { db, initDatabase } = await import('../server/src/db.js');
  await initDatabase();

  const { deleteUserAccount } = await import('../server/src/accountService.js');

  // 1. テストユーザーのセットアップ
  console.log('1. テストユーザーとデータの作成...');
  await db.prepare(`
    INSERT INTO users (id, name, summary, master_key_hash, role, is_frozen, public_key_pem, private_key_pem, created_at)
    VALUES 
      ('admin1', '管理者1', 'サーバー管理者', 'hash1', 'admin', 0, 'pub', 'priv', datetime('now')),
      ('admin2', '管理者2', 'サーバー管理者2', 'hash2', 'admin', 0, 'pub', 'priv', datetime('now')),
      ('alice', 'アリス', '一般ユーザー', 'hash3', 'user', 0, 'pub', 'priv', datetime('now')),
      ('bob', 'ボブ', '一般ユーザー2', 'hash4', 'user', 0, 'pub', 'priv', datetime('now'))
  `).run();

  // 投稿と関連データ作成
  await db.prepare(`
    INSERT INTO posts (id, user_id, author_name, author_url, author_handle, content, is_local, visibility, published_at)
    VALUES
      ('post_alice_1', 'alice', 'アリス', 'https://spica.test/users/alice', '@alice@spica.test', 'アリスの投稿1', 1, 'public', datetime('now')),
      ('post_alice_2', 'alice', 'アリス', 'https://spica.test/users/alice', '@alice@spica.test', 'アリスの投稿2', 1, 'public', datetime('now')),
      ('post_bob_1', 'bob', 'ボブ', 'https://spica.test/users/bob', '@bob@spica.test', 'ボブの投稿1', 1, 'public', datetime('now'))
  `).run();

  // リアクション作成
  await db.prepare(`
    INSERT INTO reactions (id, post_id, user_id, user_name, reaction, is_local, created_at)
    VALUES
      ('r1', 'post_alice_1', 'bob', 'ボブ', '👍', 1, datetime('now')),
      ('r2', 'post_bob_1', 'alice', 'アリス', '❤️', 1, datetime('now'))
  `).run();

  // フォロー作成
  await db.prepare(`
    INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
    VALUES
      ('f1', 'https://spica.test/users/alice', 'https://spica.test/users/bob', 'https://spica.test/users/bob/inbox', 1, 'accepted', datetime('now')),
      ('f2', 'https://spica.test/users/bob', 'https://spica.test/users/alice', 'https://spica.test/users/alice/inbox', 1, 'accepted', datetime('now'))
  `).run();

  // セッション作成
  await db.prepare(`
    INSERT INTO sessions (token, user_id, created_at, expires_at)
    VALUES ('tok_alice', 'alice', datetime('now'), datetime('now', '+30 days'))
  `).run();

  console.log('✅ データセットアップ完了');

  // 2. 一般ユーザー alice の削除テスト
  console.log('2. @alice のアカウント削除を実行...');
  const resAlice = await deleteUserAccount('alice');
  if (!resAlice.success) {
    throw new Error(`アリスの削除に失敗: ${resAlice.error}`);
  }
  console.log('✅ deleteUserAccount("alice") 成功');

  // 検証: alice のレコードが消えていること
  const aliceUser = await db.prepare('SELECT * FROM users WHERE id = ?').get('alice');
  if (aliceUser) throw new Error('alice の users レコードが残っています');

  const alicePosts = await db.prepare('SELECT * FROM posts WHERE user_id = ?').all('alice');
  if (alicePosts.length > 0) throw new Error('alice の posts レコードが残っています');

  const alicePostReactions = await db.prepare("SELECT * FROM reactions WHERE post_id IN ('post_alice_1', 'post_alice_2')").all();
  if (alicePostReactions.length > 0) throw new Error('alice の投稿に対するリアクションが残っています');

  const aliceReactions = await db.prepare('SELECT * FROM reactions WHERE user_id = ?').all('alice');
  if (aliceReactions.length > 0) throw new Error('alice が付けたリアクションが残っています');

  const bobReactions = await db.prepare('SELECT * FROM reactions WHERE user_id = ?').all('bob');
  if (bobReactions.length > 0) throw new Error('aliceの投稿につけたbobのリアクションが残っています');

  const aliceFollows = await db.prepare("SELECT * FROM follows WHERE follower_url LIKE '%/alice' OR following_url LIKE '%/alice'").all();
  if (aliceFollows.length > 0) throw new Error('alice のフォロー関係が残っています');

  const aliceSessions = await db.prepare('SELECT * FROM sessions WHERE user_id = ?').all('alice');
  if (aliceSessions.length > 0) throw new Error('alice のセッションが残っています');

  // bobの投稿が残っていることの確認
  const bobPost = await db.prepare("SELECT * FROM posts WHERE id = 'post_bob_1'").get();
  if (!bobPost) throw new Error('bob の投稿が誤って削除されています');

  console.log('✅ アカウント関連全テーブルのカスケード削除が正常に確認できました');

  // 3. 管理者保護テスト
  console.log('3. 管理者保護テスト (最後の管理者の削除防止)...');
  // まず admin2 を削除（admin1 が残っているので成功するはず）
  const resAdmin2 = await deleteUserAccount('admin2');
  if (!resAdmin2.success) throw new Error(`admin2 の削除に失敗: ${resAdmin2.error}`);
  console.log('✅ 複数管理者がいる場合の削除成功');

  // 次に最後の管理者 admin1 を削除しようとする（拒否されるはず）
  const resAdmin1 = await deleteUserAccount('admin1');
  if (resAdmin1.success) throw new Error('最後の管理者の削除が許可されてしまいました！');
  console.log(`✅ 最後の管理者の削除保護が正常に作動: "${resAdmin1.error}"`);

  // クリーンアップ
  await db.close();
  [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`].forEach((p) => {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  });

  console.log('\n🎉 すべてのアカウント削除テストが正常に通過しました！');
  process.exit(0);
}

runTest().catch((err) => {
  console.error('❌ テスト失敗:', err);
  process.exit(1);
});
