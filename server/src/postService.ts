import crypto from 'node:crypto';
import { db, UserRow, PostRow, createNotification, AntennaRow } from './db.js';
import { config } from './config.js';
import { broadcastNote } from './streaming.js';
import {
  buildNote,
  buildCreateActivity,
  deliverActivity,
  fetchRemoteActor,
} from './activitypub.js';
import { canViewPost, normalizeVisibility, PostVisibility } from './postVisibility.js';
import { queueLinkPreviewFetch } from './linkPreview.js';

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
  const parsedAttachments = Array.isArray(attachments) ? attachments : [];
  const channelId = typeof params.channel_id === 'string' && params.channel_id.trim() ? params.channel_id.trim() : null;

  const postText = params.content ? params.content.trim() : '';
  const inReplyTo = typeof in_reply_to === 'string' && in_reply_to.trim() ? in_reply_to.trim() : null;
  const quoteId = typeof quote_id === 'string' && quote_id.trim() ? quote_id.trim() : null;
  const isSensitive = Boolean(is_sensitive);
  const cwText = typeof cw === 'string' && cw.trim() ? cw.trim() : null;
  const actorUrl = `${config.origin}/users/${user.id}`;
  const postId = `${actorUrl}/posts/${Date.now()}`;
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
    const foundEmojis = db.prepare(`
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
    const quoteTarget = db.prepare('SELECT id, author_url, visibility FROM posts WHERE id = ?').get(quoteId) as
      | { id: string; author_url: string; visibility: string | null }
      | undefined;
    if (quoteTarget && !canViewPost(quoteTarget, actorUrl)) {
      throw new Error('この投稿は引用できません。');
    }
  }

  // 1. ローカルDBに投稿保存
  db.prepare(`
    INSERT INTO posts (id, user_id, author_name, author_url, author_handle, author_icon, content, is_local, visibility, emojis, in_reply_to, quote_id, is_sensitive, media_attachments, cw, published_at, channel_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(postId, user.id, user.name, actorUrl, authorHandle, authorIcon, postText, visibility, emojisJson, inReplyTo, quoteId, isSensitive ? 1 : 0, attachmentsJson, cwText, now, channelId);

  // チャンネルの投稿数をインクリメント
  let channelData: any = null;
  if (channelId) {
    try {
      db.prepare('UPDATE channels SET posts_count = posts_count + 1 WHERE id = ?').run(channelId);
      channelData = db.prepare('SELECT id, name, description, banner_url, color FROM channels WHERE id = ?').get(channelId);
    } catch (e) {
      console.error('[Post] Failed to update channel posts count:', e);
    }
  }

  // 引用元投稿の解決（あれば）
  let quotePostData: any = null;
  if (quoteId) {
    const qRow = db.prepare('SELECT id, user_id, author_name, author_url, author_handle, author_icon, content, cw, emojis, media_attachments, is_sensitive, published_at FROM posts WHERE id = ?').get(quoteId) as any;
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

    db.prepare(`
      INSERT INTO polls (id, post_id, multiple, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(pollId, postId, multiple, expiresAt, now);

    const insertChoice = db.prepare(`
      INSERT INTO poll_choices (id, poll_id, choice_index, text, votes_count)
      VALUES (?, ?, ?, ?, 0)
    `);
    validChoices.forEach((choiceText: string, idx: number) => {
      insertChoice.run(crypto.randomUUID(), pollId, idx, choiceText);
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
    checkAntennaMatchesAndNotify(responsePostData);
  }

  // 返信の場合、親投稿の作成者（ローカルユーザー）へ通知を送信
  // 返信相手（重複通知を避けるためメンション通知から除外する）
  let replyParentUserId: string | null = null;

  if (inReplyTo) {
    try {
      const parentPost = db.prepare('SELECT * FROM posts WHERE id = ?').get(inReplyTo) as PostRow | undefined;
      if (parentPost && parentPost.is_local === 1) {
        replyParentUserId = parentPost.user_id;
        createNotification({
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
      const target = db.prepare('SELECT id FROM users WHERE id = ?').get(mentionedId);
      if (!target) {
        continue;
      }
      createNotification({
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
  const followerInboxes = (db.prepare(`
    SELECT DISTINCT inbox_url FROM follows
    WHERE following_url = ? AND status = 'accepted' AND inbox_url IS NOT NULL AND inbox_url != ''
  `).all(actorUrl) as { inbox_url: string }[]).map((f) => f.inbox_url);

  // リレーは不特定多数のサーバーへ再配信するため、フォロワー限定投稿では使用しない
  const relayInboxes = visibility === 'public'
    ? (db.prepare(`
        SELECT DISTINCT inbox_url FROM relays WHERE status = 'accepted'
      `).all() as { inbox_url: string }[]).map((r) => r.inbox_url)
    : [];

  const directInboxes: string[] = [];
  if (inReplyTo) {
    const parentPost = db.prepare('SELECT author_url FROM posts WHERE id = ?').get(inReplyTo) as { author_url: string } | undefined;
    if (parentPost && !parentPost.author_url.startsWith(config.origin)) {
      try {
        const remoteActor = await fetchRemoteActor(parentPost.author_url);
        if (remoteActor.inbox_url) directInboxes.push(remoteActor.inbox_url);
      } catch {}
    }
  }
  if (quoteId) {
    const quotedPost = db.prepare('SELECT author_url FROM posts WHERE id = ?').get(quoteId) as { author_url: string } | undefined;
    if (quotedPost && !quotedPost.author_url.startsWith(config.origin)) {
      try {
        const remoteActor = await fetchRemoteActor(quotedPost.author_url);
        if (remoteActor.inbox_url) directInboxes.push(remoteActor.inbox_url);
      } catch {}
    }
  }

  const allTargetInboxes = Array.from(new Set([...followerInboxes, ...relayInboxes, ...directInboxes]));

  // 非同期でフォロワー及びリレーへ配送
  if (allTargetInboxes.length > 0) {
    Promise.allSettled(
      allTargetInboxes.map((inboxUrl) =>
        deliverActivity({
          inboxUrl,
          activity: createActivity,
          senderUser: user,
        })
      )
    ).then((results) => {
      const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value).length;
      console.log(`[Delivery] Federation sent: ${succeeded}/${allTargetInboxes.length} inboxes`);
    });
  }

  return { post: responsePostData, federatedTo: allTargetInboxes.length };
}

/**
 * 新着ノートが各ユーザーのアンテナ条件にマッチするかを判定し、通知を発行
 */
export function checkAntennaMatchesAndNotify(post: any): void {
  try {
    const antennas = db.prepare('SELECT * FROM antennas WHERE notify = 1').all() as unknown as AntennaRow[];
    if (!antennas || antennas.length === 0) return;

    for (const ant of antennas) {
      // 自分の投稿は自分に通知しない
      if (ant.user_id === post.user_id) continue;

      if (isPostMatchingAntenna(post, ant)) {
        createNotification({
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
 * 投稿が特定のアンテナ条件に合致しているかを判定
 */
export function isPostMatchingAntenna(post: any, ant: AntennaRow): boolean {
  // 1. ファイル添付フィルタ
  if (ant.with_file === 1) {
    const hasMedia = Array.isArray(post.media_attachments) && post.media_attachments.length > 0;
    if (!hasMedia) return false;
  }

  // 2. ソース範囲フィルタ
  if (ant.src === 'home') {
    // アンテナ所有者のフォロー対象かチェック
    const isFollowing = db.prepare(`
      SELECT 1 FROM follows 
      WHERE follower_url = ? AND following_url = ?
    `).get(`${config.origin}/users/${ant.user_id}`, post.author_url);
    if (!isFollowing) return false;
  } else if (ant.src === 'users') {
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

  // 3. テキストの準備（本文 ＋ CW）
  const rawText = `${post.content || ''} ${post.cw || ''}`;
  const textToSearch = ant.case_sensitive === 1 ? rawText : rawText.toLowerCase();

  // 4. 除外キーワード判定（1つでも含まれていれば不一致）
  if (ant.exclude_keywords && ant.exclude_keywords.trim().length > 0) {
    const excludeList = ant.exclude_keywords
      .split(/[,、\n\s]+/)
      .map((k) => k.trim())
      .filter(Boolean);

    for (const ex of excludeList) {
      const targetEx = ant.case_sensitive === 1 ? ex : ex.toLowerCase();
      if (textToSearch.includes(targetEx)) {
        return false;
      }
    }
  }

  // 5. 含有キーワード判定（ORマッチ: いずれか1つでも含まれれば一致）
  if (ant.keywords && ant.keywords.trim().length > 0) {
    const keywordList = ant.keywords
      .split(/[,、\n\s]+/)
      .map((k) => k.trim())
      .filter(Boolean);

    if (keywordList.length === 0) return true; // キーワード指定なしは全件一致

    const matchesKeyword = keywordList.some((kw) => {
      const targetKw = ant.case_sensitive === 1 ? kw : kw.toLowerCase();
      return textToSearch.includes(targetKw);
    });

    if (!matchesKeyword) return false;
  }

  return true;
}
