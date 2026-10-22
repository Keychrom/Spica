/**
 * アンテナの「リスト」ソース（src = 'list'）の共通処理。
 *
 * 拾う対象は **アンテナの持ち主が作ったリストのメンバーだけ**。
 * リストの id は antennas.user_list に入れる（src = 'users' のときはユーザー一覧なので兼用）。
 * Misskey API の `userListId` がこれに当たる。
 *
 * メンバーの保存形式は routes/lists.ts のとおりで、ローカルは `alice`、
 * リモートは `@eve@remote.test`（actor URL が分かっている場合は URL）になる。
 */
import { config } from './config.js';
import { db } from './db.js';

/** 比較用に前後の @ と大文字小文字を落とす */
export function normalizeListMember(raw: unknown): string {
  return String(raw || '').trim().replace(/^@+/, '').toLowerCase();
}

/**
 * 投稿がリストのメンバーに一致するか（**DB を引かない**）。
 * 通知の判定のように投稿 1 件 × アンテナ数ぶん呼ばれる場所で使う。
 */
export function postMatchesListMembers(post: any, members: readonly string[]): boolean {
  if (members.length === 0) return false;
  const userId = String(post.user_id || '').toLowerCase();
  const authorUrl = String(post.author_url || '').toLowerCase();
  const handle = String(post.author_handle || '').toLowerCase().replace(/^@/, '');
  return members.some((raw) => {
    const member = normalizeListMember(raw);
    if (!member) return false;
    // actor URL（リモートで解決できた人）
    if (member.includes('/')) return userId === member || authorUrl === member;
    // リモートのハンドル（@eve@remote.test）
    if (member.includes('@')) return handle === member;
    // ローカルのユーザー ID。別ドメインの同名ユーザーを拾わないよう actor URL まで見る
    return userId === member || authorUrl === `${config.origin}/users/${member}`.toLowerCase();
  });
}

/**
 * アンテナのタイムライン用の WHERE 条件を作る（`p` は posts の別名）。
 * メンバーが 0 人なら **1=0**（条件を足さないと全投稿に一致してしまう）。
 */
export function listMemberCondition(members: readonly string[], params: any[]): string {
  const conditions: string[] = [];
  for (const raw of members) {
    const member = normalizeListMember(raw);
    if (!member) continue;
    if (member.includes('/')) {
      conditions.push('(LOWER(p.user_id) = ? OR LOWER(p.author_url) = ?)');
      params.push(member, member);
    } else if (member.includes('@')) {
      conditions.push('(LOWER(p.author_handle) = ? OR LOWER(p.author_url) = ?)');
      params.push(`@${member}`, member);
    } else {
      conditions.push('(LOWER(p.user_id) = ? OR LOWER(p.author_url) = ?)');
      params.push(member, `${config.origin}/users/${member}`.toLowerCase());
    }
  }
  return conditions.length > 0 ? `(${conditions.join(' OR ')})` : '1=0';
}

/**
 * リストのメンバーを取る。**持ち主でないリストは空**（他人のリストをアンテナに指定できない）。
 */
export async function getAntennaListMembers(listId: string, ownerId: string): Promise<string[]> {
  const id = String(listId || '').trim();
  if (!id) return [];
  const rows = (await db
    .prepare(`
      SELECT lm.member
      FROM list_members lm
      JOIN lists l ON l.id = lm.list_id
      WHERE lm.list_id = ? AND l.user_id = ?
      ORDER BY lm.created_at ASC
    `)
    .all(id, ownerId)) as { member: string }[];
  return rows.map((row) => row.member).filter(Boolean);
}

/** 通知の判定用に、複数リストのメンバーを 1 回で引くための鍵 */
export function antennaListKey(ownerId: string, listId: string): string {
  return `${String(ownerId || '').toLowerCase()}\u0000${String(listId || '').trim()}`;
}

/**
 * 通知の判定用の一括取得。戻り値の鍵は antennaListKey(owner, list)。
 * 持ち主が一致しないリストのメンバーは含めない。
 */
export async function getAntennaListMembersBatch(listIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const ids = Array.from(new Set(listIds.map((id) => String(id || '').trim()).filter(Boolean)));
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = (await db
      .prepare(`
        SELECT lm.list_id, l.user_id AS owner_id, lm.member
        FROM list_members lm
        JOIN lists l ON l.id = lm.list_id
        WHERE lm.list_id IN (${chunk.map(() => '?').join(',')})
      `)
      .all(...chunk)) as { list_id: string; owner_id: string; member: string }[];
    for (const row of rows) {
      const key = antennaListKey(row.owner_id, row.list_id);
      const members = map.get(key) || [];
      members.push(row.member);
      map.set(key, members);
    }
  }
  return map;
}
