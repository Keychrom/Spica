/**
 * フォロー欄の識別子と「おすすめ」の除外を確かめる（下見）。
 *   BASE=http://127.0.0.1:3747 npx tsx scripts/check-follow-people.ts
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3747';
const realFetch = globalThis.fetch;
(globalThis as any).fetch = (input: any, init?: any) =>
  typeof input === 'string' && input.startsWith('/') ? realFetch(`${BASE}${input}`, init) : realFetch(input, init);
(globalThis as any).window = { location: { origin: BASE } };

const api = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await realFetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
};

let bad = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) bad++;
};

const stamp = Date.now().toString(36);
const alice = await api('POST', '/api/auth/register', undefined, { id: `alice${stamp}`, name: 'Alice', agreedToRules: true });
const bob = await api('POST', '/api/auth/register', undefined, { id: `bob${stamp}`, name: 'Bob', agreedToRules: true });
const aliceToken = alice.data.sessionToken as string;
const aliceId = `alice${stamp}`;
const bobId = `bob${stamp}`;

// リモートの相手を 1 人足す（フォローは DB に直接入れる）
const { createAsyncDatabase } = await import('../server/src/db/asyncDriver.js');
const dbPath = process.env.DB_PATH || 'server/data_follow_check.sqlite';
const conn = createAsyncDatabase({ driver: 'sqlite', dbPath });
const run = async (sql: string, ...params: unknown[]) => {
  for (let i = 0; i < 20; i++) {
    try {
      await conn.prepare(sql).run(...params);
      return;
    } catch (err: any) {
      if (i === 19 || !String(err?.message || '').includes('locked')) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
};
const remoteActor = 'https://remote.test/users/eve';
await run(
  `INSERT INTO remote_actors (id, username, domain, name, icon_url, inbox_url, public_key_id, public_key_pem, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?)
   ON CONFLICT(id) DO NOTHING`,
  remoteActor, 'eve', 'remote.test', 'Eve', '', `${remoteActor}/inbox`, `${remoteActor}#main-key`, '', new Date().toISOString());

// alice → bob（ローカル）と alice → eve（リモート）のフォロー
await api('POST', '/api/follow', aliceToken, { targetHandle: `@${bobId}@${new URL(BASE).host}` });
await run(
  `INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
   VALUES (?,?,?,?,0,?,?)
   ON CONFLICT(id) DO NOTHING`,
  `f-${stamp}`, `${BASE}/users/${aliceId}`, remoteActor, `${remoteActor}/inbox`, 'accepted', new Date().toISOString());

console.log('🧪 フォロー欄');
const following = await api('GET', `/api/following?userId=${aliceId}`, aliceToken);
const rows = following.data as any[];
check('フォロー一覧が返る', Array.isArray(rows) && rows.length === 2, `${rows?.length} 件`);
const localRow = rows.find((r) => r.following_url === `${BASE}/users/${bobId}`);
const remoteRow = rows.find((r) => r.following_url === remoteActor);
check('ローカルの行に following_url がある', Boolean(localRow));
check('一覧の id は follows の行 ID（相手の ID ではない）', Boolean(localRow && localRow.id !== bobId), `id=${localRow?.id}`);

const { personIdentifier } = await import('../client/src/lib/profile.js');
const localTarget = personIdentifier(localRow);
const remoteTarget = personIdentifier(remoteRow);
check('ローカルの相手は素の ID になる', localTarget === bobId, localTarget);
check('リモートの相手は actor URL のまま', remoteTarget === remoteActor, remoteTarget);

// 直す前の形（行 ID のまま）では開けない＝不具合の再現
const broken = await api('GET', `/api/users/${encodeURIComponent(localRow.id)}`);
check('行 ID のままでは開けない（直す前の不具合）', broken.status === 404, `HTTP ${broken.status}`);
const fixedLocal = await api('GET', `/api/users/${encodeURIComponent(localTarget)}`);
check('直した形ならローカルのプロフィールが開く', fixedLocal.status === 200 && fixedLocal.data?.id === bobId, `HTTP ${fixedLocal.status}`);

console.log('\n🧪 おすすめ（ディレクトリ）');
const withToken = await api('GET', '/api/directory', aliceToken);
const idsWith = ((withToken.data as any)?.users ?? []).map((u: any) => u.id);
check('フォロー中の相手は出ない', !idsWith.includes(bobId), idsWith.join(', '));
check('自分も出ない', !idsWith.includes(aliceId));
const withoutToken = await api('GET', '/api/directory');
const idsWithout = ((withoutToken.data as any)?.users ?? []).map((u: any) => u.id);
check('未ログインの公開一覧には出る（変えていない）', idsWithout.includes(bobId), idsWithout.join(', '));

await conn.close();
console.log('');
console.log(bad === 0 ? '🎉 すべて確認できました' : `❌ ${bad} 件失敗`);
process.exit(bad === 0 ? 0 : 1);
