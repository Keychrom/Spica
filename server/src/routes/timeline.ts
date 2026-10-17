/**
 * タイムライン・検索・タグ・入力補完・SSE。
 *
 * api.ts から切り出したルーター。マウント位置（api.ts）は元の登録順と同じ。
 */
import { asyncHandler } from '../asyncHandler.js';
import { Router, Request, Response } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { collectVisiblePage, cursorPredicate, parsePageQuery, type PageCursor } from '../pagination.js';
import { getUserFromToken, issueStreamTicket, consumeStreamTicket } from '../auth.js';
import { getUserPrefs } from '../userPrefs.js';
import { addStreamClient, removeStreamClient, isStreamAtCapacity } from '../streaming.js';
import { parseStreams } from '../streamRouting.js';
import { cacheGet, cacheSet, isTimelineCacheEnabled } from '../timelineCache.js';
import { resolveWebFinger, fetchRemoteActor } from '../activitypub.js';
import { enrichAndFilterPosts } from '../postEnrichment.js';

const router = Router();

// ==========================================
// 📡 リアルタイムストリーミング (SSE) エンドポイント
//    ?streams=local,home,tag:foo で「受け取りたいもの」を申告する（省略時は全部＝従来どおり）
// ==========================================
router.get('/streaming', asyncHandler(async (req: Request, res: Response) => {
  let user = req.user;
  if (!user && req.query.token && typeof req.query.token === 'string') {
    // 旧経路（互換のため残す）。アプリ本体は下のチケットを使う
    user = await getUserFromToken(req.query.token) || undefined;
  }
  if (!user && req.query.ticket && typeof req.query.ticket === 'string') {
    // ワンタイムチケット（60 秒・1 回だけ）。チケットを付けて無効なら、黙って
    // 未認証にせず断る（アプリは取り直して張り直す）
    user = await consumeStreamTicket(req.query.ticket) || undefined;
    if (!user) {
      res.status(401).json({ error: 'ストリーミングのチケットが無効です。' });
      return;
    }
  }
  // 常時接続の上限。溢れたら待たせずに断る（クライアントは少し待って張り直す）
  if (isStreamAtCapacity()) {
    res.setHeader('Retry-After', '30');
    res.status(503).json({ error: 'リアルタイム接続が混み合っています。しばらく待ってから再接続してください。' });
    return;
  }
  const clientId = addStreamClient(res, user?.id, parseStreams(req.query.streams));
  req.on('close', () => {
    removeStreamClient(clientId);
  });
}));

/**
 * ストリーミング接続用のワンタイムチケットを発行する
 * （EventSource はヘッダを付けられないため、トークンをクエリに載せないための経路）
 */
router.post('/streaming/ticket', asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'ログインが必要です。' });
    return;
  }
  const ticket = await issueStreamTicket(req.user.id);
  res.json({ ticket, expiresIn: 60 });
}));


// タイムライン取得（ローカル / ホーム / 連合 / タグ別）- リノート（RT）・リアクション・返信集計付き
export const handleTimeline = asyncHandler(async (req: Request, res: Response) => {
  const mode = req.query.mode as string; // 'local', 'home', 'all', 'tag'
  const tag = (req.query.tag as string || '').trim().replace(/^#/, '');
  const page = parsePageQuery(req, 50);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }

  // 条件は配列に溜めて AND で連結する（OR を含む条件を括弧で囲い、
  // カーソル条件と混ざっても優先順位が壊れないようにする）
  const postConds: string[] = [];
  const announceConds: string[] = [];
  const params: any[] = [];
  const announceParams: any[] = [];

  // DM（visibility = 'direct'）はどのタイムラインにも出さない（存在自体を見せない。docs/DM.md）
  postConds.push("COALESCE(p.visibility, 'public') != 'direct'");
  announceConds.push("COALESCE(p.visibility, 'public') != 'direct'");

  // ホームの「フォロー中」判定は follows を JOIN して行う。
  // `author_url IN (SELECT following_url FROM follows ...)` と書くと、PostgreSQL は
  // published_at の索引で「21 件そろった時点で止まる」ことができず、候補（数千〜10 万件）を
  // 全部読んでから並べ替える。JOIN にすると両エンジンとも索引の逆順走査で止まれる
  // （実測: 596ms → 0.1ms / PostgreSQL 265ms → 0.7ms）。
  let postFollowJoin = '';
  let announceFollowJoin = '';
  let followParam: string | null = null;
  // ホームでブーストを隠す設定のときは、ブースト側の枝ごと落とす（行を読まない）
  let hideAnnounces = false;

  // 投稿側の FROM 句。タグのときだけ FTS を噛ませる（下の tag 分岐を参照）
  let postFrom = 'posts p';
  const recentScanPosts = mode === 'tag' ? config.recentScanPosts : 0;

  if (mode === 'tag' && tag) {
    // タグは「本文に #tag を含む投稿を新しい順に」。`content LIKE '%#tag%'` だけだと
    // **毎回 全件走査**になり、32 万投稿で 300ms 超（SQLite は同期ドライバなので、
    // ハッシュタグを 1 回クリックされるだけでプロセスが止まる）。
    //
    // FTS（trigram）で候補を絞る手もあるが、**FTS の索引範囲は `fts_index_scope`（既定は
    // ローカル投稿のみ）**なので、リモート投稿のタグが出なくなる。タグは「いま何が話題か」を
    // 見る機能なので、**直近 N 件（`RECENT_SCAN_POSTS`・既定 2 万）に限って走査**し、
    // リモート投稿も今までどおり拾う（N 件の索引走査なので DB が育ってもコストは一定）。
    if (recentScanPosts > 0) {
      postConds.push(`p.published_at >= (
        SELECT COALESCE(MIN(published_at), '') FROM (SELECT published_at FROM posts ORDER BY published_at DESC LIMIT ?)
      )`);
      params.push(recentScanPosts);
    }
    postConds.push('(p.content LIKE ? OR p.content LIKE ?)');
    announceConds.push('(p.content LIKE ? OR p.content LIKE ?)');
    params.push(`%#${tag}%`, `%/tags/${tag}%`);
    announceParams.push(`%#${tag}%`, `%/tags/${tag}%`);
  } else if (mode === 'local') {
    postConds.push('p.is_local = 1');
    announceConds.push('a.is_local = 1');
  } else if (mode === 'home') {
    const myActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;
    if (myActorUrl) {
      postFollowJoin = 'LEFT JOIN follows f ON f.following_url = p.author_url AND f.follower_url = ?';
      announceFollowJoin = 'LEFT JOIN follows f ON f.following_url = a.user_id AND f.follower_url = ?';
      // ホームは「**自分 + フォロー中の人**」だけ（2026-10-15 に変更）。
      // 以前は `p.is_local = 1 OR フォロー中` で、ローカルの全員の投稿がホームに並んでいた
      // （小さいサーバーでもホームが賑わう利点はあったが、フォローしていない人の投稿が
      //  混ざる＝ホームとローカルの区別が付かない）。ローカルだけ見たいときは「ローカル」タブへ
      postConds.push('(p.author_url = ? OR f.follower_url IS NOT NULL)');
      announceConds.push('(a.user_id = ? OR f.follower_url IS NOT NULL)');
      params.push(myActorUrl); // 自分の投稿もホームに出す
      announceParams.push(myActorUrl); // 自分のブーストも
      followParam = myActorUrl;
      // 本人の設定（ホームでブースト・返信を隠す）。ゲストには設定が無いので触らない
      const homePrefs = await getUserPrefs(req.user!.id);
      if (homePrefs.hideRepliesInHome) {
        // 自分の返信は残す（自分が書いた返信が消えると会話の文脈が切れる）
        postConds.push('(p.in_reply_to IS NULL OR p.user_id = ?)');
        params.push(req.user!.id);
      }
      if (homePrefs.hideBoostsInHome) hideAnnounces = true;
    } else {
      postConds.push('p.is_local = 1');
      announceConds.push('a.is_local = 1');
    }
  }

  // 枝ごとに ORDER BY + LIMIT を押し込む。PostgreSQL は `UNION ALL` の外側に ORDER BY があると
  // 枝を全部読んでから並べ替える（LIMIT が押し込まれない）ため、投稿が増えるほど遅くなる。
  // 枝の中で並べ替えておけば、索引の逆順走査で「必要な件数だけ」読んで止まれる
  // （実測: 連合 812ms → 0.8ms、ローカル 226ms → 0.3ms。SQLite は元々 MERGE で流していた）。
  //
  // 除外（ブロック・ミュート・ミュートワード・フォロワー限定）は enrich の後で分かるので、
  // ここでは**カーソル位置と件数を受け取って読むだけ**にし、ページの組み立ては
  // collectVisiblePage に任せる（足りなければ読み足す）
  const fetchTimelineRows = async (cursor: PageCursor | null, n: number): Promise<any[]> => {
    const postCondsRun = [...postConds];
    const announceCondsRun = [...announceConds];
    const paramsRun = [...params];
    const announceParamsRun = [...announceParams];
    // 続きの読み込み（カーソル）：ORDER BY と同じ組で比較する
    if (cursor) {
      postCondsRun.push(cursorPredicate('p.published_at', 'p.id'));
      announceCondsRun.push(cursorPredicate('a.created_at', 'p.id'));
      paramsRun.push(cursor.at, cursor.at, cursor.id);
      announceParamsRun.push(cursor.at, cursor.at, cursor.id);
    }
    const postWhere = postCondsRun.length > 0 ? ` WHERE ${postCondsRun.join(' AND ')}` : '';
    const announceWhere = announceCondsRun.length > 0 ? ` WHERE ${announceCondsRun.join(' AND ')}` : '';

    const query = `
    SELECT * FROM (
    SELECT 
      p.id AS post_id,
      p.user_id,
      p.author_name,
      p.author_url,
      p.author_handle,
      p.content,
      p.cw,
      p.is_local,
      p.visibility,
      p.emojis,p.in_reply_to,
      p.quote_id,
      p.is_sensitive,
      p.media_attachments,
      p.published_at,
      p.edited_at,
      p.channel_id,
      COALESCE(
        NULLIF(p.author_icon, ''),
        NULLIF(u.icon_url, ''),
        NULLIF(ra.icon_url, ''),
        ''
      ) AS author_icon,
      NULL AS announce_id,
      NULL AS renoted_by_name,
      NULL AS renoted_by_handle,
      NULL AS renoted_by_icon,
      NULL AS renoted_by_url,
      p.published_at AS timeline_at
    FROM ${postFrom}
    ${postFollowJoin}
    LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
    LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
    ${postWhere}
    ORDER BY p.published_at DESC, p.id DESC
    LIMIT ?

    )${hideAnnounces ? '' : `
    UNION ALL SELECT * FROM (

    SELECT 
      p.id AS post_id,
      p.user_id,
      p.author_name,
      p.author_url,
      p.author_handle,
      p.content,
      p.cw,
      p.is_local,
      p.visibility,
      p.emojis,p.in_reply_to,
      p.quote_id,
      p.is_sensitive,
      p.media_attachments,
      p.published_at,
      p.edited_at,
      p.channel_id,
      COALESCE(
        NULLIF(p.author_icon, ''),
        NULLIF(u.icon_url, ''),
        NULLIF(ra.icon_url, ''),
        ''
      ) AS author_icon,
      a.id AS announce_id,
      a.user_name AS renoted_by_name,
      a.user_handle AS renoted_by_handle,
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

    )`}
    ORDER BY timeline_at DESC, post_id DESC
    LIMIT ?
  `;

    // パラメータは SQL に現れる順に並べる（枝の中の JOIN → 条件 → 枝の LIMIT、最後に外側の LIMIT）
    const postsBranchParams = [...(followParam ? [followParam] : []), ...paramsRun, n];
    const announcesBranchParams = [...(followParam ? [followParam] : []), ...announceParamsRun, n];
    return await db.prepare(query).all(
      ...postsBranchParams,
      ...(hideAnnounces ? [] : announcesBranchParams),
      n,
    ) as any[];
  };

  // 読み取りの結果を短い TTL でキャッシュする（同じ画面を何度も開いたときの組み立てを省く）。
  // **ユーザーごと**に鍵を分ける（リアクション・ブックマーク・投票の状態が混ざるため）。
  const cacheKey = [
    'timeline',
    req.user?.id || 'guest',
    mode || 'all',
    tag,
    encodeURIComponent(Array.isArray(req.query.cursor) ? String(req.query.cursor[0]) : String(req.query.cursor || '')),
    String(page.limit),
  ].join('|');

  if (isTimelineCacheEnabled()) {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      res.setHeader('X-Timeline-Cache', 'HIT');
      // **続きのカーソルも一緒に返す。** HIT 経路でヘッダを落とすと、15 秒以内の再アクセス
      // （＝スクロール直後の再取得）で「次ページ無し」と誤解され、無限スクロールが途切れる。
      // 古い形（配列だけ）がキャッシュに残っていたらカーソル無しとして扱う
      const entry = Array.isArray(cached)
        ? { rows: cached, nextCursor: null as string | null }
        : (cached as { rows: unknown; nextCursor?: string | null });
      if (entry.nextCursor) {
        res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor');
        res.setHeader('X-Next-Cursor', entry.nextCursor);
      }
      return res.json(entry.rows);
    }
  }

  const currentActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;
  // 除外（ブロック・ミュート・ミュートワード・フォロワー限定）でページが短くならないよう、
  // 足りない分は読み足してからカーソルを決める（以前は limit + 1 件でカーソルを確定していた）
  const { items: enriched, nextCursor } = await collectVisiblePage({
    limit: page.limit,
    cursor: page.cursor,
    fetchRows: fetchTimelineRows,
    filterRows: (rows) => enrichAndFilterPosts(rows, currentActorUrl, req.user?.id),
    sortKey: 'timeline_at',
    idKey: 'post_id',
  });
  // 続きがある場合のみ X-Next-Cursor ヘッダで通知（レスポンス形状は従来どおり配列）
  if (nextCursor) {
    res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor');
    res.setHeader('X-Next-Cursor', nextCursor);
  }

  if (isTimelineCacheEnabled()) {
    res.setHeader('X-Timeline-Cache', 'MISS');
    // 保存の完了は待たない（応答を遅らせない）。カーソルも一緒に持たせる
    void cacheSet(cacheKey, { rows: enriched, nextCursor }, config.timelineCacheTtlSec);
  }

  res.json(enriched);
});
router.get('/timeline', handleTimeline);

// 人気・トレンドハッシュタグ一覧
router.get('/tags/popular', asyncHandler(async (_req: Request, res: Response) => {
  try {
    // フォロワー限定投稿のタグは公開のトレンドに出さない（DM も同じく出さない）
    const recentPosts = await db.prepare("SELECT content FROM posts WHERE COALESCE(visibility, 'public') NOT IN ('followers', 'direct') ORDER BY published_at DESC LIMIT 200").all() as { content: string }[];
    const tagCountMap = new Map<string, number>();

    const tagRegex = /#([a-zA-Z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)/gu;
    for (const post of recentPosts) {
      const cleanContent = post.content.replace(/<[^>]*>/g, ' ');
      const matches = cleanContent.matchAll(tagRegex);
      const seenInPost = new Set<string>();
      for (const match of matches) {
        const tag = match[1].toLowerCase();
        if (tag.length >= 2 && !seenInPost.has(tag)) {
          seenInPost.add(tag);
          tagCountMap.set(tag, (tagCountMap.get(tag) || 0) + 1);
        }
      }
    }

    const popularTags = Array.from(tagCountMap.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    res.json(popularTags);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}));

// 統合検索 API (ユーザー、投稿、Fediverse外部アドレス即時解決)
router.get('/search', asyncHandler(async (req: Request, res: Response) => {
  const q = (req.query.q as string || '').trim();
  if (!q) {
    return res.json({ remoteUser: null, users: [], posts: [] });
  }

  // 🔎 検索演算子: from:user / before:YYYY-MM-DD / after:YYYY-MM-DD / has:media / -除外語
  interface ParsedSearchQuery {
    text: string;
    from: string | null;
    before: string | null;
    after: string | null;
    hasMedia: boolean;
    excludes: string[];
  }
  const parsedQuery: ParsedSearchQuery = (() => {
    let text = q;
    let from: string | null = null;
    let before: string | null = null;
    let after: string | null = null;
    let hasMedia = false;
    const excludes: string[] = [];

    text = text.replace(/(?:^|\s)from:([^\s]+)/gi, (_m, v: string) => { from = v.replace(/^@/, ''); return ' '; });
    text = text.replace(/(?:^|\s)before:([^\s]+)/gi, (_m, v: string) => { before = v; return ' '; });
    text = text.replace(/(?:^|\s)after:([^\s]+)/gi, (_m, v: string) => { after = v; return ' '; });
    text = text.replace(/(?:^|\s)has:media/gi, () => { hasMedia = true; return ' '; });
    text = text.replace(/(?:^|\s)-([^\s]+)/g, (_m, v: string) => { excludes.push(v); return ' '; });

    return { text: text.trim(), from, before, after, hasMedia, excludes };
  })();

  const searchText = parsedQuery.text;

  // 演算子を SQL 条件に変換する（FTS / LIKE の両方に適用）
  const extraConds: string[] = [];
  const extraParams: any[] = [];
  // DM（visibility = 'direct'）は検索に絶対に出さない（本文も存在も見せない。docs/DM.md）
  extraConds.push("COALESCE(p.visibility, 'public') != 'direct'");
  if (parsedQuery.from) {
    extraConds.push('(p.user_id = ? OR p.author_handle LIKE ? OR p.author_url LIKE ?)');
    const pattern = parsedQuery.from.startsWith('http') ? parsedQuery.from : `%${parsedQuery.from}%`;
    extraParams.push(parsedQuery.from, pattern, pattern);
  }
  for (const term of parsedQuery.excludes) {
    extraConds.push('p.content NOT LIKE ?');
    extraParams.push(`%${term}%`);
  }
  if (parsedQuery.hasMedia) {
    extraConds.push("(p.media_attachments IS NOT NULL AND p.media_attachments != '[]' AND p.media_attachments != '')");
  }
  if (parsedQuery.after) {
    extraConds.push('p.published_at >= ?');
    extraParams.push(`${parsedQuery.after}T00:00:00.000Z`);
  }
  if (parsedQuery.before) {
    extraConds.push('p.published_at < ?');
    extraParams.push(`${parsedQuery.before}T00:00:00.000Z`);
  }
  const extraWhere = extraConds.length > 0 ? ` AND ${extraConds.join(' AND ')}` : '';

  const currentActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;
  let remoteUser: any = null;

  // 1. Fediverse アドレス直接解決 (@user@domain または URL)
  const isAddressOrUrl = searchText.includes('@') || searchText.startsWith('http://') || searchText.startsWith('https://');
  if (isAddressOrUrl) {
    try {
      let actorUrl = '';
      if (searchText.startsWith('http://') || searchText.startsWith('https://')) {
        actorUrl = searchText;
      } else {
        actorUrl = await resolveWebFinger(searchText);
      }

      if (actorUrl) {
        const actor = await fetchRemoteActor(actorUrl, false);
        let isFollowing = false;
        if (currentActorUrl) {
          const follow = await db.prepare('SELECT id FROM follows WHERE follower_url = ? AND following_url = ?').get(currentActorUrl, actor.id);
          isFollowing = Boolean(follow);
        }

        remoteUser = {
          id: actor.id,
          username: actor.username,
          domain: actor.domain,
          name: actor.name || actor.username,
          summary: actor.summary || '',
          icon_url: actor.icon_url || '',
          banner_url: actor.banner_url || '',
          is_following: isFollowing,
        };
      }
    } catch (err: any) {
      console.log(`[Search WebFinger Info] Could not resolve "${q}":`, err.message);
    }
  }

  // 2. ユーザー検索 (ローカルユーザー + キャッシュ済みリモートユーザー)
  const searchPattern = `%${searchText.replace(/^@/, '')}%`;
  const localUsers = searchText ? await db.prepare(`
    SELECT id, name, summary, icon_url, 1 as is_local, NULL as domain, ('@' || id) as handle
    FROM users
    WHERE approval_status = 'approved' AND (id LIKE ? OR name LIKE ?)
    LIMIT 10
  `).all(searchPattern, searchPattern) as any[] : [];

  // リモートアクターは連合で育ち続けるので、**直近に見た N 件**に限って走査する
  // （`LIKE '%語%'` は索引が使えず、全件だと件数に比例して重くなる）。
  // `RECENT_SCAN_ACTORS=0` で従来どおり全件（遅い代わりに古い相手も見つかる）
  const actorWindow = config.recentScanActors;
  const remoteActors = searchText ? await db.prepare(actorWindow > 0 ? `
    SELECT id, username, domain, name, summary, icon_url, 0 as is_local, ('@' || username || '@' || domain) as handle
    FROM (
      SELECT id, username, domain, name, summary, icon_url
      FROM remote_actors
      ORDER BY updated_at DESC
      LIMIT ?
    ) ra
    WHERE ra.username LIKE ? OR ra.name LIKE ? OR ra.domain LIKE ?
    LIMIT 10
  ` : `
    SELECT id, username, domain, name, summary, icon_url, 0 as is_local, ('@' || username || '@' || domain) as handle
    FROM remote_actors
    WHERE username LIKE ? OR name LIKE ? OR domain LIKE ?
    LIMIT 10
  `).all(...(actorWindow > 0 ? [actorWindow, searchPattern, searchPattern, searchPattern] : [searchPattern, searchPattern, searchPattern])) as any[] : [];

  const combinedUsers = await Promise.all([...localUsers, ...remoteActors].map(async (u) => {
    let isFollowing = false;
    const targetUrl = u.is_local ? `${config.origin}/users/${u.id}` : u.id;
    if (currentActorUrl) {
      const follow = await db.prepare('SELECT id FROM follows WHERE follower_url = ? AND following_url = ?').get(currentActorUrl, targetUrl);
      isFollowing = Boolean(follow);
    }
    return {
      ...u,
      is_following: isFollowing,
    };
  }));

  // 3. 投稿本文検索 (SQLite FTS5 / trigram 超高速・高精度検索 ＆ 短語・フェイルセーフ対応)
  let postRows: any[] = [];
  const terms = searchText.split(/\s+/).filter(Boolean);
  const hasLongTerm = terms.some((t) => t.length >= 3);

  if (hasLongTerm) {
    try {
      // 3文字以上の単語を安全にフレーズエスケープして FTS5 MATCH クエリ作成
      const ftsQuery = terms.filter((t) => t.length >= 3).map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
      if (ftsQuery) {
        postRows = await db.prepare(`
          SELECT 
            p.id AS post_id,
            p.user_id,
            p.author_name,
            p.author_url,
            p.author_handle,
            p.content,
            p.cw,
            p.is_local,
            p.visibility,
            p.emojis,p.in_reply_to,
            p.quote_id,
            p.is_sensitive,
            p.media_attachments,
            p.published_at,
            p.edited_at,
            COALESCE(
              NULLIF(p.author_icon, ''),
              NULLIF(u.icon_url, ''),
              NULLIF(ra.icon_url, ''),
              ''
            ) AS author_icon,
            NULL AS announce_id,
            NULL AS renoted_by_name,
            NULL AS renoted_by_handle,
            NULL AS renoted_by_icon,
            NULL AS renoted_by_url,
            p.published_at AS timeline_at
          FROM posts_fts f
          JOIN posts p ON f.post_id = p.id
          LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
          LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
          WHERE posts_fts MATCH ?${extraWhere}
          ORDER BY bm25(posts_fts), p.published_at DESC
          LIMIT 40
        `).all(ftsQuery, ...extraParams) as any[];
      }
    } catch (ftsErr: any) {
      console.warn('[FTS5 Search Fallback]:', ftsErr.message);
    }
  }

  // 短い単語（1〜2文字）の場合、または FTS5 で未ヒット時の LIKE 補完
  // 演算子のみの検索（例: has:media だけ）にも対応するため、本文が空でも実行する
  if (postRows.length === 0 && (terms.length > 0 || extraConds.length > 0)) {
    const postPattern = terms.length > 0 ? `%${searchText}%` : '%';
    // FTS にヒットしない語（リモート投稿にしか無い語・1〜2 文字の語）はここに落ちる。
    // 全件走査だと 32 万投稿で 250ms 超（SQLite は同期なのでプロセスが止まる）ので、
    // **直近 N 件に限る**（タグタイムラインと同じ `recentScanPosts`。既定 2 万）。
    const recentBound = config.recentScanPosts > 0
      ? [`p.published_at >= (
          SELECT COALESCE(MIN(published_at), '') FROM (SELECT published_at FROM posts ORDER BY published_at DESC LIMIT ?)
        )`, config.recentScanPosts] as const
      : null;
    postRows = await db.prepare(`
      SELECT 
        p.id AS post_id,
        p.user_id,
        p.author_name,
        p.author_url,
        p.author_handle,
        p.content,
        p.cw,
        p.is_local,
        p.visibility,
        p.emojis,p.in_reply_to,
        p.quote_id,
        p.is_sensitive,
        p.media_attachments,
        p.published_at,
        p.edited_at,
        COALESCE(
          NULLIF(p.author_icon, ''),
          NULLIF(u.icon_url, ''),
          NULLIF(ra.icon_url, ''),
          ''
        ) AS author_icon,
        NULL AS announce_id,
        NULL AS renoted_by_name,
        NULL AS renoted_by_handle,
        NULL AS renoted_by_icon,
        NULL AS renoted_by_url,
        p.published_at AS timeline_at
      FROM posts p
      LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
      LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
      WHERE (p.content LIKE ? OR p.cw LIKE ?)${extraWhere}${recentBound ? ` AND ${recentBound[0]}` : ''}
      ORDER BY p.published_at DESC
      LIMIT 30
    `).all(postPattern, postPattern, ...extraParams, ...(recentBound ? [recentBound[1]] : [])) as any[];
  }

  const posts = await enrichAndFilterPosts(postRows, currentActorUrl, req.user?.id);

  res.json({
    remoteUser,
    users: combinedUsers,
    posts,
  });
}));


// ==========================================
// 入力補完 (オートコンプリート: ユーザー & ハッシュタグ)
// ==========================================

// ユーザー入力補完 (@メンション用)
router.get('/autocomplete/users', asyncHandler(async (req: Request, res: Response) => {
  const q = ((req.query.q as string) || '').trim().replace(/^@/, '').toLowerCase();
  const currentUserId = req.user?.id;
  const currentActorUrl = currentUserId ? `${config.origin}/users/${currentUserId}` : null;

  try {
    const results: any[] = [];
    const seen = new Set<string>();

    // 1. ログインユーザーがフォロー中のユーザーから検索（優先度高）
    if (currentActorUrl) {
      const followRows = await db.prepare(`
        SELECT r.id, r.username, r.name, r.domain, r.icon_url
        FROM follows f
        JOIN remote_actors r ON f.following_url = r.id
        WHERE f.follower_url = ? AND (LOWER(r.username) LIKE ? OR LOWER(r.name) LIKE ?)
        LIMIT 6
      `).all(currentActorUrl, `%${q}%`, `%${q}%`) as any[];

      for (const r of followRows) {
        const handle = `@${r.username}@${r.domain}`;
        if (!seen.has(handle.toLowerCase())) {
          seen.add(handle.toLowerCase());
          results.push({
            id: r.id,
            username: r.username,
            name: r.name || r.username,
            handle,
            icon_url: r.icon_url || '',
            is_following: true,
          });
        }
      }
    }

    // 2. ローカルユーザーから検索
    const localUsers = await db.prepare(`
      SELECT id, name, icon_url
      FROM users
      WHERE LOWER(id) LIKE ? OR LOWER(name) LIKE ?
      LIMIT 6
    `).all(`%${q}%`, `%${q}%`) as any[];

    for (const u of localUsers) {
      const handle = `@${u.id}@${config.domain}`;
      if (!seen.has(handle.toLowerCase())) {
        seen.add(handle.toLowerCase());
        results.push({
          id: u.id,
          username: u.id,
          name: u.name,
          handle,
          icon_url: u.icon_url || '',
          is_following: false,
        });
      }
    }

    // 3. その他リモートアクターから検索（件数枠が余っている場合）
    if (results.length < 8) {
      const remainingLimit = 8 - results.length;
      const remoteUsers = await db.prepare(`
        SELECT id, username, name, domain, icon_url
        FROM remote_actors
        WHERE LOWER(username) LIKE ? OR LOWER(name) LIKE ?
        LIMIT ?
      `).all(`%${q}%`, `%${q}%`, remainingLimit) as any[];

      for (const r of remoteUsers) {
        const handle = `@${r.username}@${r.domain}`;
        if (!seen.has(handle.toLowerCase())) {
          seen.add(handle.toLowerCase());
          results.push({
            id: r.id,
            username: r.username,
            name: r.name || r.username,
            handle,
            icon_url: r.icon_url || '',
            is_following: false,
          });
        }
      }
    }

    res.json(results.slice(0, 8));
  } catch (err: any) {
    console.error('[Autocomplete Users Error]:', err);
    res.status(500).json({ error: 'ユーザー補完に失敗しました。' });
  }
}));

// ハッシュタグ入力補完 (#タグ用)
router.get('/autocomplete/tags', asyncHandler(async (req: Request, res: Response) => {
  const rawQ = ((req.query.q as string) || '').trim().replace(/^#/, '').toLowerCase();

  try {
    // フォロワー限定投稿のタグは候補に出さない
    // DM（visibility = 'direct'）はタグ候補に出さない
    const recentPosts = await db.prepare("SELECT content FROM posts WHERE COALESCE(visibility, 'public') NOT IN ('followers', 'direct') ORDER BY published_at DESC LIMIT 300").all() as { content: string }[];
    const tagCountMap = new Map<string, number>();

    const tagRegex = /#([a-zA-Z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)/gu;
    for (const post of recentPosts) {
      const cleanContent = post.content.replace(/<[^>]*>/g, ' ');
      const matches = cleanContent.matchAll(tagRegex);
      const seenInPost = new Set<string>();
      for (const match of matches) {
        const tag = match[1];
        const lower = tag.toLowerCase();
        if ((!rawQ || lower.includes(rawQ)) && !seenInPost.has(lower)) {
          seenInPost.add(lower);
          tagCountMap.set(tag, (tagCountMap.get(tag) || 0) + 1);
        }
      }
    }

    const matchedTags = Array.from(tagCountMap.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    res.json(matchedTags);
  } catch (err: any) {
    console.error('[Autocomplete Tags Error]:', err);
    res.status(500).json({ error: 'ハッシュタグ補完に失敗しました。' });
  }
}));


export default router;
