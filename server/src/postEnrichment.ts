/**
 * 投稿行の整形と、アンケートの得票数の扱い。
 *
 * タイムライン・ブックマーク・リスト・アンテナ・チャンネル・プロフィールの各ルーターが
 * 共通で使う（api.ts から切り出した。ロジックは移しただけ）。
 */
import { db, matchesBlockedDomainRule, loadBlockedDomainRules } from './db.js';
import { filterVisiblePosts } from './postVisibility.js';
import { getMutedWords, postMatchesMutedWords } from './wordFilter.js';
import { extractFirstUrl, getCachedPreviews } from './linkPreview.js';
import { getUserPrefs, isDomainMutedByPrefs } from './userPrefs.js';

/**
 * 単一投稿用のアンケート情報を取得するヘルパー
 */
/**
 * ActivityPub の Question（`oneOf` / `anyOf`）から**得票数だけ**を取り込む。
 *
 * 原典（アンケートを作ったサーバー）は票が入るたびに `Update{Question}` をフォロワーへ送る。
 * これを受け取らないと、**他のサーバーで入った票が手元の表示に反映されない**
 * （Spica 同士でも同期が取れない）。作者本人からの Update であることは呼び出し側で確認済み。
 *
 * ・票数は `_misskey_votes`（Misskey）か `replies.totalItems`（Mastodon）に入っている
 * ・選択肢はまず**テキスト一致**、合わなければ**並び順**で対応させる
 * ・**多い方を採用する**（原典がまだ知らない自分の票を、古い Update で消さないため）
 */
export async function applyPollCountsFromQuestion(postId: string, question: any): Promise<boolean> {
  const poll = (await db.prepare('SELECT id FROM polls WHERE post_id = ?').get(postId)) as { id: string } | undefined;
  if (!poll) return false;
  const list = Array.isArray(question?.oneOf)
    ? question.oneOf
    : Array.isArray(question?.anyOf)
      ? question.anyOf
      : null;
  if (!list || list.length === 0) return false;

  const choices = (await db
    .prepare('SELECT choice_index, text, votes_count FROM poll_choices WHERE poll_id = ? ORDER BY choice_index ASC')
    .all(poll.id)) as { choice_index: number; text: string; votes_count: number }[];

  const taken = new Set<number>();
  let changed = false;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const raw = item?._misskey_votes ?? item?.replies?.totalItems;
    const count = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(count) || count < 0) continue;
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const byText = name ? choices.find((c) => !taken.has(c.choice_index) && c.text.trim() === name) : undefined;
    const target = byText ?? choices[i];
    if (!target || taken.has(target.choice_index)) continue;
    taken.add(target.choice_index);
    if (count > (target.votes_count || 0)) {
      await db
        .prepare('UPDATE poll_choices SET votes_count = ? WHERE poll_id = ? AND choice_index = ?')
        .run(count, poll.id, target.choice_index);
      changed = true;
    }
  }
  return changed;
}

/**
 * 投稿のアンケート（自分の投票状態つき）を取る。
 */
export async function getPollDataForPost(postId: string, currentUserId?: string | null) {
  try {
    const poll = await db.prepare('SELECT id, post_id, multiple, expires_at, created_at FROM polls WHERE post_id = ?').get(postId) as any;
    if (!poll) return null;

    const choices = await db.prepare(`
      SELECT choice_index, text, votes_count
      FROM poll_choices
      WHERE poll_id = ?
      ORDER BY choice_index ASC
    `).all(poll.id) as { choice_index: number; text: string; votes_count: number }[];

    let myVotedIndices = new Set<number>();
    if (currentUserId) {
      const myVotes = await db.prepare('SELECT choice_index FROM poll_votes WHERE poll_id = ? AND user_id = ?').all(poll.id, currentUserId) as { choice_index: number }[];
      myVotedIndices = new Set(myVotes.map((v) => v.choice_index));
    }

    const now = new Date().toISOString();
    const isExpired = poll.expires_at ? poll.expires_at < now : false;
    const totalVotes = choices.reduce((sum, c) => sum + (c.votes_count || 0), 0);

    return {
      id: poll.id,
      multiple: Boolean(poll.multiple),
      expires_at: poll.expires_at,
      is_expired: isExpired,
      total_votes: totalVotes,
      my_voted: myVotedIndices.size > 0,
      choices: choices.map((c) => ({
        choice_index: c.choice_index,
        text: c.text,
        votes_count: c.votes_count,
        me: myVotedIndices.has(c.choice_index),
      })),
    };
  } catch (err) {
    console.error('[getPollDataForPost] Error:', err);
    return null;
  }
}

// ==========================================
// タイムライン・投稿・フォロー
// ==========================================

// 投稿リストにリアクション・RT・返信情報を付与し、ブロック済みドメインを除外する共通ヘルパー
/** タイムラインの行を表示用に整形する（Misskey 互換 API からも同じものを使う） */
export async function enrichAndFilterPosts(rows: any[], currentActorUrl: string | null, currentUserId?: string | null) {
  if (rows.length === 0) return [];

  const postIds = Array.from(new Set(rows.map((r) => r.post_id || r.id)));
  const placeholders = postIds.map(() => '?').join(',');
  const viewer = currentActorUrl || '';

  // 1 リクエストで 12 本撃っていたのを、**同じ IN を持つ物は 1 本にまとめ、独立な物は同時に流す**。
  // （1 本ずつ await していたので、PostgreSQL ではそのぶん往復が積み上がっていた）
  //   - カウンタ（リアクション / ブースト / 返信数）… 同じ対象なので UNION ALL で 1 本
  //   - 閲覧者の状態（ブックマーク / ピン留め / ブロック / ミュート）… 同上
  //   - どれか 1 つが失敗しても他は返す（safe() が握って空を返す）
  const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      console.error(`[enrichAndFilterPosts] Error fetching ${label}:`, e);
      return fallback;
    }
  };

  const counterRowsPromise = safe(
    'counters',
    () =>
      db.prepare(`
        SELECT post_id, 'reaction' AS kind, reaction, count(*) AS count,
          max(case when user_id = ? then 1 else 0 end) AS me
        FROM reactions
        WHERE post_id IN (${placeholders})
        GROUP BY post_id, reaction
        UNION ALL
        SELECT post_id, 'announce' AS kind, '' AS reaction, count(*) AS count,
          max(case when user_id = ? then 1 else 0 end) AS me
        FROM announces
        WHERE post_id IN (${placeholders})
        GROUP BY post_id
        UNION ALL
        SELECT in_reply_to AS post_id, 'reply' AS kind, '' AS reaction, count(*) AS count, 0 AS me
        FROM posts
        WHERE in_reply_to IN (${placeholders})
        GROUP BY in_reply_to
        UNION ALL
        SELECT quote_id AS post_id, 'quote' AS kind, '' AS reaction, count(*) AS count, 0 AS me
        FROM posts
        WHERE quote_id IN (${placeholders}) AND quote_id IS NOT NULL
        GROUP BY quote_id
      `).all(viewer, ...postIds, viewer, ...postIds, ...postIds, ...postIds) as Promise<
        { post_id: string; kind: string; reaction: string; count: number; me: number }[]
      >,
    [],
  );

  // 閲覧者に紐づく状態を 1 本にまとめる（表ごとに 1 本ずつ撃っていた）
  const viewerStatePromise = currentUserId
    ? safe(
        'viewer state',
        () =>
          db.prepare(`
            SELECT post_id, 'bookmark' AS kind FROM bookmarks WHERE user_id = ? AND post_id IN (${placeholders})
            UNION ALL
            SELECT post_id, 'pinned' AS kind FROM pinned_posts WHERE user_id = ? AND post_id IN (${placeholders})
            UNION ALL
            SELECT target_user_id AS post_id, 'blocked' AS kind FROM user_blocks WHERE user_id = ?
            UNION ALL
            SELECT target_user_id AS post_id, 'muted' AS kind FROM user_mutes WHERE user_id = ?
          `).all(currentUserId, ...postIds, currentUserId, ...postIds, currentUserId, currentUserId) as Promise<
            { post_id: string; kind: string }[]
          >,
        [],
      )
    : Promise.resolve([] as { post_id: string; kind: string }[]);

  const [counterRows, viewerStateRows] = await Promise.all([counterRowsPromise, viewerStatePromise]);

  const allReactions = counterRows.filter((r) => r.kind === 'reaction');
  const allAnnounces = counterRows.filter((r) => r.kind === 'announce');
  const allReplies = counterRows.filter((r) => r.kind === 'reply');
  const allQuoteCounts = counterRows.filter((r) => r.kind === 'quote');

  // 📊 アンケート情報の取得（選択肢と投票はアンケート本体に依存するので、ここだけ直列）
  const pollsMap = new Map<string, any>();
  const loadPolls = async (): Promise<void> => {
    const pollRows = await db.prepare(`
      SELECT id, post_id, multiple, expires_at, created_at
      FROM polls
      WHERE post_id IN (${placeholders})
    `).all(...postIds) as any[];

    if (pollRows.length > 0) {
      const pollIds = pollRows.map((p) => p.id);
      const pollPlaceholders = pollIds.map(() => '?').join(',');

      const choiceRows = await db.prepare(`
        SELECT id, poll_id, choice_index, text, votes_count
        FROM poll_choices
        WHERE poll_id IN (${pollPlaceholders})
        ORDER BY choice_index ASC
      `).all(...pollIds) as any[];

      let userVotesMap = new Map<string, Set<number>>();
      if (currentUserId) {
        const voteRows = await db.prepare(`
          SELECT poll_id, choice_index
          FROM poll_votes
          WHERE poll_id IN (${pollPlaceholders}) AND user_id = ?
        `).all(...pollIds, currentUserId) as any[];
        for (const v of voteRows) {
          if (!userVotesMap.has(v.poll_id)) userVotesMap.set(v.poll_id, new Set());
          userVotesMap.get(v.poll_id)!.add(v.choice_index);
        }
      }

      const choicesByPoll = new Map<string, any[]>();
      for (const c of choiceRows) {
        if (!choicesByPoll.has(c.poll_id)) choicesByPoll.set(c.poll_id, []);
        const myVotes = userVotesMap.get(c.poll_id);
        choicesByPoll.get(c.poll_id)!.push({
          choice_index: c.choice_index,
          text: c.text,
          votes_count: c.votes_count,
          me: myVotes ? myVotes.has(c.choice_index) : false,
        });
      }

      const now = new Date().toISOString();
      for (const p of pollRows) {
        const choices = choicesByPoll.get(p.id) || [];
        const totalVotes = choices.reduce((sum, c) => sum + (c.votes_count || 0), 0);
        const myVotes = userVotesMap.get(p.id);
        const isExpired = p.expires_at ? p.expires_at < now : false;

        pollsMap.set(p.post_id, {
          id: p.id,
          multiple: Boolean(p.multiple),
          expires_at: p.expires_at,
          is_expired: isExpired,
          total_votes: totalVotes,
          my_voted: Boolean(myVotes && myVotes.size > 0),
          choices,
        });
      }
    }
  };

  // 🔖 ブックマーク / 📌 ピン留め / 🚫 ブロック・ミュート（上の 1 本にまとめた結果を振り分ける）
  const bookmarkedSet = new Set(
    viewerStateRows.filter((r) => r.kind === 'bookmark').map((r) => r.post_id),
  );
  const pinnedSet = new Set(
    viewerStateRows.filter((r) => r.kind === 'pinned').map((r) => r.post_id),
  );
  const blockedOrMutedUserIds = new Set<string>();
  for (const r of viewerStateRows) {
    if ((r.kind === 'blocked' || r.kind === 'muted') && r.post_id) {
      blockedOrMutedUserIds.add(String(r.post_id).toLowerCase());
    }
  }

  // 🔇 ワードフィルター（ミュートワード）は下の Promise.all で取る（利用者ごとの設定）

  const reactionsMap = new Map<string, { reaction: string; count: number; me: boolean }[]>();
  for (const r of allReactions) {
    if (!reactionsMap.has(r.post_id)) reactionsMap.set(r.post_id, []);
    reactionsMap.get(r.post_id)!.push({ reaction: r.reaction, count: r.count, me: Boolean(r.me) });
  }

  const announcesMap = new Map<string, { count: number; me: boolean }>();
  for (const a of allAnnounces) {
    announcesMap.set(a.post_id, { count: a.count, me: Boolean(a.me) });
  }

  const repliesMap = new Map<string, number>();
  for (const rp of allReplies) {
    repliesMap.set(rp.post_id, rp.count);
  }

  const quotesCountMap = new Map<string, number>();
  for (const qc of allQuoteCounts) {
    quotesCountMap.set(qc.post_id, qc.count);
  }

  // 💬 引用ノート (Quote) 情報の一括取得
  const quotesMap = new Map<string, any>();
  const loadQuotes = async (): Promise<void> => {
    const quoteIds = Array.from(new Set(rows.map((r) => r.quote_id).filter(Boolean)));
    if (quoteIds.length === 0) return;
    const qPlaceholders = quoteIds.map(() => '?').join(',');
    const quoteRows = await db.prepare(`
      SELECT id, user_id, author_name, author_url, author_handle, author_icon, content, cw, emojis, media_attachments, is_sensitive, published_at
      FROM posts
      WHERE id IN (${qPlaceholders})
    `).all(...quoteIds) as any[];

    for (const q of quoteRows) {
      quotesMap.set(q.id, {
        id: q.id,
        user_id: q.user_id,
        author_name: q.author_name,
        author_url: q.author_url,
        author_handle: q.author_handle,
        author_icon: q.author_icon,
        content: q.content,
        cw: q.cw || null,
        emojis: q.emojis,
        is_sensitive: Boolean(q.is_sensitive),
        media_attachments: (() => {
          try {
            return typeof q.media_attachments === 'string' ? JSON.parse(q.media_attachments || '[]') : (q.media_attachments || []);
          } catch {
            return [];
          }
        })(),
        published_at: q.published_at,
      });
    }
  };

  // 📢 チャンネル (Channels) 情報の一括取得
  const channelsMap = new Map<string, any>();
  const loadChannels = async (): Promise<void> => {
    const channelIds = Array.from(new Set(rows.map((r) => r.channel_id).filter(Boolean)));
    if (channelIds.length === 0) return;
    const cPlaceholders = channelIds.map(() => '?').join(',');
    const channelRows = await db.prepare(`
      SELECT id, name, description, banner_url, color, posts_count, followers_count
      FROM channels
      WHERE id IN (${cPlaceholders})
    `).all(...channelIds) as any[];

    for (const ch of channelRows) {
      channelsMap.set(ch.id, ch);
    }
  };

  // 🔗 リンクプレビューは 1 回のクエリでまとめて取る（行ごとに問い合わせない）
  const previewUrls = Array.from(
    new Set(rows.map((r) => extractFirstUrl(r.content)).filter((url): url is string => Boolean(url))),
  );

  // 残りは互いに依存しないので同時に流す（SQLite は 1 接続なので直列化されるが、
  // PostgreSQL では往復が重ならない）。ミュートワードと遮断ドメインは TTL つきのキャッシュ。
  const [, , , linkPreviews, blockedDomainRules, mutedWords] = await Promise.all([
    safe('polls', loadPolls, undefined as void),
    safe('quotes', loadQuotes, undefined as void),
    safe('channels', loadChannels, undefined as void),
    safe('link previews', () => getCachedPreviews(previewUrls), new Map()),
    safe('blocked domain rules', () => loadBlockedDomainRules(), []),
    safe('muted words', () => getMutedWords(currentUserId), []),
  ]);

  const enrichedItems = rows.map((r) => {
    const pid = r.post_id || r.id;
    const cid = r.channel_id || null;
    return {
      id: pid,
      feed_id: r.announce_id ? `rn_${r.announce_id}` : pid,
      user_id: r.user_id,
      author_name: r.author_name,
      author_url: r.author_url,
      author_handle: r.author_handle,
      author_icon: r.author_icon,
      content: r.content,
      cw: r.cw || null,
      quote_id: r.quote_id || null,
      quote: r.quote_id ? (quotesMap.get(r.quote_id) || null) : null,
      is_sensitive: Boolean(r.is_sensitive),
      poll: pollsMap.get(pid) || null,
      is_pinned: pinnedSet.has(pid),
      is_local: r.is_local,
      visibility: r.visibility,
      emojis: r.emojis,
      in_reply_to: r.in_reply_to,
      media_attachments: (() => {
        try {
          return typeof r.media_attachments === 'string' ? JSON.parse(r.media_attachments || '[]') : (r.media_attachments || []);
        } catch {
          return [];
        }
      })(),
      published_at: r.published_at,
      edited_at: r.edited_at || null,
      timeline_at: r.timeline_at || r.published_at,
      // 🔗 リンクプレビュー（OGP カード）: キャッシュ済みのものだけ添付する
      link_preview: (() => {
        const url = extractFirstUrl(r.content);
        return url ? linkPreviews.get(url) ?? null : null;
      })(),
      renote: r.announce_id ? {
        id: r.announce_id,
        name: r.renoted_by_name || '誰か',
        handle: r.renoted_by_handle || '',
        icon: r.renoted_by_icon || '',
        url: r.renoted_by_url || '',
        at: r.timeline_at,
      } : null,
      reactions: reactionsMap.get(pid) || [],
      announce_count: announcesMap.get(pid)?.count || 0,
      my_announced: announcesMap.get(pid)?.me || false,
      reply_count: repliesMap.get(pid) || 0,
      quote_count: quotesCountMap.get(pid) || 0,
      bookmarked: bookmarkedSet.has(pid),
      channel_id: cid,
      channel: cid ? (channelsMap.get(cid) || null) : null,
    };
  });

  // 🔇 自分用のドメインミュート（設定から。表示から除外する）
  const mutedDomains = currentUserId ? (await getUserPrefs(currentUserId)).mutedDomains : [];

  // ブロック対象ドメインおよび個人ブロック・ミュート対象ユーザーの投稿を除外
  const filteredItems = enrichedItems.filter((item) => {
    if (blockedOrMutedUserIds.size > 0) {
      if (item.user_id && blockedOrMutedUserIds.has(item.user_id.toLowerCase())) return false;
      if (item.author_url && blockedOrMutedUserIds.has(item.author_url.toLowerCase())) return false;
      if (item.author_handle && blockedOrMutedUserIds.has(item.author_handle.toLowerCase())) return false;
      if (item.renote) {
        if (item.renote.url && blockedOrMutedUserIds.has(item.renote.url.toLowerCase())) return false;
        if (item.renote.handle && blockedOrMutedUserIds.has(item.renote.handle.toLowerCase())) return false;
      }
    }
    if (item.is_local === 1) return true;
    // 自分用のドメインミュート（ローカル投稿には効かせない＝自分のサーバーを誤って消せないように）
    if (mutedDomains.length > 0) {
      if (isDomainMutedByPrefs(mutedDomains, item.author_url) || isDomainMutedByPrefs(mutedDomains, item.author_handle)) return false;
      if (item.renote && (isDomainMutedByPrefs(mutedDomains, item.renote.url) || isDomainMutedByPrefs(mutedDomains, item.renote.handle))) return false;
    }
    // 表示の絞り込みは suspend / silence のどちらでも隠す（判定は読み込み済みルールに対して同期で行う）
    if (matchesBlockedDomainRule(blockedDomainRules, item.author_url) || matchesBlockedDomainRule(blockedDomainRules, item.author_handle)) return false;
    if (item.renote && (matchesBlockedDomainRule(blockedDomainRules, item.renote.url) || matchesBlockedDomainRule(blockedDomainRules, item.renote.handle))) return false;
    return true;
  });

  // 🔇 ミュートワードに一致する投稿を除外
  const wordFilteredItems = mutedWords.length > 0
    ? filteredItems.filter((item) => !postMatchesMutedWords(item, mutedWords))
    : filteredItems;

  // 閲覧権限のない投稿（フォロワー限定で、閲覧者が本人でもフォロワーでもないもの）を除外
  return await filterVisiblePosts(wordFilteredItems, currentActorUrl);
}
