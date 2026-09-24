import { config } from './config.js';
import { db } from './db.js';

/**
 * リアルタイム配信（SSE）の**宛先判定**。
 *
 * 以前は「接続している全クライアントに全部の新着を配る」作りだった（クライアント側で捨てていた）。
 * リレーを購読していると 1 日に数万件のリモート投稿が届くので、**サーバー側で必要な人だけに絞る**。
 *
 * クライアントは接続時に見たいストリームを申告する（`/api/streaming?streams=local,home,tag:foo`）:
 *
 *   - `local`   … ローカル投稿（`is_local = 1`）
 *   - `home`    … 自分のホーム（ローカル投稿 + フォロー中のアクター）
 *   - `all`     … 連合タイムライン（全件）
 *   - `tag:<名前>`     … そのハッシュタグを含む投稿
 *   - `channel:<ID>`  … そのチャンネルの投稿
 *   - `*`       … 全部（未指定のときの既定。古いクライアントは今までどおり全部受け取る）
 *
 * 判定は**投稿ごとに 1 回**材料（`NoteRouting`）を作ってから行う。リモート投稿のときだけ
 * 「作者をフォローしているローカルユーザー」を引く（60 秒キャッシュ・`follows(following_url)` の索引が効く）。
 * ローカル投稿は「ホームの定義に `is_local = 1` が含まれる」ため、フォロワーを引く必要がない。
 */

/** 全イベントを受け取るストリーム（`streams` 未指定のときの既定） */
export const ALL_STREAMS = '*';

/** 投稿 1 件を誰に配るかの材料。Redis では他のプロセスにもこの形で渡す */
export interface NoteRouting {
  /** ローカル投稿か */
  local: boolean;
  /** 作者のアクター URL */
  author: string;
  /** 作者をフォローしているローカルユーザー ID（`home` の判定に使う。ローカル投稿では空） */
  followers: string[];
}

/** 配信先の判定に使うクライアントの情報 */
export interface StreamTarget {
  userId: string | null;
  streams: Set<string>;
}

/** 判定に使う投稿の情報（配信するペイロードの一部） */
export interface RoutableNote {
  is_local?: unknown;
  user_id?: string | null;
  author_url?: string | null;
  content?: string | null;
  channel_id?: string | null;
}

/** `streams=local,home,tag:foo` をパースする。未指定・不正な値だけなら「全部」 */
export function parseStreams(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof raw === 'string') {
    for (const part of raw.split(',')) {
      const name = part.trim();
      if (!name) continue;
      if (name === ALL_STREAMS) {
        out.add(ALL_STREAMS);
        continue;
      }
      // 種類は英小文字、値はそのまま（チャンネル ID は大文字小文字を区別しうる）
      const [kind, ...rest] = name.split(':');
      const value = rest.join(':').trim();
      const lowerKind = kind.toLowerCase();
      if (!value) {
        if (lowerKind === 'local' || lowerKind === 'home' || lowerKind === 'all') out.add(lowerKind);
        continue;
      }
      if (value.length > 120) continue;
      if (lowerKind === 'tag') out.add(`tag:${value.toLowerCase()}`);
      else if (lowerKind === 'channel') out.add(`channel:${value}`);
    }
  }
  if (out.size === 0) out.add(ALL_STREAMS);
  return out;
}

/** ローカルユーザーのアクター URL からユーザー ID を取り出す（リモートなら null） */
export function actorUrlToUserId(url: string | null | undefined): string | null {
  if (!url) return null;
  const prefix = `${config.origin}/users/`;
  if (!url.startsWith(prefix)) return null;
  const id = url.slice(prefix.length).split(/[/?#]/)[0];
  return id || null;
}

/** フォロワー一覧のキャッシュ（同じ作者の投稿が続くので効く） */
const followerCache = new Map<string, { ids: string[]; at: number }>();
const FOLLOWER_CACHE_TTL_MS = 60_000;
const FOLLOWER_CACHE_MAX = 500;

/** そのアクターをフォローしているローカルユーザー ID（`accepted` のみ） */
export async function getFollowerUserIds(actorUrl: string): Promise<string[]> {
  if (!actorUrl) return [];
  const now = Date.now();
  const cached = followerCache.get(actorUrl);
  if (cached && now - cached.at < FOLLOWER_CACHE_TTL_MS) return cached.ids;

  let ids: string[] = [];
  try {
    const rows = (await db
      .prepare("SELECT follower_url FROM follows WHERE following_url = ? AND status = 'accepted'")
      .all(actorUrl)) as { follower_url: string }[];
    ids = rows.map((row) => actorUrlToUserId(row.follower_url)).filter((id): id is string => Boolean(id));
  } catch {
    // 判定できないときは「フォロワー無し」として扱う（配信が止まるだけで、壊れはしない）
    return [];
  }

  if (followerCache.size >= FOLLOWER_CACHE_MAX) {
    const oldest = followerCache.keys().next().value;
    if (oldest !== undefined) followerCache.delete(oldest);
  }
  followerCache.set(actorUrl, { ids, at: now });
  return ids;
}

/** 投稿 1 件分の配信材料を作る（リモート投稿のときだけフォロワーを引く） */
export async function buildNoteRouting(note: RoutableNote): Promise<NoteRouting> {
  const local = note.is_local === true || Number(note.is_local) === 1;
  const author = String(note.author_url || note.user_id || '');
  return {
    local,
    author,
    followers: local ? [] : await getFollowerUserIds(author),
  };
}

/** この投稿をこのクライアントへ配るべきか */
export function shouldDeliverNote(client: StreamTarget, note: RoutableNote, routing: NoteRouting): boolean {
  const streams = client.streams;
  if (streams.has(ALL_STREAMS)) return true;

  // 自分の投稿（自分のクライアントには必ず届ける）
  if (client.userId) {
    if (client.userId === note.user_id) return true;
    if (client.userId === actorUrlToUserId(routing.author)) return true;
  }

  if (routing.local) {
    // ローカル投稿はローカルタイムラインとホームの両方に出る
    if (streams.has('local') || streams.has('home')) return true;
  } else if (streams.has('home') && client.userId && routing.followers.includes(client.userId)) {
    return true;
  }

  if (streams.has('all')) return true;

  const content = (note.content || '').toLowerCase();
  for (const stream of streams) {
    if (stream.startsWith('tag:')) {
      const tag = stream.slice(4);
      if (content.includes(`#${tag}`) || content.includes(`/tags/${tag}`)) return true;
    } else if (stream.startsWith('channel:')) {
      if (note.channel_id && note.channel_id === stream.slice(8)) return true;
    }
  }
  return false;
}

/** 検査用: キャッシュを空にする */
export function clearFollowerCache(): void {
  followerCache.clear();
}
