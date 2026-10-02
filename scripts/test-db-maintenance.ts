/**
 * DB メンテナンスの検証
 *
 * 一時ディレクトリに「本番と同じ形の DB」を作り、dbMaintenance の
 *   ① 保持期間削除（残すべき投稿が残ること・従属行と FTS が消えること）
 *   ② 孤立メディア（参照されているファイルが消えないこと）
 *   ③ checkpoint + VACUUM（サイズが実際に縮むこと）
 *   ④ VACUUM INTO バックアップ（復元できること）
 * を確認する。実 DB には一切触れない。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAsyncDatabase, withTransaction } from '../server/src/db/asyncDriver.js';
import {
  DEFAULT_MAINTENANCE_OPTIONS,
  MaintenanceOptions,
  applyRemotePostRemoval,
  backupDatabase,
  cleanupOrphanMedia,
  formatBytes,
  getDbSizeInfo,
  keepConditions,
  openMaintenanceDb,
  optimizeDatabase,
  planRemotePostRemoval,
  rotateBackups,
  runMaintenance,
} from '../server/src/dbMaintenance.js';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} ${detail}`);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spica-dbmaint-'));
const dbPath = path.join(tmpDir, 'data_astrabit.sqlite');
const uploadsDir = path.join(tmpDir, 'data/uploads');
const backupDir = path.join(tmpDir, 'data/backups');
fs.mkdirSync(path.join(uploadsDir, 'alice'), { recursive: true });

// ---------------------------------------------------------------------------
// 本番と同じ形の DB を用意する
// ---------------------------------------------------------------------------
const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86400_000).toISOString();

{
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, summary TEXT, master_key_hash TEXT, role TEXT,
      is_frozen INTEGER DEFAULT 0, public_key_pem TEXT, private_key_pem TEXT, created_at TEXT,
      password_hash TEXT, email TEXT, email_verified INTEGER DEFAULT 0, icon_url TEXT DEFAULT '', banner_url TEXT DEFAULT '');
    CREATE TABLE posts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, author_name TEXT, author_url TEXT, author_handle TEXT,
      author_icon TEXT DEFAULT '', content TEXT, is_local INTEGER DEFAULT 1, visibility TEXT DEFAULT 'public',
      emojis TEXT DEFAULT '[]', cw TEXT, in_reply_to TEXT, quote_id TEXT, is_sensitive INTEGER DEFAULT 0,
      media_attachments TEXT DEFAULT '[]', published_at TEXT NOT NULL, fts_indexed INTEGER NOT NULL DEFAULT 1);
    CREATE VIRTUAL TABLE posts_fts USING fts5(post_id UNINDEXED, content, tokenize='trigram');
    CREATE TRIGGER posts_ai AFTER INSERT ON posts WHEN new.fts_indexed = 1 BEGIN
      INSERT INTO posts_fts(post_id, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER posts_ad AFTER DELETE ON posts BEGIN
      DELETE FROM posts_fts WHERE post_id = old.id;
    END;
    CREATE TABLE follows (id TEXT PRIMARY KEY, follower_url TEXT, following_url TEXT, inbox_url TEXT, is_local INTEGER,
      status TEXT DEFAULT 'accepted', created_at TEXT, UNIQUE(follower_url, following_url));
    CREATE TABLE reactions (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, user_id TEXT, user_name TEXT, user_icon TEXT DEFAULT '',
      reaction TEXT, is_local INTEGER DEFAULT 1, created_at TEXT, UNIQUE(post_id, user_id, reaction));
    CREATE TABLE announces (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, user_id TEXT, user_name TEXT, user_handle TEXT,
      user_icon TEXT DEFAULT '', is_local INTEGER DEFAULT 1, created_at TEXT, UNIQUE(post_id, user_id));
    CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT, actor_id TEXT, actor_name TEXT,
      actor_handle TEXT, actor_icon TEXT DEFAULT '', post_id TEXT, post_content TEXT DEFAULT '', content TEXT DEFAULT '',
      is_read INTEGER DEFAULT 0, created_at TEXT);
    CREATE TABLE bookmarks (user_id TEXT NOT NULL, post_id TEXT NOT NULL, created_at TEXT, PRIMARY KEY(user_id, post_id));
    CREATE TABLE pinned_posts (user_id TEXT NOT NULL, post_id TEXT NOT NULL, created_at TEXT,
      PRIMARY KEY(user_id, post_id), FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE);
    CREATE TABLE polls (id TEXT PRIMARY KEY, post_id TEXT NOT NULL UNIQUE, created_at TEXT,
      FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE);
    CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT, icon_url TEXT DEFAULT '');
    CREATE TABLE announcements (id TEXT PRIMARY KEY, title TEXT, content TEXT, is_active INTEGER, created_by TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE custom_emojis (id TEXT PRIMARY KEY, name TEXT, image_url TEXT);
    -- 本番と同じ索引（保持判定が post_id で引くため。主キーは (user_id, post_id) なので必要）
    CREATE INDEX idx_bookmarks_post ON bookmarks(post_id);
    CREATE INDEX idx_pinned_posts_post ON pinned_posts(post_id);
  `);

  const now = new Date().toISOString();
  db.prepare('INSERT INTO users (id, name, created_at, role, email, email_verified) VALUES (?,?,?,?,?,?)').run('alice', 'Alice', now, 'admin', 'alice@example.test', 1);
  db.prepare('INSERT INTO users (id, name, created_at, role, icon_url) VALUES (?,?,?,?,?)').run('bob', 'Bob', now, 'user', `${'http://x'}/uploads/alice/bob-avatar.png`);

  const insertPost = db.prepare(`INSERT INTO posts (id, user_id, author_name, author_url, author_handle, content, is_local, in_reply_to, media_attachments, published_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  // ローカル投稿（削除されてはいけない）
  insertPost.run('local-1', 'alice', 'Alice', 'http://local/users/alice', '@alice@local', 'ローカルの投稿', 1, null, '[]', iso(1));
  insertPost.run('local-2', 'alice', 'Alice', 'http://local/users/alice', '@alice@local', 'メディアつき', 1, null,
    JSON.stringify([{ url: 'http://local/uploads/alice/kept.png', key: 'alice/kept.png' }]), iso(2));

  // 古いリモート投稿（削除対象）。実際のノート程度の長さを持たせる
  const filler = 'リモートから流入したノート本文です。'.repeat(6);
  for (let i = 0; i < 2000; i++) {
    insertPost.run(`remote-old-${i}`, 'http://remote/users/u' + i, 'U', 'http://remote/users/u' + i, `@u${i}@remote`,
      `古いリモート投稿 ${i} ${filler}`, 0, null, '[]', iso(40 + (i % 5)));
  }
  // 新しいリモート投稿（保持）
  for (let i = 0; i < 50; i++) {
    insertPost.run(`remote-new-${i}`, 'http://remote/users/n' + i, 'N', 'http://remote/users/n' + i, `@n${i}@remote`,
      `新しいリモート投稿 ${i}`, 0, null, '[]', iso(1));
  }
  // 古いが残すべきリモート投稿
  insertPost.run('remote-bookmarked', 'http://remote/users/bm', 'BM', 'http://remote/users/bm', '@bm@remote', 'ブックマークされた古い投稿', 0, null, '[]', iso(100));
  insertPost.run('remote-pinned', 'http://remote/users/pin', 'PIN', 'http://remote/users/pin', '@pin@remote', 'ピン留めされた古い投稿', 0, null, '[]', iso(100));
  insertPost.run('remote-react', 'http://remote/users/re', 'RE', 'http://remote/users/re', '@re@remote', 'ローカルがリアクションした古い投稿', 0, null, '[]', iso(100));
  insertPost.run('remote-boosted', 'http://remote/users/bo', 'BO', 'http://remote/users/bo', '@bo@remote', 'ローカルがブーストした古い投稿', 0, null, '[]', iso(100));
  insertPost.run('remote-parent', 'http://remote/users/pa', 'PA', 'http://remote/users/pa', '@pa@remote', 'ローカル投稿の親', 0, null, '[]', iso(100));
  insertPost.run('remote-reply-to-local', 'http://remote/users/rl', 'RL', 'http://remote/users/rl', '@rl@remote', 'ローカル投稿への返信', 0, 'local-1', '[]', iso(100));
  insertPost.run('remote-followed', 'http://remote/users/fo', 'FO', 'http://remote/users/fo', '@fo@remote', 'フォロー中の人の投稿', 0, null, '[]', iso(100));

  // ローカル投稿が remote-parent を親にする／引用する
  const quoted = db.prepare('INSERT INTO posts (id, user_id, author_name, author_url, author_handle, content, is_local, in_reply_to, quote_id, published_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  quoted.run('local-reply', 'alice', 'Alice', 'http://local/users/alice', '@alice@local', 'リモートへの返信', 1, 'remote-parent', null, iso(5));
  quoted.run('local-quote', 'bob', 'Bob', 'http://local/users/bob', '@bob@local', '引用', 1, null, 'remote-parent', iso(5));

  db.prepare('INSERT INTO bookmarks (user_id, post_id, created_at) VALUES (?,?,?)').run('alice', 'remote-bookmarked', now);
  db.prepare('INSERT INTO pinned_posts (user_id, post_id, created_at) VALUES (?,?,?)').run('alice', 'remote-pinned', now);
  db.prepare('INSERT INTO reactions (id, post_id, user_id, user_name, reaction, is_local, created_at) VALUES (?,?,?,?,?,?,?)').run('r1', 'remote-react', 'alice', 'Alice', '⭐', 1, now);
  db.prepare('INSERT INTO announces (id, post_id, user_id, user_name, user_handle, is_local, created_at) VALUES (?,?,?,?,?,?,?)').run('a1', 'remote-boosted', 'alice', 'Alice', '@alice@local', 1, now);
  db.prepare('INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at) VALUES (?,?,?,?,?,?,?)').run('f1', 'http://local/users/alice', 'http://remote/users/fo', 'http://remote/inbox', 1, 'accepted', now);
  // 削除対象の投稿に対する、リモートからのリアクション（一緒に消えるべき）
  db.prepare('INSERT INTO reactions (id, post_id, user_id, user_name, reaction, is_local, created_at) VALUES (?,?,?,?,?,?,?)').run('r2', 'remote-old-1', 'http://remote/users/x', 'X', '⭐', 0, now);
  db.prepare('INSERT INTO announces (id, post_id, user_id, user_name, user_handle, is_local, created_at) VALUES (?,?,?,?,?,?,?)').run('a2', 'remote-old-2', 'http://remote/users/x', 'X', '@x@remote', 0, now);
  db.prepare('INSERT INTO notifications (id, user_id, type, actor_id, actor_name, actor_handle, post_id, created_at) VALUES (?,?,?,?,?,?,?,?)').run('n1', 'alice', 'reaction', 'x', 'X', '@x@remote', 'remote-old-3', now);
  db.prepare('INSERT INTO notifications (id, user_id, type, actor_id, actor_name, actor_handle, post_id, created_at) VALUES (?,?,?,?,?,?,?,?)').run('n2', 'alice', 'reply', 'x', 'X', '@x@remote', 'local-1', now);
  db.prepare('INSERT INTO polls (id, post_id, created_at) VALUES (?,?,?)').run('p1', 'remote-old-4', now);

  // 孤立メディア用のファイル
  fs.writeFileSync(path.join(uploadsDir, 'alice/kept.png'), Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(uploadsDir, 'alice/orphan.png'), Buffer.alloc(4096, 2));
  fs.writeFileSync(path.join(uploadsDir, 'alice/orphan2.webm'), Buffer.alloc(8192, 3));
  fs.writeFileSync(path.join(uploadsDir, 'alice/fresh.png'), Buffer.alloc(1024, 4));
  const past = new Date(Date.now() - 7 * 86400_000);
  fs.utimesSync(path.join(uploadsDir, 'alice/orphan.png'), past, past);
  fs.utimesSync(path.join(uploadsDir, 'alice/orphan2.webm'), past, past);

  // FTS を全投稿ぶん埋める（実 DB と同じく索引が大きい状態にする）
  db.exec("INSERT INTO posts_fts(post_id, content) SELECT id, content || ' ' || printf('%.0f', length(content)) FROM posts WHERE id NOT IN (SELECT post_id FROM posts_fts)");

  const pageCountBefore = (db.prepare('PRAGMA page_count').get() as any).page_count;
  console.log(`[setup] DB 作成: ${formatBytes(fs.statSync(dbPath).size)} (${pageCountBefore} ページ), 投稿 ${(db.prepare('SELECT COUNT(*) c FROM posts').get() as any).c} 件`);
  db.close();
}

// ---------------------------------------------------------------------------
// ① 削除計画
// ---------------------------------------------------------------------------
const options: MaintenanceOptions = { ...DEFAULT_MAINTENANCE_OPTIONS, retentionDays: 30 };
{
  const conn = openMaintenanceDb(dbPath);
  const db = createAsyncDatabase({ sqlite: conn });
  const plan = await planRemotePostRemoval(db, options);
  check('削除対象は古いリモート投稿のみ (2000件)', plan.byAge === 2000, `byAge=${plan.byAge}`);
  check('保持期間内の投稿は対象外', plan.total === 2000, `total=${plan.total}`);
  check('ブックマークされた投稿は残す', plan.keptByReason['ブックマーク'] === 1);
  check('ピン留めされた投稿は残す', plan.keptByReason['ピン留め'] === 1);
  check('ローカルのリアクションがある投稿は残す', plan.keptByReason['ローカルからのリアクション'] === 1);
  check('ローカルのブーストがある投稿は残す', plan.keptByReason['ローカルからのブースト'] === 1);
  check('ローカル投稿の親/引用元は残す', plan.keptByReason['ローカル投稿の返信先/引用元'] === 1, JSON.stringify(plan.keptByReason));
  check('ローカル投稿への返信は残す', plan.keptByReason['ローカル投稿への返信'] === 1);
  check('フォロー中アクターの投稿は残す', plan.keptByReason['フォロー中アクターの投稿'] === 1);

  // 件数上限の計画
  const capPlan = await planRemotePostRemoval(db, { ...options, retentionDays: 0, maxRemotePosts: 100 });
  check('件数上限でも削除計画が出る', capPlan.byCount > 0, `byCount=${capPlan.byCount}`);
  conn.close();
}

// ---------------------------------------------------------------------------
// ①-b 保持判定の「書き方」（ここが崩れると候補 1 件ごとにローカル投稿を全走査する）
// ---------------------------------------------------------------------------
{
  const conn = openMaintenanceDb(dbPath);
  // 実測（2026-10-02・投稿 32.4 万 / 削除対象 26.7 万）:
  //   相関 EXISTS + datetime() … 1 件あたり 71ms（全体で 5 時間相当）
  //   集合演算 + 文字列比較     … 全件 0.61 秒
  const keepSql = keepConditions(options).sql;
  check('保持判定で datetime() を使わない（列を包むと索引が効かない）', !/datetime\(/i.test(keepSql), keepSql);
  check('保持判定は集合演算（IN (SELECT …)）で書く', /IN \(SELECT/i.test(keepSql));

  const cutoff = new Date(Date.now() - (options.retentionDays || 30) * 86400_000).toISOString();
  const details = (
    conn
      .prepare(`EXPLAIN QUERY PLAN SELECT p.id FROM posts p WHERE p.is_local = 0 AND p.published_at < ? AND NOT (${keepSql})`)
      .all(cutoff) as any[]
  ).map((r) => String(r.detail));
  check(
    '相関サブクエリを使わない（候補 1 件ごとにローカル投稿を走査しない）',
    !details.some((d) => /CORRELATED SCALAR SUBQUERY/i.test(d)),
    details.join(' | '),
  );
  check(
    '外側の posts は索引で引く（テーブル全走査をしない）',
    !details.some((d) => /^SCAN p/.test(d)),
    details.join(' | '),
  );
  // 保持判定が使う索引が実在すること（無いと候補ごとに全走査になる）
  const indexes = (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as any[]).map((r) => r.name);
  check('bookmarks(post_id) の索引がある', indexes.includes('idx_bookmarks_post'));
  check('pinned_posts(post_id) の索引がある', indexes.includes('idx_pinned_posts_post'));
  conn.close();
}

// ---------------------------------------------------------------------------
// ①-c メンテナンス中に走った同時トランザクションが巻き戻されない
//
// バッチが生の `BEGIN IMMEDIATE` を流していると、ドライバはトランザクションが開いていることを
// 知らないので、同時リクエストの文がそのトランザクションに相乗りする。同時リクエストが
// 自分でトランザクションを張ろうとすると "cannot start a transaction within a transaction" になり、
// その ROLLBACK が**メンテナンスのバッチまで巻き戻す**（2026-10-02 に直した）。
// ---------------------------------------------------------------------------
{
  // **共有のフィクスチャを壊さないよう、DB をコピーしてから**この検査だけを行う
  // （ここで候補を全部消してしまうため）
  const workPath = `${dbPath}-a1.sqlite`;
  {
    const src = openMaintenanceDb(dbPath);
    src.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    src.close();
    fs.copyFileSync(dbPath, workPath);
  }
  const conn = openMaintenanceDb(workPath);
  const db = createAsyncDatabase({ sqlite: conn });
  // バッチが何度も回るように候補を増やす（1 バッチ 5000 件）
  const iso40 = new Date(Date.now() - 40 * 86400_000).toISOString();
  const fill = conn.prepare(
    "INSERT INTO posts (id, user_id, author_name, author_url, author_handle, content, is_local, published_at, fts_indexed) VALUES (?, 'remote', 'R', 'http://remote/fill', '@fill@remote', '古い', 0, ?, 0)",
  );
  conn.exec('BEGIN');
  for (let i = 0; i < 20000; i++) fill.run(`fill-${i}`, iso40);
  conn.exec('COMMIT');

  let done = false;
  const maintenance = applyRemotePostRemoval(db, options).then((c) => {
    done = true;
    return c;
  });
  // **マイクロタスクだけで交互に進める**。SQLite の文は `Promise.resolve(fn())` で解決するので、
  // 実際のリクエストもこの粒度でメンテナンスに割り込む（タイマー待ちにすると、
  // メンテナンスが一気に走り切ってしまい割り込みが起きない）。
  await Promise.resolve();

  let errors = 0;
  let writes = 0;
  while (!done && writes + errors < 20) {
    try {
      const key = `probe-${writes + errors}`;
      await withTransaction(db, async () => {
        await db.prepare('INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, 'x', new Date().toISOString());
      });
      writes++;
    } catch {
      errors++;
    }
    await Promise.resolve();
  }
  const counts = await maintenance;
  const probes = (conn.prepare("SELECT COUNT(*) AS c FROM server_settings WHERE key LIKE 'probe-%'").get() as any).c;
  check('メンテナンス中でも同時トランザクションがエラーにならない', errors === 0, `errors=${errors}`);
  check('同時トランザクションの書き込みが残る（巻き戻されない）', writes > 0 && probes === writes, `writes=${writes} probes=${probes}`);
  check('メンテナンスは最後まで進む', counts.posts > 20000, `posts=${counts.posts}`);
  conn.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${workPath}${suffix}`, { force: true });
}

// ---------------------------------------------------------------------------
// ② 孤立メディア（ドライラン → 実行）
// ---------------------------------------------------------------------------
{
  const conn = openMaintenanceDb(dbPath);
  const db = createAsyncDatabase({ sqlite: conn });
  const dry = await cleanupOrphanMedia(db, uploadsDir, options, false);
  check('孤立メディアを検出する (2件)', dry.orphanFiles === 2, `orphan=${dry.orphanFiles} samples=${dry.samples.join(',')}`);
  check('参照されているファイルは孤立扱いしない', !dry.samples.includes('alice/kept.png'));
  check('新しすぎるファイルは見送る', dry.skippedYoung === 1, `skippedYoung=${dry.skippedYoung}`);
  check('ドライランでは削除しない', fs.existsSync(path.join(uploadsDir, 'alice/orphan.png')));

  const applied = await cleanupOrphanMedia(db, uploadsDir, options, true);
  check('実行で孤立メディアを削除する', applied.orphanFiles === 2 && !fs.existsSync(path.join(uploadsDir, 'alice/orphan.png')), `orphan=${applied.orphanFiles}`);
  check('参照ファイルは残る', fs.existsSync(path.join(uploadsDir, 'alice/kept.png')));
  check('新しいファイルも残る', fs.existsSync(path.join(uploadsDir, 'alice/fresh.png')));
  conn.close();
}

// ---------------------------------------------------------------------------
// ③ + ④ 削除と VACUUM、バックアップ
// ---------------------------------------------------------------------------
{
  const conn = openMaintenanceDb(dbPath);
  const db = createAsyncDatabase({ sqlite: conn });
  const sizeBefore = await getDbSizeInfo(dbPath, db);
  const backup = backupDatabase(conn, dbPath, backupDir);
  check('VACUUM INTO でバックアップが作られる', fs.existsSync(backup.path) && backup.bytes > 0, `${backup.path} ${backup.bytes}`);

  // バックアップは削除前の状態なので、対象投稿がまだ残っている（復元可能性の確認）
  const bdb = new DatabaseSync(backup.path, { readOnly: true });
  check('バックアップは削除前の内容を保持している', (bdb.prepare('SELECT COUNT(*) c FROM posts').get() as any).c > 250);
  bdb.close();

  const removed = await applyRemotePostRemoval(db, options);
  check('2000 件のリモート投稿を削除', removed.posts === 2000, `posts=${removed.posts}`);
  check('FTS 索引も同時に削除', removed.fts === 2000, `fts=${removed.fts}`);
  check('従属するリアクションを削除', removed.reactions === 1, `reactions=${removed.reactions}`);
  check('従属するブーストを削除', removed.announces === 1, `announces=${removed.announces}`);
  check('従属する通知を削除（ローカル投稿宛は残す）', removed.notifications === 1, `notifications=${removed.notifications}`);
  check('従属するアンケートを削除', removed.polls === 1, `polls=${removed.polls}`);

  const remaining = async (sql: string): Promise<number> => Number((await db.prepare(sql).get() as any).c);
  check('ローカル投稿は残っている', await remaining('SELECT COUNT(*) c FROM posts WHERE is_local = 1') === 4, `local=${await remaining('SELECT COUNT(*) c FROM posts WHERE is_local = 1')}`);
  check('保持対象のリモート投稿は残っている', await remaining('SELECT COUNT(*) c FROM posts WHERE is_local = 0') === 57, `remote=${await remaining('SELECT COUNT(*) c FROM posts WHERE is_local = 0')}`);
  check('ブックマークされた投稿が残っている', await remaining("SELECT COUNT(*) c FROM posts WHERE id = 'remote-bookmarked'") === 1);
  check('FTS からも消えている', await remaining("SELECT COUNT(*) c FROM posts_fts WHERE post_id LIKE 'remote-old-%'") === 0);
  check('FTS に残す投稿は残っている', await remaining("SELECT COUNT(*) c FROM posts_fts WHERE post_id = 'local-1'") === 1);
  check('ローカル投稿宛の通知は残る', await remaining("SELECT COUNT(*) c FROM notifications WHERE id = 'n2'") === 1);
  check('ローカル投稿は削除されていない（整合性）', await remaining("SELECT COUNT(*) c FROM posts WHERE id IN ('local-1','local-2','local-reply','local-quote')") === 4);
  check('孤立 FTS 行が残っていない', await remaining('SELECT COUNT(*) c FROM posts_fts WHERE post_id NOT IN (SELECT id FROM posts)') === 0);

  // FTS 同期トリガが元に戻っていること（今後の投稿で壊れないこと）
  const triggers = ((await db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'posts_ad'").all()) as any[]).length;
  check('FTS 同期トリガが復元されている', triggers === 1, `triggers=${triggers}`);
  await db.prepare(`INSERT INTO posts (id, user_id, author_name, author_url, author_handle, content, is_local, media_attachments, published_at)
    VALUES ('after-maint', 'alice', 'Alice', 'http://local/users/alice', '@alice@local', 'メンテナンス後の投稿', 1, '[]', ?)`).run(new Date().toISOString());
  check('メンテナンス後の投稿が FTS に入る', await remaining("SELECT COUNT(*) c FROM posts_fts WHERE post_id = 'after-maint'") === 1);
  await db.prepare("DELETE FROM posts WHERE id = 'after-maint'").run();
  check('メンテナンス後の削除で FTS からも消える', await remaining("SELECT COUNT(*) c FROM posts_fts WHERE post_id = 'after-maint'") === 0);

  const optimized = optimizeDatabase(conn);
  check('wal_checkpoint + VACUUM が成功する', optimized.checkpointed && optimized.vacuumed, JSON.stringify(optimized));
  check('FTS セグメントのマージも行う', optimized.ftsOptimized, JSON.stringify(optimized));
  const sizeAfter = await getDbSizeInfo(dbPath, db);
  console.log(
    `[info] DB: ${formatBytes(sizeBefore.dbBytes)} -> ${formatBytes(sizeAfter.dbBytes)} ` +
      `/ ページ ${sizeBefore.pageCount}(空き ${sizeBefore.freelistCount}) -> ${sizeAfter.pageCount}(空き ${sizeAfter.freelistCount})`,
  );
  check('VACUUM で DB が縮む', sizeAfter.dbBytes < sizeBefore.dbBytes, `${formatBytes(sizeBefore.dbBytes)} -> ${formatBytes(sizeAfter.dbBytes)}`);
  conn.close();
}

// ---------------------------------------------------------------------------
// バックアップの世代管理
// ---------------------------------------------------------------------------
{
  const db = openMaintenanceDb(dbPath);
  for (let i = 0; i < 3; i++) {
    const b = backupDatabase(db, dbPath, backupDir);
    // 連続実行でも同名にならないよう mtime をずらす
    fs.utimesSync(b.path, new Date(Date.now() - (3 - i) * 1000), new Date(Date.now() - (3 - i) * 1000));
  }
  const before = fs.readdirSync(backupDir).filter((f) => f.endsWith('.sqlite'));
  const removedFiles = rotateBackups(backupDir, 2);
  const after = fs.readdirSync(backupDir).filter((f) => f.endsWith('.sqlite'));
  check('古いバックアップを世代数までに整理する', after.length === 2 && removedFiles.length === before.length - 2, `before=${before.length} after=${after.length} removed=${removedFiles.length}`);
  check('最新のバックアップが残っている', fs.existsSync(path.join(backupDir, after.sort().pop()!)));
  db.close();
}

// ---------------------------------------------------------------------------
// runMaintenance（CLI が使う入口・ドライランと実行）
// ---------------------------------------------------------------------------
{
  const dry = await runMaintenance({
    dbPath,
    uploadsDir,
    backupDir,
    options,
    apply: false,
    backup: true,
    vacuum: true,
    backupsKeep: 3,
  });
  check('ドライランでは削除しない', dry.applied === false && dry.removed.posts === 0);
  check('ドライランでも孤立メディアを数える', dry.media.orphanFiles === 0, `orphan=${dry.media.orphanFiles}`);

  const run = await runMaintenance({
    dbPath,
    uploadsDir,
    backupDir,
    options,
    apply: true,
    backup: true,
    vacuum: true,
    backupsKeep: 3,
    log: () => {},
  });
  check('実行モードではバックアップと VACUUM が走る', Boolean(run.backup) && run.optimize?.vacuumed === true);
  check('2回目の実行で削除対象は 0 件（冪等）', run.removed.posts === 0, `posts=${run.removed.posts}`);
}

// ---------------------------------------------------------------------------
console.log(`\n===== ${pass} PASS / ${fail} FAIL =====`);
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {}
process.exit(fail === 0 ? 0 : 1);
