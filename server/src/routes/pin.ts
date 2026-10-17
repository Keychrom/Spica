/**
 * 📌 プロフィールピン留め (Pinned Posts) エンドポイント
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
// 📌 プロフィールピン留め (Pinned Posts) エンドポイント
// ==========================================

/** ピン留めを**指定した状態に**する（Misskey 互換の `i/pin` / `i/unpin` から呼ぶ） */
export async function setPinnedPost(
  userId: string,
  targetPostId: string,
  pinned: boolean,
): Promise<{ success: boolean; pinned?: boolean; error?: string; status?: number }> {
  const cleanPostId = targetPostId.trim();
  if (!cleanPostId) {
    return { success: false, status: 400, error: 'postId は必須です。' };
  }
  const post = await db.prepare('SELECT id, user_id, is_local FROM posts WHERE id = ?').get(cleanPostId) as
    | { id: string; user_id: string; is_local: number }
    | undefined;
  if (!post) {
    return { success: false, status: 404, error: '投稿が見つかりません。' };
  }
  if (post.is_local !== 1 || post.user_id !== userId) {
    return { success: false, status: 403, error: '自分の投稿のみプロフィールにピン留めできます。' };
  }

  const existing = await db.prepare('SELECT 1 FROM pinned_posts WHERE user_id = ? AND post_id = ?').get(userId, cleanPostId);
  // SQLite では行が `{ '1': 1 }` で返るので、真偽に直してから比べる
  if (Boolean(existing) === pinned) {
    // 既にその状態（Misskey の i/pin は二重に押されても増やさない）
    return { success: true, pinned };
  }
  if (pinned) {
    const count = (await db.prepare('SELECT COUNT(*) as c FROM pinned_posts WHERE user_id = ?').get(userId) as any).c;
    if (count >= 5) {
      return { success: false, status: 400, error: 'ピン留めできるノートは最大5件までです。' };
    }
    await db.prepare('INSERT INTO pinned_posts (user_id, post_id, created_at) VALUES (?, ?, ?)')
      .run(userId, cleanPostId, new Date().toISOString());
  } else {
    await db.prepare('DELETE FROM pinned_posts WHERE user_id = ? AND post_id = ?').run(userId, cleanPostId);
  }
  return { success: true, pinned };
}

// ピン留めトグルの共通ロジック (最大5件、本人の投稿のみ)
async function togglePinPost(userId: string, targetPostId: string): Promise<{ success: boolean; pinned?: boolean; postId?: string; notFound?: boolean; notAllowed?: boolean; limitReached?: boolean; error?: string }> {
  let cleanPostId = targetPostId.trim();

  // posts テーブルから該当投稿を照合
  let post = await db.prepare('SELECT id, user_id, is_local FROM posts WHERE id = ?').get(cleanPostId) as { id: string; user_id: string; is_local: number } | undefined;
  if (!post && cleanPostId.includes('%')) {
    try {
      const decoded = decodeURIComponent(cleanPostId);
      post = await db.prepare('SELECT id, user_id, is_local FROM posts WHERE id = ?').get(decoded) as { id: string; user_id: string; is_local: number } | undefined;
      if (post) cleanPostId = decoded;
    } catch {}
  }

  if (!post) {
    return { success: false, notFound: true, error: '投稿が見つかりません。' };
  }

  // 自分の投稿のみピン留め可能
  if (post.is_local !== 1 || post.user_id !== userId) {
    return { success: false, notAllowed: true, error: '自分の投稿のみプロフィールにピン留めできます。' };
  }

  const existing = await db.prepare('SELECT 1 FROM pinned_posts WHERE user_id = ? AND post_id = ?').get(userId, cleanPostId);
  if (existing) {
    await db.prepare('DELETE FROM pinned_posts WHERE user_id = ? AND post_id = ?').run(userId, cleanPostId);
    return { success: true, pinned: false, postId: cleanPostId };
  } else {
    // 上限5件チェック
    const count = (await db.prepare('SELECT COUNT(*) as c FROM pinned_posts WHERE user_id = ?').get(userId) as any).c;
    if (count >= 5) {
      return { success: false, limitReached: true, error: 'ピン留めできるノートは最大5件までです。' };
    }
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO pinned_posts (user_id, post_id, created_at) VALUES (?, ?, ?)').run(userId, cleanPostId, now);
    return { success: true, pinned: true, postId: cleanPostId };
  }
}

// 📌 投稿のピン留め追加 / 解除 (トグル - 推奨: Request Body)
router.post('/posts/pin/toggle', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const postId = String(req.body?.postId || req.query?.postId || '').trim();

  if (!postId) {
    return res.status(400).json({ error: 'postId は必須です。' });
  }

  try {
    const result = await togglePinPost(user.id, postId);
    if (result.notFound) {
      return res.status(404).json({ error: result.error });
    }
    if (result.notAllowed) {
      return res.status(403).json({ error: result.error });
    }
    if (result.limitReached) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result);
  } catch (err: any) {
    console.error('[Pin Post Error]:', err);
    res.status(500).json({ error: 'ピン留め処理に失敗しました。' });
  }
}));

// 📌 投稿のピン留め追加 / 解除 (後方互換: パスパラメータ)
router.post('/posts/:id/pin', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const rawPostId = req.params.id as string;
  const postId = decodeURIComponent(rawPostId);

  try {
    const result = await togglePinPost(user.id, postId);
    if (result.notFound) {
      return res.status(404).json({ error: result.error });
    }
    if (result.notAllowed) {
      return res.status(403).json({ error: result.error });
    }
    if (result.limitReached) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result);
  } catch (err: any) {
    console.error('[Pin Post Error]:', err);
    res.status(500).json({ error: 'ピン留め処理に失敗しました。' });
  }
}));


export default router;
