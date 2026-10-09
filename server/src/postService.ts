import crypto from 'node:crypto';
import { db, UserRow, PostRow, createNotification, AntennaRow } from './db.js';
import { withTransaction } from './db/asyncDriver.js';
import { config } from './config.js';
import { broadcastNote, broadcastEvent } from './streaming.js';
import {
  buildNote,
  buildCreateActivity,
  buildUpdateNoteActivity,
  deliverActivity,
  fetchRemoteActor,
} from './activitypub.js';
import { canViewPost, normalizeVisibility, PostVisibility } from './postVisibility.js';
import { localPostId } from './ids.js';
import { queueLinkPreviewFetch } from './linkPreview.js';
import { invalidateTimelineCache } from './timelineCache.js';
import { linkMediaToPost } from './mediaService.js';
import { runWithConcurrency } from './jobs.js';

export interface CreatePostParams {
  user: UserRow;
  content?: string;
  in_reply_to?: string | null;
  attachments?: any[];
  cw?: string | null;
  poll?: any;
  quote_id?: string | null;
  is_sensitive?: boolean;
  visibility?: 'public' | 'local' | 'followers';
  channel_id?: string | null;
}

/**
 * 投稿作成の共通コアエンジン (通常投稿および予約投稿の自動実行で利用)
 */
export async function executeCreatePost(params: CreatePostParams): Promise<{ post: any; federatedTo: number }> {
  const { user, in_reply_to, attachments, cw, poll, quote_id, is_sensitive } = params;
  const visibility: PostVisibility = normalizeVisibility(params.visibility);

  // DM（visibility = 'direct'）は通常の投稿作成では作らせない。
  // 宛先の検証・許可リスト・スパム対策は DM の送信 API（/api/dm/messages）が担う（docs/DM.md）
  if (visibility === 'direct') {
    throw new Error('DM はメッセージの画面（/api/dm/messages）から送ってください。');
  }
  const parsedAttachments = (Array.isArray(attachments) ? attachments : [])
    .filter((att: any) => att && typeof att.url === 'string' && att.url.length > 0)
    .slice(0, 4)
    .map((att: any) => ({
      url: String(att.url),
      mediaType: typeof att.mediaType === 'string' ? att.mediaType : 'image/jpeg',
      name: typeof att.name === 'string' ? att.name.slice(0, 300) : '',
      // 代替テキスト（alt）。連合先には添付の name として届く
      description: typeof att.description === 'string' ? att.description.slice(0, 1500) : '',
      size: typeof att.size === 'number' ? att.size : undefined,
      width: typeof att.width === 'number' ? att.width : undefined,
      height: typeof att.height === 'number' ? att.height : undefined,
      thumbnailUrl: typeof att.thumbnailUrl === 'string' ? att.thumbnailUrl : undefined,
      duration: typeof att.duration === 'number' ? att.duration : undefined,
    }));
  const channelId = typeof params.channel_id === 'string' && params.channel_id.trim() ? params.channel_id.trim() : null;

  const postText = params.content ? params.content.trim() : '';
  const inReplyTo = typeof in_reply_to === 'string' && in_reply_to.trim() ? in_reply_to.trim() : null;
  const quoteId = typeof quote_id === 'string' && quote_id.trim() ? quote_id.trim() : null;
  const isSensitive = Boolean(is_sensitive);
  const cwText = typeof cw === 'string' && cw.trim() ? cw.trim() : null;
  const actorUrl = `${config.origin}/users/${user.id}`;
  const postId = localPostId(actorUrl);
  const now = new Date().toISOString();
  const authorHandle = `@${user.id}@${config.domain}`;
  const authorIcon = user.icon_url || '';
  const attachmentsJson = JSON.stringify(parsedAttachments);

  // アンケート選択肢の抽出・バリデーション
  const validChoices = (poll && Array.isArray(poll.choices))
    ? poll.choices.map((c: any) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean)
    : [];

  if (!postText && parsedAttachments.length === 0 && validChoices.length === 0 && !quoteId) {
    throw new Error('投稿内容、画像、引用、またはアンケートを入力してください。');
  }

  // 投稿本文内のカスタム絵文字ショートコード (:name:) を検出
  const emojiMatches: string[] = Array.from(new Set(postText.match(/:([a-zA-Z0-9_]{2,30}):/g) || []));
  let postEmojis: { name: string; url: string }[] = [];
  let apEmojiTags: any[] = [];

  if (emojiMatches.length > 0) {
    const emojiNames = emojiMatches.map((m: string) => m.slice(1, -1).toLowerCase());
    const placeholders = emojiNames.map(() => '?').join(',');
    const foundEmojis = await db.prepare(`
      SELECT name, url FROM custom_emojis WHERE name IN (${placeholders})
    `).all(...emojiNames) as unknown as { name: string; url: string }[];

    if (foundEmojis.length > 0) {
      postEmojis = foundEmojis.map((e) => ({
        name: `:${e.name}:`,
        url: e.url,
      }));
      apEmojiTags = foundEmojis.map((e) => ({
        type: 'Emoji',
        name: `:${e.name}:`,
        icon: {
          type: 'Image',
          mediaType: 'image/png',
          url: e.url,
        },
      }));
    }
  }
  const emojisJson = postEmojis.length > 0 ? JSON.stringify(postEmojis) : '[]';

  // 引用元が閲覧できない投稿（フォロワー限定など）は引用を拒否する
  if (quoteId) {
    const quoteTarget = await db.prepare('SELECT id, author_url, visibility FROM posts WHERE id = ?').get(quoteId) as
      | { id: string; author_url: string; visibility: string | null }
      | undefined;
    if (quoteTarget && !(await canViewPost(quoteTarget, actorUrl))) {
      throw new Error('この投稿は引用できません。');
    }
  }

  // 1. ローカルDBに投稿保存
  await db.prepare(`
    INSERT INTO posts (id, user_id, author_name, author_url, author_handle, author_icon, content, is_local, visibility, emojis, in_reply_to, quote_id, is_sensitive, media_attachments, cw, published_at, channel_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(postId, user.id, user.name, actorUrl, authorHandle, authorIcon, postText, visibility, emojisJson, inReplyTo, quoteId, isSensitive ? 1 : 0, attachmentsJson, cwText, now, channelId);

  // タイムラインの読み取りキャッシュを捨てる。これが無いと、投稿した直後に
  // ホームを開いても最大 TTL ぶん古い並び（自分の投稿が無い）を見ることになる。
  await invalidateTimelineCache();

  // 添付メディアをドライブの台帳へ紐づける（自分がアップロードしたメディアのみ）
  await linkMediaToPost(user.id, postId, parsedAttachments);

  // チャンネルの投稿数をインクリメント
  let channelData: any = null;
  if (channelId) {
    try {
      await db.prepare('UPDATE channels SET posts_count = posts_count + 1 WHERE id = ?').run(channelId);
      channelData = await db.prepare('SELECT id, name, description, banner_url, color FROM channels WHERE id = ?').get(channelId);
    } catch (e) {
      console.error('[Post] Failed to update channel posts count:', e);
    }
  }

  // 引用元投稿の解決（あれば）
  let quotePostData: any = null;
  if (quoteId) {
    const qRow = await db.prepare('SELECT id, user_id, author_name, author_url, author_handle, author_icon, content, cw, emojis, media_attachments, is_sensitive, published_at FROM posts WHERE id = ?').get(quoteId) as any;
    if (qRow) {
      quotePostData = {
        ...qRow,
        is_sensitive: Boolean(qRow.is_sensitive),
        media_attachments: (() => {
          try { return typeof qRow.media_attachments === 'string' ? JSON.parse(qRow.media_attachments || '[]') : (qRow.media_attachments || []); }
          catch { return []; }
        })(),
      };
    }
  }

  // 2. アンケートがある場合は polls / poll_choices テーブルに保存
  let pollDataForAp = null;
  let createdPoll: any = null;

  if (validChoices.length >= 2) {
    const pollId = crypto.randomUUID();
    const multiple = poll.multiple ? 1 : 0;
    let expiresAt: string | null = null;
    if (typeof poll.expires_in === 'number' && poll.expires_in > 0) {
      expiresAt = new Date(Date.now() + poll.expires_in * 1000).toISOString();
    }

    // アンケート本体と選択肢は**同じトランザクション**で入れる。
    // 別々に入れると、選択肢が入り切る前に投票が届き得る（PostgreSQL で実際に起きた:
    // `forEach` のコールバックで await していなかったため、3 つめが入る前に
    // 投票が処理され「無効な選択肢」で 400 になった）。
    await withTransaction(db, async () => {
      await db.prepare(`
        INSERT INTO polls (id, post_id, multiple, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(pollId, postId, multiple, expiresAt, now);

      const insertChoice = await db.prepare(`
        INSERT INTO poll_choices (id, poll_id, choice_index, text, votes_count)
        VALUES (?, ?, ?, ?, 0)
      `);
      for (let idx = 0; idx < validChoices.length; idx++) {
        await insertChoice.run(crypto.randomUUID(), pollId, idx, validChoices[idx]);
      }
    });

    pollDataForAp = {
      choices: validChoices,
      multiple: Boolean(poll.multiple),
      expiresAt,
    };

    createdPoll = {
      id: pollId,
      multiple: Boolean(multiple),
      expires_at: expiresAt,
      is_expired: false,
      total_votes: 0,
      my_voted: false,
      choices: validChoices.map((text: string, idx: number) => ({
        choice_index: idx,
        text,
        votes_count: 0,
        me: false,
      })),
    };
  }

  console.log(`[Post] Note created by ${authorHandle} (visibility: ${visibility}, quote: ${quoteId || 'none'}): "${postText.slice(0, 40)}"`);

  // クライアント向け投稿オブジェクトの構築
  const responsePostData = {
    id: postId,
    feed_id: postId,
    user_id: user.id,
    author_name: user.name,
    author_url: actorUrl,
    author_handle: authorHandle,
    author_icon: authorIcon,
    content: postText,
    cw: cwText,
    quote_id: quoteId,
    quote: quotePostData,
    is_sensitive: isSensitive,
    poll: createdPoll,
    is_pinned: false,
    is_local: 1,
    visibility,
    emojis: emojisJson !== '[]' ? emojisJson : null,
    in_reply_to: inReplyTo,
    media_attachments: parsedAttachments,
    published_at: now,
    timeline_at: now,
    renote: null,
    reactions: [],
    announce_count: 0,
    my_announced: false,
    reply_count: 0,
    bookmarked: false,
    channel_id: channelId,
    channel: channelData,
  };

  // 🔗 本文に URL があればリンクプレビュー（OGPカード）を非同期で取得しておく
  queueLinkPreviewFetch(postText);

  // 📡 全SSE接続クライアントに新着ノートをプッシュ（公開投稿のみ。
  //    ローカル限定・フォロワー限定は配信すると存在自体が漏れるため配信しない）
  if (visibility === 'public') {
    broadcastNote(responsePostData);
  }

  // 📡 新着ノートに対するアンテナ条件チェック ＆ 通知
  //    （フォロワー限定は、フォローしていないユーザーのアンテナ通知経由で内容が漏れるため対象外）
  if (visibility !== 'followers') {
    await checkAntennaMatchesAndNotify(responsePostData);
  }

  // 返信の場合、親投稿の作成者（ローカルユーザー）へ通知を送信
  // 返信相手（重複通知を避けるためメンション通知から除外する）
  let replyParentUserId: string | null = null;

  if (inReplyTo) {
    try {
      const parentPost = await db.prepare('SELECT * FROM posts WHERE id = ?').get(inReplyTo) as PostRow | undefined;
      if (parentPost && parentPost.is_local === 1) {
        replyParentUserId = parentPost.user_id;
        await createNotification({
          userId: parentPost.user_id,
          type: 'reply',
          actorId: user.id,
          actorName: user.name,
          actorHandle: authorHandle,
          actorIcon: authorIcon,
          postId,
          postContent: parentPost.content,
          content: postText,
        });
      }
    } catch (e) {
      console.error('[Notification Error] Reply notification failed:', e);
    }
  }

  // 🔔 メンション通知: 本文中の @user / @user@domain を検出してローカルユーザーへ通知する
  try {
    const mentionMatches = postText.match(/@[a-zA-Z0-9_]{2,30}(?:@[a-zA-Z0-9.\-]+)?/g) || [];
    const mentionedIds = new Set<string>();

    for (const raw of mentionMatches) {
      const body = raw.slice(1);
      const [name, domain] = body.split('@');
      const mentionedId = (name || '').toLowerCase();
      if (!mentionedId || mentionedId === user.id) {
        continue;
      }
      // ドメイン指定がある場合は自ノード宛のみを対象にする
      if (domain && domain.toLowerCase() !== config.domain.toLowerCase()) {
        continue;
      }
      if (replyParentUserId && mentionedId === replyParentUserId) {
        continue; // 返信通知と重複するため
      }
      mentionedIds.add(mentionedId);
    }

    for (const mentionedId of mentionedIds) {
      const target = await db.prepare('SELECT id FROM users WHERE id = ?').get(mentionedId);
      if (!target) {
        continue;
      }
      await createNotification({
        userId: mentionedId,
        type: 'mention',
        actorId: user.id,
        actorName: user.name,
        actorHandle: authorHandle,
        actorIcon: authorIcon,
        postId,
        postContent: postText,
      });
      console.log(`[Notification] 📣 メンション通知: @${user.id} → @${mentionedId}`);
    }
  } catch (e) {
    console.error('[Notification Error] Mention notification failed:', e);
  }

  // ローカル限定投稿の場合は外部配信を行わず終了
  if (visibility === 'local') {
    return { post: responsePostData, federatedTo: 0 };
  }

  // 3. ActivityPub オブジェクトの構築（公開 / フォロワー限定は外部配信）
  const note = buildNote({
    id: postId,
    authorUrl: actorUrl,
    content: postText,
    publishedAt: now,
    inReplyTo,
    quoteUrl: quoteId,
    attachments: parsedAttachments,
    summary: cwText,
    sensitive: isSensitive,
    poll: pollDataForAp,
    tags: apEmojiTags.length > 0 ? apEmojiTags : undefined,
    visibility,
  });

  const createActivity = buildCreateActivity({
    note,
    actorUrl,
  });

  // 4. 配信先 Inbox の収集: フォロワー(承認済みのみ) + 承認済みリレー + 返信相手(あれば) + 引用相手(あれば)
  //
  // 同じサーバーのフォロワーは**共有 Inbox（sharedInbox）1 つにまとめる**。
  // まとめないと、そのサーバーのフォロワー数だけ署名付き POST と DNS 解決が走る
  // （Mastodon / Misskey はどちらも sharedInbox を公開しているので、実質 1 本で済む）。
  const followerInboxes = (await db.prepare(`
    SELECT DISTINCT COALESCE(ra.shared_inbox_url, f.inbox_url) AS inbox_url
    FROM follows f
    LEFT JOIN remote_actors ra ON ra.id = f.follower_url
    WHERE f.following_url = ? AND f.status = 'accepted'
      AND COALESCE(ra.shared_inbox_url, f.inbox_url) IS NOT NULL
      AND COALESCE(ra.shared_inbox_url, f.inbox_url) != ''
  `).all(actorUrl) as { inbox_url: string }[]).map((f) => f.inbox_url);

  // リレーは不特定多数のサーバーへ再配信するため、フォロワー限定投稿では使用しない
  const relayInboxes = visibility === 'public'
    ? (await db.prepare(`
        SELECT DISTINCT inbox_url FROM relays WHERE status = 'accepted'
      `).all() as { inbox_url: string }[]).map((r) => r.inbox_url)
    : [];

  const directInboxes: string[] = [];
  if (inReplyTo) {
    const parentPost = await db.prepare('SELECT author_url FROM posts WHERE id = ?').get(inReplyTo) as { author_url: string } | undefined;
    if (parentPost && !parentPost.author_url.startsWith(config.origin)) {
      try {
        const remoteActor = await fetchRemoteActor(parentPost.author_url);
        if (remoteActor.inbox_url) directInboxes.push(remoteActor.inbox_url);
      } catch {}
    }
  }
  if (quoteId) {
    const quotedPost = await db.prepare('SELECT author_url FROM posts WHERE id = ?').get(quoteId) as { author_url: string } | undefined;
    if (quotedPost && !quotedPost.author_url.startsWith(config.origin)) {
      try {
        const remoteActor = await fetchRemoteActor(quotedPost.author_url);
        if (remoteActor.inbox_url) directInboxes.push(remoteActor.inbox_url);
      } catch {}
    }
  }

  const allTargetInboxes = Array.from(new Set([...followerInboxes, ...relayInboxes, ...directInboxes]));

  // 非同期でフォロワー及びリレーへ配送。
  // **同時実行数を絞る**（既定 5、`DELIVERY_CONCURRENCY`）。以前は全部を一度に投げていたので、
  // フォロワーが多いと 1 投稿で数百〜数千の fetch が同時に立ち、ソケットとメモリを使い切っていた。
  // 絞っても総時間はほぼ変わらない（1 件あたりはネットワーク待ちが主）。
  if (allTargetInboxes.length > 0) {
    void runWithConcurrency(allTargetInboxes, config.deliveryConcurrency, async (inboxUrl) => {
      try {
        return (await deliverActivity({
          inboxUrl,
          activity: createActivity,
          senderUser: user,
        })) === true;
      } catch {
        return false;
      }
    }).then((results) => {
      const succeeded = results.filter((ok) => ok === true).length;
      console.log(`[Delivery] Federation sent: ${succeeded}/${allTargetInboxes.length} inboxes`);
    });
  }

  return { post: responsePostData, federatedTo: allTargetInboxes.length };
}

/**
 * 配信先 Inbox を集める（作成と編集で同じ audience を使う）。
 *
 * - フォロワー（承認済みのみ・共有 Inbox にまとめる）
 * - 承認済みリレー（公開投稿のみ）
 * - 返信先の相手・引用した相手（リモートのときだけ）
 */
export async function collectAudienceInboxes(
  actorUrl: string,
  opts: { visibility: string; inReplyTo?: string | null; quoteId?: string | null },
): Promise<string[]> {
  const followerInboxes = (await db.prepare(`
    SELECT DISTINCT COALESCE(ra.shared_inbox_url, f.inbox_url) AS inbox_url
    FROM follows f
    LEFT JOIN remote_actors ra ON ra.id = f.follower_url
    WHERE f.following_url = ? AND f.status = 'accepted'
      AND COALESCE(ra.shared_inbox_url, f.inbox_url) IS NOT NULL
      AND COALESCE(ra.shared_inbox_url, f.inbox_url) != ''
  `).all(actorUrl) as { inbox_url: string }[]).map((f) => f.inbox_url);

  // リレーは不特定多数のサーバーへ再配信するため、フォロワー限定投稿では使用しない
  const relayInboxes = opts.visibility === 'public'
    ? (await db.prepare(`
        SELECT DISTINCT inbox_url FROM relays WHERE status = 'accepted'
      `).all() as { inbox_url: string }[]).map((r) => r.inbox_url)
    : [];

  const directInboxes: string[] = [];
  if (opts.inReplyTo) {
    const parentPost = await db.prepare('SELECT author_url FROM posts WHERE id = ?').get(opts.inReplyTo) as { author_url: string } | undefined;
    if (parentPost && !parentPost.author_url.startsWith(config.origin)) {
      try {
        const remoteActor = await fetchRemoteActor(parentPost.author_url);
        if (remoteActor.inbox_url) directInboxes.push(remoteActor.inbox_url);
      } catch {}
    }
  }
  if (opts.quoteId) {
    const quotedPost = await db.prepare('SELECT author_url FROM posts WHERE id = ?').get(opts.quoteId) as { author_url: string } | undefined;
    if (quotedPost && !quotedPost.author_url.startsWith(config.origin)) {
      try {
        const remoteActor = await fetchRemoteActor(quotedPost.author_url);
        if (remoteActor.inbox_url) directInboxes.push(remoteActor.inbox_url);
      } catch {}
    }
  }

  return Array.from(new Set([...followerInboxes, ...relayInboxes, ...directInboxes]));
}

/**
 * 投稿を編集する（本文・CW・センシティブ）。
 *
 * 配信先は作成時と同じ audience（フォロワー＋リレー＋返信先/引用相手）に `Update` を送る。
 * Misskey / Mastodon は Update を受信すると手元のコピーを差し替えるので、連合先でも編集が反映される。
 * アンケートと添付メディアは編集しない（票や添付の整合が壊れるため）。
 */
export async function executeUpdatePost(params: {
  user: UserRow;
  postId: string;
  content?: string;
  cw?: string | null;
  isSensitive?: boolean;
}): Promise<{ ok: true; post: any; federatedTo: number } | { ok: false; status: number; error: string }> {
  const { user, postId } = params;
  const post = (await db.prepare('SELECT * FROM posts WHERE id = ?').get(postId)) as PostRow | undefined;
  if (!post || post.is_local !== 1) {
    return { ok: false, status: 404, error: '投稿が見つかりません。' };
  }
  if (post.user_id !== user.id) {
    return { ok: false, status: 403, error: '自分の投稿だけ編集できます。' };
  }
  if (post.visibility === 'direct') {
    // DM は編集の連合が煩雑なので対象外（送り直しで対応してもらう）
    return { ok: false, status: 400, error: 'メッセージ（DM）は編集できません。' };
  }

  const postText = params.content !== undefined ? String(params.content).trim() : post.content;
  const cwText = params.cw !== undefined ? (params.cw === null ? null : String(params.cw).trim() || null) : (post.cw ?? null);
  const isSensitive = params.isSensitive !== undefined ? (params.isSensitive ? 1 : 0) : (post.is_sensitive ? 1 : 0);

  let attachments: any[] = [];
  try { attachments = JSON.parse(post.media_attachments || '[]'); } catch { attachments = []; }
  if (!postText && attachments.length === 0) {
    return { ok: false, status: 400, error: '本文が空の投稿は編集できません。' };
  }

  const now = new Date().toISOString();
  // 本文のカスタム絵文字を拾い直す（編集で増減するため）
  const actorUrl = `${config.origin}/users/${user.id}`;
  const emojiMatches = postText.match(/:[a-zA-Z0-9_+-]+:/g) || [];
  let emojisJson = '[]';
  const apEmojiTags: { name: string; url: string }[] = [];
  if (emojiMatches.length > 0) {
    const uniqueNames = Array.from(new Set(emojiMatches.map((m) => m.slice(1, -1).toLowerCase())));
    const found = (await db
      .prepare(`SELECT name, url FROM custom_emojis WHERE name IN (${uniqueNames.map(() => '?').join(',')})`)
      .all(...uniqueNames)) as { name: string; url: string }[];
    if (found.length > 0) {
      emojisJson = JSON.stringify(found);
      for (const emoji of found) apEmojiTags.push({ name: emoji.name, url: emoji.url });
    }
  }

  await db
    .prepare('UPDATE posts SET content = ?, cw = ?, is_sensitive = ?, emojis = ?, edited_at = ? WHERE id = ?')
    .run(postText, cwText, isSensitive, emojisJson, now, postId);
  await invalidateTimelineCache();

  const updated = (await db.prepare('SELECT * FROM posts WHERE id = ?').get(postId)) as PostRow;

  // 連合先にも反映する（Update は「同じ ID のオブジェクトを差し替える」合図）
  let federatedTo = 0;
  if (updated.visibility !== 'local') {
    const note = buildNote({
      id: updated.id,
      authorUrl: actorUrl,
      content: postText,
      publishedAt: updated.published_at,
      editedAt: now,
      inReplyTo: updated.in_reply_to || undefined,
      quoteUrl: updated.quote_id || undefined,
      attachments,
      summary: cwText || undefined,
      sensitive: isSensitive === 1,
      tags: apEmojiTags.length > 0 ? apEmojiTags : undefined,
      visibility: updated.visibility,
    });
    const updateActivity = buildUpdateNoteActivity({ note, actorUrl });
    const inboxes = await collectAudienceInboxes(actorUrl, {
      visibility: updated.visibility,
      inReplyTo: updated.in_reply_to,
      quoteId: updated.quote_id,
    });
    federatedTo = inboxes.length;
    if (inboxes.length > 0) {
      void runWithConcurrency(inboxes, config.deliveryConcurrency, async (inboxUrl) => {
        try {
          return (await deliverActivity({ inboxUrl, activity: updateActivity, senderUser: user })) === true;
        } catch {
          return false;
        }
      }).then((results) => {
        const succeeded = results.filter((ok) => ok === true).length;
        console.log(`[Delivery] ✏️ Update sent: ${succeeded}/${inboxes.length} inboxes`);
      });
    }
  }

  // 画面を開いている人の表示も差し替える（本文と CW だけを送る）。
  // ⚠️ publishEvent を直接呼ぶと SSE には届かない（配信側は 'stream' チャンネルだけを購読している）。
  //    他のイベントと同じく broadcastEvent を通す（Redis が無くても自プロセスのクライアントへ届く）
  broadcastEvent('post_updated', {
    id: postId,
    content: postText,
    cw: cwText,
    is_sensitive: isSensitive,
    emojis: emojisJson,
    edited_at: now,
  });

  return {
    ok: true,
    federatedTo,
    post: { ...updated, media_attachments: attachments, emojis: emojisJson },
  };
}

/**
 * 新着ノートが各ユーザーのアンテナ条件にマッチするかを判定し、通知を発行
 */
export async function checkAntennaMatchesAndNotify(post: any): Promise<void> {
  try {
    const antennas = await db.prepare('SELECT * FROM antennas WHERE notify = 1').all() as unknown as AntennaRow[];
    if (!antennas || antennas.length === 0) return;

    // `src = 'home'` のアンテナは「持ち主がこの投稿者をフォローしているか」を見る。
    // アンテナごとに 1 本ずつ引くと **投稿 1 件あたりアンテナ数ぶんのクエリ**になり、
    // リレーから投稿が流れてくるほど効いてくる（投稿数 × アンテナ数）。
    // フォロー関係を 1 本でまとめて引いておく。
    const authorUrl = String(post.author_url || '');
    const homeOwners = Array.from(
      new Set(
        antennas
          .filter((ant) => ant.src === 'home' && ant.user_id !== post.user_id)
          .map((ant) => `${config.origin}/users/${ant.user_id}`),
      ),
    );
    const followsAuthor = new Set<string>();
    if (authorUrl && homeOwners.length > 0) {
      // プレースホルダが増えすぎないように区切って引く（アンテナが数千ある場合の保険）
      const CHUNK = 400;
      for (let i = 0; i < homeOwners.length; i += CHUNK) {
        const chunk = homeOwners.slice(i, i + CHUNK);
        const rows = (await db
          .prepare(`SELECT follower_url FROM follows WHERE following_url = ? AND follower_url IN (${chunk.map(() => '?').join(',')})`)
          .all(authorUrl, ...chunk)) as { follower_url: string }[];
        for (const row of rows) followsAuthor.add(row.follower_url);
      }
    }

    for (const ant of antennas) {
      // 自分の投稿は自分に通知しない
      if (ant.user_id === post.user_id) continue;

      // フォロー範囲の判定は上でまとめて済ませてある（ここでは引かない）
      if (ant.src === 'home' && !followsAuthor.has(`${config.origin}/users/${ant.user_id}`)) continue;

      if (isPostMatchingAntenna(post, ant)) {
        await createNotification({
          userId: ant.user_id,
          type: 'antenna',
          actorId: post.user_id || 'remote',
          actorName: post.author_name || 'Anonymous',
          actorHandle: post.author_handle || '',
          actorIcon: post.author_icon || '',
          postId: post.id,
          postContent: post.content || '',
          content: `アンテナ「${ant.name}」に新しいノートが届きました`,
        });
      }
    }
  } catch (e) {
    console.error('[Antenna Notification Error]:', e);
  }
}

/**
 * 投稿が特定のアンテナ条件に合致しているかを判定する。
 *
 * **DB は引かない**（`src = 'home'` のフォロー確認は呼び出し側がまとめて行う）。
 * 投稿 1 件ごとにアンテナ数ぶんクエリを撃たないための分離なので、ここに問い合わせを足さないこと。
 */
/**
 * アンテナ判定のための下ごしらえを、**投稿 1 件・アンテナ 1 件につき 1 回**だけにする。
 *
 * 以前はアンテナごとに「本文＋CW を連結して小文字化」と「キーワード文字列の分割」を
 * やり直していた（アンテナ 1000 件・本文 5KB で 18ms/投稿。リレーから 600 投稿/秒が
 * 流れてくる状況では、それだけで 10 秒分になる）。
 * 派生した値なので、元が同じなら使い回して構わない。
 */
const postTextCache = new WeakMap<object, { raw: string; lower: string }>();
const keywordListCache = new Map<string, string[]>();

function postTexts(post: any): { raw: string; lower: string } {
  const cached = postTextCache.get(post);
  if (cached) return cached;
  const raw = `${post.content || ''} ${post.cw || ''}`;
  const value = { raw, lower: raw.toLowerCase() };
  postTextCache.set(post, value);
  return value;
}

/** キーワード文字列を分割する（同じ文字列なら覚えておく） */
function splitKeywords(raw: string): string[] {
  const cached = keywordListCache.get(raw);
  if (cached) return cached;
  const list = raw
    .split(/[,、\n\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  if (keywordListCache.size >= 5000) keywordListCache.clear();
  keywordListCache.set(raw, list);
  return list;
}

export function isPostMatchingAntenna(post: any, ant: AntennaRow): boolean {
  // 1. ファイル添付フィルタ
  if (ant.with_file === 1) {
    const hasMedia = Array.isArray(post.media_attachments) && post.media_attachments.length > 0;
    if (!hasMedia) return false;
  }

  // 2. ソース範囲フィルタ（`home` のフォロー確認は呼び出し側で済み）
  if (ant.src === 'users') {
    // 特定ユーザーリスト
    const allowed = (ant.user_list || '')
      .split(',')
      .map((u) => u.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean);
    const postUserId = (post.user_id || '').toLowerCase();
    const postHandle = (post.author_handle || '').toLowerCase().replace(/^@/, '');
    const matched = allowed.some((target) => postUserId === target || postHandle.includes(target));
    if (!matched) return false;
  }

  // 3. テキストの準備（本文 ＋ CW。投稿ごとに 1 回だけ作る）
  const { raw: rawText, lower: lowerText } = postTexts(post);
  const textToSearch = ant.case_sensitive === 1 ? rawText : lowerText;

  // 4. 除外キーワード判定（1つでも含まれていれば不一致）
  if (ant.exclude_keywords && ant.exclude_keywords.trim().length > 0) {
    const excludeList = splitKeywords(ant.exclude_keywords);

    for (const ex of excludeList) {
      const targetEx = ant.case_sensitive === 1 ? ex : ex.toLowerCase();
      if (textToSearch.includes(targetEx)) {
        return false;
      }
    }
  }

  // 5. 含有キーワード判定（ORマッチ: いずれか1つでも含まれれば一致）
  if (ant.keywords && ant.keywords.trim().length > 0) {
    const keywordList = splitKeywords(ant.keywords);

    if (keywordList.length === 0) return true; // キーワード指定なしは全件一致

    const matchesKeyword = keywordList.some((kw) => {
      const targetKw = ant.case_sensitive === 1 ? kw : kw.toLowerCase();
      return textToSearch.includes(targetKw);
    });

    if (!matchesKeyword) return false;
  }

  return true;
}
