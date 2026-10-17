/**
 * 📋 リスト（ユーザーを束ねた専用タイムライン）
 *
 * api.ts から切り出したルーター。マウント位置（api.ts）は元の登録順と同じ。
 */
import { asyncHandler } from '../asyncHandler.js';
import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { withTransaction } from '../db/asyncDriver.js';
import { db, UserRow, PostRow, FollowRow, RemoteActorRow, ReactionRow, AnnounceRow, isDomainBlocked, matchesBlockedDomainRule, loadBlockedDomainRules, createNotification, NotificationRow, getInstanceInfo, InvitationCodeRow, CustomEmojiRow, AntennaRow, DraftRow, ScheduledPostRow, ChannelRow, WebAuthnCredentialRow, getServerSetting, setServerSetting, NOTIFICATION_TYPES, NOTIFICATION_TYPE_LABELS, getNotificationPrefs, saveNotificationPrefs, getDisabledNotificationTypes } from '../db.js';
import { getEmailNotificationStatus, setEmailNotificationEnabled } from '../emailNotifier.js';
import { getUserPermissions } from '../auth.js';
import { config } from '../config.js';
import { generateKeyPair } from '../crypto.js';
import { assertFetchableRemoteUrl } from '../remoteFetchGuard.js';
import { applyPageHeaders, collectVisiblePage, cursorPredicate, parsePageQuery, type PageCursor } from '../pagination.js';
import { canViewPost, filterVisiblePosts, isPublicPost, normalizeVisibility } from '../postVisibility.js';
import { createReport, logNewReport } from '../reportService.js';
import { getMutedWords, postMatchesMutedWords, invalidateMutedWords } from '../wordFilter.js';
import { extractFirstUrl, getCachedPreviews } from '../linkPreview.js';
import { parseArchive, importNotes, buildSpicaBundle, buildSpicaBundleFromZip, importSpicaArchive, buildImportMessage } from '../importService.js';
import { isZipBuffer, readZipEntries } from '../zipReader.js';
import { parseProfileFields } from '../activitypub.js';
import { isMailConfigured, sendMail, generateVerificationCode, issueVerificationCode, verifyCode, getMailConfig, saveMailConfig, verifyMailConnection } from '../mailService.js';

import { uploadMediaFile } from '../storage.js';
import { checkMediaQuota, deleteMedia, getMediaStats, listMedia, recordMedia, toClientMedia, unlinkMediaFromPost } from '../mediaService.js';
import { executeCreatePost, executeUpdatePost, MAX_POST_ATTACHMENTS } from '../postService.js';
import { isApprovedUser } from '../registration.js';
import { buildOtpauthUri, generateRecoveryCodes, generateTotpSecret, verifyTotpCode } from '../totp.js';
import { consumeRecoveryCode, disableTotp, enableTotp, getTotpState, setPendingTotpSecret } from '../totpService.js';
import {
  createWebAuthnRegistrationOptions,
  verifyWebAuthnRegistration,
  createWebAuthnAuthenticationOptions,
  verifyWebAuthnAuthentication,
  saveChallenge,
} from '../webauthnService.js';
import {
  generateMasterKey,
  hashMasterKey,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  listUserSessions,
  destroySessionById,
  destroyOtherSessions,
  sessionPublicId,
  requireAuth,
  getUserFromToken,
  issueStreamTicket,
  consumeStreamTicket,
} from '../auth.js';
import { deleteUserAccount, beginUserDeletion } from '../accountService.js';
import { getUserPrefs, saveUserPrefs, isDomainMutedByPrefs } from '../userPrefs.js';
import {
  isDmEnabled,
  dmFeatureFlags,
  listDmConversations,
  getDmConversationMessages,
  markDmConversationRead,
  sendDmMessage,
  canViewDmMessage,
} from '../dm.js';
import { exportUserData, streamUserExportZip, buildUserExportFile } from '../exportService.js';
import { enqueueJob, getJob } from '../jobs.js';
import {
  getVapidPublicKey,
  savePushSubscription,
  removePushSubscription,
  isUserSubscribed,
  sendPushToUser,
} from '../pushService.js';
import {
  addStreamClient,
  removeStreamClient,
  broadcastNote,
  broadcastReaction,
  broadcastAnnounce,
  broadcastPoll,
  broadcastDeletePost,
  isStreamAtCapacity,
} from '../streaming.js';
import { parseStreams } from '../streamRouting.js';
import { cacheGet, cacheSet, isTimelineCacheEnabled, invalidateTimelineCache } from '../timelineCache.js';
import {
  buildNote,
  buildCreateActivity,
  buildFollowActivity,
  buildEmojiReactActivity,
  buildLikeActivity,
  buildAnnounceActivity,
  buildUndoActivity,
  buildDeleteActivity,
  buildAcceptActivity,
  buildRejectActivity,
  deliverActivity,
  resolveWebFinger,
  fetchRemoteActor,
  fetchActorAliases,
  buildMoveActivity,
  federatePollUpdate,
  federatePollVote,
} from '../activitypub.js';
import { applyPollCountsFromQuestion, enrichAndFilterPosts, getPollDataForPost } from '../postEnrichment.js';


const router = Router();

// 📋 リスト（ユーザーを束ねた専用タイムライン）
//    アンテナの「ユーザー指定」と同じ考え方で、登録したメンバーの投稿だけを時系列で返す

// 自分のリスト一覧
router.get('/lists', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const lists = await db.prepare('SELECT * FROM lists WHERE user_id = ? ORDER BY created_at DESC').all(user.id) as any[];
  const withMembers = await Promise.all(
    lists.map(async (list) => ({
      ...list,
      members: await db.prepare('SELECT id, member, display_name FROM list_members WHERE list_id = ? ORDER BY created_at ASC').all(list.id),
    })),
  );
  res.json(withMembers);
}));

// リスト作成
export const handleCreateList = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 60) : '';
  if (!name) {
    return res.status(400).json({ error: 'リスト名を入力してください。' });
  }
  const count = (await db.prepare('SELECT COUNT(*) AS c FROM lists WHERE user_id = ?').get(user.id) as { c: number }).c;
  if (count >= 50) {
    return res.status(400).json({ error: '作成できるリストは 50 件までです。' });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO lists (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, user.id, name, now, now);
  console.log(`[List] 📋 @${user.id} がリスト「${name}」を作成`);
  res.status(201).json({ success: true, id, name });
});
router.post('/lists', requireAuth, handleCreateList);

// リスト名の変更
export const handleUpdateList = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const id = String(req.params.id);
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 60) : '';
  if (!name) {
    return res.status(400).json({ error: 'リスト名を入力してください。' });
  }
  const result = await db.prepare('UPDATE lists SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(name, new Date().toISOString(), id, user.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'リストが見つかりません。' });
  }
  res.json({ success: true, id, name });
});
router.put('/lists/:id', requireAuth, handleUpdateList);

// リスト削除
export const handleDeleteList = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const id = String(req.params.id);
  const existing = await db.prepare('SELECT id FROM lists WHERE id = ? AND user_id = ?').get(id, user.id);
  if (!existing) {
    return res.status(404).json({ error: 'リストが見つかりません。' });
  }
  await db.prepare('DELETE FROM list_members WHERE list_id = ?').run(id);
  await db.prepare('DELETE FROM lists WHERE id = ?').run(id);
  res.json({ success: true });
});
router.delete('/lists/:id', requireAuth, handleDeleteList);

// メンバー追加（ローカルID / ハンドル / actor URL を受け付ける）
export const handleAddListMember = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const listId = String(req.params.id);
  const list = await db.prepare('SELECT id FROM lists WHERE id = ? AND user_id = ?').get(listId, user.id);
  if (!list) {
    return res.status(404).json({ error: 'リストが見つかりません。' });
  }

  const raw = typeof req.body?.member === 'string' ? req.body.member.trim() : '';
  if (!raw) {
    return res.status(400).json({ error: '追加するユーザー（@user または @user@domain）を指定してください。' });
  }

  // 表示名の解決（ローカルユーザー → リモートアクター → そのまま）
  const localId = raw.replace(/^@/, '').split('@')[0].toLowerCase();
  const localUser = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(localId) as { id: string; name: string } | undefined;
  const remoteActor = localUser
    ? undefined
    : (await db.prepare('SELECT id, name, username FROM remote_actors WHERE id = ?').get(raw) as
        | { id: string; name: string | null; username: string }
        | undefined);

  const member = localUser ? localUser.id : raw;
  const displayName = localUser?.name || remoteActor?.name || remoteActor?.username || raw;

  const count = (await db.prepare('SELECT COUNT(*) AS c FROM list_members WHERE list_id = ?').get(listId) as { c: number }).c;
  if (count >= 500) {
    return res.status(400).json({ error: '1つのリストに追加できるのは 500 人までです。' });
  }

  try {
    await db.prepare('INSERT INTO list_members (id, list_id, member, display_name, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), listId, member, displayName, new Date().toISOString());
  } catch {
    return res.status(409).json({ error: '既にこのリストに追加されています。' });
  }

  res.status(201).json({ success: true, member, display_name: displayName });
});
router.post('/lists/:id/members', requireAuth, handleAddListMember);

// メンバー削除
export const handleRemoveListMember = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const listId = String(req.params.id);
  const list = await db.prepare('SELECT id FROM lists WHERE id = ? AND user_id = ?').get(listId, user.id);
  if (!list) {
    return res.status(404).json({ error: 'リストが見つかりません。' });
  }
  const result = await db.prepare('DELETE FROM list_members WHERE id = ? AND list_id = ?').run(String(req.params.memberId), listId);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'メンバーが見つかりません。' });
  }
  res.json({ success: true });
});
router.delete('/lists/:id/members/:memberId', requireAuth, handleRemoveListMember);

// リストのタイムライン（メンバーの投稿のみ / 公開範囲とミュートワードを尊重）
export const handleListTimeline = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const listId = String(req.params.id);
  const list = await db.prepare('SELECT * FROM lists WHERE id = ? AND user_id = ?').get(listId, user.id) as any;
  if (!list) {
    return res.status(404).json({ error: 'リストが見つかりません。' });
  }

  const page = parsePageQuery(req, 50);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }

  const members = (await db.prepare('SELECT member FROM list_members WHERE list_id = ?').all(listId) as { member: string }[])
    .map((m) => m.member);

  if (members.length === 0) {
    return res.json({ list: { id: list.id, name: list.name }, posts: [], memberCount: 0 });
  }

  // メンバー条件は OR でまとめ、カーソル条件は AND で絞り込む（優先順位に注意）
  const memberConds: string[] = [];
  const params: any[] = [];
  for (const member of members) {
    memberConds.push('(p.user_id = ? OR p.author_url = ? OR p.author_handle = ? OR p.author_handle LIKE ?)');
    params.push(member, member, member, `%${member.replace(/^@/, '')}%`);
  }
  const conditions: string[] = [`(${memberConds.join(' OR ')})`];
  // DM（visibility = 'direct'）はリストにも出さない
  conditions.push("COALESCE(p.visibility, 'public') != 'direct'");

  const viewerActor = `${config.origin}/users/${user.id}`;
  const listMutedWords = await getMutedWords(user.id);
  const { items: enriched, nextCursor } = await collectVisiblePage({
    limit: page.limit,
    cursor: page.cursor,
    fetchRows: async (cursor, n) => {
      const conditionsRun = [...conditions];
      const paramsRun = [...params];
      if (cursor) {
        conditionsRun.push(cursorPredicate('p.published_at', 'p.id'));
        paramsRun.push(cursor.at, cursor.at, cursor.id);
      }
      paramsRun.push(n);
      return await db.prepare(`
        SELECT
          p.id AS post_id,
          p.*,
          COALESCE(NULLIF(p.author_icon, ''), NULLIF(u.icon_url, ''), NULLIF(ra.icon_url, ''), '') AS author_icon,
          p.published_at AS timeline_at
        FROM posts p
        LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
        LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
        WHERE ${conditionsRun.join(' AND ')}
        ORDER BY p.published_at DESC, p.id DESC
        LIMIT ?
      `).all(...paramsRun) as any[];
    },
    // 閲覧権限（フォロワー限定）とミュートワードで絞ってから、共通の整形（ブロック・ミュートも見る）
    filterRows: async (rows) => {
      const visible = (await filterVisiblePosts(rows, viewerActor))
        .filter((post) => !postMatchesMutedWords(post, listMutedWords));
      return await enrichAndFilterPosts(visible, viewerActor, user.id);
    },
    sortKey: 'timeline_at',
    idKey: 'post_id',
  });
  if (nextCursor) {
    res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor');
    res.setHeader('X-Next-Cursor', nextCursor);
  }

  res.json({ list: { id: list.id, name: list.name }, posts: enriched, memberCount: members.length });
});
router.get('/lists/:id/timeline', requireAuth, handleListTimeline);


export default router;
