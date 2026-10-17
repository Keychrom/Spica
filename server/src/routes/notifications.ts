/**
 * 通知 (Notifications) エンドポイント
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
// 通知 (Notifications) エンドポイント
// ==========================================

// 通知一覧の取得 (最新順、ブロック・ミュート除外)
router.get('/notifications', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const page = parsePageQuery(req, 50);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }
  const filter = req.query.filter as string | undefined;

  let filterClause = '';
  const params: any[] = [user.id];

  if (filter === 'reply') {
    filterClause = ` AND type = 'reply'`;
  } else if (filter === 'mention') {
    filterClause = ` AND type = 'mention'`;
  } else if (filter === 'reaction') {
    filterClause = ` AND type IN ('reaction', 'announce', 'renote')`;
  } else if (filter === 'follow') {
    filterClause = ` AND type = 'follow'`;
  }

  // 種類別設定で無効にした通知は一覧にも出さない（過去に生成済みのものも隠す）
  const disabled = await getDisabledNotificationTypes(user.id);
  if (disabled.length > 0) {
    filterClause += ` AND type NOT IN (${disabled.map(() => '?').join(', ')})`;
    params.push(...disabled);
  }

  // 続きの読み込み（カーソル）：ORDER BY と同じ組で比較する
  const cursorClause = page.cursor ? ` AND ${cursorPredicate('created_at', 'id')}` : '';
  if (page.cursor) {
    params.push(page.cursor.at, page.cursor.at, page.cursor.id);
  }
  params.push(page.limit + 1);

  try {
    const notifications = await db.prepare(`
      SELECT * FROM notifications
      WHERE user_id = ? ${filterClause}${cursorClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params) as unknown as NotificationRow[];

    // 続きがある場合のみ X-Next-Cursor を設定（ブロック等で除外する前の行から生成する）
    const pageRows = applyPageHeaders(res, notifications, page.limit, 'created_at', 'id');

    // ブロックまたはミュートしているユーザーを除外
    const blockedRows = await db.prepare('SELECT target_user_id FROM user_blocks WHERE user_id = ?').all(user.id) as { target_user_id: string }[];
    const mutedRows = await db.prepare('SELECT target_user_id FROM user_mutes WHERE user_id = ?').all(user.id) as { target_user_id: string }[];
    const excludeIds = new Set<string>();
    for (const r of blockedRows) if (r.target_user_id) excludeIds.add(r.target_user_id.toLowerCase());
    for (const r of mutedRows) if (r.target_user_id) excludeIds.add(r.target_user_id.toLowerCase());
    const blockedDomainRules = await loadBlockedDomainRules();

    // ミュートワードは通知の本文にも効かせる（タイムラインと同じ判定を使う）
    const notifMutedWords = await getMutedWords(user.id);
    const filtered = pageRows.filter((n) => {
      if (n.actor_id && excludeIds.has(n.actor_id.toLowerCase())) return false;
      if (n.actor_handle && excludeIds.has(n.actor_handle.toLowerCase())) return false;
      // サイレンス / ブロックしたサーバーからの通知は一覧に出さない
      if (matchesBlockedDomainRule(blockedDomainRules, n.actor_id)) return false;
      if (matchesBlockedDomainRule(blockedDomainRules, n.actor_handle)) return false;
      if (matchesBlockedDomainRule(blockedDomainRules, (n as any).origin_url)) return false;
      if (notifMutedWords.length > 0) {
        const text = `${n.post_content || ''} ${n.content || ''}`;
        if (postMatchesMutedWords({ content: text, cw: '' } as any, notifMutedWords)) return false;
      }
      return true;
    });

    res.json(filtered);
  } catch (err: any) {
    console.error('[API Notification Error]:', err);
    res.status(500).json({ error: err.message });
  }
}));

// 表示と投稿の好み（ユーザーごと・サーバー保存。端末をまたいで同じ見た目になる）
// 検証と既定値は userPrefs.ts が唯一の正。ここは入出力だけ。
router.get('/me/prefs', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  res.json({ prefs: await getUserPrefs(user.id) });
}));

router.put('/me/prefs', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const source = body.prefs && typeof body.prefs === 'object' ? body.prefs : body;
  const prefs = await saveUserPrefs(user.id, source);
  // ホームでブースト/返信を隠す・ドメインミュートはサーバー側の組み立てに効くので、
  // 読取りキャッシュを捨てる（次の取得から新しい設定で組み立てる）
  await invalidateTimelineCache();
  console.log(`[Prefs] ⚙️ @${user.id} が表示・投稿設定を更新しました`);
  res.json({ success: true, prefs });
}));

// 通知の種類別設定（フォロー・返信・メンション・リアクション・リノート・アンテナ・引っ越し）
router.get('/notifications/settings', requireAuth, async (req: Request, res: Response) => {
  const user = req.rawUser!;
  try {
    res.json({
      prefs: await getNotificationPrefs(user.id),
      types: NOTIFICATION_TYPES.map((type) => ({ type, label: NOTIFICATION_TYPE_LABELS[type] ?? type })),
      // メール通知（SMTP 設定時のみ利用可能。オプトイン）
      email: await getEmailNotificationStatus(user.id),
    });
  } catch (err: any) {
    console.error('[API Notification Settings Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/notifications/settings', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const source = body.prefs && typeof body.prefs === 'object' ? body.prefs : body;
    const prefs = await saveNotificationPrefs(user.id, source as Record<string, unknown>);
    console.log(`[Notification] ⚙️ @${user.id} が通知設定を更新: ${JSON.stringify(prefs)}`);
    res.json({ success: true, prefs });
  } catch (err: any) {
    console.error('[API Notification Settings Save Error]:', err);
    res.status(500).json({ error: err.message || '通知設定の保存に失敗しました。' });
  }
}));

// メール通知の ON/OFF（SMTP 未設定なら 400）
router.post('/notifications/email', requireAuth, async (req: Request, res: Response) => {
  const user = req.rawUser!;
  try {
    const enabled = req.body?.enabled === true;
    const status = await getEmailNotificationStatus(user.id);
    if (!status.available) {
      return res.status(400).json({ error: 'このサーバーではメール通知が利用できません（SMTP 未設定）。' });
    }
    if (enabled && !status.email) {
      return res.status(400).json({ error: 'メールアドレスを設定してから有効にしてください。' });
    }
    if (enabled && !status.verified) {
      return res.status(400).json({ error: 'メールアドレスの確認が済んでいません。設定 → メールアドレスから確認してください。' });
    }
    await setEmailNotificationEnabled(user.id, enabled);
    console.log(`[Notification] ✉️ @${user.id} のメール通知: ${enabled ? 'ON' : 'OFF'}`);
    res.json({ success: true, email: await getEmailNotificationStatus(user.id) });
  } catch (err: any) {
    console.error('[API Notification Email Error]:', err);
    res.status(500).json({ error: err.message || 'メール通知の設定に失敗しました。' });
  }
});

// 未読通知数の取得 (軽量)
router.get('/notifications/unread-count', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  try {
    const disabled = await getDisabledNotificationTypes(user.id);
    const exclude = disabled.length > 0 ? ` AND type NOT IN (${disabled.map(() => '?').join(', ')})` : '';
    const row = await db.prepare(`
      SELECT COUNT(*) as c FROM notifications
      WHERE user_id = ? AND is_read = 0${exclude}
    `).get(user.id, ...disabled) as { c: number } | undefined;

    res.json({ unreadCount: row ? Number(row.c) : 0 });
  } catch (err: any) {
    console.error('[API Unread Count Error]:', err);
    res.status(500).json({ error: err.message });
  }
}));

// すべての通知を既読にする
router.post('/notifications/read-all', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  try {
    await db.prepare(`
      UPDATE notifications
      SET is_read = 1
      WHERE user_id = ? AND is_read = 0
    `).run(user.id);

    res.json({ success: true, message: 'すべての通知を既読にしました。' });
  } catch (err: any) {
    console.error('[API Read All Error]:', err);
    res.status(500).json({ error: err.message });
  }
}));

// 単一の通知を既読にする（Misskey 互換の `i/read-notification` からも呼ぶ）
export const handleReadNotification = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const notificationId = req.params.id as string;

  try {
    await db.prepare(`
      UPDATE notifications
      SET is_read = 1
      WHERE id = ? AND user_id = ?
    `).run(notificationId, user.id);

    res.json({ success: true });
  } catch (err: any) {
    console.error('[API Mark Read Error]:', err);
    res.status(500).json({ error: err.message });
  }
});
router.post('/notifications/:id/read', requireAuth, handleReadNotification);


export default router;
