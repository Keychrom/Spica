/**
 * PostgreSQL 対応（スキーマ生成・適用・移送）の検証 (`npm run test:pg-port`)
 *
 * PostgreSQL が必要です。接続先は TEST_DATABASE_URL（例: spica_test データベース）。
 * 未設定のときは「スキップ」として終了コード 2 を返します（成功と区別するため）。
 *
 *   TEST_DATABASE_URL=postgres://spica:pass@127.0.0.1:5432/spica_test npm run test:pg-port
 *
 * 検証する内容:
 *   1. スキーマ生成: SQLite の migrations から PG DDL を作り、SQLite 固有の構文が残らない
 *   2. スキーマ適用: 生成した DDL を PostgreSQL に適用できる（--reset で作り直し）
 *   3. データ移送: 代表的なデータを入れた SQLite から移送し、行数と内容の要約が一致する
 *   4. FTS: posts_fts に索引が入り、日本語の部分一致で引ける
 *   5. トリガー: PG 側で投稿を INSERT / DELETE すると posts_fts が追随する
 *   6. 外部キー: 参照先が無い行は拒否される
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from 'pg';
import { configurePgTypes } from './pg-shared.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_SQLITE = path.resolve(ROOT_DIR, 'server', 'data_test_pg_port.sqlite');
const DSN = process.env.TEST_DATABASE_URL || '';

let failures = 0;
let passed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}: ${JSON.stringify(actual)}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}: ${JSON.stringify(actual)} (期待値 ${JSON.stringify(expected)})`);
  }
}

function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT_DIR,
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });
    let out = '';
    child.stdout?.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.on('close', (code) => resolve({ code: code ?? 0, out }));
  });
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

async function seedSqlite(): Promise<{ posts: number; ftsRows: number; users: number }> {
  for (const f of [TEST_SQLITE, `${TEST_SQLITE}-wal`, `${TEST_SQLITE}-shm`]) {
    try { fs.unlinkSync(f); } catch {}
  }
  process.env.DB_PATH = TEST_SQLITE;
  const mod: any = await import('../server/src/db.js');
  await mod.initDatabase();

  const db = new DatabaseSync(TEST_SQLITE);
  const now = new Date().toISOString();
  const keyPair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  db.prepare(`INSERT INTO users (id, name, summary, icon_url, master_key_hash, public_key_pem, private_key_pem, role, created_at, notification_prefs, email_notifications)
    VALUES (?, ?, ?, '', ?, ?, ?, 'admin', ?, '{}', 0)`).run(
    'alice', 'アリス', 'テスト用のユーザー', sha256('hash-alice'),
    keyPair.publicKey as unknown as string, keyPair.privateKey as unknown as string, now,
  );
  db.prepare(`INSERT INTO users (id, name, summary, icon_url, master_key_hash, public_key_pem, private_key_pem, role, created_at, notification_prefs, email_notifications)
    VALUES (?, ?, '', '', ?, ?, '', 'user', ?, '{"reaction":false}', 1)`).run(
    'bob', 'ボブ', sha256('hash-bob'), 'public-key-bob', now,
  );

  db.prepare(`INSERT INTO posts (id, user_id, author_name, author_url, author_handle, author_icon, content, cw, is_local, visibility, emojis, media_attachments, is_sensitive, published_at, fts_indexed)
    VALUES (?, 'alice', 'アリス', ?, '@alice@localhost', '', ?, NULL, 1, 'public', '[]', '[]', 0, ?, 1)`).run(
    'https://localhost/users/alice/posts/1', 'https://localhost/users/alice', '日本語の検索テストです', now,
  );
  db.prepare(`INSERT INTO posts (id, user_id, author_name, author_url, author_handle, author_icon, content, cw, is_local, visibility, emojis, media_attachments, is_sensitive, published_at, fts_indexed)
    VALUES (?, 'alice', 'アリス', ?, '@alice@localhost', '', ?, '閲覧注意', 1, 'followers', '[]', ?, 1, ?, 1)`).run(
    'https://localhost/users/alice/posts/2', 'https://localhost/users/alice', 'フォロワー限定の投稿',
    JSON.stringify([{ url: 'https://cdn.example.com/a.webp', mediaType: 'image/webp', description: '代替テキスト' }]), now,
  );
  db.prepare(`INSERT INTO posts (id, user_id, author_name, author_url, author_handle, author_icon, content, cw, is_local, visibility, emojis, media_attachments, is_sensitive, published_at, fts_indexed)
    VALUES (?, 'eve', 'eve', ?, '@eve@remote.test', '', ?, NULL, 0, 'public', '[]', '[]', 0, ?, 0)`).run(
    'https://remote.test/notes/1', 'https://remote.test/users/eve', 'リモートの投稿（索引対象外）', now,
  );

  db.prepare(`INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
    VALUES (?, 'eve', 'remote.test', 'eve', '', '', '', ?, NULL, ?, ?, ?)`).run(
    'https://remote.test/users/eve', 'https://remote.test/users/eve/inbox', 'https://remote.test/users/eve#main-key', 'remote-public-key', now,
  );
  db.prepare(`INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
    VALUES ('f1', ?, ?, ?, 1, 'accepted', ?)`).run('https://localhost/users/alice', 'https://remote.test/users/eve', 'https://remote.test/users/eve/inbox', now);
  db.prepare(`INSERT INTO reactions (id, post_id, user_id, user_name, user_icon, reaction, is_local, created_at)
    VALUES ('r1', ?, 'bob', 'ボブ', '', '👍', 1, ?)`).run('https://localhost/users/alice/posts/1', now);
  db.prepare(`INSERT INTO bookmarks (user_id, post_id, created_at) VALUES ('bob', ?, ?)`).run('https://localhost/users/alice/posts/1', now);
  db.prepare(`INSERT INTO announces (id, post_id, user_id, user_name, user_handle, user_icon, is_local, created_at)
    VALUES ('a1', ?, 'https://remote.test/users/eve', 'eve', '@eve@remote.test', '', 0, ?)`).run('https://localhost/users/alice/posts/1', now);
  db.prepare(`INSERT INTO notifications (id, user_id, type, actor_id, actor_name, actor_handle, actor_icon, post_id, post_content, content, is_read, created_at)
    VALUES ('n1', 'alice', 'reaction', 'bob', 'ボブ', '@bob@localhost', '', ?, ?, '👍', 0, ?)`).run('https://localhost/users/alice/posts/1', '日本語の検索テストです', now);
  db.prepare(`INSERT INTO polls (id, post_id, multiple, expires_at, created_at) VALUES ('p1', ?, 0, NULL, ?)`).run('https://localhost/users/alice/posts/1', now);
  db.prepare(`INSERT INTO poll_choices (id, poll_id, choice_index, text, votes_count) VALUES ('pc1', 'p1', 0, 'はい', 2)`).run();
  db.prepare(`INSERT INTO poll_choices (id, poll_id, choice_index, text, votes_count) VALUES ('pc2', 'p1', 1, 'いいえ', 1)`).run();
  db.prepare(`INSERT INTO media (id, user_id, url, key, media_type, size, name, thumbnail_url, thumbnail_key, width, height, duration, post_id, created_at)
    VALUES ('m1', 'alice', 'https://cdn.example.com/a.webp', 'uploads/a.webp', 'image/webp', 1234, 'a.webp', '', '', 640, 480, NULL, ?, ?)`).run(
    'https://localhost/users/alice/posts/2', now,
  );
  db.prepare(`INSERT INTO custom_emojis (id, name, url, category, aliases, created_at) VALUES ('e1', 'spica', 'https://cdn.example.com/spica.webp', '一般', '["スピカ"]', ?)`).run(now);
  db.prepare(`INSERT INTO lists (id, user_id, name, created_at, updated_at) VALUES ('l1', 'alice', 'リスト', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO list_members (id, list_id, member, display_name, created_at) VALUES ('lm1', 'l1', 'https://remote.test/users/eve', 'eve', ?)`).run(now);
  db.prepare(`INSERT INTO antennas (id, user_id, name, src, keywords, exclude_keywords, user_list, case_sensitive, with_file, notify, created_at)
    VALUES ('an1', 'alice', 'アンテナ', 'all', '["テスト"]', '[]', '', 0, 0, 1, ?)`).run(now);
  db.prepare(`INSERT INTO blocked_domains (domain, reason, created_at, created_by, severity) VALUES ('spam.example.com', 'テスト', ?, 'alice', 'silence')`).run(now);
  db.prepare(`INSERT INTO admin_actions (id, actor_id, action, method, path, target_type, target_id, detail, status, created_at)
    VALUES ('aa1', 'alice', 'block_domain', 'POST', '/blocks', 'domain', 'spam.example.com', 'ドメインの制限（ブロック / サイレンス） | {}', 201, ?)`).run(now);
  db.prepare(`INSERT INTO server_settings (key, value, updated_at) VALUES ('instance_name', 'テストノード', ?)`).run(now);
  // instance_actor は遅延生成されるテーブル。実際の鍵生成を呼んで作らせる
  const instanceActor: any = await import('../server/src/instanceActor.js');
  instanceActor.getInstanceActorKeyPair();

  const posts = Number((db.prepare('SELECT COUNT(*) AS c FROM posts').get() as any).c);
  const ftsRows = Number((db.prepare('SELECT COUNT(*) AS c FROM posts_fts').get() as any).c);
  const users = Number((db.prepare('SELECT COUNT(*) AS c FROM users').get() as any).c);
  db.close();
  return { posts, ftsRows, users };
}

async function main(): Promise<number> {
  console.log('====================================================');
  console.log('🧪 PostgreSQL 対応（スキーマ・移送）検証');
  console.log('====================================================');

  if (!DSN) {
    console.log('');
    console.log('⏭️  TEST_DATABASE_URL が未設定のためスキップしました（終了コード 2）。');
    console.log('   例: TEST_DATABASE_URL=postgres://spica:pass@127.0.0.1:5432/spica_test npm run test:pg-port');
    return 2;
  }
  console.log(`接続先: ${DSN.replace(/:[^:@/]+@/, ':***@')}`);
  console.log('');

  console.log('📦 [1] 検証用の SQLite を作る（実際の migrations を使用）');
  const seeded = await seedSqlite();
  check('ユーザーを作成', seeded.users, 2);
  check('投稿を作成', seeded.posts, 3);
  check('FTS 索引が入る（ローカル2件のみ）', seeded.ftsRows, 2);

  console.log('\n🛠️  [2] PG スキーマを生成して適用');
  const schema = await run(process.execPath, [path.join(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/pg-schema.ts']);
  check('スキーマ生成が成功', schema.code, 0);
  const schemaSql = fs.readFileSync(path.join(ROOT_DIR, 'server', 'src', 'db', 'schema.pg.sql'), 'utf8');
  check('posts_fts は通常テーブル + trigram 索引', /CREATE TABLE IF NOT EXISTS posts_fts/.test(schemaSql) && /gin_trgm_ops/.test(schemaSql), true);
  check('トリガーは plpgsql 関数になっている', /CREATE OR REPLACE FUNCTION spica_posts_ai/.test(schemaSql), true);

  const init = await run(process.execPath, [path.join(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/pg-init.ts', '--dsn', DSN, '--reset']);
  check('スキーマ適用が成功', init.code, 0);

  console.log('\n🚚 [3] データ移送と検証');
  const migrate = await run(process.execPath, [path.join(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/pg-migrate.ts', '--from', TEST_SQLITE, '--dsn', DSN, '--verify', '--truncate']);
  check('移送と検証が成功', migrate.code, 0);
  if (migrate.code !== 0) {
    console.log(migrate.out.split('\n').slice(-25).join('\n'));
  }
  const verified = /すべてのテーブルで行数と内容の要約が一致しました/.test(migrate.out);
  check('全テーブルで行数と内容が一致', verified, true);

  console.log('\n🔎 [4] FTS（日本語の部分一致）');
  const client = new Client({ connectionString: DSN });
  configurePgTypes();
  await client.connect();
  try {
    const ftsCount = await client.query('SELECT COUNT(*)::int AS c FROM posts_fts');
    check('posts_fts に索引が入っている', ftsCount.rows[0].c, 2);

    const search = await client.query(`SELECT post_id FROM posts_fts WHERE content ILIKE '%検索テスト%'`);
    check('日本語の部分一致で引ける', search.rows.length, 1);
    check('引けたのは該当の投稿', search.rows[0]?.post_id, 'https://localhost/users/alice/posts/1');

    // 行数が少ないと planner は seq scan を選ぶので、トランザクション内で seqscan を切って
    // 「trigram 索引が使えること」を確かめる（SET LOCAL はトランザクション内でのみ有効）
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const explain = await client.query(`EXPLAIN SELECT post_id FROM posts_fts WHERE content ILIKE '%検索テスト%'`);
    await client.query('ROLLBACK');
    const plan = explain.rows.map((row: any) => row['QUERY PLAN']).join(' | ');
    check('trigram 索引が使える（enable_seqscan=off で確認）', /Index Scan/i.test(plan), true);
    if (!/Index Scan/i.test(plan)) console.log(`     実際のプラン: ${plan}`);

    console.log('\n🔔 [5] トリガー（PG 側で投稿を入れると posts_fts が追随する）');
    await client.query(
      `INSERT INTO posts (id, user_id, author_name, author_url, author_handle, author_icon, content, cw, is_local, visibility, emojis, media_attachments, is_sensitive, published_at, fts_indexed)
       VALUES ($1, 'alice', 'アリス', 'https://localhost/users/alice', '@alice@localhost', '', 'トリガーの確認用', NULL, 1, 'public', '[]', '[]', 0, $2, 1)`,
      ['https://localhost/users/alice/posts/3', new Date().toISOString()],
    );
    const afterInsert = await client.query(`SELECT COUNT(*)::int AS c FROM posts_fts`);
    check('INSERT で索引が増える', afterInsert.rows[0].c, 3);

    await client.query(`UPDATE posts SET content = '更新後の本文' WHERE id = 'https://localhost/users/alice/posts/3'`);
    const afterUpdate = await client.query(`SELECT content FROM posts_fts WHERE post_id = $1`, ['https://localhost/users/alice/posts/3']);
    check('UPDATE で索引が更新される', afterUpdate.rows[0]?.content, '更新後の本文');

    await client.query(`DELETE FROM posts WHERE id = 'https://localhost/users/alice/posts/3'`);
    const afterDelete = await client.query(`SELECT COUNT(*)::int AS c FROM posts_fts`);
    check('DELETE で索引が消える', afterDelete.rows[0].c, 2);

    const noIndex = await client.query(
      `INSERT INTO posts (id, user_id, author_name, author_url, author_handle, author_icon, content, cw, is_local, visibility, emojis, media_attachments, is_sensitive, published_at, fts_indexed)
       VALUES ($1, 'alice', 'アリス', 'https://localhost/users/alice', '@alice@localhost', '', '索引しない投稿', NULL, 0, 'public', '[]', '[]', 0, $2, 0)`,
      ['https://remote.test/notes/2', new Date().toISOString()],
    );
    const afterNoIndex = await client.query(`SELECT COUNT(*)::int AS c FROM posts_fts`);
    check('fts_indexed = 0 は索引しない（WHEN 句）', afterNoIndex.rows[0].c, 2);
    check('索引しない投稿自体は入る', noIndex.rowCount, 1);

    console.log('\n🔗 [6] 外部キー');
    let fkRejected = false;
    try {
      // poll_choices は polls を参照している（SQLite 側にも FOREIGN KEY がある）
      await client.query(`INSERT INTO poll_choices (id, poll_id, choice_index, text, votes_count) VALUES ('pc-bad', 'no-such-poll', 0, 'x', 0)`);
    } catch {
      fkRejected = true;
    }
    check('参照先が無い行は拒否される', fkRejected, true);

    let cascadeOk = false;
    await client.query(`INSERT INTO polls (id, post_id, multiple, expires_at, created_at) VALUES ('p-del', 'https://localhost/users/alice/posts/2', 0, NULL, $1)`, [new Date().toISOString()]);
    await client.query(`INSERT INTO poll_choices (id, poll_id, choice_index, text, votes_count) VALUES ('pc-del', 'p-del', 0, 'x', 0)`);
    await client.query(`DELETE FROM polls WHERE id = 'p-del'`);
    const remaining = await client.query(`SELECT COUNT(*)::int AS c FROM poll_choices WHERE poll_id = 'p-del'`);
    cascadeOk = remaining.rows[0].c === 0;
    check('ON DELETE CASCADE が効く', cascadeOk, true);

    console.log('\n📊 [7] 主要テーブルの件数（PostgreSQL 側）');
    const counts = await client.query(`
      SELECT 'users' AS t, COUNT(*)::int AS c FROM users
      UNION ALL SELECT 'posts', COUNT(*)::int FROM posts
      UNION ALL SELECT 'follows', COUNT(*)::int FROM follows
      UNION ALL SELECT 'reactions', COUNT(*)::int FROM reactions
      UNION ALL SELECT 'notifications', COUNT(*)::int FROM notifications
      UNION ALL SELECT 'media', COUNT(*)::int FROM media
      UNION ALL SELECT 'admin_actions', COUNT(*)::int FROM admin_actions
      ORDER BY t
    `);
    const table = Object.fromEntries(counts.rows.map((row: any) => [row.t, row.c]));
    check('users', table.users, 2);
    check('posts（索引しない投稿を追加済み）', table.posts, 4);
    check('follows', table.follows, 1);
    check('reactions', table.reactions, 1);
    check('notifications', table.notifications, 1);
    check('media', table.media, 1);
    check('admin_actions', table.admin_actions, 1);
  } finally {
    await client.end();
  }

  // 後片付け
  for (const f of [TEST_SQLITE, `${TEST_SQLITE}-wal`, `${TEST_SQLITE}-shm`]) {
    try { fs.unlinkSync(f); } catch {}
  }

  console.log('');
  console.log(`結果: ${passed} 件成功 / ${failures} 件失敗`);
  if (failures === 0) {
    console.log('✅ PostgreSQL 対応（スキーマ生成・適用・移送・検索・トリガー）は動作しています');
  }
  return failures > 0 ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('テスト実行中にエラー:', err);
  process.exit(1);
});
