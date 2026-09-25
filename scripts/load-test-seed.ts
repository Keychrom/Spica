/**
 * 負荷試験用のデータを仕込む
 *
 *   npx tsx scripts/load-test-seed.ts --db .bench/live-snapshot.sqlite --token-out .bench/token
 *
 * 何をするか:
 *   ・ベンチ用のユーザー（既定 `bench`）と、そのユーザーのセッション（API を叩くためのトークン）を作る
 *   ・**投稿数の多い順**に N 人（既定 150 人）をフォローさせる（ホームタイムラインを重くするため）
 *   ・同じ SQLite をコピー／PostgreSQL へ移送して使うので、**両構成でまったく同じデータ**になる
 *
 * 注意:
 *   ・既存の DB を書き換える。**ライブの DB では実行しない**（スナップショットに対して実行する）
 *   ・トークンは標準出力に出さず `--token-out` のファイルに書く
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function valueOf(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dbPath = valueOf('--db');
if (!dbPath) {
  console.error('❌ --db <SQLite のパス> を指定してください');
  process.exit(2);
}
const userId = valueOf('--user') || 'bench';
const followCount = parseInt(valueOf('--follows') || '150', 10);
const origin = (valueOf('--origin') || 'http://localhost:3900').replace(/\/+$/, '');
const tokenOut = valueOf('--token-out');
const token = valueOf('--token') || crypto.randomBytes(24).toString('hex');

const db = new DatabaseSync(dbPath);
const now = new Date();
const actorUrl = `${origin}/users/${userId}`;

const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as { id: string } | undefined;
if (!existing) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  db.prepare(
    `INSERT INTO users (id, name, summary, master_key_hash, role, is_frozen, public_key_pem, private_key_pem, created_at, email_verified, discoverable)
     VALUES (?, ?, ?, ?, 'user', 0, ?, ?, ?, 0, 1)`,
  ).run(
    userId,
    '負荷試験用のユーザー',
    '負荷試験のためだけに作られたアカウントです。',
    crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'),
    publicKey,
    privateKey,
    now.toISOString(),
  );
}

// セッション（`/api/*` を本人として叩くため）
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
  token,
  userId,
  now.toISOString(),
  new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString(),
);

// 投稿数の多い順にフォローする（ホームタイムラインが実際に重くなる相手を選ぶ）
const topAuthors = db
  .prepare('SELECT author_url, COUNT(*) AS c FROM posts GROUP BY author_url ORDER BY c DESC LIMIT ?')
  .all(followCount) as { author_url: string; c: number }[];

db.prepare('DELETE FROM follows WHERE follower_url = ?').run(actorUrl);
const insertFollow = db.prepare(
  `INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
   VALUES (?, ?, ?, ?, 0, 'accepted', ?)
   ON CONFLICT(follower_url, following_url) DO NOTHING`,
);
let added = 0;
for (const author of topAuthors) {
  const result = insertFollow.run(
    crypto.randomUUID(),
    actorUrl,
    author.author_url,
    `${author.author_url.replace(/\/users\/.*$/, '')}/inbox`,
    now.toISOString(),
  );
  added += Number(result.changes ?? 0);
}

const followingPosts = db
  .prepare('SELECT COUNT(*) AS c FROM posts WHERE author_url IN (SELECT following_url FROM follows WHERE follower_url = ?)')
  .get(actorUrl) as { c: number };
const totalPosts = db.prepare('SELECT COUNT(*) AS c FROM posts').get() as { c: number };

console.log(`✅ 種付け完了 ${dbPath}`);
console.log(`   ユーザー: ${userId}（${actorUrl}）`);
console.log(`   フォロー: ${topAuthors.length} 人中 ${added} 人を追加（合計 ${followingPosts.c.toLocaleString()} 投稿がホームの対象）`);
console.log(`   全投稿: ${totalPosts.c.toLocaleString()}`);
if (tokenOut) {
  fs.writeFileSync(tokenOut, token);
  console.log(`   トークン: ${tokenOut} に書き出しました`);
}
db.close();
