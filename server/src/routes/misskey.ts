import { Router, Request, RequestHandler, Response, NextFunction } from 'express';
import { asyncHandler } from '../asyncHandler.js';
import { db, UserRow, getInstanceInfo } from '../db.js';
import { config } from '../config.js';
import { MAX_POST_ATTACHMENTS, executeUpdatePost } from '../postService.js';
import { getUserFromToken, createSession } from '../auth.js';
import { isApprovedUser } from '../registration.js';
import { fetchRemoteActor } from '../activitypub.js';
import { getStreamClientCount } from '../streaming.js';
import { encodeCursor } from '../pagination.js';
import { deleteMedia, listMedia, toClientMedia } from '../mediaService.js';
import {
  enrichAndFilterPosts,
  handleAddListMember,
  handleAnnouncePost,
  handleBlockUser,
  handleCreateAntenna,
  handleCreateList,
  handleCreatePost,
  handleDeleteAntenna,
  handleDeleteList,
  handleDeletePost,
  handleFollow,
  handleAntennaTimeline,
  handleListBookmarks,
  handleListTimeline,
  handleMuteUser,
  handleReactToPost,
  handleReadNotification,
  handleRemoveListMember,
  handleRespondFollowRequest,
  handleShowAntenna,
  handleTimeline,
  handleToggleBookmark,
  handleUnblockUser,
  handleUnfollow,
  handleUnmuteUser,
  handleUpdateAntenna,
  handleUpdateList,
  handleUpdateProfile,
  handleVotePoll,
  mediaUploadMiddleware,
  saveUploadedMediaFiles,
  setPinnedPost,
} from './api.js';
import {
  buildMisskeyNote,
  buildMisskeyNotification,
  buildMisskeyUser,
  collectReferenceTimes,
  encodeMisskeyId,
  fromMisskeyVisibility,
  resolveMisskeyId,
  type MisskeyTarget,
} from '../misskeyFormat.js';

/**
 * Misskey 互換 API（サードパーティ製クライアントから使うためのセット）
 *
 *   - 読み取り: meta / i / emojis / タイムライン（home・local・global・hybrid）/ notes の各一覧
 *     （show・conversation・children・replies・mentions・renotes・featured・search・search-by-tag）/
 *     users（show・notes・search・relation・followers・following）/ notifications / favorites /
 *     lists / antennas / drive/files / ap/show / get-online-users-count
 *   - 書き込み: notes/create・delete・update、reactions、favorites、polls/vote、following、
 *     following/requests、mute、blocking、i/update・i/pin・i/unpin・i/read-notification、
 *     users/lists/*、antennas/*、drive/files/create・delete
 *   - 認証: `Authorization: Bearer <トークン>` または本文の `i`
 *
 * **方針**: 実装は「Spica の API を別名で包む」だけにして、判定・連合・通知のロジックは
 * 既存のハンドラ（api.ts から export しているもの）をそのまま呼ぶ。二重実装すると
 * 片方だけ直る事故が起きるため。
 *
 * **ストリーミング（WebSocket）**: `GET /streaming?i=<トークン>` で受ける（実装は streaming.ts の
 * Misskey 互換セクション）。`meta.features.streaming` は true を返す。
 * 対応チャンネルは homeTimeline / localTimeline / hybridTimeline / globalTimeline / main（自分の通知）で、
 * Spica 自身の SSE と同じイベント源（Redis Pub/Sub 含む）から配る。
 *
 * 実装しないもの（docs/FEATURES.md に明記）:
 *   - `visibility: specified`（DM）: この API では作成しない（400 を返す）。DM は Spica の
 *     設定 `dm_enabled` が on のときだけ `/api/dm/messages` で扱う（docs/DM.md）
 *   - 権限の細分化: MiAuth で要求された権限は承認画面に表示するが、発行するトークンは
 *     通常のセッションと同じ（アプリごとの権限分離はしない）
 *   - チャット・ページ・Play・クリップ・ギャラリー・Webhook・管理 API（Spica に無い機能）
 */
export const misskeyRouter = Router();

/** Misskey は本文の `i` でもトークンを渡せる（Authorization ヘッダーの代わり） */
function misskeyAuthBridge(req: Request, _res: Response, next: NextFunction) {
  if (!req.headers.authorization && req.body && typeof req.body.i === 'string' && req.body.i) {
    req.headers.authorization = `Bearer ${req.body.i}`;
  }
  next();
}

/**
 * 認証済みなら req.user / req.rawUser を埋める（未認証でも続行。読み取りは公開）。
 *
 * 委譲先のハンドラ（api.ts の `requireAuth` 越しのもの）は `req.rawUser` を読むので、
 * **ここで同じ形に詰めておく**のが要点（詰め忘れると投稿作成などが undefined で落ちる）。
 */
async function attachUser(req: Request): Promise<UserRow | null> {
  const header = String(req.headers.authorization || '');
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  const authUser = await getUserFromToken(token);
  if (!authUser) return null;
  const user = (await db.prepare('SELECT * FROM users WHERE id = ?').get(authUser.id)) as unknown as UserRow | undefined;
  if (!user) return null;
  req.user = authUser;
  req.rawUser = user;
  return user;
}

function requireUser(user: UserRow | null, res: Response): user is UserRow {
  if (!user) {
    res.status(401).json({ error: '認証が必要です。', code: 'AUTHENTICATION_REQUIRED' });
    return false;
  }
  return true;
}

/**
 * 委譲先のハンドラ（api.ts）は応答を自分で書くので、いったん受け取ってから
 * Misskey の形に作り直す。**ロジックは既存のものをそのまま使う**ための橋渡し。
 *
 * ⚠️ `asyncHandler` は promise を返さない（Express 4 で reject を拾うためのラッパなので
 * fire-and-forget）。そのため **応答が書かれるまで待つ**必要がある。待たずに進むと、
 * 書き込みが終わる前に次の処理（結果の取得）へ進んでしまう。
 */
async function callHandler(
  handler: (req: Request, res: Response, next: NextFunction) => unknown,
  req: Request,
): Promise<{ status: number; body: any }> {
  let status = 200;
  let body: any = null;
  let settled = false;
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });

  const shim = {
    status(code: number) {
      status = code;
      return shim;
    },
    json(payload: any) {
      body = payload;
      settle();
      return shim;
    },
    send(payload: any) {
      body = payload;
      settle();
      return shim;
    },
    end() {
      settle();
      return shim;
    },
    setHeader() {
      return shim;
    },
    getHeader() {
      return undefined;
    },
    headersSent: false,
  } as unknown as Response;

  await (handler as any)(req, shim, (err?: any) => {
    if (err) {
      console.error('[Misskey] 委譲先のハンドラでエラー:', err?.message || err);
      if (!body) body = { error: '処理に失敗しました。' };
      status = status >= 400 ? status : 500;
    }
    settle();
  });

  // 応答が書かれるまで待つ（保険として 30 秒で打ち切る）
  await Promise.race([
    done,
    new Promise<void>((resolve) => setTimeout(resolve, 30_000).unref?.()),
  ]);

  return { status, body };
}

/** 委譲先がエラーを返したら、そのまま Misskey の応答として流す */
function forwardError(res: Response, result: { status: number; body: any }): boolean {
  if (result.status >= 400) {
    res.status(result.status).json(result.body || { error: '処理に失敗しました。' });
    return true;
  }
  return false;
}

misskeyRouter.use(misskeyAuthBridge);

// ===========================================================================
// インスタンス情報・自分の情報
// ===========================================================================

misskeyRouter.post('/meta', asyncHandler(async (_req: Request, res: Response) => {
  const info = getInstanceInfo();
  const emojis = (await db.prepare('SELECT name, url FROM custom_emojis').all()) as { name: string; url: string }[];
  res.json({
    name: info.name,
    version: '13.0.0-spica',
    uri: config.origin,
    description: info.description,
    // クライアントはこの長さで入力欄を制限する
    maxNoteTextLength: 3000,
    disableRegistration: info.registration_mode === 'closed',
    emailRequiredForSignup: false,
    maintenanceMode: false,
    emojis: Object.fromEntries(emojis.map((e) => [e.name, e.url])),
    features: {
      // ストリーミング（WebSocket、`/streaming`）に対応。クライアントはチャンネルを購読して受け取る
      streaming: true,
      registration: info.registration_mode !== 'closed',
      localTimeline: true,
      globalTimeline: true,
      hashtags: true,
    },
  });
}));

/** 自分のアカウント */
misskeyRouter.post('/i', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;

  const counts = (await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM posts WHERE user_id = ? AND is_local = 1 AND COALESCE(visibility, 'public') != 'direct') AS notes,
      (SELECT COUNT(*) FROM follows WHERE following_url = ? AND status = 'accepted') AS followers,
      (SELECT COUNT(*) FROM follows WHERE follower_url = ?) AS following
  `).get(user.id, `${config.origin}/users/${user.id}`, `${config.origin}/users/${user.id}`)) as any;

  res.json(buildMisskeyUser({
    id: user.id,
    name: user.name,
    handle: `@${user.id}@${config.domain}`,
    icon_url: user.icon_url,
    banner_url: user.banner_url,
    summary: user.summary,
    is_local: 1,
    fields: user.fields,
    created_at: user.created_at,
    is_locked: user.is_locked,
    role: user.role,
    followers_count: counts?.followers,
    following_count: counts?.following,
    notes_count: counts?.notes,
  }));
}));

// ===========================================================================
// タイムライン
// ===========================================================================

/**
 * タイムラインの行を取る。api.ts の `/api/timeline` と同じ「枝ごとに ORDER BY + LIMIT」の形に
 * しておく（PostgreSQL で外側 ORDER BY にすると枝を全部読んでしまうため）。
 */
async function fetchTimelineRows(params: {
  mode: 'home' | 'local' | 'all';
  viewerId: string | null;
  limit: number;
  untilAt?: string | null;
  sinceAt?: string | null;
}): Promise<any[]> {
  const { mode, viewerId, limit } = params;
  const postConds: string[] = [];
  const announceConds: string[] = [];
  const params_: any[] = [];
  const announceParams: any[] = [];
  let postFollowJoin = '';
  let announceFollowJoin = '';
  let followParam: string | null = null;

  // DM（visibility = 'direct'）はどのタイムラインにも出さない（docs/DM.md）
  postConds.push("COALESCE(p.visibility, 'public') != 'direct'");
  announceConds.push("COALESCE(p.visibility, 'public') != 'direct'");

  if (mode === 'home' && viewerId) {
    const myActorUrl = `${config.origin}/users/${viewerId}`;
    postFollowJoin = 'LEFT JOIN follows f ON f.following_url = p.author_url AND f.follower_url = ?';
    announceFollowJoin = 'LEFT JOIN follows f ON f.following_url = a.user_id AND f.follower_url = ?';
    // ⚠️ /api/timeline のホームと同じ定義にすること（自分 + フォロー中。ローカルの全員は入れない）
    postConds.push('(p.author_url = ? OR f.follower_url IS NOT NULL)');
    announceConds.push('(a.user_id = ? OR f.follower_url IS NOT NULL)');
    params_.push(myActorUrl);
    announceParams.push(myActorUrl);
    followParam = myActorUrl;
  } else if (mode === 'local') {
    postConds.push('p.is_local = 1');
    announceConds.push('a.is_local = 1');
  }

  // Misskey の untilId / sinceId は時刻に翻訳して渡ってくる
  if (params.untilAt) {
    postConds.push('p.published_at < ?');
    announceConds.push('a.created_at < ?');
    params_.push(params.untilAt);
    announceParams.push(params.untilAt);
  }
  if (params.sinceAt) {
    postConds.push('p.published_at > ?');
    announceConds.push('a.created_at > ?');
    params_.push(params.sinceAt);
    announceParams.push(params.sinceAt);
  }

  const postWhere = postConds.length ? ` WHERE ${postConds.join(' AND ')}` : '';
  const announceWhere = announceConds.length ? ` WHERE ${announceConds.join(' AND ')}` : '';
  const branchLimit = limit + 1;

  const query = `
    SELECT * FROM (
      SELECT
        p.id AS post_id, p.user_id, p.author_name, p.author_url, p.author_handle, p.content, p.cw,
        p.is_local, p.visibility, p.emojis, p.in_reply_to, p.media_attachments, p.published_at, p.channel_id, p.edited_at,
        p.quote_id, p.is_sensitive,
        COALESCE(NULLIF(p.author_icon, ''), NULLIF(u.icon_url, ''), NULLIF(ra.icon_url, ''), '') AS author_icon,
        NULL AS announce_id, NULL AS renoted_by_name, NULL AS renoted_by_handle,
        NULL AS renoted_by_icon, NULL AS renoted_by_url,
        p.published_at AS timeline_at
      FROM posts p
      ${postFollowJoin}
      LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
      LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
      ${postWhere}
      ORDER BY p.published_at DESC, p.id DESC
      LIMIT ?
    ) UNION ALL SELECT * FROM (
      SELECT
        p.id AS post_id, p.user_id, p.author_name, p.author_url, p.author_handle, p.content, p.cw,
        p.is_local, p.visibility, p.emojis, p.in_reply_to, p.media_attachments, p.published_at, p.channel_id, p.edited_at,
        p.quote_id, p.is_sensitive,
        COALESCE(NULLIF(p.author_icon, ''), NULLIF(u.icon_url, ''), NULLIF(ra.icon_url, ''), '') AS author_icon,
        a.id AS announce_id, a.user_name AS renoted_by_name, a.user_handle AS renoted_by_handle,
        COALESCE(NULLIF(a.user_icon, ''), NULLIF(ru.icon_url, ''), '') AS renoted_by_icon,
        a.user_id AS renoted_by_url,
        a.created_at AS timeline_at
      FROM announces a
      JOIN posts p ON a.post_id = p.id
      ${announceFollowJoin}
      LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
      LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
      LEFT JOIN users ru ON a.is_local = 1 AND a.user_id = ru.id
      ${announceWhere}
      ORDER BY a.created_at DESC, p.id DESC
      LIMIT ?
    )
    ORDER BY timeline_at DESC, post_id DESC
    LIMIT ?
  `;

  const rows = (await db.prepare(query).all(
    ...[...(followParam ? [followParam] : []), ...params_, branchLimit],
    ...[...(followParam ? [followParam] : []), ...announceParams, branchLimit],
    branchLimit,
  )) as any[];

  return rows.slice(0, limit);
}

/** untilId / sinceId / untilDate / sinceDate を時刻に翻訳する */
async function resolveTimeCursor(body: any): Promise<{ untilAt: string | null; sinceAt: string | null; error?: string }> {
  let untilAt: string | null = null;
  let sinceAt: string | null = null;

  if (typeof body.untilId === 'string' && body.untilId) {
    const target = await resolveMisskeyId(body.untilId);
    if (!target) return { untilAt: null, sinceAt: null, error: 'untilId が見つかりません。' };
    untilAt = target.at;
  } else if (typeof body.untilDate === 'number' || typeof body.untilDate === 'string') {
    const ms = Number(body.untilDate);
    if (Number.isFinite(ms)) untilAt = new Date(ms > 1e12 ? ms : ms * 1000).toISOString();
  }

  if (typeof body.sinceId === 'string' && body.sinceId) {
    const target = await resolveMisskeyId(body.sinceId);
    if (!target) return { untilAt, sinceAt: null, error: 'sinceId が見つかりません。' };
    sinceAt = target.at;
  } else if (typeof body.sinceDate === 'number' || typeof body.sinceDate === 'string') {
    const ms = Number(body.sinceDate);
    if (Number.isFinite(ms)) sinceAt = new Date(ms > 1e12 ? ms : ms * 1000).toISOString();
  }

  return { untilAt, sinceAt };
}

function readLimit(raw: unknown, fallback = 20, max = 100): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

async function respondWithTimeline(
  req: Request,
  res: Response,
  mode: 'home' | 'local' | 'all',
): Promise<void> {
  const viewer = await attachUser(req);
  const body = req.body || {};
  const cursor = await resolveTimeCursor(body);
  if (cursor.error) {
    res.status(400).json({ error: cursor.error });
    return;
  }

  const limit = readLimit(body.limit);
  const rows = await fetchTimelineRows({
    mode,
    viewerId: viewer?.id || null,
    limit,
    untilAt: cursor.untilAt,
    sinceAt: cursor.sinceAt,
  });
  const currentActorUrl = viewer ? `${config.origin}/users/${viewer.id}` : null;
  const enriched = await enrichAndFilterPosts(rows, currentActorUrl, viewer?.id || null);
  res.json(await toMisskeyNotes(enriched));
}

/** ホーム（自分 + フォロー中。`/api/timeline?mode=home` と同じ定義） */
misskeyRouter.post('/notes/timeline', asyncHandler((req, res) => respondWithTimeline(req, res, 'home')));
/**
 * Misskey の hybrid は「ローカル + フォロー」だが、Spica のホームは**自分 + フォロー中**なので
 * ローカルの全員は含まない（ローカル全体は `notes/local-timeline`。docs/FEATURES.md に明記）。
 */
misskeyRouter.post('/notes/hybrid-timeline', asyncHandler((req, res) => respondWithTimeline(req, res, 'home')));
/** ローカル */
misskeyRouter.post('/notes/local-timeline', asyncHandler((req, res) => respondWithTimeline(req, res, 'local')));
/** 連合（リレー含む） */
misskeyRouter.post('/notes/global-timeline', asyncHandler((req, res) => respondWithTimeline(req, res, 'all')));

// ===========================================================================
// ノート
// ===========================================================================

/** 解決した ID がブーストなら、元の投稿に読み替える（ブーストをブーストはできない） */
async function targetPostId(target: MisskeyTarget): Promise<string | null> {
  if (target.kind === 'post') return target.id;
  if (target.kind === 'announce') {
    const row = (await db.prepare('SELECT post_id FROM announces WHERE id = ?').get(target.id)) as
      | { post_id: string }
      | undefined;
    return row?.post_id || null;
  }
  return null;
}

interface AnnounceRow {
  id: string;
  post_id: string;
  user_id: string;
  user_name: string;
  user_handle: string;
  user_icon: string;
  created_at: string;
}

/**
 * ブーストを Misskey のノートとして組み立てる。
 * Misskey では「renote を持つノート」（投稿者 = ブーストした人、中身 = 元ノート）として表す。
 */
async function noteFromAnnounce(announce: AnnounceRow, viewer: UserRow | null): Promise<any | null> {
  const postRow = await db.prepare('SELECT * FROM posts WHERE id = ?').get(announce.post_id);
  if (!postRow) return null;
  const actorUrl = viewer ? `${config.origin}/users/${viewer.id}` : null;
  const enriched = await enrichAndFilterPosts([postRow], actorUrl, viewer?.id || null);
  if (enriched.length === 0) return null;

  const boosted = {
    ...enriched[0],
    timeline_at: announce.created_at,
    renote: {
      id: announce.id,
      name: announce.user_name,
      handle: announce.user_handle,
      icon: announce.user_icon,
      url: announce.user_id,
      at: announce.created_at,
    },
  };
  const referenceTimes = await collectReferenceTimes([boosted.in_reply_to, boosted.quote_id]);
  return buildMisskeyNote(boosted, false, referenceTimes);
}

/** 整形済みの行を Misskey のノートに変換する（参照 ID の時刻はまとめて引く） */
async function toMisskeyNotes(items: any[]): Promise<any[]> {
  if (items.length === 0) return [];
  const referenceTimes = await collectReferenceTimes([
    ...items.map((item: any) => item.in_reply_to),
    ...items.map((item: any) => item.quote_id),
  ]);
  return items.map((item) => buildMisskeyNote(item, false, referenceTimes));
}

/** 1 件のノートを取る（enrich して返す） */
async function loadNote(postId: string, viewer: UserRow | null): Promise<any | null> {
  const row = await db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!row) return null;
  const actorUrl = viewer ? `${config.origin}/users/${viewer.id}` : null;
  const enriched = await enrichAndFilterPosts([row], actorUrl, viewer?.id || null);
  const notes = await toMisskeyNotes(enriched);
  return notes.length > 0 ? notes[0] : null;
}

misskeyRouter.post('/notes/show', asyncHandler(async (req: Request, res: Response) => {
  const viewer = await attachUser(req);
  const target = await resolveMisskeyId(String(req.body?.noteId || ''));
  if (!target) {
    return res.status(400).json({ error: 'noteId を解決できません。', code: 'NO_SUCH_NOTE' });
  }
  // タイムラインで見たブーストをそのまま開けるように、ブーストの ID も受け付ける
  const note = target.kind === 'announce'
    ? await noteFromAnnounce((await db.prepare('SELECT * FROM announces WHERE id = ?').get(target.id)) as AnnounceRow, viewer)
    : await loadNote(target.id, viewer);
  if (!note) {
    return res.status(404).json({ error: 'ノートが見つかりません。', code: 'NO_SUCH_NOTE' });
  }
  res.json(note);
}));

/** 会話（親ノート + 対象ノート + 返信） */
misskeyRouter.post('/notes/conversation', asyncHandler(async (req: Request, res: Response) => {
  const viewer = await attachUser(req);
  const target = await resolveMisskeyId(String(req.body?.noteId || ''));
  if (!target) {
    return res.status(400).json({ error: 'noteId を解決できません。', code: 'NO_SUCH_NOTE' });
  }
  const post = (await db.prepare('SELECT * FROM posts WHERE id = ?').get(target.id)) as any;
  if (!post) {
    return res.status(404).json({ error: 'ノートが見つかりません。', code: 'NO_SUCH_NOTE' });
  }

  const limit = readLimit(req.body?.limit, 10, 100);
  // 返信一覧に加えて、**親ノートも 1 件引く**（引かないと「親 + 対象 + 返信」にならない）
  const parentRow = post.in_reply_to
    ? ((await db.prepare('SELECT * FROM posts WHERE id = ?').get(post.in_reply_to)) as any)
    : null;
  const replyRows = (await db.prepare(
    "SELECT * FROM posts WHERE in_reply_to = ? AND COALESCE(visibility, 'public') != 'direct' ORDER BY published_at ASC LIMIT ?",
  ).all(target.id, limit)) as any[];

  const actorUrl = viewer ? `${config.origin}/users/${viewer.id}` : null;
  const rows = [parentRow, post, ...replyRows].filter(Boolean);
  const enriched = await enrichAndFilterPosts(rows, actorUrl, viewer?.id || null);
  const notes = await toMisskeyNotes(enriched);
  // enriched と notes は同じ順番なので、正規 ID → Misskey ノートの対応は添字で取れる
  const noteByCanonicalId = new Map<string, any>(enriched.map((item: any, index: number) => [item.id, notes[index]]));

  const conversation: any[] = [];
  for (const row of [parentRow, post, ...replyRows]) {
    const note = row ? noteByCanonicalId.get(row.id) : undefined;
    if (note) conversation.push(note);
  }
  res.json(conversation);
}));

/** ファイル ID（ドライブの URL）から投稿の添付を作る */
async function buildAttachmentsFromFileIds(fileIds: unknown): Promise<any[] | undefined> {
  if (!Array.isArray(fileIds) || fileIds.length === 0) return undefined;
  const ids = fileIds.map((id) => String(id)).filter(Boolean).slice(0, MAX_POST_ATTACHMENTS);
  if (ids.length === 0) return undefined;

  const rows = (await db.prepare(
    `SELECT url, media_type, name, size, width, height, thumbnail_url, duration FROM media WHERE url IN (${ids.map(() => '?').join(', ')})`,
  ).all(...ids)) as any[];

  // 台帳に無い（古い投稿の添付など）場合は URL だけでも添付として扱う
  const byUrl = new Map(rows.map((row) => [row.url, row]));
  return ids.map((url) => {
    const row = byUrl.get(url);
    if (!row) {
      return { url, mediaType: guessMediaType(url) };
    }
    return {
      url: row.url,
      id: row.url,
      mediaType: row.media_type,
      name: row.name || '',
      size: row.size || 0,
      width: row.width || undefined,
      height: row.height || undefined,
      thumbnailUrl: row.thumbnail_url || undefined,
      duration: row.duration || undefined,
    };
  });
}

function guessMediaType(url: string): string {
  const ext = url.split('.').pop()?.toLowerCase() || '';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video/mp4';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'audio/mpeg';
  if (['gif'].includes(ext)) return 'image/gif';
  if (['png'].includes(ext)) return 'image/png';
  if (['webp'].includes(ext)) return 'image/webp';
  return 'image/jpeg';
}

/** 投稿（Misskey の notes/create） */
misskeyRouter.post('/notes/create', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const body = req.body || {};

  const text = typeof body.text === 'string' ? body.text : '';
  const renoteTarget = body.renoteId ? await resolveMisskeyId(String(body.renoteId)) : null;
  if (body.renoteId && !renoteTarget) {
    return res.status(400).json({ error: 'renoteId を解決できません。', code: 'NO_SUCH_NOTE' });
  }
  if (!text.trim() && !renoteTarget && !body.fileIds?.length && !body.poll && !body.quoteId) {
    return res.status(400).json({ error: '本文がありません。', code: 'NO_CONTENT' });
  }

  const visibilityResult = fromMisskeyVisibility(body.visibility, Boolean(body.localOnly));
  if (!visibilityResult.ok) {
    return res.status(400).json({ error: visibilityResult.error, code: 'INVALID_PARAM' });
  }

  // ブースト（本文なし + renoteId）は既存の announce ハンドラに任せる（連合・通知込み）
  if (renoteTarget && !text.trim() && !body.quoteId) {
    const boostPostId = await targetPostId(renoteTarget);
    if (!boostPostId) {
      return res.status(400).json({ error: 'renoteId を解決できません。', code: 'NO_SUCH_NOTE' });
    }
    // Misskey は「ブーストしたノート」を返す（投稿者 = ブーストした人、renote = 元ノート）
    const actorUrl = `${config.origin}/users/${user.id}`;
    const findAnnounce = (): Promise<AnnounceRow | undefined> =>
      db.prepare(
        'SELECT * FROM announces WHERE post_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1',
      ).get(boostPostId, actorUrl) as Promise<AnnounceRow | undefined>;

    // すでにブースト済みなら何もしない。Spica の API はトグルなので、そのまま呼ぶと
    // 「2 回目のブーストで解除される」＝ Misskey の意味（create = 付与）と違う動きになる
    let announceRow = await findAnnounce();
    if (!announceRow) {
      req.params = { ...(req.params || {}), id: boostPostId } as any;
      req.body = {};
      const announced = await callHandler(handleAnnouncePost, req);
      if (forwardError(res, announced)) return;
      announceRow = await findAnnounce();
    }

    const note = announceRow ? await noteFromAnnounce(announceRow, user) : null;
    if (!note) {
      return res.status(500).json({ error: 'ブーストは作成されましたが取得に失敗しました。' });
    }
    return res.json({ createdNote: note });
  }

  const attachments = await buildAttachmentsFromFileIds(body.fileIds);

  let replyTo: string | null = null;
  if (body.replyId) {
    const parent = await resolveMisskeyId(String(body.replyId));
    if (!parent) {
      return res.status(400).json({ error: 'replyId を解決できません。', code: 'NO_SUCH_NOTE' });
    }
    replyTo = await targetPostId(parent);
  }

  let quoteId: string | null = null;
  const quoteSource = body.quoteId || (renoteTarget && text.trim() ? body.renoteId : null);
  if (quoteSource) {
    const quote = await resolveMisskeyId(String(quoteSource));
    if (!quote) {
      return res.status(400).json({ error: '引用元を解決できません。', code: 'NO_SUCH_NOTE' });
    }
    quoteId = await targetPostId(quote);
  }

  req.body = {
    content: text,
    cw: typeof body.cw === 'string' && body.cw ? body.cw : null,
    visibility: visibilityResult.visibility,
    in_reply_to: replyTo,
    quote_id: quoteId,
    attachments,
    poll: body.poll && Array.isArray(body.poll.choices)
      ? {
          choices: body.poll.choices.map((c: any) => (typeof c === 'string' ? c : c?.text)).filter(Boolean),
          multiple: Boolean(body.poll.multiple),
          expires_in: typeof body.poll.expiredAfter === 'number' ? Math.floor(body.poll.expiredAfter / 1000) : undefined,
        }
      : undefined,
    is_sensitive: Boolean(body.isSensitive ?? body.is_sensitive),
  };

  const created = await callHandler(handleCreatePost, req);
  if (forwardError(res, created)) return;

  const note = await loadNote(String(created.body?.id || ''), user);
  if (!note) {
    return res.status(500).json({ error: '投稿は作成されましたが取得に失敗しました。' });
  }
  res.json({ createdNote: note });
}));

misskeyRouter.post('/notes/delete', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const target = await resolveMisskeyId(String(req.body?.noteId || ''), ['post']);
  if (!target) {
    return res.status(400).json({ error: 'noteId を解決できません。', code: 'NO_SUCH_NOTE' });
  }
  req.params = { ...(req.params || {}), id: target.id } as any;
  const deleted = await callHandler(handleDeletePost, req);
  if (forwardError(res, deleted)) return;
  res.status(204).end();
}));

// ===========================================================================
// リアクション / お気に入り / 投票
// ===========================================================================

misskeyRouter.post('/notes/reactions/create', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const target = await resolveMisskeyId(String(req.body?.noteId || ''), ['post']);
  if (!target) {
    return res.status(400).json({ error: 'noteId を解決できません。', code: 'NO_SUCH_NOTE' });
  }
  req.params = { ...(req.params || {}), id: target.id } as any;
  req.body = { reaction: String(req.body?.reaction || '👍') };
  const reaction = await callHandler(handleReactToPost, req);
  if (forwardError(res, reaction)) return;
  res.status(204).end();
}));

misskeyRouter.post('/notes/reactions/delete', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const target = await resolveMisskeyId(String(req.body?.noteId || ''), ['post']);
  if (!target) {
    return res.status(400).json({ error: 'noteId を解決できません。', code: 'NO_SUCH_NOTE' });
  }
  const actorUrl = `${config.origin}/users/${user.id}`;
  const existing = (await db.prepare(
    'SELECT reaction FROM reactions WHERE post_id = ? AND user_id = ? LIMIT 1',
  ).get(target.id, actorUrl)) as { reaction: string } | undefined;
  if (!existing) {
    return res.status(404).json({ error: 'リアクションがありません。', code: 'NO_SUCH_REACTION' });
  }
  // 自分のリアクションを消す（既存のトグルを 1 回だけ呼ぶ）
  req.params = { ...(req.params || {}), id: target.id } as any;
  req.body = { reaction: existing.reaction };
  const removed = await callHandler(handleReactToPost, req);
  if (forwardError(res, removed)) return;
  res.status(204).end();
}));

/** ノートに付いているリアクション一覧 */
misskeyRouter.post('/notes/reactions', asyncHandler(async (req: Request, res: Response) => {
  await attachUser(req);
  const target = await resolveMisskeyId(String(req.body?.noteId || ''), ['post']);
  if (!target) {
    return res.status(400).json({ error: 'noteId を解決できません。', code: 'NO_SUCH_NOTE' });
  }
  const rows = (await db.prepare(`
    SELECT user_id, reaction, created_at FROM reactions WHERE post_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(target.id, readLimit(req.body?.limit, 10, 100))) as any[];
  res.json(rows.map((row) => ({
    id: encodeMisskeyId('post', row.user_id + '|' + row.reaction, row.created_at),
    createdAt: new Date(row.created_at).toISOString(),
    user: buildMisskeyUser({ id: row.user_id, is_local: String(row.user_id).startsWith(config.origin) ? 1 : 0 }),
    type: row.reaction,
  })));
}));

misskeyRouter.post('/notes/favorites/create', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const target = await resolveMisskeyId(String(req.body?.noteId || ''), ['post']);
  if (!target) {
    return res.status(400).json({ error: 'noteId を解決できません。', code: 'NO_SUCH_NOTE' });
  }
  req.body = { postId: target.id };
  const favorited = await callHandler(handleToggleBookmark, req);
  if (forwardError(res, favorited)) return;
  res.status(204).end();
}));

misskeyRouter.post('/notes/favorites/delete', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const target = await resolveMisskeyId(String(req.body?.noteId || ''), ['post']);
  if (!target) {
    return res.status(400).json({ error: 'noteId を解決できません。', code: 'NO_SUCH_NOTE' });
  }
  const existing = await db.prepare('SELECT 1 FROM bookmarks WHERE user_id = ? AND post_id = ?').get(user.id, target.id);
  if (!existing) {
    return res.status(404).json({ error: 'お気に入りではありません。', code: 'NOT_FAVORITED' });
  }
  req.body = { postId: target.id };
  const removed = await callHandler(handleToggleBookmark, req);
  if (forwardError(res, removed)) return;
  res.status(204).end();
}));

misskeyRouter.post('/notes/polls/vote', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const target = await resolveMisskeyId(String(req.body?.noteId || ''), ['post']);
  if (!target) {
    return res.status(400).json({ error: 'noteId を解決できません。', code: 'NO_SUCH_NOTE' });
  }
  req.params = { ...(req.params || {}), id: target.id } as any;
  req.body = { choices: req.body?.choice !== undefined ? [Number(req.body.choice)] : req.body?.choices };
  const voted = await callHandler(handleVotePoll, req);
  if (forwardError(res, voted)) return;
  res.status(204).end();
}));

// ===========================================================================
// ユーザー / フォロー
// ===========================================================================

/** ローカルの actor URL はユーザー名を id にする（Misskey の id は短い識別子） */
function localActorId(actorUrl: string): string {
  if (actorUrl.startsWith(`${config.origin}/users/`)) {
    return actorUrl.slice(`${config.origin}/users/`.length);
  }
  return actorUrl;
}

/** `users/show` の引数（userId / username / userIds）からローカル or リモートの 1 人を引く */
async function findUser(identifier: string): Promise<{ user?: UserRow; remote?: any } | null> {
  const value = String(identifier || '').trim().replace(/^@/, '');
  if (!value) return null;

  // ローカル（ユーザー名 or actor URL）。承認待ち・却下の申請は存在しない扱いにする
  const localId = value.startsWith(config.origin) ? value.split('/').pop() || '' : value.split('@')[0];
  const local = (await db.prepare('SELECT * FROM users WHERE id = ?').get(localId)) as unknown as UserRow | undefined;
  if (local && isApprovedUser(local)) return { user: local };

  const actorUrl = value.includes('@') && !value.startsWith('http')
    ? `${config.origin}/users/${value.split('@')[0]}`
    : value;
  if (actorUrl.startsWith(config.origin)) {
    const again = (await db.prepare('SELECT * FROM users WHERE id = ?').get(actorUrl.split('/').pop() || '')) as unknown as UserRow | undefined;
    if (again && isApprovedUser(again)) return { user: again };
  }

  // リモート（actor URL そのもの、または user@domain）
  if (value.startsWith('http')) {
    const remote = await db.prepare('SELECT * FROM remote_actors WHERE id = ?').get(value);
    if (remote) return { remote };
  }
  const [username, domain] = value.includes('@') ? value.split('@') : ['', ''];
  if (username && domain) {
    const remote = await db.prepare('SELECT * FROM remote_actors WHERE username = ? AND domain = ?').get(username, domain);
    if (remote) return { remote };
  }
  return null;
}

/** 1 人のユーザーを Misskey 形式で組み立てる（`users/show`・`users/relation`・`ap/show` で共用） */
async function userObject(identifier: string): Promise<any | null> {
  const found = await findUser(identifier);
  if (!found && String(identifier).startsWith('http')) {
    // `ap/show` は「URL を開く」操作なので、キャッシュに無ければ取りに行く（他の経路は取らない）
    try {
      const actor = await fetchRemoteActor(String(identifier));
      return buildMisskeyUser({
        id: actor.id,
        name: actor.name,
        handle: `@${actor.username}@${actor.domain}`,
        icon_url: actor.icon_url,
        banner_url: actor.banner_url,
        summary: actor.summary,
        is_local: 0,
        notes_count: ((await db.prepare('SELECT COUNT(*) AS c FROM posts WHERE author_url = ?').get(actor.id) as any)?.c) || 0,
      });
    } catch {
      return null;
    }
  }
  if (!found) return null;

  if (found.remote) {
    const notesCount = (await db.prepare('SELECT COUNT(*) AS c FROM posts WHERE author_url = ?').get(found.remote.id) as any)?.c || 0;
    return buildMisskeyUser({
      id: found.remote.id,
      name: found.remote.name,
      handle: `@${found.remote.username}@${found.remote.domain}`,
      icon_url: found.remote.icon_url,
      banner_url: found.remote.banner_url,
      summary: found.remote.summary,
      is_local: 0,
      notes_count: notesCount,
    });
  }

  const user = found.user!;
  const counts = (await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM posts WHERE user_id = ? AND is_local = 1 AND COALESCE(visibility, 'public') != 'direct') AS notes,
      (SELECT COUNT(*) FROM follows WHERE following_url = ? AND status = 'accepted') AS followers,
      (SELECT COUNT(*) FROM follows WHERE follower_url = ?) AS following
  `).get(user.id, `${config.origin}/users/${user.id}`, `${config.origin}/users/${user.id}`)) as any;
  return buildMisskeyUser({
    id: user.id,
    name: user.name,
    handle: `@${user.id}@${config.domain}`,
    icon_url: user.icon_url,
    banner_url: user.banner_url,
    summary: user.summary,
    is_local: 1,
    fields: user.fields,
    created_at: user.created_at,
    is_locked: user.is_locked,
    role: user.role,
    followers_count: counts?.followers,
    following_count: counts?.following,
    notes_count: counts?.notes,
  });
}

/** 1 人のユーザーを Misskey 形式で返す（`users/show` と `following/create` で共用） */
async function respondUser(identifier: string, res: Response): Promise<void> {
  const user = await userObject(identifier);
  if (!user) {
    res.status(404).json({ error: 'ユーザーが見つかりません。', code: 'NO_SUCH_USER' });
    return;
  }
  res.json(user);
}

misskeyRouter.post('/users/show', asyncHandler(async (req: Request, res: Response) => {
  await respondUser(String(req.body?.userId || req.body?.username || ''), res);
}));

misskeyRouter.post('/users/notes', asyncHandler(async (req: Request, res: Response) => {
  const viewer = await attachUser(req);
  const identifier = String(req.body?.userId || req.body?.username || '');
  const found = await findUser(identifier);
  if (!found) {
    return res.status(404).json({ error: 'ユーザーが見つかりません。', code: 'NO_SUCH_USER' });
  }
  const authorUrl = found.user ? `${config.origin}/users/${found.user.id}` : found.remote.id;
  const limit = readLimit(req.body?.limit);
  const rows = (await db.prepare(`
    SELECT * FROM posts WHERE author_url = ? AND COALESCE(visibility, 'public') != 'direct'
    ORDER BY published_at DESC LIMIT ?
  `).all(authorUrl, limit + 1)) as any[];
  const actorUrl = viewer ? `${config.origin}/users/${viewer.id}` : null;
  const enriched = await enrichAndFilterPosts(rows.slice(0, limit), actorUrl, viewer?.id || null);
  res.json(await toMisskeyNotes(enriched));
}));

misskeyRouter.post('/users/search', asyncHandler(async (req: Request, res: Response) => {
  const query = String(req.body?.query || '').trim().replace(/^@/, '');
  const limit = readLimit(req.body?.limit, 10, 50);
  if (!query) {
    return res.json([]);
  }
  const users = (await db.prepare(`
    SELECT * FROM users WHERE (id LIKE ? OR name LIKE ?) AND is_frozen = 0 ORDER BY id ASC LIMIT ?
  `).all(`%${query}%`, `%${query}%`, limit)) as unknown as UserRow[];
  res.json(users.map((user) => buildMisskeyUser({
    id: user.id,
    name: user.name,
    handle: `@${user.id}@${config.domain}`,
    icon_url: user.icon_url,
    banner_url: user.banner_url,
    summary: user.summary,
    is_local: 1,
    fields: user.fields,
    created_at: user.created_at,
    is_locked: user.is_locked,
    role: user.role,
  })));
}));

misskeyRouter.post('/following/create', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const identifier = String(req.body?.userId || req.body?.username || '');
  const found = await findUser(identifier);
  if (!found) {
    return res.status(404).json({ error: 'ユーザーが見つかりません。', code: 'NO_SUCH_USER' });
  }
  const handle = found.user ? `@${found.user.id}@${config.domain}` : `@${found.remote.username}@${found.remote.domain}`;
  req.body = { targetHandle: handle };
  const followed = await callHandler(handleFollow, req);
  if (forwardError(res, followed)) return;
  // Misskey はフォローしたユーザーを返す
  await respondUser(identifier, res);
}));

misskeyRouter.post('/following/delete', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const found = await findUser(String(req.body?.userId || req.body?.username || ''));
  if (!found) {
    return res.status(404).json({ error: 'ユーザーが見つかりません。', code: 'NO_SUCH_USER' });
  }
  const handle = found.user ? `@${found.user.id}@${config.domain}` : `@${found.remote.username}@${found.remote.domain}`;
  const actorUrl = found.user ? `${config.origin}/users/${found.user.id}` : found.remote.id;
  req.body = { targetHandle: handle, targetActorUrl: actorUrl };
  await handleUnfollow(req, res, () => {});
}));

misskeyRouter.post('/users/followers', asyncHandler(async (req: Request, res: Response) => {
  await attachUser(req);
  const found = await findUser(String(req.body?.userId || req.body?.username || ''));
  if (!found) {
    return res.status(404).json({ error: 'ユーザーが見つかりません。', code: 'NO_SUCH_USER' });
  }
  const actorUrl = found.user ? `${config.origin}/users/${found.user.id}` : found.remote.id;
  const rows = (await db.prepare(`
    SELECT f.*, r.name, r.username, r.domain, r.icon_url, r.summary, r.banner_url
    FROM follows f LEFT JOIN remote_actors r ON f.follower_url = r.id
    WHERE f.following_url = ? AND f.status = 'accepted' ORDER BY f.created_at DESC LIMIT ?
  `).all(actorUrl, readLimit(req.body?.limit, 10, 100))) as any[];
  res.json(rows.map((row) => buildMisskeyUser({
    id: localActorId(String(row.follower_url || '')),
    name: row.name,
    handle: row.username && row.domain ? `@${row.username}@${row.domain}` : row.follower_url,
    icon_url: row.icon_url,
    summary: row.summary,
    banner_url: row.banner_url,
    is_local: String(row.follower_url || '').startsWith(config.origin) ? 1 : 0,
  })));
}));

misskeyRouter.post('/users/following', asyncHandler(async (req: Request, res: Response) => {
  await attachUser(req);
  const found = await findUser(String(req.body?.userId || req.body?.username || ''));
  if (!found) {
    return res.status(404).json({ error: 'ユーザーが見つかりません。', code: 'NO_SUCH_USER' });
  }
  const actorUrl = found.user ? `${config.origin}/users/${found.user.id}` : found.remote.id;
  const rows = (await db.prepare(`
    SELECT f.*, r.name, r.username, r.domain, r.icon_url, r.summary, r.banner_url
    FROM follows f LEFT JOIN remote_actors r ON f.following_url = r.id
    WHERE f.follower_url = ? ORDER BY f.created_at DESC LIMIT ?
  `).all(actorUrl, readLimit(req.body?.limit, 10, 100))) as any[];
  res.json(rows.map((row) => buildMisskeyUser({
    id: localActorId(String(row.following_url || '')),
    name: row.name,
    handle: row.username && row.domain ? `@${row.username}@${row.domain}` : row.following_url,
    icon_url: row.icon_url,
    summary: row.summary,
    banner_url: row.banner_url,
    is_local: String(row.following_url || '').startsWith(config.origin) ? 1 : 0,
  })));
}));

// ===========================================================================
// 通知
// ===========================================================================

misskeyRouter.post('/i/notifications', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const limit = readLimit(req.body?.limit, 10, 100);
  const conds = ['user_id = ?'];
  const params: any[] = [user.id];

  if (req.body?.untilId) {
    const target = await resolveMisskeyId(String(req.body.untilId), ['notification']);
    if (target) {
      conds.push('created_at < ?');
      params.push(target.at);
    }
  }
  if (req.body?.sinceId) {
    const target = await resolveMisskeyId(String(req.body.sinceId), ['notification']);
    if (target) {
      conds.push('created_at > ?');
      params.push(target.at);
    }
  }
  if (typeof req.body?.markAsRead === 'boolean' && req.body.markAsRead) {
    // 明示的に既読にする（Misskey のクライアントは表示後にこれを呼ぶ）
    await db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(user.id);
  }

  params.push(limit);
  const rows = (await db.prepare(`
    SELECT * FROM notifications WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT ?
  `).all(...params)) as any[];
  res.json(rows.map((row) => buildMisskeyNotification(row)));
}));

misskeyRouter.post('/i/read-all-notifications', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  await db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(user.id);
  res.json({ success: true });
}));

// ===========================================================================
// 検索・トレンド・ドライブ
// ===========================================================================

misskeyRouter.post('/notes/search', asyncHandler(async (req: Request, res: Response) => {
  const viewer = await attachUser(req);
  const query = String(req.body?.query || '').trim();
  if (!query) return res.json([]);
  const limit = readLimit(req.body?.limit, 10, 50);

  const conds = ["(visibility = 'public' OR visibility IS NULL)", '(content LIKE ? OR content LIKE ?)'];
  const params: any[] = [`%${query}%`, `%${query}%`];
  if (config.recentScanPosts > 0) {
    conds.push(`published_at >= (
      SELECT COALESCE(MIN(published_at), '') FROM (SELECT published_at FROM posts ORDER BY published_at DESC LIMIT ?)
    )`);
    params.push(config.recentScanPosts);
  }
  const rows = (await db.prepare(`
    SELECT * FROM posts WHERE ${conds.join(' AND ')} ORDER BY published_at DESC LIMIT ?
  `).all(...params, limit)) as any[];
  const actorUrl = viewer ? `${config.origin}/users/${viewer.id}` : null;
  const enriched = await enrichAndFilterPosts(rows, actorUrl, viewer?.id || null);
  res.json(await toMisskeyNotes(enriched));
}));

misskeyRouter.post('/hashtags/trend', asyncHandler(async (_req: Request, res: Response) => {
  const rows = (await db.prepare(
    // フォロワー限定と DM（visibility = 'direct'）は公開のタグ集計に出さない
    "SELECT content FROM posts WHERE COALESCE(visibility, 'public') NOT IN ('followers', 'direct') ORDER BY published_at DESC LIMIT 200",
  ).all()) as { content: string }[];
  const counts = new Map<string, number>();
  const tagRegex = /#([a-zA-Z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)/gu;
  for (const post of rows) {
    const clean = String(post.content || '').replace(/<[^>]*>/g, ' ');
    const seen = new Set<string>();
    for (const match of clean.matchAll(tagRegex)) {
      const tag = match[1].toLowerCase();
      if (tag.length >= 2 && !seen.has(tag)) {
        seen.add(tag);
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
  }
  res.json(Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, chart: [count], usersCount: 0 })));
}));

/** ドライブへのアップロード（投稿前にファイルを送る） */
misskeyRouter.post(
  '/drive/files/create',
  mediaUploadMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const user = await attachUser(req);
    if (!requireUser(user, res)) return;
    const files = (req.files as Express.Multer.File[]) || (req.file ? [req.file] : []);
    const result = await saveUploadedMediaFiles(user.id, files);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    const media = result.mediaRows[0];
    res.json({
      id: media.url,
      createdAt: new Date().toISOString(),
      name: media.name || '',
      type: media.mediaType || '',
      size: media.size || 0,
      url: media.url,
      thumbnailUrl: media.thumbnailUrl || null,
      isSensitive: false,
      comment: null,
    });
  }),
);

// ===========================================================================
// スレッド・メンション・ブーストした人・ピン留め
// ===========================================================================

/**
 * Misskey のノート ID を Spica の並び順カーソル（時刻 + ID）に翻訳する。
 * Spica の一覧 API は「不透明なカーソル」で続きを読むので、untilId から組み立て直す。
 */
async function misskeyCursorPair(noteId: string): Promise<{ at: string; id: string } | null> {
  const target = await resolveMisskeyId(noteId);
  if (!target) return null;
  if (target.kind === 'post') return { at: target.at, id: target.id };
  // ブーストの ID が来たら元の投稿に読み替える（一覧は元投稿の並びなので）
  const row = (await db.prepare(
    'SELECT p.id, p.published_at FROM announces a JOIN posts p ON p.id = a.post_id WHERE a.id = ?',
  ).get(target.id)) as { id: string; published_at: string } | undefined;
  return row ? { at: row.published_at, id: row.id } : null;
}

/** 返信一覧（`notes/children` / `notes/replies`）。古い順に返す */
async function respondWithReplies(req: Request, res: Response): Promise<void> {
  const viewer = await attachUser(req);
  const target = await resolveMisskeyId(String(req.body?.noteId || ''));
  if (!target) {
    res.status(400).json({ error: 'noteId を解決できません。', code: 'NO_SUCH_NOTE' });
    return;
  }
  const postId = await targetPostId(target);
  if (!postId) {
    res.status(404).json({ error: 'ノートが見つかりません。', code: 'NO_SUCH_NOTE' });
    return;
  }

  const limit = readLimit(req.body?.limit, 10, 100);
  const cursor = await resolveTimeCursor(req.body);
  if (cursor.error) {
    res.status(400).json({ error: cursor.error });
    return;
  }

  // DM（visibility = 'direct'）は返信一覧にも出さない（notes/conversation と同じ扱い）
  const conds = ["in_reply_to = ?", "COALESCE(visibility, 'public') != 'direct'"];
  const params: any[] = [postId];
  if (cursor.untilAt) {
    conds.push('published_at < ?');
    params.push(cursor.untilAt);
  }
  if (cursor.sinceAt) {
    conds.push('published_at > ?');
    params.push(cursor.sinceAt);
  }

  const rows = (await db.prepare(
    `SELECT * FROM posts WHERE ${conds.join(' AND ')} ORDER BY published_at ASC, id ASC LIMIT ?`,
  ).all(...params, limit)) as any[];

  const actorUrl = viewer ? `${config.origin}/users/${viewer.id}` : null;
  const enriched = await enrichAndFilterPosts(rows, actorUrl, viewer?.id || null);
  res.json(await toMisskeyNotes(enriched));
}

misskeyRouter.post('/notes/children', asyncHandler((req, res) => respondWithReplies(req, res)));
misskeyRouter.post('/notes/replies', asyncHandler((req, res) => respondWithReplies(req, res)));

/** 自分宛のメンション・返信（`notes/mentions`） */
misskeyRouter.post('/notes/mentions', asyncHandler(async (req: Request, res: Response) => {
  const viewer = await attachUser(req);
  if (!requireUser(viewer, res)) return;

  const limit = readLimit(req.body?.limit, 10, 100);
  const cursor = await resolveTimeCursor(req.body);
  if (cursor.error) {
    return res.status(400).json({ error: cursor.error });
  }

  // Spica はメンション・返信で通知を作る。**自分の通知**を辿れば
  // 「自分宛のメンション」も「自分のノートへの返信」も漏れなく取れる（本文の全走査は要らない）
  const conds = ["user_id = ?", 'post_id IS NOT NULL', "type IN ('mention', 'reply')"];
  const params: any[] = [viewer.id];
  if (cursor.untilAt) {
    conds.push('created_at < ?');
    params.push(cursor.untilAt);
  }
  if (cursor.sinceAt) {
    conds.push('created_at > ?');
    params.push(cursor.sinceAt);
  }
  const notices = (await db.prepare(
    `SELECT post_id FROM notifications WHERE ${conds.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(...params, limit)) as { post_id: string }[];
  if (notices.length === 0) {
    return res.json([]);
  }

  const ids = notices.map((n) => n.post_id);
  const rows = (await db.prepare(
    `SELECT * FROM posts WHERE id IN (${ids.map(() => '?').join(', ')})`,
  ).all(...ids)) as any[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  const enriched = await enrichAndFilterPosts(ordered, `${config.origin}/users/${viewer.id}`, viewer.id);
  res.json(await toMisskeyNotes(enriched));
}));

/** ブーストした人（`notes/renotes`） */
misskeyRouter.post('/notes/renotes', asyncHandler(async (req: Request, res: Response) => {
  const viewer = await attachUser(req);
  const target = await resolveMisskeyId(String(req.body?.noteId || ''));
  if (!target) {
    return res.status(400).json({ error: 'noteId を解決できません。', code: 'NO_SUCH_NOTE' });
  }
  const postId = await targetPostId(target);
  if (!postId) {
    return res.status(404).json({ error: 'ノートが見つかりません。', code: 'NO_SUCH_NOTE' });
  }

  const limit = readLimit(req.body?.limit, 10, 100);
  const cursor = await resolveTimeCursor(req.body);
  if (cursor.error) {
    return res.status(400).json({ error: cursor.error });
  }
  const conds = ['post_id = ?'];
  const params: any[] = [postId];
  if (cursor.untilAt) {
    conds.push('created_at < ?');
    params.push(cursor.untilAt);
  }
  if (cursor.sinceAt) {
    conds.push('created_at > ?');
    params.push(cursor.sinceAt);
  }
  const rows = (await db.prepare(
    `SELECT * FROM announces WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
  ).all(...params, limit)) as unknown as AnnounceRow[];

  const notes = (await Promise.all(rows.map((row) => noteFromAnnounce(row, viewer)))).filter(Boolean);
  res.json(notes);
}));

/** プロフィールのピン留め（`notes/featured` / `users/featured-notes`） */
async function respondFeaturedNotes(req: Request, res: Response): Promise<void> {
  const viewer = await attachUser(req);
  const found = await findUser(String(req.body?.userId || req.body?.username || ''));
  // ピン留めは Spica の手元にある分だけ（他のサーバーの人のピンは持っていない）
  if (!found || !found.user) {
    res.json([]);
    return;
  }
  const limit = readLimit(req.body?.limit, 10, 100);
  const rows = (await db.prepare(`
    SELECT
      p.*,
      p.id AS post_id,
      COALESCE(NULLIF(p.author_icon, ''), NULLIF(u.icon_url, ''), NULLIF(ra.icon_url, ''), '') AS author_icon,
      p.published_at AS timeline_at
    FROM pinned_posts pin
    JOIN posts p ON p.id = pin.post_id
    LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
    LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
    WHERE pin.user_id = ? AND COALESCE(p.visibility, 'public') != 'direct'
    ORDER BY pin.created_at DESC
    LIMIT ?
  `).all(found.user.id, limit)) as any[];

  const actorUrl = viewer ? `${config.origin}/users/${viewer.id}` : null;
  const enriched = await enrichAndFilterPosts(rows, actorUrl, viewer?.id || null);
  res.json(await toMisskeyNotes(enriched));
}

misskeyRouter.post('/notes/featured', asyncHandler((req, res) => respondFeaturedNotes(req, res)));
misskeyRouter.post('/users/featured-notes', asyncHandler((req, res) => respondFeaturedNotes(req, res)));

/** フォロー状態（`users/relation`）。クライアントはフォローボタンの表示に使う */
misskeyRouter.post('/users/relation', asyncHandler(async (req: Request, res: Response) => {
  const viewer = await attachUser(req);
  if (!requireUser(viewer, res)) return;

  const requested: string[] = (Array.isArray(req.body?.userId) ? req.body.userId : [req.body?.userId])
    .map((id: unknown) => String(id || '').trim())
    .filter(Boolean);
  if (requested.length === 0) {
    return res.status(400).json({ error: 'userId が必要です。' });
  }

  const myActorUrl = `${config.origin}/users/${viewer.id}`;
  // 依頼された ID を actor URL に直す（ローカルのユーザー名 / user@host / URL）
  const actorByRequest = new Map<string, string>();
  for (const id of requested) {
    const found = await findUser(id);
    if (found?.user) actorByRequest.set(id, `${config.origin}/users/${found.user.id}`);
    else if (found?.remote) actorByRequest.set(id, found.remote.id);
  }
  const actorUrls = Array.from(new Set(actorByRequest.values()));

  const following = new Map<string, string>();
  const followedBy = new Map<string, string>();
  const blocked = new Set<string>();
  const muted = new Set<string>();
  if (actorUrls.length > 0) {
    const placeholders = actorUrls.map(() => '?').join(', ');
    for (const row of (await db.prepare(
      `SELECT following_url, status FROM follows WHERE follower_url = ? AND following_url IN (${placeholders})`,
    ).all(myActorUrl, ...actorUrls)) as { following_url: string; status: string }[]) {
      following.set(row.following_url, row.status);
    }
    for (const row of (await db.prepare(
      `SELECT follower_url, status FROM follows WHERE following_url = ? AND follower_url IN (${placeholders})`,
    ).all(myActorUrl, ...actorUrls)) as { follower_url: string; status: string }[]) {
      followedBy.set(row.follower_url, row.status);
    }
    // ミュート・ブロックは**ローカルは利用者 ID、リモートは actor URL** で入っている
    const keys = [...actorUrls, ...actorUrls.filter((u) => u.startsWith(`${config.origin}/users/`)).map((u) => u.split('/').pop() as string)];
    const keyPlaceholders = keys.map(() => '?').join(', ');
    for (const row of (await db.prepare(
      `SELECT target_user_id FROM user_blocks WHERE user_id = ? AND target_user_id IN (${keyPlaceholders})`,
    ).all(viewer.id, ...keys)) as { target_user_id: string }[]) {
      blocked.add(row.target_user_id);
    }
    for (const row of (await db.prepare(
      `SELECT target_user_id FROM user_mutes WHERE user_id = ? AND target_user_id IN (${keyPlaceholders})`,
    ).all(viewer.id, ...keys)) as { target_user_id: string }[]) {
      muted.add(row.target_user_id);
    }
  }

  res.json(requested.map((id) => {
    const actorUrl = actorByRequest.get(id);
    const keys = actorUrl
      ? [actorUrl, actorUrl.startsWith(`${config.origin}/users/`) ? actorUrl.split('/').pop() as string : actorUrl]
      : [];
    const outStatus = actorUrl ? following.get(actorUrl) : undefined;
    const inStatus = actorUrl ? followedBy.get(actorUrl) : undefined;
    return {
      id,
      isFollowing: outStatus === 'accepted',
      isFollowed: inStatus === 'accepted',
      hasPendingFollowRequestFromYou: outStatus === 'pending',
      hasPendingFollowRequestToYou: inStatus === 'pending',
      isBlocking: keys.some((key) => blocked.has(key)),
      isBlocked: false,
      isMuted: keys.some((key) => muted.has(key)),
      isRenoteMuted: false,
    };
  }));
}));

// ===========================================================================
// 絵文字・ドライブ・リスト・アンテナ・その他
// ===========================================================================

/** カスタム絵文字の一覧（`emojis`） */
misskeyRouter.post('/emojis', asyncHandler(async (_req: Request, res: Response) => {
  const rows = (await db.prepare('SELECT name, url, category, aliases FROM custom_emojis ORDER BY name ASC').all()) as
    { name: string; url: string; category: string | null; aliases: string | null }[];
  res.json(rows.map((row) => ({
    name: row.name,
    url: row.url,
    category: row.category || null,
    aliases: (() => {
      try { return JSON.parse(row.aliases || '[]'); } catch { return []; }
    })(),
  })));
}));

/** ドライブの 1 ファイルを Misskey の形にする（アップロードと一覧で同じ形を使う） */
function misskeyFile(media: { url: string; name?: string | null; mediaType?: string | null; size?: number | null; thumbnailUrl?: string | null; createdAt?: string | null }) {
  return {
    id: media.url,
    createdAt: new Date(media.createdAt || Date.now()).toISOString(),
    name: media.name || '',
    type: media.mediaType || '',
    size: media.size || 0,
    url: media.url,
    thumbnailUrl: media.thumbnailUrl || null,
    isSensitive: false,
    comment: null,
  };
}

/** ドライブのファイル一覧（`drive/files`） */
misskeyRouter.post('/drive/files', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;

  const limit = readLimit(req.body?.limit, 40, 100);
  // 続きは untilId（この API はファイル ID として URL を返すので URL が来る）
  let cursor: { at: string; id: string } | null = null;
  if (typeof req.body?.untilId === 'string' && req.body.untilId) {
    const row = (await db.prepare('SELECT id, created_at FROM media WHERE user_id = ? AND (url = ? OR id = ?)')
      .get(user.id, req.body.untilId, req.body.untilId)) as { id: string; created_at: string } | undefined;
    if (!row) {
      return res.status(400).json({ error: 'untilId を解決できません。' });
    }
    cursor = { at: row.created_at, id: row.id };
  }

  const items = await listMedia({ userId: user.id, limit: limit + 1, cursor });
  res.json(items.slice(0, limit).map((row) => misskeyFile(toClientMedia(row))));
}));

/** ドライブのファイル削除（`drive/files/delete`） */
misskeyRouter.post('/drive/files/delete', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;

  const fileId = String(req.body?.fileId || '').trim();
  if (!fileId) {
    return res.status(400).json({ error: 'fileId が必要です。' });
  }
  // この API はファイル ID として URL を返しているので、URL と台帳の ID の両方を受ける
  const row = (await db.prepare('SELECT id FROM media WHERE user_id = ? AND (url = ? OR id = ?)')
    .get(user.id, fileId, fileId)) as { id: string } | undefined;
  if (!row) {
    return res.status(404).json({ error: 'ファイルが見つかりません。' });
  }
  const result = await deleteMedia(user.id, row.id);
  if (!result.ok) {
    return res.status(result.inUse ? 409 : 404).json({ error: result.error });
  }
  res.status(204).end();
}));

/** 自分のリスト一覧（`users/lists/list`） */
misskeyRouter.post('/users/lists/list', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const limit = readLimit(req.body?.limit, 30, 100);
  const rows = (await db.prepare('SELECT id, name, created_at FROM lists WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(user.id, limit)) as { id: string; name: string; created_at: string }[];
  res.json(rows.map((row) => ({
    id: row.id,
    userId: user.id,
    name: row.name,
    createdAt: new Date(row.created_at).toISOString(),
    isPublic: false,
  })));
}));

/** リストのタイムライン（`notes/user-list-timeline`） */
misskeyRouter.post('/notes/user-list-timeline', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;

  const listId = String(req.body?.listId || '').trim();
  if (!listId) {
    return res.status(400).json({ error: 'listId が必要です。' });
  }
  const limit = readLimit(req.body?.limit, 20, 100);
  const query: Record<string, string> = { limit: String(limit) };
  if (typeof req.body?.untilId === 'string' && req.body.untilId) {
    const pair = await misskeyCursorPair(req.body.untilId);
    if (!pair) {
      return res.status(400).json({ error: 'untilId を解決できません。' });
    }
    query.cursor = encodeCursor(pair.at, pair.id);
  }

  // 判定（公開範囲・ミュートワード・メンバーの解決）は Spica のリストのタイムラインをそのまま使う
  req.params = { ...(req.params || {}), id: listId } as any;
  req.query = query as any;
  const result = await callHandler(handleListTimeline, req);
  if (forwardError(res, result)) return;
  res.json(await toMisskeyNotes((result.body?.posts || []) as any[]));
}));

/** 自分のアンテナ一覧（`antennas/list`） */
misskeyRouter.post('/antennas/list', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const rows = (await db.prepare('SELECT * FROM antennas WHERE user_id = ? ORDER BY created_at DESC').all(user.id)) as any[];
  res.json(rows.map(misskeyAntenna));
}));

/** アンテナのタイムライン（`antennas/notes`） */
misskeyRouter.post('/antennas/notes', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;

  const antennaId = String(req.body?.antennaId || '').trim();
  if (!antennaId) {
    return res.status(400).json({ error: 'antennaId が必要です。' });
  }
  const limit = readLimit(req.body?.limit, 20, 100);
  const query: Record<string, string> = { limit: String(limit) };
  if (typeof req.body?.untilId === 'string' && req.body.untilId) {
    const pair = await misskeyCursorPair(req.body.untilId);
    if (!pair) {
      return res.status(400).json({ error: 'untilId を解決できません。' });
    }
    query.cursor = encodeCursor(pair.at, pair.id);
  }

  req.params = { ...(req.params || {}), id: antennaId } as any;
  req.query = query as any;
  const result = await callHandler(handleAntennaTimeline, req);
  if (forwardError(res, result)) return;
  res.json(await toMisskeyNotes((result.body?.posts || []) as any[]));
}));

/** タグのノート（`notes/search-by-tag`）。絞り込みは Spica のタグのタイムラインに任せる */
misskeyRouter.post('/notes/search-by-tag', asyncHandler(async (req: Request, res: Response) => {
  const tag = String(req.body?.tag || '').replace(/^#/, '').trim();
  if (!tag) {
    return res.json([]);
  }
  const limit = readLimit(req.body?.limit, 20, 100);
  const query: Record<string, string> = { mode: 'tag', tag, limit: String(limit) };
  if (typeof req.body?.untilId === 'string' && req.body.untilId) {
    const pair = await misskeyCursorPair(req.body.untilId);
    if (!pair) {
      return res.status(400).json({ error: 'untilId を解決できません。' });
    }
    query.cursor = encodeCursor(pair.at, pair.id);
  }
  req.query = query as any;
  const result = await callHandler(handleTimeline, req);
  if (forwardError(res, result)) return;
  const rows = Array.isArray(result.body) ? result.body : [];
  res.json(await toMisskeyNotes(rows as any[]));
}));

/** いまつながっているクライアント数（`get-online-users-count`） */
misskeyRouter.post('/get-online-users-count', asyncHandler(async (_req: Request, res: Response) => {
  res.json({ count: getStreamClientCount() });
}));

/**
 * URL からノート・ユーザーを引く（`ap/show`）。
 * クライアントの「URL を貼って開く」操作がこれを使う。
 */
misskeyRouter.post('/ap/show', asyncHandler(async (req: Request, res: Response) => {
  const viewer = await attachUser(req);
  const uri = String(req.body?.uri || '').trim();
  if (!uri) {
    return res.status(400).json({ error: 'uri が必要です。' });
  }

  // 投稿（正規 ID。末尾スラッシュ付きでも引く）
  const post = (await db.prepare('SELECT id FROM posts WHERE id = ? OR id = ?')
    .get(uri, uri.replace(/\/+$/, ''))) as { id: string } | undefined;
  if (post) {
    const note = await loadNote(post.id, viewer);
    if (note) {
      return res.json({ type: 'Note', object: note });
    }
  }

  // ユーザー（ローカル・リモートとも。リモートはキャッシュに無ければ取りに行く）
  const user = await userObject(uri);
  if (user) {
    return res.json({ type: 'User', object: user });
  }

  res.status(404).json({ error: 'この URL は解決できませんでした。', code: 'NO_SUCH_OBJECT' });
}));

/** 通知を 1 件だけ既読にする（`i/read-notification`） */
misskeyRouter.post('/i/read-notification', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const target = await resolveMisskeyId(String(req.body?.notificationId || ''), ['notification']);
  if (!target) {
    return res.status(400).json({ error: 'notificationId を解決できません。', code: 'NO_SUCH_NOTIFICATION' });
  }
  req.params = { ...(req.params || {}), id: target.id } as any;
  const result = await callHandler(handleReadNotification, req);
  if (forwardError(res, result)) return;
  res.status(204).end();
}));

/** 自分のプロフィール更新（`i/update`）。項目名を Spica の形へ読み替えて既存のハンドラに渡す */
misskeyRouter.post('/i/update', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const body = req.body || {};

  // アバター・バナーは drive のファイル ID（この API では URL）で指定される
  const avatar = typeof body.avatarId === 'string' ? body.avatarId : (typeof body.avatarUrl === 'string' ? body.avatarUrl : undefined);
  const banner = typeof body.bannerId === 'string' ? body.bannerId : (typeof body.bannerUrl === 'string' ? body.bannerUrl : undefined);

  req.body = {
    ...(typeof body.name === 'string' ? { name: body.name } : {}),
    ...(typeof body.description === 'string' ? { summary: body.description } : {}),
    ...(typeof body.isLocked === 'boolean' ? { is_locked: body.isLocked } : {}),
    ...(typeof body.isExplorable === 'boolean' ? { discoverable: body.isExplorable } : {}),
    ...(avatar !== undefined ? { icon_url: avatar } : {}),
    ...(banner !== undefined ? { banner_url: banner } : {}),
    ...(Array.isArray(body.fields) ? { fields: body.fields } : {}),
  };
  const result = await callHandler(handleUpdateProfile, req);
  if (forwardError(res, result)) return;
  res.status(204).end();
}));

/** ピン留め（`i/pin` / `i/unpin`）。トグルではないので**指定した状態に**する */
async function pinNote(req: Request, res: Response, pinned: boolean): Promise<void> {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const target = await resolveMisskeyId(String(req.body?.noteId || ''), ['post']);
  if (!target) {
    return void res.status(400).json({ error: 'noteId を解決できません。', code: 'NO_SUCH_NOTE' });
  }
  const result = await setPinnedPost(user.id, target.id, pinned);
  if (!result.success) {
    return void res.status(result.status || 400).json({ error: result.error });
  }
  res.status(204).end();
}
misskeyRouter.post('/i/pin', asyncHandler((req, res) => pinNote(req, res, true)));
misskeyRouter.post('/i/unpin', asyncHandler((req, res) => pinNote(req, res, false)));

/** ノートの編集（`notes/update`）。編集の連合（Update）は Spica のハンドラが行う */
misskeyRouter.post('/notes/update', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const target = await resolveMisskeyId(String(req.body?.noteId || ''), ['post']);
  if (!target) {
    return res.status(400).json({ error: 'noteId を解決できません。', code: 'NO_SUCH_NOTE' });
  }
  const body = req.body || {};
  const result = await executeUpdatePost({
    user: req.rawUser!,
    postId: target.id,
    content: typeof body.text === 'string' ? body.text : undefined,
    cw: body.cw === null ? null : (typeof body.cw === 'string' ? body.cw : undefined),
  });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }
  res.status(204).end();
}));

/** ミュート / ブロック（`mute/*` `blocking/*`）。判定と連合は Spica のハンドラに任せる */
async function delegateByIdentifier(
  handler: RequestHandler,
  identifier: string,
  req: Request,
): Promise<{ status: number; body: any }> {
  req.params = { ...(req.params || {}), identifier } as any;
  return await callHandler(handler, req);
}

misskeyRouter.post('/mute/create', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const identifier = String(req.body?.userId || '').trim();
  if (!identifier) {
    return res.status(400).json({ error: 'userId が必要です。' });
  }
  const result = await delegateByIdentifier(handleMuteUser, identifier, req);
  if (forwardError(res, result)) return;
  res.status(204).end();
}));

misskeyRouter.post('/mute/delete', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const identifier = String(req.body?.userId || '').trim();
  if (!identifier) {
    return res.status(400).json({ error: 'userId が必要です。' });
  }
  const result = await delegateByIdentifier(handleUnmuteUser, identifier, req);
  if (forwardError(res, result)) return;
  res.status(204).end();
}));

misskeyRouter.post('/mute/list', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const limit = readLimit(req.body?.limit, 30, 100);
  const rows = (await db.prepare('SELECT target_user_id FROM user_mutes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(user.id, limit)) as { target_user_id: string }[];
  const users = (await Promise.all(rows.map((row) => userObject(row.target_user_id)))).filter(Boolean);
  res.json(users);
}));

misskeyRouter.post('/blocking/create', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const identifier = String(req.body?.userId || '').trim();
  if (!identifier) {
    return res.status(400).json({ error: 'userId が必要です。' });
  }
  const result = await delegateByIdentifier(handleBlockUser, identifier, req);
  if (forwardError(res, result)) return;
  // Misskey はブロックした相手を返す
  const blocked = await userObject(identifier);
  if (!blocked) {
    return res.status(204).end();
  }
  res.json(blocked);
}));

misskeyRouter.post('/blocking/delete', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const identifier = String(req.body?.userId || '').trim();
  if (!identifier) {
    return res.status(400).json({ error: 'userId が必要です。' });
  }
  const result = await delegateByIdentifier(handleUnblockUser, identifier, req);
  if (forwardError(res, result)) return;
  res.status(204).end();
}));

misskeyRouter.post('/blocking/list', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const limit = readLimit(req.body?.limit, 30, 100);
  const rows = (await db.prepare('SELECT target_user_id FROM user_blocks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(user.id, limit)) as { target_user_id: string }[];
  const users = (await Promise.all(rows.map((row) => userObject(row.target_user_id)))).filter(Boolean);
  res.json(users);
}));

/** 受け取ったフォローリクエスト（`following/requests/list`。旧い名前の `i/following/requests/list` も同じ） */
async function respondFollowRequests(req: Request, res: Response): Promise<void> {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const limit = readLimit(req.body?.limit, 30, 100);
  const myActorUrl = `${config.origin}/users/${user.id}`;
  const rows = (await db.prepare(
    "SELECT follower_url FROM follows WHERE following_url = ? AND status = 'pending' ORDER BY created_at DESC LIMIT ?",
  ).all(myActorUrl, limit)) as { follower_url: string }[];
  const users = (await Promise.all(rows.map((row) => userObject(row.follower_url)))).filter(Boolean);
  res.json(users);
}

misskeyRouter.post('/following/requests/list', asyncHandler((req, res) => respondFollowRequests(req, res)));
misskeyRouter.post('/i/following/requests/list', asyncHandler((req, res) => respondFollowRequests(req, res)));

/** フォローリクエストの承認 / 拒否 / 取り消し（`following/requests/*`） */
async function respondFollowRequestAction(
  req: Request,
  res: Response,
  action: 'accept' | 'reject' | 'cancel',
): Promise<void> {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;

  const found = await findUser(String(req.body?.userId || ''));
  const actorUrl = found?.user ? `${config.origin}/users/${found.user.id}` : found?.remote?.id;
  if (!actorUrl) {
    return void res.status(404).json({ error: 'ユーザーが見つかりません。', code: 'NO_SUCH_USER' });
  }

  if (action === 'cancel') {
    // 自分が送ったリクエストの取り消し（Undo(Follow) の配送込み）
    req.body = { targetActorUrl: actorUrl };
    const result = await callHandler(handleUnfollow, req);
    if (forwardError(res, result)) return;
    return void res.status(204).end();
  }

  req.body = { actorUrl, action };
  const result = await callHandler(handleRespondFollowRequest, req);
  if (forwardError(res, result)) return;
  res.status(204).end();
}

misskeyRouter.post('/following/requests/accept', asyncHandler((req, res) => respondFollowRequestAction(req, res, 'accept')));
misskeyRouter.post('/following/requests/reject', asyncHandler((req, res) => respondFollowRequestAction(req, res, 'reject')));
misskeyRouter.post('/following/requests/cancel', asyncHandler((req, res) => respondFollowRequestAction(req, res, 'cancel')));

/** お気に入り（ブックマーク）の一覧（`i/favorites`） */
misskeyRouter.post('/i/favorites', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;

  const limit = readLimit(req.body?.limit, 20, 100);
  const query: Record<string, string> = { limit: String(limit) };
  if (typeof req.body?.untilId === 'string' && req.body.untilId) {
    const target = await resolveMisskeyId(req.body.untilId);
    const postId = target ? await targetPostId(target) : null;
    // 一覧は「登録した時刻」で並ぶので、カーソルもブックマーク側の時刻で組む
    const row = postId
      ? (await db.prepare('SELECT created_at FROM bookmarks WHERE user_id = ? AND post_id = ?').get(user.id, postId)) as
        | { created_at: string }
        | undefined
      : undefined;
    if (!postId || !row) {
      return res.status(400).json({ error: 'untilId を解決できません。' });
    }
    query.cursor = encodeCursor(row.created_at, postId);
  }

  req.query = query as any;
  const result = await callHandler(handleListBookmarks, req);
  if (forwardError(res, result)) return;
  const rows = Array.isArray(result.body) ? result.body : [];
  res.json(await toMisskeyNotes(rows as any[]));
}));

// ===========================================================================
// リスト・アンテナの作成・更新・削除（`users/lists/*` `antennas/*`）
// ===========================================================================

/** リストの作成 → 作ったリストを Misskey の形で返す */
misskeyRouter.post('/users/lists/create', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  req.body = { name: req.body?.name };
  const result = await callHandler(handleCreateList, req);
  if (forwardError(res, result)) return;
  const id = String(result.body?.id || '');
  const name = String(result.body?.name || '');
  res.json({ id, userId: user.id, name, createdAt: new Date().toISOString(), isPublic: false });
}));

misskeyRouter.post('/users/lists/update', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const listId = String(req.body?.listId || '').trim();
  if (!listId) {
    return res.status(400).json({ error: 'listId が必要です。' });
  }
  req.params = { ...(req.params || {}), id: listId } as any;
  req.body = { name: req.body?.name };
  const result = await callHandler(handleUpdateList, req);
  if (forwardError(res, result)) return;
  res.status(204).end();
}));

misskeyRouter.post('/users/lists/delete', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const listId = String(req.body?.listId || '').trim();
  if (!listId) {
    return res.status(400).json({ error: 'listId が必要です。' });
  }
  req.params = { ...(req.params || {}), id: listId } as any;
  const result = await callHandler(handleDeleteList, req);
  if (forwardError(res, result)) return;
  res.status(204).end();
}));

/** リストへ追加（`users/lists/push`）。Misskey は userId で渡す */
misskeyRouter.post('/users/lists/push', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const listId = String(req.body?.listId || '').trim();
  const found = await findUser(String(req.body?.userId || ''));
  if (!listId) {
    return res.status(400).json({ error: 'listId が必要です。' });
  }
  if (!found) {
    return res.status(404).json({ error: 'ユーザーが見つかりません。', code: 'NO_SUCH_USER' });
  }
  // Spica のメンバー追加はハンドル / actor URL / 利用者 ID を受ける
  req.params = { ...(req.params || {}), id: listId } as any;
  req.body = { member: found.user ? found.user.id : found.remote.id };
  const result = await callHandler(handleAddListMember, req);
  if (forwardError(res, result)) return;
  res.status(204).end();
}));

/** リストから外す（`users/lists/pull`） */
misskeyRouter.post('/users/lists/pull', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const listId = String(req.body?.listId || '').trim();
  const found = await findUser(String(req.body?.userId || ''));
  if (!listId) {
    return res.status(400).json({ error: 'listId が必要です。' });
  }
  if (!found) {
    return res.status(404).json({ error: 'ユーザーが見つかりません。', code: 'NO_SUCH_USER' });
  }
  const memberValue = found.user ? found.user.id : found.remote.id;
  // Spica のメンバー削除は行 ID を取るので、先に引く
  const row = (await db.prepare(
    'SELECT id FROM list_members WHERE list_id = ? AND (member = ? OR member = ? OR display_name = ?)',
  ).get(listId, memberValue, `${config.origin}/users/${memberValue}`, String(req.body?.userId || ''))) as { id: string } | undefined;
  if (!row) {
    return res.status(404).json({ error: 'リストのメンバーではありません。' });
  }
  req.params = { ...(req.params || {}), id: listId, memberId: row.id } as any;
  const result = await callHandler(handleRemoveListMember, req);
  if (forwardError(res, result)) return;
  res.status(204).end();
}));

/** アンテナの 1 件を Misskey の形にする */
function misskeyAntenna(row: any) {
  const split = (value: unknown) => String(value || '').split(/[,、\n\s]+/).map((k) => k.trim()).filter(Boolean);
  return {
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    name: row.name,
    keywords: split(row.keywords),
    excludeKeywords: split(row.exclude_keywords),
    src: ['home', 'all', 'users'].includes(row.src) ? row.src : 'all',
    userListId: null,
    users: split(row.user_list).map((u) => u.replace(/^@/, '')),
    caseSensitive: Boolean(row.case_sensitive),
    notify: Boolean(row.notify),
    withReplies: false,
    withFile: Boolean(row.with_file),
  };
}

/** Misskey のアンテナ条件 → Spica の形（キーワードは配列で来る） */
function antennaBodyFromMisskey(body: any): Record<string, unknown> {
  const keywords: string[] = Array.isArray(body?.keywords) ? body.keywords.map((k: unknown) => String(k)).filter(Boolean) : [];
  const exclude: string[] = Array.isArray(body?.excludeKeywords)
    ? body.excludeKeywords.map((k: unknown) => String(k)).filter(Boolean)
    : [];
  const users: string[] = Array.isArray(body?.users) ? body.users.map((u: unknown) => String(u)).filter(Boolean) : [];
  // Misskey の src は home / all / users / list。Spica に list は無いので users として受ける
  const rawSrc = String(body?.src || 'all');
  const src = users.length > 0 ? 'users' : (['home', 'all'].includes(rawSrc) ? rawSrc : 'all');
  return {
    name: body?.name,
    src,
    user_list: users.join(','),
    keywords: keywords.join(' '),
    exclude_keywords: exclude.join(' '),
    case_sensitive: Boolean(body?.caseSensitive),
    with_file: Boolean(body?.withFile),
    notify: Boolean(body?.notify),
  };
}

misskeyRouter.post('/antennas/show', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const antennaId = String(req.body?.antennaId || '').trim();
  if (!antennaId) {
    return res.status(400).json({ error: 'antennaId が必要です。' });
  }
  req.params = { ...(req.params || {}), id: antennaId } as any;
  const result = await callHandler(handleShowAntenna, req);
  if (forwardError(res, result)) return;
  res.json(misskeyAntenna(result.body));
}));

misskeyRouter.post('/antennas/create', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  req.body = antennaBodyFromMisskey(req.body);
  const result = await callHandler(handleCreateAntenna, req);
  if (forwardError(res, result)) return;
  res.json(misskeyAntenna(result.body));
}));

misskeyRouter.post('/antennas/update', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const antennaId = String(req.body?.antennaId || '').trim();
  if (!antennaId) {
    return res.status(400).json({ error: 'antennaId が必要です。' });
  }
  req.params = { ...(req.params || {}), id: antennaId } as any;
  req.body = antennaBodyFromMisskey(req.body);
  const result = await callHandler(handleUpdateAntenna, req);
  if (forwardError(res, result)) return;
  res.json(misskeyAntenna(result.body));
}));

misskeyRouter.post('/antennas/delete', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const antennaId = String(req.body?.antennaId || '').trim();
  if (!antennaId) {
    return res.status(400).json({ error: 'antennaId が必要です。' });
  }
  req.params = { ...(req.params || {}), id: antennaId } as any;
  const result = await callHandler(handleDeleteAntenna, req);
  if (forwardError(res, result)) return;
  res.status(204).end();
}));

// ===========================================================================
// MiAuth（ブラウザで承認してトークンを受け取る Misskey 標準のログイン）
// ===========================================================================

export const miauthRouter = Router();

interface MiauthRow {
  id: string;
  app_name: string;
  callback: string;
  permissions: string;
  created_at: string;
  status: string;
  approved_user_id: string | null;
  token: string | null;
}

/**
 * クライアントがブラウザで開く URL。
 * ここでリクエスト内容（アプリ名・権限）を覚えてから SPA に渡す（承認画面はクライアント側）。
 */
miauthRouter.get('/:session', asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const session = String(req.params.session || '').slice(0, 100);
  if (!session) return next();

  const name = String(req.query.name || '').slice(0, 100) || 'クライアント';
  const callback = String(req.query.callback || '').slice(0, 500);
  const permissions = String(req.query.permission || '').slice(0, 1000);

  const existing = (await db.prepare('SELECT * FROM miauth_sessions WHERE id = ?').get(session)) as MiauthRow | undefined;
  if (!existing) {
    await db.prepare(
      'INSERT INTO miauth_sessions (id, app_name, callback, permissions, created_at, status) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(session, name, callback, permissions, new Date().toISOString(), 'pending');
    // この URL は認証なしで叩けるので、古いセッションを掃除して増え続けないようにする
    await db.prepare('DELETE FROM miauth_sessions WHERE created_at < ?')
      .run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  }

  if (!req.headers.accept || !req.headers.accept.includes('text/html')) {
    // API として叩かれた場合は内容だけ返す
    return res.json({ session, name, permissions: permissions ? permissions.split(',').filter(Boolean) : [] });
  }
  return next();
}));

/** 承認画面が読む（ログイン済みの利用者だけ） */
miauthRouter.get('/:session/info', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const session = String(req.params.session || '');
  const row = (await db.prepare('SELECT * FROM miauth_sessions WHERE id = ?').get(session)) as MiauthRow | undefined;
  if (!row) {
    return res.status(404).json({ error: 'セッションが見つかりません。' });
  }
  res.json({
    session: row.id,
    name: row.app_name,
    callback: row.callback,
    permissions: row.permissions ? row.permissions.split(',').filter(Boolean) : [],
    status: row.status,
  });
}));

/** 承認（ログイン中の利用者としてトークンを発行する） */
miauthRouter.post('/:session/approve', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const session = String(req.params.session || '');
  const row = (await db.prepare('SELECT * FROM miauth_sessions WHERE id = ?').get(session)) as MiauthRow | undefined;
  if (!row) {
    return res.status(404).json({ error: 'セッションが見つかりません。' });
  }
  if (row.status === 'approved' && row.token) {
    return res.json({ success: true, alreadyApproved: true });
  }

  // 通常のセッションと同じトークンを発行する（設定画面のセッション一覧から失効できる）
  const { token } = await createSession(user.id, req.headers["user-agent"]);
  await db.prepare('UPDATE miauth_sessions SET status = ?, approved_user_id = ?, token = ? WHERE id = ?')
    .run('approved', user.id, token, session);
  res.json({ success: true });
}));

/** 拒否 */
miauthRouter.post('/:session/deny', asyncHandler(async (req: Request, res: Response) => {
  const user = await attachUser(req);
  if (!requireUser(user, res)) return;
  const session = String(req.params.session || '');
  await db.prepare('UPDATE miauth_sessions SET status = ? WHERE id = ?').run('denied', session);
  res.json({ success: true });
}));

/** クライアントがトークンを受け取る（承認されるまで ok: false） */
miauthRouter.post('/:session/check', asyncHandler(async (req: Request, res: Response) => {
  const session = String(req.params.session || '');
  const row = (await db.prepare('SELECT * FROM miauth_sessions WHERE id = ?').get(session)) as MiauthRow | undefined;
  if (!row) {
    return res.json({ ok: false });
  }
  if (row.status === 'approved' && row.token) {
    return res.json({ ok: true, token: row.token });
  }
  res.json({ ok: false });
}));
