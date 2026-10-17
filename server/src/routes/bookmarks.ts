/**
 * 🔖 ブックマーク (Bookmarks) エンドポイント
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
// 🔖 ブックマーク (Bookmarks) エンドポイント
// ==========================================

// ブックマークトグルの共通ロジック
async function toggleBookmarkPost(userId: string, targetPostId: string) {
  let cleanPostId = targetPostId.trim();

  // posts テーブルから該当投稿を照合
  let post = await db.prepare('SELECT id FROM posts WHERE id = ?').get(cleanPostId) as { id: string } | undefined;
  if (!post && cleanPostId.includes('%')) {
    try {
      const decoded = decodeURIComponent(cleanPostId);
      post = await db.prepare('SELECT id FROM posts WHERE id = ?').get(decoded) as { id: string } | undefined;
      if (post) cleanPostId = decoded;
    } catch {}
  }

  if (!post) {
    return { success: false, notFound: true };
  }

  const existing = await db.prepare('SELECT 1 FROM bookmarks WHERE user_id = ? AND post_id = ?').get(userId, cleanPostId);
  if (existing) {
    await db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND post_id = ?').run(userId, cleanPostId);
    return { success: true, bookmarked: false, postId: cleanPostId };
  } else {
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO bookmarks (user_id, post_id, created_at) VALUES (?, ?, ?)').run(userId, cleanPostId, now);
    return { success: true, bookmarked: true, postId: cleanPostId };
  }
}

// 🔖 投稿のブックマーク追加 / 解除 (トグル - 推奨: Request Body)
/** ブックマーク（Misskey の favorite）。Misskey 互換 API からも同じ関数を呼ぶ */
export const handleToggleBookmark = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const postId = String(req.body?.postId || req.query?.postId || '').trim();

  if (!postId) {
    return res.status(400).json({ error: 'postId は必須です。' });
  }

  // 閲覧できない投稿（フォロワー限定など）はブックマークできない
  const bookmarkTarget = await db.prepare('SELECT author_url, visibility FROM posts WHERE id = ?').get(postId) as
    | { author_url: string; visibility: string | null }
    | undefined;
  if (bookmarkTarget && !(await canViewPost(bookmarkTarget, `${config.origin}/users/${user.id}`))) {
    return res.status(403).json({ error: 'この投稿はブックマークできません。' });
  }

  try {
    const result = await toggleBookmarkPost(user.id, postId);
    if (result.notFound) {
      return res.status(404).json({ error: '投稿が見つかりません。' });
    }
    res.json(result);
  } catch (err: any) {
    console.error('[Bookmark Error]:', err);
    res.status(500).json({ error: 'ブックマーク処理に失敗しました。' });
  }
});
router.post('/bookmarks/toggle', requireAuth, handleToggleBookmark);

// 🔖 投稿のブックマーク追加 / 解除 (後方互換: パスパラメータ)
router.post('/posts/:id/bookmark', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const rawPostId = req.params.id as string;
  const postId = decodeURIComponent(rawPostId);

  try {
    const result = await toggleBookmarkPost(user.id, postId);
    if (result.notFound) {
      return res.status(404).json({ error: '投稿が見つかりません。' });
    }
    res.json(result);
  } catch (err: any) {
    console.error('[Bookmark Error]:', err);
    res.status(500).json({ error: 'ブックマーク処理に失敗しました。' });
  }
}));

// ブックマーク一覧取得
export const handleListBookmarks = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const page = parsePageQuery(req, 50);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }
  try {
    const currentActorUrl = `${config.origin}/users/${user.id}`;
    const { items: enriched, nextCursor } = await collectVisiblePage({
      limit: page.limit,
      cursor: page.cursor,
      fetchRows: async (cursor, n) => {
        const cursorCondRun = cursor ? ` AND ${cursorPredicate('b.created_at', 'p.id')}` : '';
        const cursorParamsRun = cursor ? [cursor.at, cursor.at, cursor.id] : [];
        const query = `
          SELECT
            p.*,
            p.id AS post_id,
            COALESCE(NULLIF(p.author_icon, ''), NULLIF(u.icon_url, ''), NULLIF(ra.icon_url, ''), '') AS author_icon,
            b.created_at AS timeline_at
          FROM bookmarks b
          JOIN posts p ON b.post_id = p.id
          LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
          LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
          WHERE b.user_id = ? AND COALESCE(p.visibility, 'public') != 'direct'${cursorCondRun}
          ORDER BY b.created_at DESC, p.id DESC
          LIMIT ?
        `;
        return await db.prepare(query).all(user.id, ...cursorParamsRun, n) as any[];
      },
      filterRows: (rows) => enrichAndFilterPosts(rows, currentActorUrl, user.id),
      sortKey: 'timeline_at',
      idKey: 'post_id',
    });
    if (nextCursor) {
      res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor');
      res.setHeader('X-Next-Cursor', nextCursor);
    }
    res.json(enriched);
  } catch (err: any) {
    console.error('[Get Bookmarks Error]:', err);
    res.status(500).json({ error: 'ブックマーク一覧の取得に失敗しました。' });
  }
});
router.get('/bookmarks', requireAuth, handleListBookmarks);


export default router;
