/**
 * 🚫 個人単位のミュート / ブロック エンドポイント
 *
 * api.ts から切り出したルーター。マウント位置（api.ts）は元の登録順と同じ。
 */
import { asyncHandler } from '../asyncHandler.js';
import { Router, Request, Response } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../auth.js';
import { invalidateTimelineCache } from '../timelineCache.js';
import { deliverActivity, resolveWebFinger, fetchRemoteActor } from '../activitypub.js';

const router = Router();

// ==========================================
// 🚫 個人単位のミュート / ブロック エンドポイント
// ==========================================

// ユーザーブロック
export const handleBlockUser = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const rawIdentifier = decodeURIComponent(req.params.identifier as string);
  const myActorUrl = `${config.origin}/users/${user.id}`;

  try {
    let cleanId = rawIdentifier.replace(/^@/, '');
    if (cleanId.includes(`@${config.domain}`)) cleanId = cleanId.replace(`@${config.domain}`, '');

    const localUser = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(cleanId) as any;
    let targetUserId = cleanId;
    let targetHandle = `@${cleanId}@${config.domain}`;
    let targetName = localUser?.name || cleanId;
    let isRemote = false;
    let remoteActorInbox: string | null = null;

    if (localUser) {
      if (localUser.id === user.id) {
        return res.status(400).json({ error: '自分自身をブロックすることはできません。' });
      }
      targetUserId = localUser.id;
      targetName = localUser.name;
    } else {
      isRemote = true;
      let targetActorUrl = rawIdentifier;
      if (!targetActorUrl.startsWith('http://') && !targetActorUrl.startsWith('https://')) {
        targetActorUrl = await resolveWebFinger(rawIdentifier);
      }
      targetUserId = targetActorUrl;
      const actor = await fetchRemoteActor(targetActorUrl, false);
      targetHandle = `@${actor.username}@${actor.domain}`;
      targetName = actor.name || actor.username;
      remoteActorInbox = actor.inbox_url;
    }

    const now = new Date().toISOString();
    await db.prepare(`
      INSERT OR REPLACE INTO user_blocks (user_id, target_user_id, target_handle, target_name, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(user.id, targetUserId, targetHandle, targetName, now);

    // 相互フォローの解除
    const targetActorUrl = isRemote ? targetUserId : `${config.origin}/users/${targetUserId}`;
    await db.prepare(`
      DELETE FROM follows
      WHERE (follower_url = ? AND following_url = ?)
         OR (follower_url = ? AND following_url = ?)
    `).run(myActorUrl, targetActorUrl, targetActorUrl, myActorUrl);
    // フォローが外れたので、キャッシュ済みのホームから相手の投稿が消えるようにする
    await invalidateTimelineCache();

    // リモートユーザーの場合、ActivityPub Block Activity を配送
    if (isRemote && remoteActorInbox) {
      try {
        const blockActivity = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${myActorUrl}#blocks/${Date.now()}`,
          type: 'Block',
          actor: myActorUrl,
          object: targetActorUrl,
        };
        deliverActivity({
          inboxUrl: remoteActorInbox,
          activity: blockActivity,
          senderUser: user,
        }).catch((e) => console.warn('[Deliver Block Warning]:', e));
      } catch {}
    }

    res.json({ success: true, is_blocked: true });
  } catch (err: any) {
    console.error('[User Block Error]:', err);
    res.status(500).json({ error: 'ユーザーのブロックに失敗しました。' });
  }
});
router.post('/users/:identifier/block', requireAuth, handleBlockUser);

// ユーザーブロック解除
export const handleUnblockUser = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const rawIdentifier = decodeURIComponent(req.params.identifier as string);
  const myActorUrl = `${config.origin}/users/${user.id}`;

  try {
    let cleanId = rawIdentifier.replace(/^@/, '');
    if (cleanId.includes(`@${config.domain}`)) cleanId = cleanId.replace(`@${config.domain}`, '');

    const localUser = await db.prepare('SELECT id FROM users WHERE id = ?').get(cleanId) as any;
    let targetUserId = cleanId;
    let isRemote = false;
    let remoteActorInbox: string | null = null;

    if (localUser) {
      targetUserId = localUser.id;
    } else {
      isRemote = true;
      let targetActorUrl = rawIdentifier;
      if (!targetActorUrl.startsWith('http://') && !targetActorUrl.startsWith('https://')) {
        try {
          targetActorUrl = await resolveWebFinger(rawIdentifier);
        } catch {
          targetActorUrl = rawIdentifier;
        }
      }
      targetUserId = targetActorUrl;
      try {
        const actor = await fetchRemoteActor(targetActorUrl, false);
        remoteActorInbox = actor.inbox_url;
      } catch {}
    }

    await db.prepare('DELETE FROM user_blocks WHERE user_id = ? AND target_user_id = ?').run(user.id, targetUserId);
    await invalidateTimelineCache();

    // リモートユーザーの場合、Undo(Block) を配送
    if (isRemote && remoteActorInbox) {
      try {
        const undoActivity = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${myActorUrl}#undo-blocks/${Date.now()}`,
          type: 'Undo',
          actor: myActorUrl,
          object: {
            id: `${myActorUrl}#blocks/${Date.now()}`,
            type: 'Block',
            actor: myActorUrl,
            object: targetUserId,
          },
        };
        deliverActivity({
          inboxUrl: remoteActorInbox,
          activity: undoActivity,
          senderUser: user,
        }).catch((e) => console.warn('[Deliver Undo Block Warning]:', e));
      } catch {}
    }

    res.json({ success: true, is_blocked: false });
  } catch (err: any) {
    console.error('[User Unblock Error]:', err);
    res.status(500).json({ error: 'ブロック解除に失敗しました。' });
  }
});
router.post('/users/:identifier/unblock', requireAuth, handleUnblockUser);

// ユーザーミュート
export const handleMuteUser = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const rawIdentifier = decodeURIComponent(req.params.identifier as string);

  try {
    let cleanId = rawIdentifier.replace(/^@/, '');
    if (cleanId.includes(`@${config.domain}`)) cleanId = cleanId.replace(`@${config.domain}`, '');

    const localUser = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(cleanId) as any;
    let targetUserId = cleanId;
    let targetHandle = `@${cleanId}@${config.domain}`;
    let targetName = localUser?.name || cleanId;

    if (localUser) {
      if (localUser.id === user.id) {
        return res.status(400).json({ error: '自分自身をミュートすることはできません。' });
      }
      targetUserId = localUser.id;
      targetName = localUser.name;
    } else {
      let targetActorUrl = rawIdentifier;
      if (!targetActorUrl.startsWith('http://') && !targetActorUrl.startsWith('https://')) {
        targetActorUrl = await resolveWebFinger(rawIdentifier);
      }
      targetUserId = targetActorUrl;
      const actor = await fetchRemoteActor(targetActorUrl, false);
      targetHandle = `@${actor.username}@${actor.domain}`;
      targetName = actor.name || actor.username;
    }

    const now = new Date().toISOString();
    await db.prepare(`
      INSERT OR REPLACE INTO user_mutes (user_id, target_user_id, target_handle, target_name, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(user.id, targetUserId, targetHandle, targetName, now);
    // ミュートした直後は相手の投稿がタイムラインから消えるべきなので、キャッシュを捨てる
    // （unmute / block は捨てていて、mute だけ抜けていた。2026-10-02 に直した）
    await invalidateTimelineCache();

    res.json({ success: true, is_muted: true });
  } catch (err: any) {
    console.error('[User Mute Error]:', err);
    res.status(500).json({ error: 'ユーザーのミュートに失敗しました。' });
  }
});
router.post('/users/:identifier/mute', requireAuth, handleMuteUser);

// ユーザーミュート解除
export const handleUnmuteUser = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const rawIdentifier = decodeURIComponent(req.params.identifier as string);

  try {
    let cleanId = rawIdentifier.replace(/^@/, '');
    if (cleanId.includes(`@${config.domain}`)) cleanId = cleanId.replace(`@${config.domain}`, '');

    let targetUserId = cleanId;
    const localUser = await db.prepare('SELECT id FROM users WHERE id = ?').get(cleanId) as any;
    if (localUser) {
      targetUserId = localUser.id;
    } else {
      let targetActorUrl = rawIdentifier;
      if (!targetActorUrl.startsWith('http://') && !targetActorUrl.startsWith('https://')) {
        try {
          targetActorUrl = await resolveWebFinger(rawIdentifier);
        } catch {
          targetActorUrl = rawIdentifier;
        }
      }
      targetUserId = targetActorUrl;
    }

    await db.prepare('DELETE FROM user_mutes WHERE user_id = ? AND target_user_id = ?').run(user.id, targetUserId);
    await invalidateTimelineCache();

    res.json({ success: true, is_muted: false });
  } catch (err: any) {
    console.error('[User Unmute Error]:', err);
    res.status(500).json({ error: 'ミュート解除に失敗しました。' });
  }
});
router.post('/users/:identifier/unmute', requireAuth, handleUnmuteUser);

// ブロック中ユーザー一覧取得
export const handleListBlocks = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  try {
    const blocks = await db.prepare(`
      SELECT target_user_id as id, target_handle as handle, target_name as name, created_at
      FROM user_blocks
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(user.id);
    res.json(blocks);
  } catch (err: any) {
    console.error('[Get Blocks Error]:', err);
    res.status(500).json({ error: 'ブロック一覧の取得に失敗しました。' });
  }
});
router.get('/user/blocks', requireAuth, handleListBlocks);

// ミュート中ユーザー一覧取得
export const handleListMutes = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  try {
    const mutes = await db.prepare(`
      SELECT target_user_id as id, target_handle as handle, target_name as name, created_at
      FROM user_mutes
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(user.id);
    res.json(mutes);
  } catch (err: any) {
    console.error('[Get Mutes Error]:', err);
    res.status(500).json({ error: 'ミュート一覧の取得に失敗しました。' });
  }
});
router.get('/user/mutes', requireAuth, handleListMutes);


export default router;
