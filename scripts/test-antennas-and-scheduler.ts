import path from 'node:path';
import fs from 'node:fs';

const TEST_DB_PATH = path.resolve(process.cwd(), 'server', 'data_test_antennas_scheduler.sqlite');

// テスト用DB初期化
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
  console.log('🧪 === 📡 アンテナ機能 ＆ ⏰ 予約投稿・下書き 総合検証テスト ===\n');

  const { db, initDatabase, createNotification } = await import('../server/src/db.js');
  await initDatabase();

  const { executeCreatePost, isPostMatchingAntenna, checkAntennaMatchesAndNotify } = await import('../server/src/postService.js');
  const { processScheduledPosts } = await import('../server/src/scheduler.js');

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
  // テスト 1: 📡 アンテナ条件マッチングの検証
  // ==========================================
  console.log('--- 1. 📡 アンテナ条件マッチングの検証 ---');

  // アンテナ1: キーワード「Spica, 連合」、除外ワード「bot」
  const antenna1: any = {
    id: 'ant-1',
    user_id: userA.id,
    name: 'Spica速報',
    src: 'all',
    user_list: '',
    keywords: 'Spica, 連合',
    exclude_keywords: 'bot, スパム',
    case_sensitive: 0,
    with_file: 0,
    notify: 1,
    created_at: new Date().toISOString(),
  };

  // テストノート1: キーワード一致
  const post1 = {
    id: 'post-1',
    user_id: userB.id,
    content: '新しい分散SNSのSpicaを使ってみた！素晴らしい！',
    cw: '',
    media_attachments: '[]',
  };
  if (!(await isPostMatchingAntenna(post1, antenna1))) {
    throw new Error('テストノート1がアンテナ1にマッチしませんでした');
  }
  console.log('✅ キーワードマッチング成功 ("Spica" 検出)');

  // テストノート2: 除外キーワード「bot」が含まれる
  const post2 = {
    id: 'post-2',
    user_id: userB.id,
    content: 'Spicaの自動投稿botです。',
    cw: '',
    media_attachments: '[]',
  };
  if (await isPostMatchingAntenna(post2, antenna1)) {
    throw new Error('除外キーワード "bot" を含むノートが除外されませんでした');
  }
  console.log('✅ 除外キーワード動作成功 ("bot" を含む投稿を除外)');

  // テストノート3: 大文字小文字の区別テスト
  const antennaCase: any = {
    id: 'ant-case',
    user_id: userA.id,
    name: '厳密検索',
    src: 'all',
    user_list: '',
    keywords: 'SPICA',
    exclude_keywords: '',
    case_sensitive: 1,
    with_file: 0,
    notify: 0,
    created_at: new Date().toISOString(),
  };
  const postLower = { id: 'p-lower', user_id: userB.id, content: 'spica test', cw: '', media_attachments: '[]' };
  const postUpper = { id: 'p-upper', user_id: userB.id, content: 'SPICA test', cw: '', media_attachments: '[]' };
  if (await isPostMatchingAntenna(postLower, antennaCase)) {
    throw new Error('case_sensitive=1 の場合に小文字が誤検知されました');
  }
  if (!(await isPostMatchingAntenna(postUpper, antennaCase))) {
    throw new Error('case_sensitive=1 の場合に大文字が正しくマッチしませんでした');
  }
  console.log('✅ 大文字小文字の厳密マッチ判定成功');

  // アンテナDB保存＆通知生成検証
  await db.prepare(`
    INSERT INTO antennas (id, user_id, name, src, user_list, keywords, exclude_keywords, case_sensitive, with_file, notify, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(antenna1.id, antenna1.user_id, antenna1.name, antenna1.src, antenna1.user_list, antenna1.keywords, antenna1.exclude_keywords, antenna1.case_sensitive, antenna1.with_file, antenna1.notify, antenna1.created_at);

  await checkAntennaMatchesAndNotify(post1);

  const notifs = await db.prepare('SELECT * FROM notifications WHERE user_id = ? AND type = ?').all(userA.id, 'antenna') as any[];
  if (notifs.length === 0) {
    throw new Error('アンテナマッチ通知が生成されませんでした');
  }
  console.log(`✅ アンテナ新着通知作成成功 (通知ID: ${notifs[0].id}, アンテナ名: ${notifs[0].content})\n`);

  // ==========================================
  // テスト 1-b: 📡 src='home' のアンテナ（フォロー範囲）
  //   「投稿ごとにアンテナ数ぶんクエリを撃たない」ように判定を分けたので、
  //   フォローしている / していないで通知が変わることを確かめる
  // ==========================================
  console.log("--- 1-b. 📡 src='home' のアンテナ判定 ---");

  const homeAntenna: any = {
    id: 'ant-home',
    user_id: userA.id,
    name: 'フォロー中の人',
    src: 'home',
    user_list: '',
    keywords: '',
    exclude_keywords: '',
    case_sensitive: 0,
    with_file: 0,
    notify: 1,
    created_at: new Date().toISOString(),
  };
  await db.prepare(`
    INSERT INTO antennas (id, user_id, name, src, user_list, keywords, exclude_keywords, case_sensitive, with_file, notify, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(homeAntenna.id, homeAntenna.user_id, homeAntenna.name, homeAntenna.src, homeAntenna.user_list, homeAntenna.keywords, homeAntenna.exclude_keywords, homeAntenna.case_sensitive, homeAntenna.with_file, homeAntenna.notify, homeAntenna.created_at);

  const bobActorUrl = 'https://spica.test/users/bob';
  const bobPost = {
    id: 'post-home-1',
    user_id: userB.id,
    author_url: bobActorUrl,
    author_name: 'Bob',
    author_handle: '@bob@spica.test',
    content: 'フォロー範囲のアンテナ確認用',
    cw: '',
    media_attachments: '[]',
  };
  const countHomeNotifs = async () =>
    ((await db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = 'antenna' AND content LIKE '%フォロー中の人%'").get(userA.id)) as { c: number }).c;

  // フォローしていない状態 → 通知されない
  await checkAntennaMatchesAndNotify(bobPost);
  if ((await countHomeNotifs()) !== 0) {
    throw new Error('フォローしていないのに src=home のアンテナが通知しました');
  }
  console.log('✅ フォローしていない相手は通知しない');

  // フォローした状態 → 通知される
  await db.prepare(`
    INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
    VALUES ('f-home-1', ?, ?, 'https://spica.test/inbox', 1, 'accepted', datetime('now'))
  `).run('https://spica.test/users/alice', bobActorUrl);
  await checkAntennaMatchesAndNotify(bobPost);
  if ((await countHomeNotifs()) !== 1) {
    throw new Error('フォローしている相手なのに src=home のアンテナが通知しませんでした');
  }
  console.log('✅ フォローしている相手は通知する');

  // 自分の投稿では自分に通知しない（有効なフォロー関係があっても）
  await checkAntennaMatchesAndNotify({ ...bobPost, id: 'post-home-2', user_id: userA.id, author_url: 'https://spica.test/users/alice' });
  if ((await countHomeNotifs()) !== 1) {
    throw new Error('自分の投稿で自分のアンテナが通知しました');
  }
  console.log('✅ 自分の投稿では通知しない\n');

  // ==========================================
  // テスト 2: 📝 下書き保存・一覧・削除の検証
  // ==========================================
  console.log('--- 2. 📝 下書き機能の検証 ---');
  const draftId = 'draft-test-1';
  await db.prepare(`
    INSERT INTO drafts (id, user_id, content, cw, visibility, media_attachments, poll, in_reply_to, quote_id, updated_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(draftId, userA.id, '下書きテスト本文です', 'ネタバレ注意', 'public', '[]', '', '', '', new Date().toISOString(), new Date().toISOString());

  const userDrafts = await db.prepare('SELECT * FROM drafts WHERE user_id = ?').all(userA.id) as any[];
  if (userDrafts.length !== 1 || userDrafts[0].content !== '下書きテスト本文です') {
    throw new Error('下書きの取得に失敗しました');
  }
  console.log('✅ 下書き保存および取得成功');

  await db.prepare('DELETE FROM drafts WHERE id = ?').run(draftId);
  const userDraftsAfter = await db.prepare('SELECT * FROM drafts WHERE user_id = ?').all(userA.id) as any[];
  if (userDraftsAfter.length !== 0) {
    throw new Error('下書きの削除に失敗しました');
  }
  console.log('✅ 下書き削除成功\n');

  // ==========================================
  // テスト 3: ⏰ 予約投稿 ＆ スケジューラの自動実行検証
  // ==========================================
  console.log('--- 3. ⏰ 予約投稿 ＆ スケジューラ自動実行の検証 ---');

  const schedId = 'sched-test-1';
  const pastScheduledAt = new Date(Date.now() - 5000).toISOString(); // 5秒前の予約日時

  await db.prepare(`
    INSERT INTO scheduled_posts (id, user_id, content, cw, visibility, media_attachments, poll, in_reply_to, quote_id, scheduled_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(schedId, userA.id, 'これは未来から来た自動予約投稿です！ #Spica', '', 'public', '[]', '', '', '', pastScheduledAt, 'pending', new Date().toISOString());

  console.log(`⏰ 予約投稿作成完了 (ID: ${schedId}, 予定時刻: ${pastScheduledAt})`);

  // スケジューラポーリングを実行
  await processScheduledPosts();

  const schedRow = await db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(schedId) as any;
  if (!schedRow || schedRow.status !== 'published') {
    throw new Error(`スケジューラ実行後もステータスが published に更新されていません: ${schedRow?.status}`);
  }
  console.log(`✅ スケジューラによる自動公開成功 (status: ${schedRow.status}, published_post_id: ${schedRow.published_post_id})`);

  // 実際に posts テーブルに投稿が作成されているか検証
  const createdPost = await db.prepare('SELECT * FROM posts WHERE id = ?').get(schedRow.published_post_id) as any;
  if (!createdPost || !createdPost.content.includes('これは未来から来た自動予約投稿です！')) {
    throw new Error('予約投稿の公開ノートが posts テーブルに存在しません');
  }
  console.log(`✅ 投稿コアエンジンによるノート作成成功 (本文: "${createdPost.content}")`);

  // 予約投稿完了通知が届いているか検証
  const schedNotifs = await db.prepare('SELECT * FROM notifications WHERE user_id = ? AND type = ?').all(userA.id, 'scheduled_published') as any[];
  if (schedNotifs.length === 0) {
    throw new Error('予約投稿公開の完了通知が届いていません');
  }
  console.log(`✅ 予約投稿公開完了通知の配信確認成功 (通知ID: ${schedNotifs[0].id})\n`);

  // ==========================================
  // テスト 3b: 公開時に全項目（公開範囲・添付・アンケート・返信先・引用元）が引き継がれるか
  // ==========================================
  console.log('--- 3b. ⏰ 予約投稿の全項目（公開範囲・添付・アンケート・返信先・引用元）---');
  const fullSchedId = 'sched-full-1';
  const attachmentsJson = JSON.stringify([
    { url: 'https://spica.test/uploads/alice/a.png', mediaType: 'image/png', description: '添付の説明' },
  ]);
  const pollJson = JSON.stringify({ choices: ['はい', 'いいえ'], multiple: false, expires_in: 3600 });
  await db.prepare(`
    INSERT INTO scheduled_posts (id, user_id, content, cw, visibility, media_attachments, poll, in_reply_to, quote_id, scheduled_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    fullSchedId,
    userA.id,
    '予約の全項目',
    'CW',
    'followers',
    attachmentsJson,
    pollJson,
    'https://remote.test/users/eve/posts/1',
    'https://remote.test/users/eve/posts/2',
    new Date(Date.now() - 5000).toISOString(),
    new Date().toISOString(),
  );

  await processScheduledPosts();
  const fullSchedRow = await db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(fullSchedId) as any;
  const fullPost = await db.prepare('SELECT * FROM posts WHERE id = ?').get(fullSchedRow?.published_post_id) as any;
  if (!fullPost) throw new Error('全項目の予約投稿が公開されませんでした');

  const fullMedia = JSON.parse(fullPost.media_attachments || '[]');
  if (fullPost.visibility !== 'followers') throw new Error(`公開範囲が引き継がれていません: ${fullPost.visibility}`);
  if (fullMedia.length !== 1 || fullMedia[0].description !== '添付の説明') {
    throw new Error(`添付が引き継がれていません: ${JSON.stringify(fullMedia)}`);
  }
  if (fullPost.in_reply_to !== 'https://remote.test/users/eve/posts/1') throw new Error('返信先が引き継がれていません');
  if (fullPost.quote_id !== 'https://remote.test/users/eve/posts/2') throw new Error('引用元が引き継がれていません');
  console.log('✅ 公開範囲・添付・返信先・引用元を引き継ぎ');

  const fullPoll = await db.prepare('SELECT * FROM polls WHERE post_id = ?').get(fullPost.id) as any;
  if (!fullPoll) throw new Error('アンケートが作られていません');
  const fullChoices = await db.prepare('SELECT * FROM poll_choices WHERE poll_id = ? ORDER BY choice_index ASC').all(fullPoll.id) as any[];
  if (fullChoices.length !== 2 || fullChoices[0].text !== 'はい' || fullChoices[1].text !== 'いいえ') {
    throw new Error(`アンケートの選択肢が引き継がれていません: ${JSON.stringify(fullChoices)}`);
  }
  const expiresIn = Date.parse(fullPoll.expires_at) - Date.now();
  if (!fullPoll.expires_at || expiresIn < 3000_000 || expiresIn > 3700_000) {
    throw new Error(`アンケートの期限が引き継がれていません: ${fullPoll.expires_at}`);
  }
  console.log('✅ アンケート（選択肢・期限）を引き継ぎ\n');

  console.log('🎉 === すべてのテストに合格しました！ ===');

  // クリーンアップ（ファイルを消す前に接続を閉じる）
  await db.close();
  [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`].forEach((p) => {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  });
}

// 明示的に終了する（スケジューラ等の interval が残ってプロセスが終わらないため）
runTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ テスト失敗:', err);
    process.exit(1);
  });
