/**
 * 🔐 WebAuthn / パスキー (Passkey) エンドポイント
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
// 🔐 WebAuthn / パスキー (Passkey) エンドポイント
// ==========================================

// パスキー登録オプション生成 (要認証)
router.post('/webauthn/register/options', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.rawUser!;
    const reqOrigin = req.headers.origin as string | undefined;
    const options = await createWebAuthnRegistrationOptions(user, reqOrigin);
    res.json(options);
  } catch (e: any) {
    console.error('[WebAuthn] register/options error:', e);
    // 許可されていないオリジンからの操作は 403（サーバーの不具合ではない）
    res.status(Number(e?.statusCode) || 500).json({ error: e.message || 'パスキー登録オプションの生成に失敗しました。' });
  }
});

// パスキー登録レスポンス検証 (要認証)
router.post('/webauthn/register/verify', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.rawUser!;
    const { device_name } = req.body;
    const reqOrigin = req.headers.origin as string | undefined;
    const result = await verifyWebAuthnRegistration(user, req.body, device_name || '', reqOrigin);
    res.json({ success: true, credential: result });
  } catch (e: any) {
    console.error('[WebAuthn] register/verify error:', e);
    res.status(Number(e?.statusCode) || 400).json({ error: e.message || 'パスキー登録の検証に失敗しました。' });
  }
});

// パスキーログイン用 認証オプション生成 (認証不要)
router.post('/webauthn/authenticate/options', async (req: Request, res: Response) => {
  try {
    const { user_id } = req.body;
    const reqOrigin = req.headers.origin as string | undefined;
    const options = await createWebAuthnAuthenticationOptions(user_id || undefined, reqOrigin);
    // 🔐 2段階認証が有効なアカウントなら、生体認証の前にコードを求める。
    //    user_id が分かる時だけ分かる情報なので、分からなければ verify 側で判定する
    let totp_required = false;
    if (user_id) {
      const row = (await db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(String(user_id))) as
        | { totp_enabled?: number }
        | undefined;
      totp_required = Number(row?.totp_enabled) === 1;
    }
    res.json({ ...options, totp_required });
  } catch (e: any) {
    console.error('[WebAuthn] authenticate/options error:', e);
    res.status(Number(e?.statusCode) || 500).json({ error: e.message || '認証オプションの生成に失敗しました。' });
  }
});

// パスキーログイン用 認証レスポンス検証 & ログイン (認証不要)
router.post('/webauthn/authenticate/verify', async (req: Request, res: Response) => {
  try {
    const reqOrigin = req.headers.origin as string | undefined;
    const result = await verifyWebAuthnAuthentication(req.body, reqOrigin);
    if (result.verified && result.user) {
      // 🔐 2段階認証が有効なアカウントは、パスキー（持っているもの）だけでは通さない。
      //    パスキーは 1 要素として数え、コード（またはリカバリーコード）を必ず求める
      if (Number((result.user as any).totp_enabled) === 1) {
        const totpCode = typeof req.body?.totpCode === 'string' ? req.body.totpCode.trim() : '';
        const okByCode = totpCode ? verifyTotpCode(String((result.user as any).totp_secret || ''), totpCode) : false;
        const okByRecovery = okByCode ? false : (totpCode ? await consumeRecoveryCode(result.user.id, totpCode) : false);
        if (!okByCode && !okByRecovery) {
          // パスキーのやり直し（端末の認証をもう一度）を求めずにコードだけ入れ直せるよう、
          // 一時トークンを渡す。**パスキーの検証が通ったあと**にしか発行しないので、
          // これだけではログインできない（コードが要る）。5 分で失効・1 回だけ使える
          const pendingToken = crypto.randomBytes(32).toString('base64url');
          await saveChallenge(pendingToken, 'totp', result.user.id);
          return res.status(401).json({
            error: totpCode ? 'コードが正しくありません。' : '2段階認証コードを入力してください。',
            totp_required: true,
            pendingToken,
          });
        }
      }
      // ここは以前 await が抜けていて、Promise がそのまま JSON に化けて
      // `token: {}` が返っていた（＝パスキーログインが必ず失敗していた）。2026-10-04 に修正。
      const session = await createSession(result.user.id, req.headers['user-agent']);
      res.json({
        success: true,
        token: session.token,
        user: {
          id: result.user.id,
          name: result.user.name,
          icon_url: result.user.icon_url,
          header_url: result.user.banner_url,
          summary: result.user.summary,
          is_admin: result.user.role === 'admin',
        },
      });
    } else {
      res.status(401).json({ error: 'パスキー認証に失敗しました。' });
    }
  } catch (e: any) {
    console.error('[WebAuthn] authenticate/verify error:', e);
    res.status(Number(e?.statusCode) || 401).json({ error: e.message || 'パスキー認証に失敗しました。' });
  }
});

/**
 * パスキーのあとの 2段階認証コード（認証不要）
 *
 * `/webauthn/authenticate/verify` が `totp_required` と一緒に返した `pendingToken` を使う。
 * パスキーをもう一度やり直さずにコードだけ送れるようにするための経路
 * （以前はチャレンジを消費したあとに 401 を返していたため、コードを入れ直しても
 *  「チャレンジが無効」で必ず失敗していた。2026-10-16 に修正）。
 */
router.post('/webauthn/authenticate/totp', async (req: Request, res: Response) => {
  try {
    const pendingToken = typeof req.body?.pendingToken === 'string' ? req.body.pendingToken.trim() : '';
    const totpCode = typeof req.body?.totpCode === 'string' ? req.body.totpCode.trim() : '';
    if (!pendingToken || !totpCode) {
      return res.status(400).json({ error: '一時トークンとコードが必要です。', totp_required: true });
    }

    // トークンは「利用者に紐づく一時的なもの」。コードが違うだけなら**消費せずに**返す
    // （コードの打ち間違いでパスキーをやり直さなくて済むように）
    const row = (await db.prepare('SELECT user_id, expires_at FROM webauthn_challenges WHERE challenge = ? AND type = ?')
      .get(pendingToken, 'totp')) as { user_id: string | null; expires_at: number } | undefined;
    if (!row || !row.user_id || row.expires_at < Date.now()) {
      return res.status(401).json({ error: '認証の続きができません。もう一度パスキーからやり直してください。', totp_required: true });
    }

    const user = (await db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id)) as UserRow | undefined;
    if (!user || user.is_frozen === 1 || Number((user as any).totp_enabled) !== 1) {
      return res.status(401).json({ error: 'このアカウントでは続けられません。', totp_required: true });
    }

    const okByCode = verifyTotpCode(String((user as any).totp_secret || ''), totpCode);
    const okByRecovery = okByCode ? false : await consumeRecoveryCode(user.id, totpCode);
    if (!okByCode && !okByRecovery) {
      return res.status(401).json({ error: 'コードが正しくありません。', totp_required: true });
    }

    // 使い終わったトークンは消す（1 回だけ）
    await db.prepare('DELETE FROM webauthn_challenges WHERE challenge = ? AND type = ?').run(pendingToken, 'totp');

    const session = await createSession(user.id, req.headers['user-agent']);
    res.json({
      success: true,
      token: session.token,
      user: {
        id: user.id,
        name: user.name,
        icon_url: user.icon_url,
        header_url: user.banner_url,
        summary: user.summary,
        is_admin: user.role === 'admin',
      },
    });
  } catch (e: any) {
    console.error('[WebAuthn] authenticate/totp error:', e);
    res.status(Number(e?.statusCode) || 401).json({ error: e.message || '2段階認証に失敗しました。' });
  }
});

// 登録済みパスキー一覧取得 (要認証)
router.get('/webauthn/credentials', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const rows = await db.prepare(`
    SELECT id, device_name, counter, created_at, last_used_at
    FROM webauthn_credentials
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(user.id) as unknown as WebAuthnCredentialRow[];
  res.json(rows);
}));

// パスキー削除 (要認証)
router.delete('/webauthn/credentials/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const credId = String(req.params.id);
  const resDel = await db.prepare(`
    DELETE FROM webauthn_credentials
    WHERE id = ? AND user_id = ?
  `).run(credId, user.id);

  if (resDel.changes === 0) {
    return res.status(404).json({ error: '指定されたパスキーが見つかりません。' });
  }
  res.json({ success: true, message: 'パスキーを削除しました。' });
}));


export default router;
