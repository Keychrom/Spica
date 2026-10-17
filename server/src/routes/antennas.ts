/**
 * 📡 アンテナ (Antenna) エンドポイント
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

// ==========================================
// 📡 アンテナ (Antenna) エンドポイント
// ==========================================

// アンテナ一覧取得
router.get('/antennas', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const rows = await db.prepare('SELECT * FROM antennas WHERE user_id = ? ORDER BY created_at DESC').all(user.id) as unknown as AntennaRow[];
  res.json(rows.map((r) => ({
    ...r,
    case_sensitive: Boolean(r.case_sensitive),
    with_file: Boolean(r.with_file),
    notify: Boolean(r.notify),
  })));
}));

// アンテナ作成
export const handleCreateAntenna = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const { name, src, user_list, keywords, exclude_keywords, case_sensitive, with_file, notify } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'アンテナ名は必須です。' });
  }

  const id = crypto.randomUUID();
  const validSrc = ['all', 'home', 'users'].includes(src) ? src : 'all';
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO antennas (id, user_id, name, src, user_list, keywords, exclude_keywords, case_sensitive, with_file, notify, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    user.id,
    name.trim(),
    validSrc,
    typeof user_list === 'string' ? user_list.trim() : '',
    typeof keywords === 'string' ? keywords.trim() : '',
    typeof exclude_keywords === 'string' ? exclude_keywords.trim() : '',
    case_sensitive ? 1 : 0,
    with_file ? 1 : 0,
    notify ? 1 : 0,
    now
  );

  res.status(201).json({
    id,
    user_id: user.id,
    name: name.trim(),
    src: validSrc,
    user_list: typeof user_list === 'string' ? user_list.trim() : '',
    keywords: typeof keywords === 'string' ? keywords.trim() : '',
    exclude_keywords: typeof exclude_keywords === 'string' ? exclude_keywords.trim() : '',
    case_sensitive: Boolean(case_sensitive),
    with_file: Boolean(with_file),
    notify: Boolean(notify),
    created_at: now,
  });
});
router.post('/antennas', requireAuth, handleCreateAntenna);

// アンテナ詳細取得
export const handleShowAntenna = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const antId = String(req.params.id);
  const ant = await db.prepare('SELECT * FROM antennas WHERE id = ? AND user_id = ?').get(antId, user.id) as unknown as AntennaRow | undefined;
  if (!ant) {
    return res.status(404).json({ error: 'アンテナが見つかりません。' });
  }
  res.json({
    ...ant,
    case_sensitive: Boolean(ant.case_sensitive),
    with_file: Boolean(ant.with_file),
    notify: Boolean(ant.notify),
  });
});
router.get('/antennas/:id', requireAuth, handleShowAntenna);

// アンテナ更新
export const handleUpdateAntenna = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const antId = String(req.params.id);
  const { name, src, user_list, keywords, exclude_keywords, case_sensitive, with_file, notify } = req.body;

  const ant = await db.prepare('SELECT * FROM antennas WHERE id = ? AND user_id = ?').get(antId, user.id) as unknown as AntennaRow | undefined;
  if (!ant) {
    return res.status(404).json({ error: 'アンテナが見つかりません。' });
  }

  const newName = name !== undefined ? String(name).trim() : ant.name;
  const newSrc = ['all', 'home', 'users'].includes(src) ? src : ant.src;
  const newUserList = user_list !== undefined ? String(user_list).trim() : ant.user_list;
  const newKeywords = keywords !== undefined ? String(keywords).trim() : ant.keywords;
  const newExclude = exclude_keywords !== undefined ? String(exclude_keywords).trim() : ant.exclude_keywords;
  const newCase = case_sensitive !== undefined ? (case_sensitive ? 1 : 0) : ant.case_sensitive;
  const newWithFile = with_file !== undefined ? (with_file ? 1 : 0) : ant.with_file;
  const newNotify = notify !== undefined ? (notify ? 1 : 0) : ant.notify;

  await db.prepare(`
    UPDATE antennas 
    SET name = ?, src = ?, user_list = ?, keywords = ?, exclude_keywords = ?, case_sensitive = ?, with_file = ?, notify = ?
    WHERE id = ? AND user_id = ?
  `).run(newName, newSrc, newUserList, newKeywords, newExclude, newCase, newWithFile, newNotify, ant.id, user.id);

  res.json({
    id: ant.id,
    user_id: user.id,
    name: newName,
    src: newSrc,
    user_list: newUserList,
    keywords: newKeywords,
    exclude_keywords: newExclude,
    case_sensitive: Boolean(newCase),
    with_file: Boolean(newWithFile),
    notify: Boolean(newNotify),
    created_at: ant.created_at,
  });
});
router.put('/antennas/:id', requireAuth, handleUpdateAntenna);

// アンテナ削除
export const handleDeleteAntenna = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const antId = String(req.params.id);
  const resDel = await db.prepare('DELETE FROM antennas WHERE id = ? AND user_id = ?').run(antId, user.id);
  if (resDel.changes === 0) {
    return res.status(404).json({ error: 'アンテナが見つかりません。' });
  }
  res.json({ success: true });
});
router.delete('/antennas/:id', requireAuth, handleDeleteAntenna);

// アンテナタイムライン取得
export const handleAntennaTimeline = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const antId = String(req.params.id);
  const ant = await db.prepare('SELECT * FROM antennas WHERE id = ? AND user_id = ?').get(antId, user.id) as unknown as AntennaRow | undefined;
  if (!ant) {
    return res.status(404).json({ error: 'アンテナが見つかりません。' });
  }

  const page = parsePageQuery(req, 30);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }
  const conditions: string[] = ['1=1'];
  const params: any[] = [];

  // ソースフィルタ
  if (ant.src === 'home') {
    const myActorUrl = `${config.origin}/users/${user.id}`;
    conditions.push(`(p.is_local = 1 OR p.author_url IN (SELECT following_url FROM follows WHERE follower_url = ?))`);
    params.push(myActorUrl);
  } else if (ant.src === 'users') {
    const userTokens = ant.user_list.split(',').map((u) => u.trim().replace(/^@/, '')).filter(Boolean);
    if (userTokens.length > 0) {
      const userConds = userTokens.map(() => `(p.user_id = ? OR p.author_handle LIKE ?)`).join(' OR ');
      conditions.push(`(${userConds})`);
      for (const token of userTokens) {
        params.push(token, `%${token}%`);
      }
    }
  }

  // メディア有無フィルタ
  if (ant.with_file === 1) {
    conditions.push(`(p.media_attachments IS NOT NULL AND p.media_attachments != '[]' AND p.media_attachments != '')`);
  }

  // キーワードフィルタ (ORマッチ)
  const kwList = ant.keywords.split(/[,、\n\s]+/).map((k) => k.trim()).filter(Boolean);
  if (kwList.length > 0) {
    const kwConds = kwList.map(() => `(p.content LIKE ? OR (p.cw IS NOT NULL AND p.cw LIKE ?))`).join(' OR ');
    conditions.push(`(${kwConds})`);
    for (const kw of kwList) {
      params.push(`%${kw}%`, `%${kw}%`);
    }
  }

  // 除外キーワードフィルタ (AND NOT)
  const exList = ant.exclude_keywords.split(/[,、\n\s]+/).map((k) => k.trim()).filter(Boolean);
  for (const ex of exList) {
    conditions.push(`(p.content NOT LIKE ? AND (p.cw IS NULL OR p.cw NOT LIKE ?))`);
    params.push(`%${ex}%`, `%${ex}%`);
  }

  // DM（visibility = 'direct'）はアンテナのタイムラインにも出さない
  conditions.push("COALESCE(p.visibility, 'public') != 'direct'");

  // 走査の上限（タグ・検索と同じ）。アンテナはキーワードやユーザー名の LIKE で絞るので、
  // 条件が緩いと全件走査になる。**直近 N 件**に限れば DB が育ってもコストが一定
  // （`RECENT_SCAN_POSTS`・既定 2 万。0 で無制限）
  if (config.recentScanPosts > 0) {
    conditions.push(`p.published_at >= (
      SELECT COALESCE(MIN(published_at), '') FROM (SELECT published_at FROM posts ORDER BY published_at DESC LIMIT ?)
    )`);
    params.push(config.recentScanPosts);
  }

  const viewerActor = `${config.origin}/users/${user.id}`;
  const { items: decorated, nextCursor } = await collectVisiblePage({
    limit: page.limit,
    cursor: page.cursor,
    fetchRows: async (cursor, n) => {
      const conditionsRun = [...conditions];
      const paramsRun = [...params];
      // 続きの読み込み（カーソル）：ORDER BY と同じ組で比較する
      if (cursor) {
        conditionsRun.push(cursorPredicate('p.published_at', 'p.id'));
        paramsRun.push(cursor.at, cursor.at, cursor.id);
      }
      paramsRun.push(n);
      return await db.prepare(`
        SELECT 
          p.id,
          p.id AS feed_id,
          p.user_id,
          p.author_name,
          p.author_url,
          p.author_handle,
          p.content,
          p.cw,
          p.is_local,
          p.visibility,
          p.emojis,
          p.in_reply_to,
          p.quote_id,
          p.is_sensitive,
          p.media_attachments,
          p.published_at,
          p.edited_at,
          p.published_at AS timeline_at,
          COALESCE(
            NULLIF(p.author_icon, ''),
            NULLIF(u.icon_url, ''),
            NULLIF(ra.icon_url, ''),
            ''
          ) AS author_icon
        FROM posts p
        LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
        LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
        WHERE ${conditionsRun.join(' AND ')}
        ORDER BY p.published_at DESC, p.id DESC
        LIMIT ?
      `).all(...paramsRun) as any[];
    },
    // 他のタイムラインと同じ整形（enrichAndFilterPosts）に任せる。
    // 以前はここだけ**投稿 1 件ごとに 7〜9 本のクエリ**を撃っていた（limit 100 で最大 900 本）。
    // 整形には閲覧権限（フォロワー限定）・ミュートワード・ブロック/ミュートの除外も入っている。
    filterRows: (rows) => enrichAndFilterPosts(rows, viewerActor, user.id),
    sortKey: 'timeline_at',
    idKey: 'id',
  });
  if (nextCursor) {
    res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor');
    res.setHeader('X-Next-Cursor', nextCursor);
  }

  res.json({
    antenna: {
      id: ant.id,
      name: ant.name,
    },
    posts: decorated,
  });
});
router.get('/antennas/:id/timeline', requireAuth, handleAntennaTimeline);


export default router;
