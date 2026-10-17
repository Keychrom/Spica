/**
 * 📝 下書き (Drafts) エンドポイント
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
// 📝 下書き (Drafts) エンドポイント
// ==========================================

// 下書き一覧取得
router.get('/drafts', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const rows = await db.prepare('SELECT * FROM drafts WHERE user_id = ? ORDER BY updated_at DESC').all(user.id) as unknown as DraftRow[];
  res.json(rows.map((r) => ({
    ...r,
    media_attachments: (() => {
      try { return JSON.parse(r.media_attachments || '[]'); } catch { return []; }
    })(),
    poll: (() => {
      try { return r.poll ? JSON.parse(r.poll) : null; } catch { return null; }
    })(),
  })));
}));

// 下書き作成・保存 (IDがあれば更新、無ければ新規)
router.post('/drafts', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const { id: draftId, content, cw, visibility, attachments, poll, in_reply_to, quote_id } = req.body;

  const contentText = typeof content === 'string' ? content : '';
  const cwText = typeof cw === 'string' ? cw : '';
  const vis = normalizeVisibility(visibility);
  const attachmentsJson = JSON.stringify(Array.isArray(attachments) ? attachments : []);
  const pollJson = poll ? JSON.stringify(poll) : '';
  const replyTo = typeof in_reply_to === 'string' ? in_reply_to : '';
  const quote = typeof quote_id === 'string' ? quote_id : '';
  const now = new Date().toISOString();

  if (draftId) {
    const existing = await db.prepare('SELECT id FROM drafts WHERE id = ? AND user_id = ?').get(draftId, user.id);
    if (existing) {
      await db.prepare(`
        UPDATE drafts 
        SET content = ?, cw = ?, visibility = ?, media_attachments = ?, poll = ?, in_reply_to = ?, quote_id = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(contentText, cwText, vis, attachmentsJson, pollJson, replyTo, quote, now, draftId, user.id);

      return res.json({
        id: draftId,
        user_id: user.id,
        content: contentText,
        cw: cwText,
        visibility: vis,
        media_attachments: Array.isArray(attachments) ? attachments : [],
        poll: poll || null,
        in_reply_to: replyTo,
        quote_id: quote,
        updated_at: now,
      });
    }
  }

  const newId = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO drafts (id, user_id, content, cw, visibility, media_attachments, poll, in_reply_to, quote_id, updated_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newId, user.id, contentText, cwText, vis, attachmentsJson, pollJson, replyTo, quote, now, now);

  res.status(201).json({
    id: newId,
    user_id: user.id,
    content: contentText,
    cw: cwText,
    visibility: vis,
    media_attachments: Array.isArray(attachments) ? attachments : [],
    poll: poll || null,
    in_reply_to: replyTo,
    quote_id: quote,
    updated_at: now,
    created_at: now,
  });
}));

// 下書き削除
router.delete('/drafts/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const draftId = String(req.params.id);
  const resDel = await db.prepare('DELETE FROM drafts WHERE id = ? AND user_id = ?').run(draftId, user.id);
  if (resDel.changes === 0) {
    return res.status(404).json({ error: '下書きが見つかりません。' });
  }
  res.json({ success: true });
}));

// ==========================================
// ⏰ 予約投稿 (Scheduled Posts) エンドポイント
// ==========================================

// 待機中の予約投稿一覧取得
router.get('/scheduled-posts', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const rows = await db.prepare(`
    SELECT * FROM scheduled_posts 
    WHERE user_id = ? AND status = 'pending'
    ORDER BY scheduled_at ASC
  `).all(user.id) as unknown as ScheduledPostRow[];

  res.json(rows.map((r) => ({
    ...r,
    media_attachments: (() => {
      try { return JSON.parse(r.media_attachments || '[]'); } catch { return []; }
    })(),
    poll: (() => {
      try { return r.poll ? JSON.parse(r.poll) : null; } catch { return null; }
    })(),
  })));
}));

// 予約投稿の作成
router.post('/scheduled-posts', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const { content, cw, visibility, attachments, poll, in_reply_to, quote_id, scheduled_at } = req.body;

  if (!scheduled_at) {
    return res.status(400).json({ error: '予約日時は必須です。' });
  }

  const scheduledTime = new Date(scheduled_at).getTime();
  if (isNaN(scheduledTime) || scheduledTime <= Date.now() + 1000) {
    return res.status(400).json({ error: '予約日時は現在より未来の時刻を指定してください。' });
  }

  const contentText = typeof content === 'string' ? content.trim() : '';
  const parsedAttachments = Array.isArray(attachments) ? attachments : [];
  // 本文が無くても、添付・引用・アンケート（選択肢 2 つ以上）があれば予約できる
  const pollChoiceCount = poll && Array.isArray(poll.choices)
    ? poll.choices.filter((choice: any) => typeof choice === 'string' && choice.trim()).length
    : 0;
  if (!contentText && parsedAttachments.length === 0 && !quote_id && pollChoiceCount < 2) {
    return res.status(400).json({ error: '投稿内容、画像、引用、またはアンケートを入力してください。' });
  }

  const id = crypto.randomUUID();
  const cwText = typeof cw === 'string' ? cw.trim() : '';
  const vis = normalizeVisibility(visibility);
  const attachmentsJson = JSON.stringify(parsedAttachments);
  const pollJson = poll ? JSON.stringify(poll) : '';
  const replyTo = typeof in_reply_to === 'string' ? in_reply_to.trim() : '';
  const quote = typeof quote_id === 'string' ? quote_id.trim() : '';
  const scheduledIso = new Date(scheduledTime).toISOString();
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO scheduled_posts (id, user_id, content, cw, visibility, media_attachments, poll, in_reply_to, quote_id, scheduled_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, user.id, contentText, cwText, vis, attachmentsJson, pollJson, replyTo, quote, scheduledIso, now);

  res.status(201).json({
    id,
    user_id: user.id,
    content: contentText,
    cw: cwText,
    visibility: vis,
    media_attachments: parsedAttachments,
    poll: poll || null,
    in_reply_to: replyTo,
    quote_id: quote,
    scheduled_at: scheduledIso,
    status: 'pending',
    created_at: now,
  });
}));

// 予約投稿のキャンセル（削除）
router.delete('/scheduled-posts/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const postId = String(req.params.id);
  const resDel = await db.prepare(`
    DELETE FROM scheduled_posts 
    WHERE id = ? AND user_id = ? AND status = 'pending'
  `).run(postId, user.id);

  if (resDel.changes === 0) {
    return res.status(404).json({ error: 'キャンセル可能な予約投稿が見つかりません。' });
  }
  res.json({ success: true, message: '予約投稿をキャンセルしました。' });
}));


export default router;
