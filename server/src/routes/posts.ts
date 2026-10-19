/**
 * 投稿の作成・削除・編集、リアクション、ブースト、投票、スレッド、通報。
 *
 * api.ts から切り出したルーター。マウント位置（api.ts）は元の登録順と同じ。
 */
import { asyncHandler } from '../asyncHandler.js';
import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { withTransaction } from '../db/asyncDriver.js';
import { db, UserRow, PostRow, ReactionRow, AnnounceRow, createNotification } from '../db.js';
import { config } from '../config.js';
import { applyPageHeaders, collectVisiblePage, cursorPredicate, parsePageQuery } from '../pagination.js';
import { canViewPost, filterVisiblePosts, isPublicPost, normalizeVisibility } from '../postVisibility.js';
import { createReport, logNewReport } from '../reportService.js';
import { unlinkMediaFromPost } from '../mediaService.js';
import { executeCreatePost, executeUpdatePost } from '../postService.js';
import { requireAuth } from '../auth.js';
import { canViewDmMessage } from '../dm.js';
import { broadcastReaction, broadcastAnnounce, broadcastPoll, broadcastDeletePost } from '../streaming.js';
import { invalidateTimelineCache } from '../timelineCache.js';
import {
  buildEmojiReactActivity,
  buildLikeActivity,
  buildAnnounceActivity,
  buildUndoActivity,
  buildDeleteActivity,
  deliverActivity,
  resolveWebFinger,
  fetchRemoteActor,
  federatePollUpdate,
  federatePollVote,
} from '../activitypub.js';
import { enrichAndFilterPosts, getPollDataForPost } from '../postEnrichment.js';

const router = Router();

// 新規投稿作成（認証必須・公開範囲選択・返信・画像添付・アンケート・引用・センシティブ対応）
/**
 * 投稿の作成。**Misskey 互換 API からも同じ関数を呼ぶ**（バリデーション・連合・アンテナ通知を
 * 二重に実装しないため）。呼び出し側は `req.body` を通常の投稿と同じ形にしてから呼ぶこと。
 */
export const handleCreatePost = async (req: Request, res: Response) => {
  try {
    const { content, in_reply_to, attachments, cw, poll, quote_id, is_sensitive, visibility, channel_id } = req.body;
    const result = await executeCreatePost({
      user: req.rawUser!,
      content,
      in_reply_to,
      attachments,
      cw,
      poll,
      quote_id,
      is_sensitive,
      visibility,
      channel_id,
    });
    res.status(201).json({
      ...result.post,
      federatedTo: result.federatedTo,
    });
  } catch (err: any) {
    console.error('[Post Error]:', err);
    res.status(400).json({ error: err.message || '投稿の作成に失敗しました。' });
  }
};
router.post('/posts', requireAuth, handleCreatePost);

// 投稿の削除 (作成者本人または管理者)
export const handleDeletePost = asyncHandler(async (req: Request, res: Response) => {
  const rawPostId = String(req.params.id);
  const postId = decodeURIComponent(rawPostId);
  const user = (req.rawUser || req.user)!;

  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(postId) as unknown as PostRow | undefined;
  if (!post) {
    return res.status(404).json({ error: '投稿が見つかりません。' });
  }

  // 権限チェック: 自ノードの作成者本人のみ削除可能 (他人の投稿・連合投稿は削除不可)
  if (post.is_local !== 1 || post.user_id !== user.id) {
    return res.status(403).json({ error: '自分の投稿のみ削除できます。他人の投稿や連合投稿は削除できません。' });
  }

  // DBから削除 (カスケード的にreactions / announces / polls もクリーンアップ)
  await db.prepare('DELETE FROM posts WHERE id = ?').run(postId);
  await db.prepare('DELETE FROM reactions WHERE post_id = ?').run(postId);
  await db.prepare('DELETE FROM announces WHERE post_id = ?').run(postId);
  // DM の既読記録も一緒に消す（孤児を残さない）
  await db.prepare('DELETE FROM dm_reads WHERE post_id = ?').run(postId).catch(() => undefined);
  // 読み取りキャッシュにも消えたことを反映させる
  await invalidateTimelineCache();
  try {
    await db.prepare('DELETE FROM polls WHERE post_id = ?').run(postId);
  } catch {}

  // ドライブの紐づけを解除する（ファイル自体はドライブに残す）
  await unlinkMediaFromPost(postId);

  console.log(`[Post Delete] Post ${postId} deleted by @${user.id}`);

  // 📡 全クライアントに投稿削除をブロードキャスト（公開投稿のみ）
  //    削除後に DB を引くと行が無いため、**削除前に読んだ post.visibility** で判断する
  if (normalizeVisibility(post.visibility) === 'public') {
    broadcastDeletePost(postId);
  }

  // 公開投稿だった場合のみ ActivityPub Delete をフォロワー & リレーへ配信
  // （ローカル限定・フォロワー限定はリレーへ配送しない）
  if (post.visibility === 'public' && post.is_local === 1) {
    const authorUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(post.user_id) as UserRow | undefined;
    if (authorUser) {
      const actorUrl = `${config.origin}/users/${authorUser.id}`;
      const deleteActivity = buildDeleteActivity({
        actorUrl,
        targetPostUrl: postId,
      });

      const followerInboxes = (await db.prepare(`
        SELECT DISTINCT inbox_url FROM follows
        WHERE following_url = ? AND inbox_url IS NOT NULL AND inbox_url != ''
      `).all(actorUrl) as { inbox_url: string }[]).map((f) => f.inbox_url);

      const relayInboxes = (await db.prepare(`
        SELECT DISTINCT inbox_url FROM relays WHERE status = 'accepted'
      `).all() as { inbox_url: string }[]).map((r) => r.inbox_url);

      const targetInboxes = Array.from(new Set([...followerInboxes, ...relayInboxes]));
      for (const inbox of targetInboxes) {
        deliverActivity({ inboxUrl: inbox, activity: deleteActivity, senderUser: authorUser }).catch(() => {});
      }
    }
  }

  res.json({ success: true, message: '投稿を削除しました。' });
});
router.delete('/posts/:id', requireAuth, handleDeletePost);

// ✏️ 投稿の編集（自分のローカル投稿のみ）。ActivityPub の Update で連合先にも反映する
router.put('/posts/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const postId = decodeURIComponent(String(req.params.id));
  const result = await executeUpdatePost({
    user: req.rawUser!,
    postId,
    content: typeof req.body?.content === 'string' ? req.body.content : undefined,
    cw: req.body?.cw === null ? null : (typeof req.body?.cw === 'string' ? req.body.cw : undefined),
    isSensitive: typeof req.body?.is_sensitive === 'boolean' ? req.body.is_sensitive : undefined,
  });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }
  res.json({ success: true, post: result.post, federatedTo: result.federatedTo });
}));

// 📊 アンケートへの投票 (認証必須)
export const handleVotePoll = asyncHandler(async (req: Request, res: Response) => {
  const rawPostId = String(req.params.id);
  const postId = decodeURIComponent(rawPostId);
  const user = (req.rawUser || req.user)!;
  const { choices } = req.body;

  if (!Array.isArray(choices) || choices.length === 0) {
    return res.status(400).json({ error: '投票する選択肢を1つ以上選択してください。' });
  }

  const poll = await db.prepare('SELECT * FROM polls WHERE post_id = ?').get(postId) as any;
  if (!poll) {
    return res.status(404).json({ error: 'この投稿にはアンケートがありません。' });
  }

  // 閲覧できない投稿（フォロワー限定など）には投票できない
  const voteTarget = await db.prepare('SELECT author_url, visibility, is_local FROM posts WHERE id = ?').get(postId) as
    | { author_url: string; visibility: string | null; is_local: number }
    | undefined;
  if (voteTarget && !(await canViewPost(voteTarget, `${config.origin}/users/${user.id}`))) {
    return res.status(403).json({ error: 'このアンケートには投票できません。' });
  }

  // 期限切れ判定
  if (poll.expires_at && poll.expires_at < new Date().toISOString()) {
    return res.status(400).json({ error: 'このアンケートの投票受付は終了しました。' });
  }

  // 単一回答制限
  if (!poll.multiple && choices.length > 1) {
    return res.status(400).json({ error: 'このアンケートは1つのみ選択可能です。' });
  }

  // 投票済み判定
  const existingVoteCount = (await db.prepare('SELECT COUNT(*) as c FROM poll_votes WHERE poll_id = ? AND user_id = ?').get(poll.id, user.id) as any).c;
  if (existingVoteCount > 0) {
    return res.status(400).json({ error: '既にこのアンケートには投票済みです。' });
  }

  // 選択肢の存在検証（テキストも取る。リモートのアンケートには
  // 「どの選択肢か」を text で送る必要がある — 連合先の choice_index は当てにならない）
  const pollChoices = await db.prepare('SELECT choice_index, text FROM poll_choices WHERE poll_id = ?').all(poll.id) as { choice_index: number; text: string }[];
  const choiceTextByIndex = new Map(pollChoices.map((c) => [c.choice_index, c.text]));
  const validIndices = new Set(pollChoices.map((c) => c.choice_index));
  for (const c of choices) {
    if (typeof c !== 'number' || !validIndices.has(c)) {
      return res.status(400).json({ error: '無効な選択肢が含まれています。' });
    }
  }

  const now = new Date().toISOString();
  const insertVote = await db.prepare('INSERT INTO poll_votes (id, poll_id, choice_index, user_id, created_at) VALUES (?, ?, ?, ?, ?)');
  const updateCount = await db.prepare('UPDATE poll_choices SET votes_count = votes_count + 1 WHERE poll_id = ? AND choice_index = ?');

  // 投票と集計はまとめて 1 つのトランザクションで入れる。
  // 文は必ず await する（待たないと COMMIT の後に実行され、集計が二重にずれる）。
  // SQLite では `withTransaction` が、開いている間だけ他のリクエストの文を待たせる。
  await withTransaction(db, async () => {
    for (const choiceIdx of choices) {
      await insertVote.run(crypto.randomUUID(), poll.id, choiceIdx, user.id, now);
      await updateCount.run(poll.id, choiceIdx);
    }
  });

  console.log(`[Poll Vote] User @${user.id} voted for choices [${choices.join(', ')}] on post ${postId}`);

  // 最新のアンケート情報を取得
  const updatedPoll = await getPollDataForPost(postId, user.id);

  // 📡 全クライアントにアンケート更新をブロードキャスト（公開投稿のみ）
  if (updatedPoll && (await isPublicPost(postId))) {
    broadcastPoll({
      postId,
      poll: updatedPoll,
    });
  }

  // 🌐 リモート連合（Misskey / Mastodon）へ配信
  //  - 自分のサーバーのアンケート: 更新後の得票数を Update(Question) で配る
  //  - 他のサーバーのアンケート: 「どの選択肢に入れたか」を原典へ送る
  //    （得票数の集計は原典の仕事。送らないと原典の票数に入らず、ずっと食い違う）
  if (voteTarget?.is_local === 1) {
    federatePollUpdate({ postId });
  } else if (req.rawUser) {
    // 署名には端末の秘密鍵が要るので、切り詰めていない行（rawUser）を使う
    const choiceTexts = choices
      .map((idx: number) => choiceTextByIndex.get(idx))
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
    federatePollVote({ postId, voter: req.rawUser, choiceTexts });
  }

  res.json({ success: true, poll: updatedPoll });
});
router.post('/posts/:id/poll/vote', requireAuth, handleVotePoll);

// 絵文字リアクションの付与 / 解除 (Misskey & Mastodon 相互互換)
export const handleReactToPost = asyncHandler(async (req: Request, res: Response) => {
  const rawPostId = String(req.params.id);
  const postId = decodeURIComponent(rawPostId);
  const reaction = String(req.body.reaction || '👍').trim();

  if (!reaction) {
    return res.status(400).json({ error: '絵文字を指定してください。' });
  }

  const user = req.rawUser!;
  const actorUrl = `${config.origin}/users/${user.id}`;

  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(postId) as PostRow | undefined;
  if (!post) {
    return res.status(404).json({ error: '対象の投稿が見つかりません。' });
  }

  // 閲覧できない投稿（フォロワー限定など）にはリアクションできない
  if (!(await canViewPost(post, actorUrl))) {
    return res.status(403).json({ error: 'この投稿にはリアクションできません。' });
  }

  // 既に同じリアクションが付与されているかチェック
  const existing = await db.prepare(`
    SELECT * FROM reactions WHERE post_id = ? AND user_id = ? AND reaction = ?
  `).get(postId, actorUrl, reaction) as ReactionRow | undefined;

  let added = false;
  if (existing) {
    // 既存あり → 解除 (Undo)
    await db.prepare('DELETE FROM reactions WHERE id = ?').run(existing.id);
    added = false;

    // 外部投稿の場合、Undo Activity を配送
    if (!post.is_local || post.visibility === 'public') {
      try {
        const undoActivity = buildUndoActivity({
          actorUrl,
          activityToUndo: {
            id: existing.id,
            type: 'Like',
            actor: actorUrl,
            object: postId,
          },
          targetActorUrl: post.author_url,
        });

        if (post.author_url && !post.author_url.startsWith(config.origin)) {
          const remote = await fetchRemoteActor(post.author_url);
          if (remote.inbox_url) {
            deliverActivity({ inboxUrl: remote.inbox_url, activity: undoActivity, senderUser: user }).catch(() => {});
          }
        }
      } catch {}
    }
  } else {
    // 新規付与
    const reactionId = `${config.origin}/activities/react/${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    await db.prepare(`
      INSERT INTO reactions (id, post_id, user_id, user_name, user_icon, reaction, is_local, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(post_id, user_id, reaction) DO UPDATE SET
        user_name = excluded.user_name,
        user_icon = excluded.user_icon
    `).run(reactionId, postId, actorUrl, user.name, user.icon_url || '', reaction, now);
    added = true;

    // ローカル投稿の場合、投稿者にリアクション通知を送信
    if (post.is_local === 1) {
      try {
        await createNotification({
          userId: post.user_id,
          type: 'reaction',
          actorId: user.id,
          actorName: user.name,
          actorHandle: `@${user.id}@${config.domain}`,
          actorIcon: user.icon_url || '',
          postId: post.id,
          postContent: post.content,
          content: reaction,
        });
      } catch (e) {
        console.error('[Notification Error] Reaction notification failed:', e);
      }
    }

    // 外部投稿またはパブリック投稿の場合、ActivityPub で配送
    // ⚡ Misskey には EmojiReact (絵文字表示)、Mastodon には Like (いいね数加算)
    if (!post.author_url.startsWith(config.origin)) {
      try {
        const remote = await fetchRemoteActor(post.author_url);
        if (remote.inbox_url) {
          // デュアル対応: content と _misskey_reaction を含めた Like (Mastodon は Like として解釈、Misskey は _misskey_reaction で絵文字解釈)
          const likeActivity = buildLikeActivity({
            id: reactionId,
            actorUrl,
            targetPostUrl: postId,
            reaction,
            targetActorUrl: post.author_url,
          });

          // Misskey 向け EmojiReact も送信
          const emojiReactActivity = buildEmojiReactActivity({
            id: `${reactionId}-emoji`,
            actorUrl,
            targetPostUrl: postId,
            reaction,
            targetActorUrl: post.author_url,
          });

          // 相手Inboxへ配送
          deliverActivity({ inboxUrl: remote.inbox_url, activity: likeActivity, senderUser: user }).catch(() => {});
          deliverActivity({ inboxUrl: remote.inbox_url, activity: emojiReactActivity, senderUser: user }).catch(() => {});
        }
      } catch (err: any) {
        console.warn('[React Delivery Warning]:', err.message);
      }
    }
  }

  // 最新のリアクション集計を返却
  const updatedReactions = await db.prepare(`
    SELECT reaction, count(*) as count,
      max(case when user_id = ? then 1 else 0 end) as me
    FROM reactions
    WHERE post_id = ?
    GROUP BY reaction
  `).all(actorUrl, postId) as { reaction: string; count: number; me: number }[];

  const reactionsList = updatedReactions.map((r) => ({ reaction: r.reaction, count: r.count, me: Boolean(r.me) }));
  const targetReaction = reactionsList.find((r) => r.reaction === reaction);

  // 📡 全クライアントにリアクション変化をブロードキャスト（公開投稿のみ）
  if (await isPublicPost(postId)) {
    broadcastReaction({
      postId,
      reaction,
      count: targetReaction ? targetReaction.count : 0,
      user_id: user.id,
      action: added ? 'add' : 'remove',
    });
  }

  res.json({
    postId,
    added,
    reactions: reactionsList,
  });
});
router.post('/posts/:id/react', requireAuth, handleReactToPost);

// RT (ブースト / Announce) の付与 / 解除
export const handleAnnouncePost = asyncHandler(async (req: Request, res: Response) => {
  const rawPostId = String(req.params.id);
  const postId = decodeURIComponent(rawPostId);
  const user = req.rawUser!;
  const actorUrl = `${config.origin}/users/${user.id}`;

  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').get(postId) as PostRow | undefined;
  if (!post) {
    return res.status(404).json({ error: '対象の投稿が見つかりません。' });
  }

  // 閲覧できない投稿（フォロワー限定など）はリノートできない
  if (!(await canViewPost(post, actorUrl))) {
    return res.status(403).json({ error: 'この投稿はリノートできません。' });
  }

  // DM はリノートできない（宛先の外へ存在が漏れるため）
  if (normalizeVisibility(post.visibility) === 'direct') {
    return res.status(403).json({ error: 'この投稿はリノートできません。' });
  }

  const existing = await db.prepare(`
    SELECT * FROM announces WHERE post_id = ? AND user_id = ?
  `).get(postId, actorUrl) as AnnounceRow | undefined;

  let announced = false;
  if (existing) {
    // 解除
    await db.prepare('DELETE FROM announces WHERE id = ?').run(existing.id);
    await invalidateTimelineCache();
    announced = false;

    // Undo(Announce) 配信
    try {
      const undoActivity = buildUndoActivity({
        actorUrl,
        activityToUndo: {
          id: existing.id,
          type: 'Announce',
          actor: actorUrl,
          object: postId,
        },
        targetActorUrl: post.author_url,
      });

      if (!post.author_url.startsWith(config.origin)) {
        const remote = await fetchRemoteActor(post.author_url);
        if (remote.inbox_url) {
          deliverActivity({ inboxUrl: remote.inbox_url, activity: undoActivity, senderUser: user }).catch(() => {});
        }
      }
    } catch {}
  } else {
    // 付与
    const announceId = `${config.origin}/activities/announce/${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    await db.prepare(`
      INSERT INTO announces (id, post_id, user_id, user_name, user_handle, user_icon, is_local, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(post_id, user_id) DO UPDATE SET
        user_name = excluded.user_name,
        user_handle = excluded.user_handle,
        user_icon = excluded.user_icon
    `).run(announceId, postId, actorUrl, user.name, `@${user.id}@${config.domain}`, user.icon_url || '', now);
    await invalidateTimelineCache();
    announced = true;

    // ローカル投稿の場合、投稿者にリノート通知を送信
    if (post.is_local === 1) {
      try {
        await createNotification({
          userId: post.user_id,
          type: 'renote',
          actorId: user.id,
          actorName: user.name,
          actorHandle: `@${user.id}@${config.domain}`,
          actorIcon: user.icon_url || '',
          postId: post.id,
          postContent: post.content,
        });
      } catch (e) {
        console.error('[Notification Error] Renote notification failed:', e);
      }
    }

    // ActivityPub Announce をフォロワー & 相手著者 & リレーへ配信
    // （公開投稿のみ。ローカル限定・フォロワー限定の投稿を連合先へ再配信しない）
    const announceActivity = buildAnnounceActivity({
      id: announceId,
      actorUrl,
      targetPostUrl: postId,
      targetActorUrl: post.author_url,
    });

    const followerInboxes = (await db.prepare(`
      SELECT DISTINCT inbox_url FROM follows
      WHERE following_url = ? AND status = 'accepted' AND inbox_url IS NOT NULL AND inbox_url != ''
    `).all(actorUrl) as { inbox_url: string }[]).map((f) => f.inbox_url);

    const relayInboxes = post.visibility === 'public'
      ? (await db.prepare(`
          SELECT DISTINCT inbox_url FROM relays WHERE status = 'accepted'
        `).all() as { inbox_url: string }[]).map((r) => r.inbox_url)
      : [];

    const targetInboxes = Array.from(new Set([...followerInboxes, ...relayInboxes]));
    if (post.visibility === 'public' && !post.author_url.startsWith(config.origin)) {
      try {
        const remote = await fetchRemoteActor(post.author_url);
        if (remote.inbox_url) targetInboxes.push(remote.inbox_url);
      } catch {}
    }

    if (post.visibility === 'public') {
      Promise.allSettled(
        targetInboxes.map((inboxUrl) =>
          deliverActivity({ inboxUrl, activity: announceActivity, senderUser: user })
        )
      ).catch(() => {});
    }
  }

  const announceCount = (await db.prepare('SELECT count(*) as c FROM announces WHERE post_id = ?').get(postId) as any).c;

  // 📡 全クライアントにリノート変化をブロードキャスト（公開投稿のみ）
  if (await isPublicPost(postId)) {
    broadcastAnnounce({
      postId,
    count: announceCount,
    renote: announced ? {
      id: postId,
      name: user.name,
      handle: `@${user.id}@${config.domain}`,
      icon: user.icon_url || '',
      url: actorUrl,
      at: new Date().toISOString(),
    } : null,
    });
  }

  res.json({
    postId,
    announced,
    announce_count: announceCount,
  });
});
router.post('/posts/:id/announce', requireAuth, handleAnnouncePost);

// 会話スレッド（親投稿・対象投稿・返信一覧）取得
router.get('/posts/:id/thread', asyncHandler(async (req: Request, res: Response) => {
  const rawPostId = String(req.params.id);
  const postId = decodeURIComponent(rawPostId);
  const currentActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;

  // 対象投稿
  const post = await db.prepare(`
    SELECT 
      p.id, p.user_id, p.author_name, p.author_url, p.author_handle, p.content,
      p.is_local, p.visibility, p.recipients, p.emojis, p.in_reply_to, p.quote_id, p.is_sensitive, p.media_attachments, p.published_at, p.edited_at,
      COALESCE(NULLIF(p.author_icon, ''), NULLIF(u.icon_url, ''), NULLIF(ra.icon_url, ''), '') AS author_icon
    FROM posts p
    LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
    LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
    WHERE p.id = ?
  `).get(postId) as any;

  if (!post) {
    return res.status(404).json({ error: '投稿が見つかりません。' });
  }

  // DM は当事者以外に存在も見せない（宛先でなければ 404）。
  // 宛先でも、受信を許可していない相手からのメッセージは見せない（docs/DM.md）
  if (normalizeVisibility(post.visibility) === 'direct') {
    if (!(await canViewDmMessage(post, currentActorUrl))) {
      return res.status(404).json({ error: '投稿が見つかりません。' });
    }
  } else if (!(await canViewPost(post, currentActorUrl))) {
    return res.status(404).json({ error: '投稿が見つかりません。' });
  }

  // 親投稿（in_reply_to がある場合）
  let parent = null;
  if (post.in_reply_to) {
    parent = await db.prepare(`
      SELECT 
        p.id, p.user_id, p.author_name, p.author_url, p.author_handle, p.content,
        p.is_local, p.visibility, p.recipients, p.emojis, p.in_reply_to, p.quote_id, p.is_sensitive, p.media_attachments, p.published_at, p.edited_at,
        COALESCE(NULLIF(p.author_icon, ''), NULLIF(u.icon_url, ''), NULLIF(ra.icon_url, ''), '') AS author_icon
      FROM posts p
      LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
      LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
      WHERE p.id = ?
    `).get(post.in_reply_to) as any;
  }

  // 子返信一覧
  const replies = await db.prepare(`
    SELECT 
      p.id, p.user_id, p.author_name, p.author_url, p.author_handle, p.content,
      p.is_local, p.visibility, p.recipients, p.emojis, p.in_reply_to, p.quote_id, p.is_sensitive, p.media_attachments, p.published_at, p.edited_at,
      COALESCE(NULLIF(p.author_icon, ''), NULLIF(u.icon_url, ''), NULLIF(ra.icon_url, ''), '') AS author_icon
    FROM posts p
    LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
    LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
    WHERE p.in_reply_to = ?
    ORDER BY p.published_at ASC
  `).all(postId) as any[];

  const allRows: any[] = [];
  if (post) allRows.push(post);
  if (parent) allRows.push(parent);
  allRows.push(...replies);

  // DM（visibility = 'direct'）の行は当事者以外に落とす（宛先でない人には返信一覧にも見せない）
  const visibleRows = await filterVisiblePosts(allRows, currentActorUrl);
  const enrichedList = await enrichAndFilterPosts(visibleRows, currentActorUrl, req.user?.id);
  const enrichedMap = new Map<string, any>(enrichedList.map((p) => [p.id, p]));

  res.json({
    post: enrichedMap.get(post.id) || null,
    parent: parent ? (enrichedMap.get(parent.id) || null) : null,
    replies: replies.map((r) => enrichedMap.get(r.id)).filter(Boolean),
  });
}));


// この投稿を引用した人の一覧（Misskey の「引用」に相当）
router.get('/posts/:id/quotes', asyncHandler(async (req: Request, res: Response) => {
  const postId = decodeURIComponent(String(req.params.id));
  const page = parsePageQuery(req, 40);
  if (page.error) return res.status(400).json({ error: page.error });
  const currentActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;
  try {
    // 引用も enrich でブロック・ミュート・フォロワー限定の除外が入るので、
    // 読み足し（collectVisiblePage）で 1 ページ分を満たす
    const { items: enriched, nextCursor } = await collectVisiblePage({
      limit: page.limit,
      cursor: page.cursor,
      fetchRows: async (cursor, n) => {
        const cursorCond = cursor ? ` AND ${cursorPredicate('p.published_at', 'p.id')}` : '';
        const cursorParams = cursor ? [cursor.at, cursor.at, cursor.id] : [];
        return await db.prepare(`
          SELECT
            p.*,
            p.id AS post_id,
            p.published_at AS timeline_at,
            COALESCE(NULLIF(p.author_icon, ''), NULLIF(u.icon_url, ''), NULLIF(ra.icon_url, ''), '') AS author_icon
          FROM posts p
          LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
          LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
          WHERE p.quote_id = ? AND COALESCE(p.visibility, 'public') != 'direct'${cursorCond}
          ORDER BY p.published_at DESC, p.id DESC
          LIMIT ?
        `).all(postId, ...cursorParams, n) as any[];
      },
      filterRows: (rows) => enrichAndFilterPosts(rows, currentActorUrl, req.user?.id),
      sortKey: 'published_at',
      idKey: 'id',
    });
    if (nextCursor) {
      res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor');
      res.setHeader('X-Next-Cursor', nextCursor);
    }
    res.json(enriched);
  } catch (err: any) {
    console.error('[API Quotes Error]:', err);
    res.status(500).json({ error: '引用の取得に失敗しました。' });
  }
}));

// 自分が付けたリアクションの履歴（設定 → 自分の記録）
router.get('/me/reactions', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const page = parsePageQuery(req, 50);
  if (page.error) return res.status(400).json({ error: page.error });
  const actorUrl = `${config.origin}/users/${user.id}`;
  try {
    // id まで含めて並べる（同じミリ秒のリアクションがあっても順序が決まり、
    // カーソルが行を飛ばしたり繰り返したりしない）
    const cursorCond = page.cursor ? ` AND ${cursorPredicate('r.created_at', 'r.id')}` : '';
    const cursorParams = page.cursor ? [page.cursor.at, page.cursor.at, page.cursor.id] : [];
    const rows = await db.prepare(`
      SELECT
        r.id, r.reaction, r.created_at,
        p.id AS post_id, p.content, p.cw, p.is_local, p.published_at,
        p.author_name, p.author_handle, p.author_url, p.user_id AS post_author_id
      FROM reactions r
      JOIN posts p ON p.id = r.post_id
      WHERE r.user_id = ?${cursorCond}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ?
    `).all(actorUrl, ...cursorParams, page.limit + 1);
    const pageRows = applyPageHeaders(res, rows, page.limit, 'created_at', 'id');
    res.json(pageRows.map((r: any) => ({
      id: r.id,
      reaction: r.reaction,
      created_at: r.created_at,
      post: {
        id: r.post_id,
        content: r.content,
        cw: r.cw,
        is_local: r.is_local,
        published_at: r.published_at,
        author_name: r.author_name,
        author_handle: r.author_handle,
        author_url: r.author_url,
        user_id: r.post_author_id,
      },
    })));
  } catch (err: any) {
    console.error('[API My Reactions Error]:', err);
    res.status(500).json({ error: 'リアクション履歴の取得に失敗しました。' });
  }
}));


// 🚩 通報の作成（投稿 / ユーザー）
router.post('/reports', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const reporterActorUrl = `${config.origin}/users/${user.id}`;
  const { targetUserId, targetPostId, category, comment, forward } = req.body;

  if (!targetUserId && !targetPostId) {
    return res.status(400).json({ error: '通報対象（ユーザーまたは投稿）を指定してください。' });
  }

  try {
    let targetActorUrl: string | null = null;
    let targetHandle = '';
    let resolvedUserId: string | null = null;
    let postContent: string | null = null;

    // 投稿への通報: 投稿から投稿者を解決する
    if (targetPostId) {
      const post = await db.prepare('SELECT id, user_id, author_url, author_handle, content, is_local, visibility FROM posts WHERE id = ?').get(String(targetPostId)) as any;
      if (!post) {
        return res.status(404).json({ error: '通報対象の投稿が見つかりません。' });
      }
      // DM は通報の対象にしない（管理画面にも本文を出さない。docs/DM.md）
      if (normalizeVisibility(post.visibility) === 'direct') {
        return res.status(400).json({ error: 'この投稿は通報できません。' });
      }
      targetActorUrl = post.author_url;
      targetHandle = post.author_handle || '';
      resolvedUserId = post.is_local === 1 ? post.user_id : null;
      postContent = post.content;
    }

    // ユーザーへの通報（ローカルID / ハンドル / actor URL）
    if (!targetActorUrl && targetUserId) {
      const identifier = String(targetUserId).trim();
      const localId = identifier.replace(/^@/, '').split('@')[0];
      const localUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(localId) as unknown as UserRow | undefined;
      if (localUser && (identifier.startsWith('@') || !identifier.includes('@'))) {
        targetActorUrl = `${config.origin}/users/${localUser.id}`;
        targetHandle = `@${localUser.id}@${config.domain}`;
        resolvedUserId = localUser.id;
      } else if (identifier.startsWith('http://') || identifier.startsWith('https://')) {
        targetActorUrl = identifier;
        targetHandle = identifier;
      } else if (identifier.includes('@')) {
        targetActorUrl = await resolveWebFinger(identifier);
        targetHandle = identifier;
      }
    }

    if (!targetActorUrl) {
      return res.status(404).json({ error: '通報対象が見つかりません。' });
    }
    if (targetActorUrl === reporterActorUrl) {
      return res.status(400).json({ error: '自分自身は通報できません。' });
    }

    // 同一対象への連続通報を防ぐ（同じ相手・同じ投稿につき1時間に1回まで）
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recent = await db.prepare(
      `SELECT id FROM reports
       WHERE reporter_actor_url = ? AND target_actor_url = ?
         AND IFNULL(target_post_id, '') = IFNULL(?, '')
         AND created_at > ?`,
    ).get(reporterActorUrl, targetActorUrl, targetPostId ? String(targetPostId) : null, cutoff);
    if (recent) {
      return res.status(409).json({ error: '同じ対象への通報は既に受け付けています。' });
    }

    const { report, forwarded } = await createReport({
      reporterActorUrl,
      reporterUserId: user.id,
      reporterHandle: `@${user.id}@${config.domain}`,
      targetActorUrl,
      targetUserId: resolvedUserId,
      targetHandle,
      targetPostId: targetPostId ? String(targetPostId) : null,
      targetPostContent: postContent,
      category,
      comment,
      forward: forward !== false,
    });

    logNewReport(report);
    console.log(`[Report] 🚩 ${reporterActorUrl} -> ${targetActorUrl} (${report.category})`);

    res.status(201).json({
      success: true,
      reportId: report.id,
      forwarded,
      message: '通報を受け付けました。ご協力ありがとうございます。',
    });
  } catch (err: any) {
    console.error('[Report Error]:', err);
    res.status(400).json({ error: err.message || '通報の送信に失敗しました。' });
  }
}));

/**
 * 自分が出した通報の一覧。
 *
 * 通報は送れるのに「その後どうなったか」が利用者から見えなかった（一覧は管理画面にしか無い）。
 * 結果を見せるための読み取り専用の口。対応状況（open / resolved）と、解決時のメモだけを返す。
 */
router.get('/reports/mine', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const reporterActorUrl = `${config.origin}/users/${user.id}`;
  const rows = await db.prepare(`
    SELECT id, target_actor_url, target_handle, target_post_id, target_post_content,
           category, comment, status, resolution_note, created_at, resolved_at
    FROM reports
    WHERE reporter_actor_url = ? OR reporter_user_id = ?
    ORDER BY created_at DESC LIMIT 100
  `).all(reporterActorUrl, user.id) as any[];

  res.json(rows.map((row) => ({
    id: row.id,
    target_handle: row.target_handle || row.target_actor_url,
    target_post_id: row.target_post_id || null,
    target_post_preview: row.target_post_content
      ? String(row.target_post_content).replace(/<[^>]*>/g, '').slice(0, 120)
      : null,
    category: row.category,
    comment: row.comment || '',
    status: row.status,
    resolution_note: row.resolution_note || '',
    created_at: row.created_at,
    resolved_at: row.resolved_at || null,
  })));
}));


export default router;
