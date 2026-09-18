import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE posts (id TEXT PRIMARY KEY, content TEXT);
  CREATE VIRTUAL TABLE posts_fts USING fts5(post_id UNINDEXED, content, tokenize='trigram');
  CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN
    INSERT INTO posts_fts(post_id, content) VALUES (new.id, new.content);
  END;
`);

db.exec("INSERT INTO posts VALUES ('p1', '今日は青い星Spicaを観測しました。とても美しい星光です。');");

function searchPosts(q) {
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  // 各単語が3文字以上かどうか判定
  const hasLongTerm = terms.some((t) => t.length >= 3);

  if (hasLongTerm) {
    // 3文字以上の単語がある場合は FTS5 で高速検索
    const ftsQuery = terms.filter((t) => t.length >= 3).map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
    console.log(`[Search] Using FTS5 query: ${ftsQuery}`);
    return db.prepare(`
      SELECT p.id, p.content
      FROM posts_fts f
      JOIN posts p ON f.post_id = p.id
      WHERE posts_fts MATCH ?
    `).all(ftsQuery);
  } else {
    // 短い単語（1〜2文字）の場合は LIKE 検索
    console.log(`[Search] Using LIKE fallback for short query: "${q}"`);
    let query = 'SELECT p.id, p.content FROM posts p WHERE ';
    const conditions = terms.map(() => 'p.content LIKE ?').join(' AND ');
    const params = terms.map((t) => `%${t}%`);
    return db.prepare(query + conditions).all(...params);
  }
}

console.log('1文字「星」:', searchPosts('星'));
console.log('2文字「観測」:', searchPosts('観測'));
console.log('3文字「美しい」:', searchPosts('美しい'));
console.log('英単語「Spica」:', searchPosts('Spica'));
console.log('複合「青い星 観測」:', searchPosts('青い星 観測'));
