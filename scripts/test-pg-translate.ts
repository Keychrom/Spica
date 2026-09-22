/**
 * SQL 翻訳（SQLite → PostgreSQL）の検証 (`npm run test:pg-translate`)
 *
 * PostgreSQL が無くても動きます（翻訳は純関数のため）。
 * プレースホルダの無限ループを作り込んだ反省から、機械的に検証できる形にしてあります。
 */
import { translateSqlForPostgres, splitFtsTerms } from '../server/src/db/driver.js';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}\n     実際: ${JSON.stringify(actual)}\n     期待: ${JSON.stringify(expected)}`);
  }
}

/** 主キーを持つテーブルの想定（INSERT OR REPLACE 用） */
const primaryKeys: Record<string, string[]> = {
  posts_fts: ['post_id'],
  server_settings: ['key'],
  bookmarks: ['user_id', 'post_id'],
};
const resolvePrimaryKey = (table: string): string[] => primaryKeys[table] ?? [];

console.log('SQL 翻訳のテスト（SQLite → PostgreSQL）');
console.log('');

// ── プレースホルダ ────────────────────────────────────────
console.log('🔢 プレースホルダ');
check(
  '? を $1, $2 に置き換える',
  translateSqlForPostgres('SELECT * FROM users WHERE id = ? AND name = ?', ['a', 'b'], resolvePrimaryKey),
  { sql: 'SELECT * FROM users WHERE id = $1 AND name = $2', params: ['a', 'b'] },
);
check(
  '文字列リテラル内の ? は触らない',
  translateSqlForPostgres("SELECT * FROM posts WHERE content LIKE '%?%' AND id = ?", ['x'], resolvePrimaryKey),
  // LIKE は ILIKE に寄せる（SQLite の LIKE は ASCII で大文字小文字を区別しない）が、
  // 文字列リテラルの中身（'%?%'）とプレースホルダの数は変わらない
  { sql: "SELECT * FROM posts WHERE content ILIKE '%?%' AND id = $1", params: ['x'] },
);
check(
  'コメント内の ? は触らない',
  translateSqlForPostgres('SELECT 1 -- ? はコメント\nWHERE id = ?', ['y'], resolvePrimaryKey),
  { sql: 'SELECT 1 -- ? はコメント\nWHERE id = $1', params: ['y'] },
);
check(
  'エスケープされた引用符（\'\'）を跨がない',
  translateSqlForPostgres("SELECT * FROM t WHERE a = 'it''s ?' AND b = ?", [1], resolvePrimaryKey),
  { sql: "SELECT * FROM t WHERE a = 'it''s ?' AND b = $1", params: [1] },
);

// ── INSERT OR 系 ─────────────────────────────────────────
console.log('\n📥 INSERT OR IGNORE / REPLACE');
check(
  'INSERT OR IGNORE は ON CONFLICT DO NOTHING',
  translateSqlForPostgres('INSERT OR IGNORE INTO posts_fts (post_id, content) VALUES (?, ?)', ['p1', 'x'], resolvePrimaryKey),
  { sql: 'INSERT INTO posts_fts (post_id, content) VALUES ($1, $2) ON CONFLICT DO NOTHING', params: ['p1', 'x'] },
);
check(
  'INSERT OR REPLACE は主キーでの UPSERT',
  translateSqlForPostgres('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)', ['k', 'v'], resolvePrimaryKey),
  {
    sql: 'INSERT INTO server_settings (key, value) VALUES ($1, $2) ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"',
    params: ['k', 'v'],
  },
);
check(
  '複合主キーでも UPSERT できる',
  translateSqlForPostgres('INSERT OR REPLACE INTO bookmarks (user_id, post_id, created_at) VALUES (?, ?, ?)', ['u', 'p', 'now'], resolvePrimaryKey),
  {
    sql: 'INSERT INTO bookmarks (user_id, post_id, created_at) VALUES ($1, $2, $3) ON CONFLICT ("user_id", "post_id") DO UPDATE SET "created_at" = EXCLUDED."created_at"',
    params: ['u', 'p', 'now'],
  },
);
check(
  '主キーが分からないテーブルは DO NOTHING に落とす',
  translateSqlForPostgres('INSERT OR REPLACE INTO unknown_table (a, b) VALUES (?, ?)', [1, 2], resolvePrimaryKey),
  { sql: 'INSERT INTO unknown_table (a, b) VALUES ($1, $2) ON CONFLICT DO NOTHING', params: [1, 2] },
);

// ── 方言の吸収 ───────────────────────────────────────────
console.log('\n🔧 方言の吸収');
check(
  'datetime(x) を外す（ISO 8601 の TEXT 比較で等価）',
  translateSqlForPostgres("SELECT COUNT(*) AS c FROM posts WHERE datetime(published_at) < datetime('2026-09-01T00:00:00.000Z')", [], resolvePrimaryKey),
  { sql: 'SELECT COUNT(*) AS c FROM posts WHERE published_at < \'2026-09-01T00:00:00.000Z\'', params: [] },
);
check(
  'temp. を pg_temp. にする',
  translateSqlForPostgres('CREATE TEMP TABLE _t (id TEXT); SELECT id FROM temp._t WHERE id = ?', ['a'], resolvePrimaryKey).sql.split(';')[1].trim(),
  'SELECT id FROM pg_temp._t WHERE id = $1',
);
check(
  'PRAGMA は無効化する（呼び出し側で処理する前提の保険）',
  translateSqlForPostgres('PRAGMA table_info(users)', [], resolvePrimaryKey),
  { sql: 'SELECT 1 AS noop', params: [] },
);
check(
  'IFNULL を COALESCE にする（通報の重複判定で使っている）',
  translateSqlForPostgres("SELECT id FROM reports WHERE user_id = ? AND IFNULL(target_post_id, '') = IFNULL(?, '')", ['u1', 'p1'], resolvePrimaryKey),
  { sql: "SELECT id FROM reports WHERE user_id = $1 AND COALESCE(target_post_id, '') = COALESCE($2, '')", params: ['u1', 'p1'] },
);
check(
  'LIKE を ILIKE にする（SQLite の LIKE は ASCII で大文字小文字を区別しない）',
  translateSqlForPostgres('SELECT id FROM users WHERE id LIKE ? OR handle NOT LIKE ?', ['%a%', '%b%'], resolvePrimaryKey),
  { sql: 'SELECT id FROM users WHERE id ILIKE $1 OR handle NOT ILIKE $2', params: ['%a%', '%b%'] },
);
check(
  '既に ILIKE のものは二重にしない',
  translateSqlForPostgres('SELECT id FROM posts WHERE content ILIKE ?', ['%x%'], resolvePrimaryKey),
  { sql: 'SELECT id FROM posts WHERE content ILIKE $1', params: ['%x%'] },
);
check(
  'like_count のような列名は書き換えない',
  translateSqlForPostgres('SELECT like_count FROM posts WHERE id = ?', ['p1'], resolvePrimaryKey),
  { sql: 'SELECT like_count FROM posts WHERE id = $1', params: ['p1'] },
);

// ── FTS ──────────────────────────────────────────────────
console.log('\n🔎 FTS（trigram 相当）');
check(
  'posts_fts MATCH ? は ILIKE の AND に展開する',
  translateSqlForPostgres(
    'SELECT p.id FROM posts_fts f JOIN posts p ON f.post_id = p.id WHERE posts_fts MATCH ? ORDER BY p.published_at DESC',
    ['"検索" "テスト"'],
    resolvePrimaryKey,
  ),
  {
    sql: 'SELECT p.id FROM posts_fts f JOIN posts p ON f.post_id = p.id WHERE f.content ILIKE $1 AND f.content ILIKE $2 ORDER BY p.published_at DESC',
    params: ['%検索%', '%テスト%'],
  },
);
check(
  'MATCH の後ろに別のパラメータがあっても順序が壊れない',
  translateSqlForPostgres(
    'SELECT * FROM posts_fts f WHERE posts_fts MATCH ? AND f.post_id = ?',
    ['"a"', 'p1'],
    resolvePrimaryKey,
  ),
  { sql: 'SELECT * FROM posts_fts f WHERE f.content ILIKE $1 AND f.post_id = $2', params: ['%a%', 'p1'] },
);
check(
  '空の検索語は TRUE（全件）にする',
  translateSqlForPostgres('SELECT * FROM posts_fts f WHERE posts_fts MATCH ?', [''], resolvePrimaryKey),
  { sql: 'SELECT * FROM posts_fts f WHERE TRUE', params: [] },
);
check('bm25 は公開時刻に置き換える', translateSqlForPostgres('ORDER BY bm25(posts_fts), p.published_at DESC', [], resolvePrimaryKey).sql,
  'ORDER BY p.published_at, p.published_at DESC');
check('語の分解（引用符と "" の解除）', splitFtsTerms('"日本 語" "テスト""x"'), ['日本 語', 'テスト"x']);

// ── 現実のクエリで無限ループしないこと（回帰テスト）─────
console.log('\n🛡️ 回帰（無限ループの再発防止）');
const realQueries: [string, unknown[]][] = [
  ['SELECT value FROM server_settings WHERE key = ?', ['auto_maintenance']],
  ['SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type NOT IN (?, ?)', ['alice', 'reaction', 'follow']],
  ['UPDATE users SET notification_prefs = ? WHERE id = ?', ['{}', 'alice']],
  ['SELECT id FROM posts WHERE is_local = 0 ORDER BY published_at DESC LIMIT ?', [50]],
  ['INSERT INTO posts_fts(post_id, content) SELECT id, content FROM posts WHERE fts_indexed = 1 AND NOT EXISTS (SELECT 1 FROM posts_fts f WHERE f.post_id = posts.id)', []],
  ["SELECT * FROM posts WHERE id IN (?, ?, ?) AND content LIKE '%?%'", ['a', 'b', 'c']],
];
let loopGuardOk = true;
for (const [sql, params] of realQueries) {
  const started = Date.now();
  const result = translateSqlForPostgres(sql, params, resolvePrimaryKey);
  const elapsed = Date.now() - started;
  // 期待: SQL に現れる $n の個数がパラメータ数と一致する
  //（文字列リテラル内の `?` は正当なので、? の有無では判定しない）
  const placeholders = (result.sql.match(/\$\d+/g) ?? []).length;
  if (elapsed > 1000 || result.params.length !== params.length || placeholders !== params.length) {
    loopGuardOk = false;
    console.log(
      `     ⚠️ ${sql.slice(0, 60)} → パラメータ ${result.params.length} / プレースホルダ ${placeholders} / ${elapsed}ms`,
    );
  }
}
check('実際に使われるクエリで無限ループせず、プレースホルダも揃う', loopGuardOk, true);

console.log('');
console.log(`結果: ${passed} 件成功 / ${failed} 件失敗`);
process.exit(failed > 0 ? 1 : 0);
