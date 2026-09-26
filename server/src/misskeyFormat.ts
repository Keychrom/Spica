import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';

/**
 * Misskey 互換 API のための整形（ID・ノート・ユーザー・通知）。
 *
 * Misskey の ID は `aid`（時刻を base36 にしたもの）で、**文字列として並べると時刻順**になる。
 * サードパーティ製クライアントは `untilId` / `sinceId` でのページングにこれを使い、
 * 手元での並べ替えにも使う。Spica の投稿 ID は `https://…/users/x/posts/1699…_ab12` という
 * URI なので、そのまま返すと**並べ替えが壊れる**（文字列比較が時刻順にならない）。
 *
 * そこで外には `<base36(ミリ秒)><8文字のハッシュ>` という Misskey 風の ID を出し、
 * 受け取ったときは時刻の前後 ±2 秒の範囲を引いてハッシュで照合する（索引が効くので 1 件の
 * レンジ走査で済む。テーブルを増やさずに可逆にするための工夫）。
 */

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_WINDOW_MS = 2000;

function toBase36(value: number): string {
  let n = Math.max(0, Math.floor(value));
  if (n === 0) return '0';
  let out = '';
  while (n > 0) {
    out = BASE36[n % 36] + out;
    n = Math.floor(n / 36);
  }
  return out;
}

function fromBase36(value: string): number {
  let n = 0;
  for (const ch of value) {
    const digit = BASE36.indexOf(ch);
    if (digit < 0) return NaN;
    n = n * 36 + digit;
  }
  return n;
}

/** キー（種別 + 正規 ID）から 8 文字のハッシュを作る */
function keyHash(key: string): string {
  const digest = crypto.createHash('sha256').update(key).digest();
  let n = 0;
  for (let i = 0; i < 6; i++) {
    n = n * 256 + digest[i];
  }
  return toBase36(n).padStart(8, '0').slice(0, 8);
}

export type MisskeyIdKind = 'post' | 'announce' | 'notification';

export interface MisskeyTarget {
  kind: MisskeyIdKind;
  /** 正規 ID（posts.id / announces.id / notifications.id） */
  id: string;
  /** 並べ替えと範囲検索に使う時刻（ISO 文字列） */
  at: string;
}

/** Spica の ID を Misskey 風の ID に変換する */
export function encodeMisskeyId(kind: MisskeyIdKind, id: string, at: string): string {
  const ms = new Date(at).getTime();
  const time = Number.isFinite(ms) ? ms : Date.now();
  return `${toBase36(time)}${keyHash(`${kind}:${id}`)}`;
}

/** Misskey 風の ID から時刻とハッシュを取り出す */
function parseMisskeyId(id: string): { ms: number; hash: string } | null {
  const value = String(id || '').trim();
  if (value.length < 9) return null;
  const hash = value.slice(-8);
  const ms = fromBase36(value.slice(0, -8));
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (!/^[0-9a-z]{8}$/.test(hash)) return null;
  return { ms, hash };
}

function windowRange(ms: number): { from: string; to: string } {
  return {
    from: new Date(ms - ID_WINDOW_MS).toISOString(),
    to: new Date(ms + ID_WINDOW_MS).toISOString(),
  };
}

/**
 * Misskey 風の ID を Spica の ID に戻す。
 *
 * `kinds` で探す種類を絞れる（ノートなら post / announce、通知なら notification）。
 * 見つからなければ null。
 */
export async function resolveMisskeyId(
  id: string,
  kinds: MisskeyIdKind[] = ['post', 'announce'],
): Promise<MisskeyTarget | null> {
  const raw = String(id || '').trim();
  if (!raw) return null;

  // 生の正規 ID（URI）や URL が来ることもある（クライアントの「URL を貼る」操作）
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    const post = (await db.prepare('SELECT id, published_at FROM posts WHERE id = ?').get(raw)) as
      | { id: string; published_at: string }
      | undefined;
    if (post) return { kind: 'post', id: post.id, at: post.published_at };
    return null;
  }

  const parsed = parseMisskeyId(raw);
  if (!parsed) return null;
  const { from, to } = windowRange(parsed.ms);

  if (kinds.includes('post')) {
    const rows = (await db.prepare(
      'SELECT id, published_at FROM posts WHERE published_at >= ? AND published_at <= ?',
    ).all(from, to)) as { id: string; published_at: string }[];
    const hit = rows.find((row) => keyHash(`post:${row.id}`) === parsed.hash);
    if (hit) return { kind: 'post', id: hit.id, at: hit.published_at };
  }

  if (kinds.includes('announce')) {
    const rows = (await db.prepare(
      'SELECT id, created_at FROM announces WHERE created_at >= ? AND created_at <= ?',
    ).all(from, to)) as { id: string; created_at: string }[];
    const hit = rows.find((row) => keyHash(`announce:${row.id}`) === parsed.hash);
    if (hit) return { kind: 'announce', id: hit.id, at: hit.created_at };
  }

  if (kinds.includes('notification')) {
    const rows = (await db.prepare(
      'SELECT id, created_at FROM notifications WHERE created_at >= ? AND created_at <= ?',
    ).all(from, to)) as { id: string; created_at: string }[];
    const hit = rows.find((row) => keyHash(`notification:${row.id}`) === parsed.hash);
    if (hit) return { kind: 'notification', id: hit.id, at: hit.created_at };
  }

  return null;
}

/** ノート ID（ブーストは専用の ID にする） */
export function noteMisskeyId(item: { id: string; feed_id?: string; renote?: { id: string } | null; timeline_at?: string }): string {
  if (item.renote?.id) {
    return encodeMisskeyId('announce', item.renote.id, item.timeline_at || new Date().toISOString());
  }
  return encodeMisskeyId('post', item.id, item.timeline_at || new Date().toISOString());
}

// ---------------------------------------------------------------------------
// 表示用の変換
// ---------------------------------------------------------------------------

/** HTML をプレーンテキストに落とす（Misskey の `text` は素のテキスト） */
export function htmlToPlainText(html: string): string {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Spica の公開範囲 → Misskey の公開範囲 */
export function toMisskeyVisibility(visibility: string | null | undefined): string {
  if (visibility === 'followers') return 'followers';
  if (visibility === 'local') return 'home';
  return 'public';
}

/**
 * Misskey の公開範囲 → Spica の公開範囲。
 * `specified`（DM）は方針として実装しないので受け付けない（呼び出し側で 400 にする）。
 */
export function fromMisskeyVisibility(
  visibility: string | null | undefined,
  localOnly: boolean,
): { ok: true; visibility: 'public' | 'local' | 'followers' } | { ok: false; error: string } {
  switch (String(visibility || 'public')) {
    case 'public':
      return { ok: true, visibility: localOnly ? 'local' : 'public' };
    case 'home':
      // Misskey の home は「フォロワーのホームまで」。Spica に同じ軸が無いので公開として扱う
      return { ok: true, visibility: localOnly ? 'local' : 'public' };
    case 'followers':
    case 'specified':
      if (visibility === 'specified') {
        return { ok: false, error: 'Spica は DM（1対1のメッセージ）を実装していません。' };
      }
      return { ok: true, visibility: 'followers' };
    default:
      return { ok: true, visibility: localOnly ? 'local' : 'public' };
  }
}

export interface MisskeyUser {
  id: string;
  username: string;
  host: string | null;
  name: string;
  avatarUrl: string;
  bannerUrl: string;
  description: string;
  handle: string;
  emojis: Record<string, string>;
  isBot: boolean;
  isCat: boolean;
  isLocked: boolean;
  isFollowing: boolean;
  isFollowed: boolean;
  followersCount: number;
  followingCount: number;
  notesCount: number;
  createdAt: string;
  fields: { name: string; value: string }[];
  uri: string | null;
  isAdmin: boolean;
  isModerator: boolean;
}

/** ユーザーの Misskey 表現を作る（`author_*` だけ分かっている場合も含む） */
export function buildMisskeyUser(source: {
  id: string;
  name?: string | null;
  handle?: string | null;
  icon_url?: string | null;
  banner_url?: string | null;
  summary?: string | null;
  is_local?: number | boolean | null;
  fields?: unknown;
  created_at?: string | null;
  is_locked?: number | boolean | null;
  role?: string | null;
  followers_count?: number | null;
  following_count?: number | null;
  notes_count?: number | null;
}): MisskeyUser {
  const isLocal = Boolean(source.is_local);
  const rawHandle = String(source.handle || '').replace(/^@/, '');
  const [handleUser, handleHost] = rawHandle.includes('@') ? rawHandle.split('@') : [rawHandle || source.id, null];
  // ローカルの actor URL（…/users/xxx）が id として渡ってきたら、ユーザー名にしてから使う
  const localId = source.id.startsWith(`${config.origin}/users/`)
    ? source.id.slice(`${config.origin}/users/`.length)
    : source.id;
  const username = isLocal ? localId : handleUser || localId;
  const host = isLocal ? null : handleHost || null;

  let fields: { name: string; value: string }[] = [];
  try {
    const parsed = typeof source.fields === 'string' ? JSON.parse(source.fields) : source.fields;
    if (Array.isArray(parsed)) {
      fields = parsed
        .filter((f: any) => f && typeof f.name === 'string' && typeof f.value === 'string')
        .map((f: any) => ({ name: f.name, value: f.value }));
    }
  } catch {
    fields = [];
  }

  return {
    id: isLocal ? source.id : handleHost ? `${handleUser}@${handleHost}` : source.id,
    username,
    host,
    name: source.name || username,
    avatarUrl: source.icon_url || '',
    bannerUrl: source.banner_url || '',
    description: source.summary || '',
    handle: `@${username}${host ? `@${host}` : `@${config.domain}`}`,
    emojis: {},
    isBot: false,
    isCat: false,
    isLocked: Boolean(source.is_locked),
    isFollowing: false,
    isFollowed: false,
    followersCount: Number(source.followers_count || 0),
    followingCount: Number(source.following_count || 0),
    notesCount: Number(source.notes_count || 0),
    createdAt: source.created_at || new Date().toISOString(),
    fields,
    uri: host ? (source.handle ? `${config.origin}/users/${username}` : null) : null,
    isAdmin: source.role === 'admin',
    isModerator: source.role === 'admin' || source.role === 'moderate',
  };
}

/**
 * 参照用の ID（replyId / renoteId）は**参照先の時刻**で作る必要がある。
 * 応答に含まれる参照先の ID を集めて、時刻を 1 クエリで引く。
 */
export async function collectReferenceTimes(postIds: (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = Array.from(new Set(postIds.filter((id): id is string => typeof id === 'string' && id.length > 0)));
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const rows = (await db.prepare(
    `SELECT id, published_at FROM posts WHERE id IN (${ids.map(() => '?').join(', ')})`,
  ).all(...ids)) as { id: string; published_at: string }[];
  for (const row of rows) {
    map.set(row.id, row.published_at);
  }
  return map;
}

/** タイムラインの整形済み行 → Misskey のノート */
export function buildMisskeyNote(item: any, nested = false, referenceTimes?: Map<string, string>): any {
  const isBoost = Boolean(item.renote?.id) && !nested;
  /** 参照先の時刻が分からなければ、その ID は出さない（誤った時刻で作ると解決できなくなる） */
  const referenceId = (targetId: string | null | undefined): string | null => {
    if (!targetId) return null;
    const at = referenceTimes?.get(targetId);
    return at ? encodeMisskeyId('post', targetId, at) : null;
  };

  const note: any = {
    id: noteMisskeyId(item),
    createdAt: new Date(item.timeline_at || item.published_at).toISOString(),
    userId: String(item.user_id || ''),
    user: buildMisskeyUser({
      id: item.user_id,
      name: item.author_name,
      handle: item.author_handle,
      icon_url: item.author_icon,
      is_local: item.is_local,
    }),
    text: item.content ? htmlToPlainText(item.content) : null,
    cw: item.cw || null,
    visibility: toMisskeyVisibility(item.visibility),
    localOnly: item.visibility === 'local',
    reactionAcceptance: null,
    renoteCount: Number(item.announce_count || 0),
    repliesCount: Number(item.reply_count || 0),
    reactions: Object.fromEntries((item.reactions || []).map((r: any) => [r.reaction, Number(r.count)])),
    reactionEmojis: {},
    fileIds: (item.media_attachments || []).map((m: any) => m.url),
    files: (item.media_attachments || []).map((m: any) => ({
      id: m.url,
      createdAt: new Date(item.timeline_at || item.published_at).toISOString(),
      name: m.name || '',
      type: m.mediaType || '',
      size: m.size || 0,
      url: m.url,
      isSensitive: Boolean(item.is_sensitive),
      comment: m.description || null,
      thumbnailUrl: m.thumbnailUrl || null,
    })),
    replyId: referenceId(item.in_reply_to),
    renoteId: null,
    uri: item.is_local ? null : item.id,
    url: null,
    isHidden: false,
    myReaction: ((item.reactions || []).find((r: any) => r.me) || {}).reaction || null,
    isFavorited: Boolean(item.bookmarked),
    poll: item.poll
      ? {
          multiple: Boolean(item.poll.multiple),
          expiresAt: item.poll.expires_at || null,
          choices: (item.poll.choices || []).map((c: any) => ({
            text: c.text,
            votes: Number(c.votes_count || 0),
            isVoted: Boolean(c.me),
          })),
        }
      : null,
    channelId: item.channel_id || null,
  };

  // ブースト: Misskey では「renote を持つノート」として表す（投稿者 = ブーストした人）
  if (isBoost) {
    note.userId = String(item.renote.url || '');
    note.user = buildMisskeyUser({
      id: String(item.renote.url || item.renote.handle || 'unknown'),
      name: item.renote.name,
      handle: item.renote.handle,
      icon_url: item.renote.icon,
      is_local: String(item.renote.url || '').startsWith(config.origin) ? 1 : 0,
    });
    note.text = null;
    note.cw = null;
    note.fileIds = [];
    note.files = [];
    note.poll = null;
    note.reactions = {};
    note.myReaction = null;
    note.renoteCount = 0;
    note.repliesCount = 0;
    note.replyId = null;
    // 中身（元のノート）。ID と時刻は**元ノート自身のもの**を使う（ブースト時刻ではない）
    note.renote = buildMisskeyNote({ ...item, renote: null, timeline_at: item.published_at }, true, referenceTimes);
    note.renoteId = note.renote.id;
  }

  return note;
}

/** 通知 → Misskey の通知 */
export function buildMisskeyNotification(row: any): any {
  const typeMap: Record<string, string> = {
    reply: 'reply',
    mention: 'mention',
    renote: 'renote',
    announce: 'renote',
    reaction: 'reaction',
    follow: 'follow',
    move: 'move',
    report: 'notification',
    antenna: 'notification',
    scheduled_published: 'notification',
  };
  return {
    id: encodeMisskeyId('notification', row.id, row.created_at),
    createdAt: new Date(row.created_at).toISOString(),
    type: typeMap[row.type] || 'notification',
    userId: String(row.actor_id || ''),
    user: buildMisskeyUser({
      id: String(row.actor_id || ''),
      name: row.actor_name,
      handle: row.actor_handle,
      icon_url: row.actor_icon,
      is_local: String(row.actor_id || '').startsWith(config.origin) ? 1 : 0,
    }),
    note: row.post_id
      ? {
          id: encodeMisskeyId('post', row.post_id, row.created_at),
          text: htmlToPlainText(row.post_content || ''),
          userId: String(row.actor_id || ''),
        }
      : undefined,
    isRead: Boolean(row.is_read),
  };
}
