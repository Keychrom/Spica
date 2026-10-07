import { db, UserRow, createNotification, getServerSetting, setServerSetting } from './db.js';
import { config } from './config.js';
import {
  buildNote,
  buildCreateActivity,
  deliverActivity,
  fetchRemoteActor,
  resolveWebFinger,
} from './activitypub.js';
import { linkMediaToPost } from './mediaService.js';
import { getUserPrefs, normalizeDmActorUrl, UserPrefs } from './userPrefs.js';
import { parseRecipients, isViewerAddressedByDirectPost } from './postVisibility.js';
import { localPostId } from './ids.js';

/**
 * DM（1対1のメッセージ）のサーバー側ロジック
 *
 * 設計は `docs/DM.md` が正。要点:
 *   - 専用テーブルは作らず、`posts` に `visibility = 'direct'` + `recipients`（JSON 配列）で保存する
 *   - サーバー管理者の設定 `dm_enabled`（既定 off）が on のときだけ有効。
 *     off のときは `/api/dm/*` は 404、受信した DM は保存せず 202（物理的に無い扱い）
 *   - 受け取るのは「宛先に自分が入っていて、送信者が自分の許可リストに載っている」ときだけ
 *   - ブロック・ミュートは許可リストより優先する
 *   - 通知（`dm`）には本文を入れない（アプリ内のみ。メール通知には載せない）
 */

/** サーバー設定のキー（`server_settings`） */
export const DM_ENABLED_KEY = 'dm_enabled';

/** 添付できるメディアの最大件数（既存の投稿と同じ） */
const DM_MAX_ATTACHMENTS = 4;

/** 会話一覧・本文で一度に走査する DM の件数（1対1なら十分すぎる量） */
const DM_SCAN_LIMIT = 500;

/** 1 日の「新しい相手への送信」の上限（既定 20。`DM_NEW_PARTNER_LIMIT` で変更できる） */
export function dmNewPartnerDailyLimit(): number {
  const parsed = parseInt(process.env.DM_NEW_PARTNER_LIMIT || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
}

/** DM 機能有効か（設定は 1 キーだけ。切り替えは設定の変更だけで完結する） */
export function isDmEnabled(): boolean {
  return getServerSetting(DM_ENABLED_KEY) === 'true';
}

/** DM 機能の ON/OFF を保存する */
export async function setDmEnabled(enabled: boolean): Promise<void> {
  await setServerSetting(DM_ENABLED_KEY, enabled ? 'true' : 'false');
}

/** クライアントへ配る機能フラグ（インスタンス情報 API に載せる） */
export function dmFeatureFlags(): { dm: boolean } {
  return { dm: isDmEnabled() };
}

/** ローカルユーザーの actor URL */
export function dmActorUrl(userId: string): string {
  return `${config.origin}/users/${userId}`;
}

/** `${origin}/users/<id>` 形式からユーザーIDを取り出す（それ以外は null） */
export function localUserIdFromActorUrl(actorUrl: string | null | undefined): string | null {
  const value = String(actorUrl ?? '').trim().replace(/\/+$/, '');
  const prefix = `${config.origin}/users/`;
  if (!value.startsWith(prefix)) return null;
  const id = value.slice(prefix.length).split(/[/?#]/)[0];
  return id || null;
}

/** actor URL の比較用に末尾スラッシュを落とす */
function trimActorUrl(value: string | null | undefined): string {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

/**
 * 受け取った DM の宛先（to / cc）から、宛先になっているローカルユーザーを解決する。
 * 他人宛の DM は保存しない（1 人も見つからなければ空）。
 */
export function localRecipientUserIds(addresses: string[]): string[] {
  const ids = new Set<string>();
  for (const address of addresses) {
    const id = localUserIdFromActorUrl(address);
    if (id) ids.add(id.toLowerCase());
  }
  return [...ids];
}

/**
 * DM の宛先（送信 API の `to`）を actor URL に解決する。
 * 受け付ける形: `@user@domain` / `user@domain` / `user` / actor URL。
 */
export async function resolveDmTarget(toRaw: unknown): Promise<{ actorUrl: string; userId: string | null } | null> {
  if (typeof toRaw !== 'string') return null;
  const raw = toRaw.trim();
  if (!raw) return null;

  // 1. actor URL そのもの
  const asUrl = normalizeDmActorUrl(raw);
  if (asUrl) {
    const userId = localUserIdFromActorUrl(asUrl);
    if (userId) {
      const local = await db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as { id: string } | undefined;
      if (!local) return null;
      return { actorUrl: dmActorUrl(local.id), userId: local.id };
    }
    return { actorUrl: asUrl, userId: null };
  }

  const clean = raw.replace(/^@/, '');
  const atIndex = clean.lastIndexOf('@');
  if (atIndex <= 0) {
    // ローカルのユーザー名だけ（`bob`）
    const local = await db.prepare('SELECT id FROM users WHERE id = ?').get(clean.toLowerCase()) as { id: string } | undefined;
    if (!local) return null;
    return { actorUrl: dmActorUrl(local.id), userId: local.id };
  }

  const [name, domain] = [clean.slice(0, atIndex), clean.slice(atIndex + 1)];
  if (!name || !domain) return null;
  if (domain.toLowerCase() === config.domain.toLowerCase()) {
    const local = await db.prepare('SELECT id FROM users WHERE id = ?').get(name.toLowerCase()) as { id: string } | undefined;
    if (!local) return null;
    return { actorUrl: dmActorUrl(local.id), userId: local.id };
  }

  // リモート: WebFinger で解決する（既存のフォローと同じ経路）
  try {
    const actorUrl = await resolveWebFinger(`@${name}@${domain}`);
    if (!actorUrl) return null;
    return { actorUrl: trimActorUrl(actorUrl), userId: localUserIdFromActorUrl(actorUrl) };
  } catch {
    return null;
  }
}

/** `posts.recipients` を配列として読む（壊れていれば空） */
export function dmRecipients(raw: unknown): string[] {
  return parseRecipients(raw);
}

/** 自分が参加している DM か（送信者 or 宛先） */
export function isDmParticipant(post: { author_url?: string | null; recipients?: unknown }, actorUrl: string): boolean {
  const me = trimActorUrl(actorUrl);
  if (!me) return false;
  if (trimActorUrl(post.author_url) === me) return true;
  return dmRecipients(post.recipients).some((recipient) => trimActorUrl(recipient) === me);
}

/** 1対1の相手（自分以外の当事者）を返す */
export function dmPartnerOf(post: { author_url?: string | null; recipients?: unknown }, myActorUrl: string): string | null {
  const me = trimActorUrl(myActorUrl);
  const author = trimActorUrl(post.author_url);
  if (author && author !== me) return author;
  for (const recipient of dmRecipients(post.recipients)) {
    const value = trimActorUrl(recipient);
    if (value && value !== me) return value;
  }
  return null;
}

// ==========================================
// 受け取りの許可（利用者ごとの設定）
// ==========================================

/**
 * 送信者を「受け取ってよい相手」か。
 * `dmPolicy = 'allowlist'` かつ `dmAllow` に送信者が入っているときだけ true（既定は noone）。
 */
export function isDmSenderAllowedByPrefs(prefs: UserPrefs, senderActorUrl: string): boolean {
  if (prefs.dmPolicy !== 'allowlist') return false;
  const sender = trimActorUrl(senderActorUrl);
  if (!sender) return false;
  return prefs.dmAllow.some((allowed) => trimActorUrl(allowed) === sender);
}

/** そのユーザーが送信者をブロック・ミュートしているか（許可リストより優先する） */
export async function isDmSenderBlockedOrMuted(recipientUserId: string, senderActorUrl: string, senderUserId?: string | null): Promise<boolean> {
  const sender = trimActorUrl(senderActorUrl);
  if (!sender && !senderUserId) return false;
  const senderId = senderUserId ? senderUserId.toLowerCase() : '';
  try {
    for (const table of ['user_blocks', 'user_mutes']) {
      const row = await db
        .prepare(
          `SELECT 1 FROM ${table}
           WHERE user_id = ? AND (LOWER(target_user_id) = LOWER(?) OR LOWER(target_user_id) = ?)`,
        )
        .get(recipientUserId, sender, senderId);
      if (row) return true;
    }
  } catch {
    // 判定に失敗した場合は「受け取らない」側に倒す（見せてはいけないものを出さない）
    return true;
  }
  return false;
}

/** 宛先のユーザーが送信者からの DM を受け取るか（許可リスト + ブロック・ミュート） */
export async function isDmReceptionAllowed(
  recipientUserId: string,
  senderActorUrl: string,
  senderUserId?: string | null,
): Promise<boolean> {
  if (await isDmSenderBlockedOrMuted(recipientUserId, senderActorUrl, senderUserId)) return false;
  try {
    const prefs = await getUserPrefs(recipientUserId);
    return isDmSenderAllowedByPrefs(prefs, senderActorUrl);
  } catch {
    return false;
  }
}

/**
 * その DM の本文を viewer に見せてよいか。
 *
 * - 宛先（送信者 or recipients）でなければ false（第三者には存在も見せない）
 * - 宛先でも、**受信を許可していない相手**からのメッセージは false（受け取りの許可を尊重する）
 * - リモートの閲覧者（ActivityPub 経由）には出さない（DM は API から読む）
 */
export async function canViewDmMessage(
  post: { author_url?: string | null; recipients?: unknown },
  viewerActorUrl: string | null,
): Promise<boolean> {
  if (!isViewerAddressedByDirectPost(post as any, viewerActorUrl)) return false;
  const me = trimActorUrl(viewerActorUrl);
  if (trimActorUrl(post.author_url) === me) return true;
  const viewerUserId = localUserIdFromActorUrl(me);
  if (!viewerUserId) return false;
  return await isDmReceptionAllowed(viewerUserId, String(post.author_url || ''), localUserIdFromActorUrl(post.author_url));
}

// ==========================================
// 会話の解決（専用テーブルを持たないので in_reply_to をさかのぼる）
// ==========================================

/**
 * 会話の頭（最初の 1 通）＝ 2 人の間でいちばん古いメッセージの id。
 *
 * 会話は「相手ごと」に 1 つ（docs/DM.md の「相手ごとの一覧」）。`in_reply_to` の連鎖は
 * メッセージの親子関係（スレッドの見え方）を表し、会話そのものはこの頭で束ねる。
 * 一覧も本文も既読も**同じ頭・同じ範囲**を使うので、未読数と既読の結果が食い違わない。
 */
export function dmConversationHeadId(rowsNewestFirst: { id: string }[]): string | null {
  return rowsNewestFirst.length > 0 ? rowsNewestFirst[rowsNewestFirst.length - 1].id : null;
}

/** 会話の頭の投稿を読む（direct でなければ null） */
export async function getDmConversationHead(conversationId: string): Promise<any | null> {
  const id = decodeURIComponent(String(conversationId || '')).trim();
  if (!id) return null;
  try {
    const row = (await db
      .prepare("SELECT * FROM posts WHERE id = ? AND visibility = 'direct'")
      .get(id)) as any;
    return row || null;
  } catch {
    return null;
  }
}

// ==========================================
// 相手のプロフィール
// ==========================================

export interface DmPartnerProfile {
  actor_url: string;
  user_id: string | null;
  name: string;
  handle: string;
  icon_url: string;
  is_local: boolean;
  /** ローカルの相手が自分からの DM を受け取る設定になっているか（リモートは null） */
  accepts_dm: boolean | null;
}

/** actor URL から表示用のプロフィールを組む（見つからなければ最小限の情報で返す） */
export async function loadDmPartnerProfile(actorUrl: string, viewerUserId: string): Promise<DmPartnerProfile> {
  const url = trimActorUrl(actorUrl);
  const localId = localUserIdFromActorUrl(url);
  if (localId) {
    const row = (await db.prepare('SELECT id, name, icon_url FROM users WHERE id = ?').get(localId)) as
      | { id: string; name: string; icon_url?: string | null }
      | undefined;
    const accepts = row ? await isDmReceptionAllowed(row.id, dmActorUrl(viewerUserId), viewerUserId) : null;
    return {
      actor_url: dmActorUrl(localId),
      user_id: localId,
      name: row?.name || localId,
      handle: `@${localId}@${config.domain}`,
      icon_url: row?.icon_url || '',
      is_local: true,
      accepts_dm: accepts,
    };
  }

  const remote = (await db
    .prepare('SELECT id, username, domain, name, icon_url FROM remote_actors WHERE id = ?')
    .get(url)) as { id: string; username: string; domain: string; name?: string | null; icon_url?: string | null } | undefined;

  return {
    actor_url: url,
    user_id: null,
    name: remote?.name || remote?.username || url,
    handle: remote ? `@${remote.username}@${remote.domain}` : url,
    icon_url: remote?.icon_url || '',
    is_local: false,
    accepts_dm: null,
  };
}

// ==========================================
// 会話一覧・本文
// ==========================================

/** 自分が参加している DM を新しい順に引く（会話の組み立ては JS 側で行う） */
async function loadDmPostsInvolving(myActorUrl: string, limit = DM_SCAN_LIMIT): Promise<any[]> {
  try {
    // LIKE は候補を絞るだけの下ごしらえ（`_` などのワイルドカードで余分に拾っても、
    // 呼び出し側が recipients を厳密に照合するので漏れない）
    return (await db
      .prepare(
        `SELECT id, user_id, author_name, author_url, author_handle, author_icon, content, cw, emojis,
                in_reply_to, media_attachments, published_at, is_local, visibility, recipients
         FROM posts
         WHERE visibility = 'direct'
           AND (author_url = ? OR recipients LIKE ?)
         ORDER BY published_at DESC, id DESC
         LIMIT ?`,
      )
      .all(myActorUrl, `%"${myActorUrl}"%`, limit)) as any[];
  } catch {
    return [];
  }
}

/** 2 人の間の DM を新しい順に引く（会話の本文用） */
async function loadDmPostsBetween(myActorUrl: string, partnerActorUrl: string, limit = DM_SCAN_LIMIT): Promise<any[]> {
  const rows = await loadDmPostsInvolving(myActorUrl, limit);
  return rows.filter((row) => dmPartnerOf(row, myActorUrl) === trimActorUrl(partnerActorUrl));
}

function parseMedia(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseEmojis(raw: unknown): any[] | null {
  const list = parseMedia(raw);
  return list.length > 0 ? list : null;
}

/** クライアントへ返す 1 通分（宛先の actor URL は必要以上に出さない） */
export function toClientDmMessage(row: any, myActorUrl: string, conversationId: string, isRead: boolean): any {
  const mine = trimActorUrl(row.author_url) === trimActorUrl(myActorUrl);
  return {
    id: row.id,
    conversation_id: conversationId,
    content: row.content || '',
    cw: row.cw || null,
    emojis: parseEmojis(row.emojis),
    media_attachments: parseMedia(row.media_attachments),
    published_at: row.published_at,
    in_reply_to: row.in_reply_to || null,
    is_mine: mine,
    is_read: mine ? true : isRead,
    author: {
      actor_url: row.author_url,
      name: row.author_name || '',
      handle: row.author_handle || '',
      icon_url: row.author_icon || '',
    },
  };
}

/** 自分が読んだ DM の id（dm_reads）を引く */
async function loadReadIds(userId: string, postIds: string[]): Promise<Set<string>> {
  const read = new Set<string>();
  if (postIds.length === 0) return read;
  const CHUNK = 400;
  for (let i = 0; i < postIds.length; i += CHUNK) {
    const chunk = postIds.slice(i, i + CHUNK);
    try {
      const rows = (await db
        .prepare(`SELECT post_id FROM dm_reads WHERE user_id = ? AND post_id IN (${chunk.map(() => '?').join(',')})`)
        .all(userId, ...chunk)) as { post_id: string }[];
      for (const row of rows) read.add(row.post_id);
    } catch {
      // 読めなければ未読側に倒す
    }
  }
  return read;
}

/**
 * 会話一覧（相手・最終メッセージ・未読数）。
 * 受け取る設定になっていない相手からの受信は数えない（相手が許可するまで見えない）。
 */
export async function listDmConversations(userId: string): Promise<any[]> {
  const me = dmActorUrl(userId);
  const rows = await loadDmPostsInvolving(me);
  const conversationRows: any[] = [];
  const partners = new Map<string, { rows: any[] }>();

  const acceptanceCache = new Map<string, boolean>();
  // 「自分がその相手からの受信を許可しているか」。受け取らない相手のメッセージは数えない
  const acceptsFrom = async (partnerActorUrl: string): Promise<boolean> => {
    const partnerUserId = localUserIdFromActorUrl(partnerActorUrl);
    const key = partnerUserId || trimActorUrl(partnerActorUrl);
    if (!acceptanceCache.has(key)) {
      acceptanceCache.set(key, await isDmReceptionAllowed(userId, partnerActorUrl, partnerUserId));
    }
    return acceptanceCache.get(key) === true;
  };

  for (const row of rows) {
    if (!isDmParticipant(row, me)) continue;
    const partner = dmPartnerOf(row, me);
    if (!partner) continue;
    if (trimActorUrl(row.author_url) !== trimActorUrl(me)) {
      // 受信: 受け取る設定になっている相手のものだけ数える
      if (!(await acceptsFrom(partner))) continue;
    }
    const bucket = partners.get(partner);
    if (bucket) bucket.rows.push(row);
    else partners.set(partner, { rows: [row] });
  }

  const allIncomingIds = [];
  for (const bucket of partners.values()) {
    for (const row of bucket.rows) {
      if (trimActorUrl(row.author_url) !== trimActorUrl(me)) allIncomingIds.push(row.id);
    }
  }
  const readIds = await loadReadIds(userId, allIncomingIds);

  for (const [partner, bucket] of partners) {
    // rows は新しい順なので先頭が最終メッセージ、末尾が最初の 1 通（＝会話の頭）
    const latest = bucket.rows[0];
    const headId = dmConversationHeadId(bucket.rows);
    if (!headId) continue;
    let unread = 0;
    for (const row of bucket.rows) {
      if (trimActorUrl(row.author_url) === trimActorUrl(me)) continue;
      if (!readIds.has(row.id)) unread++;
    }
    conversationRows.push({
      id: headId,
      partner,
      latest,
      unread,
      message_count: bucket.rows.length,
    });
  }

  // 最終メッセージが新しい順
  conversationRows.sort((a, b) => String(b.latest.published_at).localeCompare(String(a.latest.published_at)));

  const result: any[] = [];
  for (const conv of conversationRows) {
    const profile = await loadDmPartnerProfile(conv.partner, userId);
    result.push({
      id: conv.id,
      partner: profile,
      last_message: {
        id: conv.latest.id,
        content: conv.latest.content || '',
        cw: conv.latest.cw || null,
        has_media: parseMedia(conv.latest.media_attachments).length > 0,
        published_at: conv.latest.published_at,
        is_mine: trimActorUrl(conv.latest.author_url) === trimActorUrl(me),
      },
      unread_count: conv.unread,
      message_count: conv.message_count,
      updated_at: conv.latest.published_at,
    });
  }
  return result;
}

/** 会話の本文（時系列）。`cursor` は「指定した位置より前（古い方）」を返す */
export async function getDmConversationMessages(
  userId: string,
  conversationId: string,
  page: { limit: number; cursor: { at: string; id: string } | null },
): Promise<{ conversation: any; messages: any[]; nextCursor: string | null; rows: any[] } | null> {
  const me = dmActorUrl(userId);
  const head = await getDmConversationHead(conversationId);
  if (!head || !isDmParticipant(head, me)) return null;

  const partner = dmPartnerOf(head, me);
  if (!partner) return null;

  const all = await loadDmPostsBetween(me, partner);
  const headId = head.id;

  // 受信は「受け取る設定になっている相手」のものだけ見せる（自分からの送信は常に見える）
  const partnerUserId = localUserIdFromActorUrl(partner);
  const accepts = await isDmReceptionAllowed(userId, partner, partnerUserId);
  const visible: any[] = [];
  for (const row of all) {
    const incoming = trimActorUrl(row.author_url) !== trimActorUrl(me);
    if (incoming && !accepts) continue;
    visible.push(row);
  }
  if (visible.length === 0) return null;

  // カーソルで「古い方」へ進む（ORDER BY は新しい順のまま切り出す）
  const filtered = page.cursor
    ? visible.filter(
        (row) =>
          row.published_at < page.cursor!.at ||
          (row.published_at === page.cursor!.at && row.id < page.cursor!.id),
      )
    : visible;
  const pageRows = filtered.slice(0, page.limit);
  const hasMore = filtered.length > page.limit;
  const nextCursor = hasMore && pageRows.length > 0
    ? Buffer.from(`${pageRows[pageRows.length - 1].published_at}|${pageRows[pageRows.length - 1].id}`, 'utf8').toString('base64url')
    : null;

  const readIds = await loadReadIds(userId, visible.filter((row) => trimActorUrl(row.author_url) !== trimActorUrl(me)).map((row) => row.id));
  const messages = pageRows
    .slice()
    .reverse() // 時系列（古い順）で返す
    .map((row) => toClientDmMessage(row, me, headId, readIds.has(row.id)));

  const unread = visible.filter(
    (row) => trimActorUrl(row.author_url) !== trimActorUrl(me) && !readIds.has(row.id),
  ).length;

  const profile = await loadDmPartnerProfile(partner, userId);
  return {
    conversation: {
      id: headId,
      partner: profile,
      unread_count: unread,
      message_count: visible.length,
    },
    messages,
    nextCursor,
    rows: visible,
  };
}

/** 会話を既読にする（受信したメッセージだけを記録する） */
export async function markDmConversationRead(userId: string, conversationId: string): Promise<{ updated: number } | null> {
  const me = dmActorUrl(userId);
  const head = await getDmConversationHead(conversationId);
  if (!head || !isDmParticipant(head, me)) return null;
  const partner = dmPartnerOf(head, me);
  if (!partner) return null;

  const all = await loadDmPostsBetween(me, partner);
  const incomingIds: string[] = [];
  for (const row of all) {
    if (trimActorUrl(row.author_url) === trimActorUrl(me)) continue;
    incomingIds.push(row.id);
  }

  const now = new Date().toISOString();
  let updated = 0;
  const CHUNK = 200;
  for (let i = 0; i < incomingIds.length; i += CHUNK) {
    const chunk = incomingIds.slice(i, i + CHUNK);
    for (const postId of chunk) {
      try {
        await db
          .prepare('INSERT INTO dm_reads (user_id, post_id, read_at) VALUES (?, ?, ?) ON CONFLICT(user_id, post_id) DO NOTHING')
          .run(userId, postId, now);
        updated++;
      } catch {
        // 既読の記録に失敗しても本文は読める（通知だけが未読のまま残る）
      }
    }
  }
  return { updated };
}

// ==========================================
// 送信
// ==========================================

/** 添付の検証（既存の投稿と同じ形: url があるものだけ・最大 4 件） */
export function parseDmAttachments(raw: unknown): any[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((att: any) => att && typeof att.url === 'string' && att.url.length > 0)
    .slice(0, DM_MAX_ATTACHMENTS)
    .map((att: any) => ({
      url: String(att.url),
      mediaType: typeof att.mediaType === 'string' ? att.mediaType : 'image/jpeg',
      name: typeof att.name === 'string' ? att.name.slice(0, 300) : '',
      description: typeof att.description === 'string' ? att.description.slice(0, 1500) : '',
      size: typeof att.size === 'number' ? att.size : undefined,
      width: typeof att.width === 'number' ? att.width : undefined,
      height: typeof att.height === 'number' ? att.height : undefined,
      thumbnailUrl: typeof att.thumbnailUrl === 'string' ? att.thumbnailUrl : undefined,
      duration: typeof att.duration === 'number' ? att.duration : undefined,
    }));
}

/** 今日（UTC 日付）の始まり */
function startOfUtcDay(): string {
  return new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
}

/** その相手とこれまでに DM をやり取りしたことがあるか */
async function isExistingDmPartner(myActorUrl: string, partnerActorUrl: string): Promise<boolean> {
  const partner = trimActorUrl(partnerActorUrl);
  try {
    const row = (await db
      .prepare(
        `SELECT 1 FROM posts
         WHERE visibility = 'direct'
           AND ((author_url = ? AND recipients LIKE ?) OR (author_url = ? AND recipients LIKE ?))
         LIMIT 1`,
      )
      .get(myActorUrl, `%"${partner}"%`, partner, `%"${myActorUrl}"%`)) as { 1?: number } | undefined;
    return Boolean(row);
  } catch {
    return false;
  }
}

/** 相手とのやり取りでいちばん古いメッセージの id（＝会話の頭） */
async function oldestDmMessageId(myActorUrl: string, partnerActorUrl: string): Promise<string | null> {
  const partner = trimActorUrl(partnerActorUrl);
  try {
    const row = (await db
      .prepare(
        `SELECT id FROM posts
         WHERE visibility = 'direct'
           AND ((author_url = ? AND recipients LIKE ?) OR (author_url = ? AND recipients LIKE ?))
         ORDER BY published_at ASC, id ASC
         LIMIT 1`,
      )
      .get(myActorUrl, `%"${partner}"%`, partner, `%"${myActorUrl}"%`)) as { id?: string } | undefined;
    return row?.id || null;
  } catch {
    return null;
  }
}

/** 今日すでに送った「新しい相手」の数（スパム対策の上限判定に使う） */
async function countNewPartnersToday(myActorUrl: string): Promise<number> {
  try {
    const rows = (await db
      .prepare(
        `SELECT recipients FROM posts
         WHERE visibility = 'direct' AND author_url = ? AND in_reply_to IS NULL AND published_at >= ?`,
      )
      .all(myActorUrl, startOfUtcDay())) as { recipients?: string | null }[];
    const partners = new Set<string>();
    for (const row of rows) {
      for (const recipient of dmRecipients(row.recipients)) partners.add(trimActorUrl(recipient));
    }
    return partners.size;
  } catch {
    return 0;
  }
}

export interface SendDmParams {
  user: UserRow;
  to: unknown;
  content?: unknown;
  cw?: unknown;
  attachments?: unknown;
  in_reply_to?: unknown;
}

export type SendDmResult =
  | { ok: true; status: number; message: any; delivered: boolean; reason?: string; federatedTo: number }
  | { ok: false; status: number; error: string };

/**
 * DM を 1 通送る。
 *
 * 送信側の制限は設けない（受け手が許可しない限り届かない）。
 * ローカルの相手が受け取らない設定のときは保存だけして通知しない（送信者には `delivered: false` を返す）。
 */
export async function sendDmMessage(params: SendDmParams): Promise<SendDmResult> {
  const { user } = params;
  const me = dmActorUrl(user.id);
  const inReplyTo = typeof params.in_reply_to === 'string' && params.in_reply_to.trim() ? params.in_reply_to.trim() : null;
  const cwText = typeof params.cw === 'string' && params.cw.trim() ? params.cw.trim() : null;
  const content = typeof params.content === 'string' ? params.content.trim() : '';
  const attachments = parseDmAttachments(params.attachments);

  if (!content && attachments.length === 0) {
    return { ok: false, status: 400, error: 'メッセージ本文またはメディアを入力してください。' };
  }

  const target = await resolveDmTarget(params.to);
  if (!target) {
    return { ok: false, status: 400, error: '宛先のユーザーが見つかりません。' };
  }
  if (trimActorUrl(target.actorUrl) === trimActorUrl(me)) {
    return { ok: false, status: 400, error: '自分自身にメッセージは送れません。' };
  }

  // 自分がブロックしている相手には送らない（相手からの受信もブロックが優先）
  if (await isDmSenderBlockedOrMuted(user.id, target.actorUrl, target.userId)) {
    return { ok: false, status: 403, error: 'この相手にはメッセージを送れません。' };
  }

  // 返信先は自分の関与している DM に限る
  let conversationPartner: string | null = null;
  if (inReplyTo) {
    const parent = (await db.prepare("SELECT id, author_url, recipients, visibility FROM posts WHERE id = ?").get(inReplyTo)) as
      | { id: string; author_url: string; recipients?: string | null; visibility?: string | null }
      | undefined;
    if (!parent || parent.visibility !== 'direct' || !isDmParticipant(parent, me)) {
      return { ok: false, status: 400, error: '返信先のメッセージが見つかりません。' };
    }
    conversationPartner = dmPartnerOf(parent, me);
    if (conversationPartner && trimActorUrl(conversationPartner) !== trimActorUrl(target.actorUrl)) {
      return { ok: false, status: 400, error: '返信先の相手と宛先が一致しません。' };
    }
  }

  // スパム対策: 新しい相手への送信は 1 日あたりの上限を設ける
  if (!inReplyTo) {
    const existingPartner = (await isExistingDmPartner(me, target.actorUrl)) || Boolean(conversationPartner);
    if (!existingPartner) {
      const sent = await countNewPartnersToday(me);
      const limit = dmNewPartnerDailyLimit();
      if (sent >= limit) {
        return {
          ok: false,
          status: 429,
          error: `新しい相手へのメッセージは 1 日 ${limit} 人までです。しばらく待ってから送ってください。`,
        };
      }
    }
  }

  const postId = localPostId(me);
  const now = new Date().toISOString();
  const authorHandle = `@${user.id}@${config.domain}`;
  const authorIcon = user.icon_url || '';
  const recipientsJson = JSON.stringify([trimActorUrl(target.actorUrl)]);

  await db.prepare(`
    INSERT INTO posts (id, user_id, author_name, author_url, author_handle, author_icon, content, is_local, visibility,
                       emojis, in_reply_to, is_sensitive, media_attachments, cw, published_at, recipients, fts_indexed)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'direct', '[]', ?, ?, ?, ?, ?, ?, 0)
  `).run(
    postId,
    user.id,
    user.name,
    me,
    authorHandle,
    authorIcon,
    content,
    inReplyTo,
    cwText ? 1 : 0,
    JSON.stringify(attachments),
    cwText,
    now,
    recipientsJson,
  );

  // 添付メディアをドライブの台帳へ紐づける（自分がアップロードしたメディアのみ）
  await linkMediaToPost(user.id, postId, attachments).catch(() => undefined);

  // 会話の頭（最初の 1 通）を返す。相手とのやり取りが無ければ、この 1 通が会話の頭になる
  const conversationId = (await oldestDmMessageId(me, target.actorUrl)) || postId;

  const responseMessage = {
    id: postId,
    conversation_id: conversationId,
    content,
    cw: cwText,
    emojis: null,
    media_attachments: attachments,
    published_at: now,
    in_reply_to: inReplyTo,
    is_mine: true,
    is_read: true,
    author: {
      actor_url: me,
      name: user.name,
      handle: authorHandle,
      icon_url: authorIcon,
    },
  };

  const targetUserId = target.userId || localUserIdFromActorUrl(target.actorUrl);

  if (targetUserId) {
    // ローカルの相手: 受け取る設定なら通知する（通知本文にはメッセージ本文を入れない）
    const accepted = await isDmReceptionAllowed(targetUserId, me, user.id);
    if (accepted) {
      try {
        await createNotification({
          userId: targetUserId,
          type: 'dm',
          actorId: user.id,
          actorName: user.name,
          actorHandle: authorHandle,
          actorIcon: authorIcon,
          postId,
          content: 'メッセージが届きました',
        });
      } catch (e) {
        console.warn('[DM] 通知の作成に失敗しました:', e);
      }
    }
    return { ok: true, status: 201, message: responseMessage, delivered: accepted, reason: accepted ? undefined : 'recipient_policy', federatedTo: 0 };
  }

  // リモートの相手: `to` = 宛先のみ（Public を含めない）の Create(Note) を配送
  let federatedTo = 0;
  try {
    const note = buildNote({
      id: postId,
      authorUrl: me,
      content,
      publishedAt: now,
      inReplyTo,
      attachments,
      summary: cwText,
      sensitive: Boolean(cwText),
      visibility: 'direct',
      directRecipients: [trimActorUrl(target.actorUrl)],
    });
    const createActivity = buildCreateActivity({ note, actorUrl: me });
    const remoteActor = await fetchRemoteActor(trimActorUrl(target.actorUrl));
    if (remoteActor?.inbox_url) {
      federatedTo = 1;
      void deliverActivity({ inboxUrl: remoteActor.inbox_url, activity: createActivity, senderUser: user }).catch(() => {});
    }
  } catch (e) {
    console.warn('[DM] リモートへの配送に失敗しました:', e);
  }

  return { ok: true, status: 201, message: responseMessage, delivered: federatedTo > 0, reason: federatedTo > 0 ? undefined : 'delivery_failed', federatedTo };
}