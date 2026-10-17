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
import notificationsRouter from './notifications.js';
import bookmarksRouter from './bookmarks.js';
import pinRouter from './pin.js';
import blocksRouter from './blocks.js';
import listsRouter from './lists.js';
import antennasRouter from './antennas.js';
import draftsRouter from './drafts.js';
import webauthnRouter from './webauthn.js';
import channelsRouter from './channels.js';

export const apiRouter = Router();

// メディアアップロード用 multer 設定 (メモリバッファ保存)
//  - 画像: 最大 15MB / 動画・音声: MEDIA_MAX_BYTES (既定 50MB)
//  - 種別ごとの上限と件数制限はハンドラ側で判定する
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const MEDIA_MAX_BYTES = (() => {
  const parsed = parseInt(process.env.MEDIA_MAX_BYTES || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50 * 1024 * 1024;
})();
const ALLOWED_MEDIA_PREFIXES = ['image/', 'video/', 'audio/'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MEDIA_MAX_BYTES,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MEDIA_PREFIXES.some((prefix) => file.mimetype.startsWith(prefix))) {
      cb(null, true);
    } else {
      cb(new Error('対応していないファイル形式です。画像（JPEG/PNG/GIF/WebP/SVG）、動画（MP4/WebM/MOV）、音声（MP3/OGG/WAV/M4A）を選択してください。'));
    }
  },
});

// ==========================================
// 認証 (Auth) エンドポイント - マスターキー方式
// ==========================================

// 📧 登録前のメールアドレス確認コード送信（パスワード方式の新規登録で使用）
apiRouter.post('/auth/register/email-code', asyncHandler(async (req: Request, res: Response) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';

  if (!(await isMailConfigured())) {
    return res.status(503).json({ error: 'このサーバーはメール送信が設定されていないため、確認コードを送信できません。' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'メールアドレスの形式が正しくありません。' });
  }

  // 既に使われているメールアドレスには送らない（登録時と同じ 409 で揃える）
  const taken = await db.prepare("SELECT id FROM users WHERE email = ? AND email != ''").get(email) as { id: string } | undefined;
  if (taken) {
    return res.status(409).json({ error: 'このメールアドレスは既に使用されています。' });
  }

  try {
    const code = generateVerificationCode();
    // 登録前はユーザーが存在しないため、メールアドレス単位の擬似IDでコードを管理する
    await issueVerificationCode({ userId: `register:${email}`, email, purpose: 'register', code });

    const sent = await sendMail({
      to: email,
      subject: `【${config.instanceName}】アカウント登録の確認コード`,
      text: [
        `${config.instanceName} (${config.domain}) のアカウント登録の確認です。`,
        '',
        `確認コード: ${code}`,
        '',
        'このコードは10分間有効です。登録画面に入力してください。',
        '心当たりがない場合はこのメールを破棄してください。',
      ].join('\n'),
    });

    if (!sent.ok) {
      return res.status(502).json({ error: `確認メールの送信に失敗しました: ${sent.error}` });
    }

    console.log(`[Register] 📧 登録用の確認コードを送信: ${email}`);
    res.json({ success: true, message: '確認コードを送信しました。メールをご確認ください。' });
  } catch (err: any) {
    console.error('[Register Email Code Error]:', err);
    res.status(500).json({ error: '確認コードの送信に失敗しました。' });
  }
}));

// アカウント新規登録 (マスターキー発行)
apiRouter.post('/auth/register', asyncHandler(async (req: Request, res: Response) => {
  const { id, name, summary, inviteCode, agreedToRules, requestMessage } = req.body;
  if (!id || !name) {
    return res.status(400).json({ error: 'ユーザーID (英数字) と表示名は必須です。' });
  }

  const cleanId = id.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,30}$/.test(cleanId)) {
    return res.status(400).json({ error: 'ユーザーIDは2〜30文字の英数字、ハイフン、アンダースコアのみ使用できます。' });
  }

  const existing = await db.prepare('SELECT id FROM users WHERE id = ?').get(cleanId);
  if (existing) {
    return res.status(409).json({ error: 'このユーザーIDは既に使用されています。' });
  }

  // ユーザー数の確認 (最初のユーザーは自動的に管理者)。
  // ※ 承認制の申請中（pending）は数えない — 最初の「実在する利用者」が管理者になる。
  const userCount = (await db.prepare("SELECT COUNT(*) as c FROM users WHERE approval_status = 'approved'").get() as any).c;
  const role = userCount === 0 ? 'admin' : 'user';

  // 招待コード検証および利用規約・ルール同意検証（最初の管理者以外の登録時）
  let verifiedInviteCode: string | null = null;
  // 承認制（approval）のときだけ pending になる。それ以外は今までどおり即時利用できる
  let approvalStatus: 'approved' | 'pending' = 'approved';
  let approvalNote = '';
  if (userCount > 0) {
    const instanceInfo = getInstanceInfo();

    // 1. 新規登録停止モードの場合
    if (instanceInfo.registration_mode === 'closed') {
      return res.status(403).json({ error: '現在このサーバーは新規アカウント登録を一時停止しています。' });
    }

    // 2. サーバールール・規約同意検証
    if (instanceInfo.require_rules_agreement && !agreedToRules) {
      if (instanceInfo.server_rules.length > 0 || instanceInfo.tos_url || instanceInfo.privacy_policy_url) {
        return res.status(400).json({ error: 'サーバーの利用規約およびルールへの同意が必要です。' });
      }
    }

    // 3. 承認制モード: この時点では利用できず、管理者の承認待ちになる（招待コードは使わない）
    if (instanceInfo.registration_mode === 'approval') {
      approvalStatus = 'pending';
      approvalNote = typeof requestMessage === 'string' ? requestMessage.trim().slice(0, 500) : '';
    }

    // 4. 招待制モード、または招待コードが入力された場合
    const codeStr = typeof inviteCode === 'string' ? inviteCode.trim() : '';
    if (instanceInfo.registration_mode === 'invite') {
      if (!codeStr) {
        return res.status(400).json({ error: 'このサーバーは招待制です。有効な招待コードを入力してください。' });
      }
    }

    if (codeStr) {
      const inv = await db.prepare('SELECT * FROM invitation_codes WHERE code = ?').get(codeStr) as InvitationCodeRow | undefined;
      if (!inv) {
        return res.status(400).json({ error: '入力された招待コードは存在しません。' });
      }
      if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
        return res.status(400).json({ error: 'この招待コードは有効期限が切れています。' });
      }
      if (inv.max_uses > 0 && inv.used_count >= inv.max_uses) {
        return res.status(400).json({ error: 'この招待コードは使用上限回数に達しています。' });
      }
      verifiedInviteCode = inv.code;
    }
  }

  console.log(`[Spica Register] Creating account @${cleanId} (Role: ${role}, Invite: ${verifiedInviteCode || 'none'})...`);

  // 🔐 パスワード方式（auth_mode = password）の場合はメールアドレスとパスワードを必須にする
  let passwordHash = '';
  let registerEmail = '';
  let registerEmailVerified = 0;
  if ((await getAuthMode()) === 'password') {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'このサーバーはメールアドレスでの登録が必要です。メールアドレスの形式をご確認ください。' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'パスワードは8文字以上で入力してください。' });
    }
    const emailTaken = await db.prepare("SELECT id FROM users WHERE email = ? AND email != ''").get(email) as { id: string } | undefined;
    if (emailTaken) {
      return res.status(409).json({ error: 'このメールアドレスは既に使用されています。' });
    }

    // 📧 メール送信が設定されているサーバーでは、確認コードによるメール確認を必須にする。
    //    SMTP 未設定のサーバーではメール関連機能が無効のため、確認なしで登録できる。
    if (await isMailConfigured()) {
      const emailCode = typeof req.body?.emailCode === 'string' ? req.body.emailCode.trim() : '';
      if (!emailCode) {
        return res.status(400).json({ error: 'メールアドレスの確認コードを入力してください（「確認コードを送信」から取得できます）。' });
      }
      const verified = await verifyCode({ userId: `register:${email}`, email, code: emailCode, purpose: 'register' });
      if (!verified.ok) {
        return res.status(400).json({ error: verified.error || '確認コードが正しくありません。' });
      }
      registerEmailVerified = 1;
      console.log(`[Spica Register] ✅ メールアドレスの確認コードを検証しました (${email})`);
    } else {
      console.log(`[Spica Register] ℹ️ メール送信が未設定のため、メール確認はスキップします (${email})`);
    }

    passwordHash = hashPassword(password);
    registerEmail = email;
    console.log(`[Spica Register] パスワード方式で登録します (@${cleanId}, email=${email})`);
  }

  // 1. 暗号学的マスターキーを生成（パスワード方式でも復元用に保持する）
  const masterKey = generateMasterKey();
  const masterKeyHash = hashMasterKey(masterKey);

  // 2. ActivityPub 用 RSA 2048-bit 鍵ペア生成
  const keyPair = generateKeyPair();
  const now = new Date().toISOString();

  // 3. DB にユーザー保存（初期設定ウィザードは未完了 = 0 で作る）
  await db.prepare(`
    INSERT INTO users (id, name, summary, master_key_hash, role, is_frozen, public_key_pem, private_key_pem, created_at, password_hash, email, email_verified, approval_status, approval_note, onboarding_completed)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    cleanId,
    name.trim(),
    summary?.trim() || '',
    masterKeyHash,
    role,
    keyPair.publicKeyPem,
    keyPair.privateKeyPem,
    now,
    passwordHash,
    registerEmail,
    registerEmailVerified,
    approvalStatus,
    approvalNote,
  );

  // 4. 招待コードの使用回数をインクリメント
  if (verifiedInviteCode) {
    try {
      await db.prepare('UPDATE invitation_codes SET used_count = used_count + 1 WHERE code = ?').run(verifiedInviteCode);
    } catch (e) {
      console.error('[Spica Register] Failed to increment invite code usage:', e);
    }
  }

  // 5. 初回セッションを発行（承認制で申請中のときは発行しない = アプリに入れない）
  const session = approvalStatus === 'pending' ? null : await createSession(cleanId, req.headers["user-agent"]);

  const actorUrl = `${config.origin}/users/${cleanId}`;
  const handle = `@${cleanId}@${config.domain}`;

  if (approvalStatus === 'pending') {
    console.log(`[Spica Register] 📝 承認制の申請を受け付けました: ${handle}`);
  } else {
    console.log(`[Spica Register] Account created successfully for ${handle}`);
  }

  // マスターキーは平文で返却（ユーザーに保存してもらうため二度と取得できない）
  res.status(201).json({
    user: {
      id: cleanId,
      name: name.trim(),
      summary: summary?.trim() || '',
      handle,
      actorUrl,
      role,
      createdAt: now,
      // 設定画面の出し分け用（本人にだけ返す。ハッシュ類は返さない）
      email: registerEmail,
      email_verified: registerEmailVerified,
      hasPassword: Boolean(passwordHash),
      permissions: Array.from(await getUserPermissions({ id: cleanId, role })),
      // 初期設定ウィザード（新規登録は未完了で作られる）＋プライバシーの初期値
      onboarding_completed: 0,
      noindex: 0,
      no_ai_training: 0,
      is_locked: 0,
      discoverable: 1,
    },
    masterKey, // ⚠️ ユーザーが安全に保存する秘密鍵
    // 承認制の申請中は「申請を受け付けた」ことを伝える（sessionToken は返らない）
    ...(approvalStatus === 'pending'
      ? {
          pending: true,
          approval_status: 'pending',
          message: 'アカウントの申請を受け付けました。管理者が承認するとログインできます。',
        }
      : {
          sessionToken: session!.token,
          sessionExpiresAt: session!.expiresAt,
        }),
  });
}));

// ログイン (マスターキー / パスワードの両対応)
apiRouter.post('/auth/login', asyncHandler(async (req: Request, res: Response) => {
  const { id, email, masterKey, password } = req.body;

  if (!masterKey && !password) {
    return res.status(400).json({ error: 'マスターキーまたはパスワードを入力してください。' });
  }
  if (!id && !email) {
    return res.status(400).json({ error: 'ユーザーIDまたはメールアドレスを入力してください。' });
  }

  // ユーザーID または メールアドレスで利用者を解決する
  let user: UserRow | undefined;
  if (id) {
    user = await db.prepare('SELECT * FROM users WHERE id = ?').get(String(id).trim().toLowerCase().replace(/^@/, '')) as unknown as UserRow | undefined;
  }
  if (!user && email) {
    user = await db.prepare('SELECT * FROM users WHERE email = ? AND email != ?').get(String(email).trim().toLowerCase(), '') as unknown as UserRow | undefined;
  }

  if (!user) {
    return res.status(401).json({ error: '認証情報が一致しません。' });
  }

  if (user.is_frozen === 1) {
    return res.status(403).json({ error: 'このアカウントは凍結されています。管理者にお問い合わせください。' });
  }

  // 承認制の申請中・却下はログインさせない（申請者にだけ理由が分かるようにする）
  if (user.approval_status === 'pending') {
    return res.status(403).json({ error: 'このアカウントは管理者の承認待ちです。承認されるとログインできます。' });
  }
  if (user.approval_status === 'rejected') {
    const reason = String((user as { approval_reason?: string }).approval_reason || '').trim();
    return res.status(403).json({
      error: reason
        ? `このアカウントの申請は承認されませんでした。理由: ${reason}`
        : 'このアカウントの申請は承認されませんでした。詳しくは管理者にお問い合わせください。',
    });
  }

  // 認証: マスターキー（指定時）→ 一致しなければパスワード（設定時）
  let authenticated = false;
  if (masterKey) {
    authenticated = hashMasterKey(String(masterKey).trim()) === user.master_key_hash;
  }
  if (!authenticated && password) {
    authenticated = verifyPassword(String(password), (user as any).password_hash);
  }

  if (!authenticated) {
    return res.status(401).json({ error: '認証情報が一致しません。' });
  }

  // 🔐 2段階認証（TOTP）。パスワード/マスターキーが合っていても、コードが無ければ入れない。
  //    - コード未指定 → totp_required を返してクライアントに入力させる
  //    - コード or リカバリーコードが一致 → 通す（リカバリーコードは一度使ったら消す）
  if (Number((user as any).totp_enabled) === 1) {
    const totpCode = typeof req.body?.totpCode === 'string' ? req.body.totpCode.trim() : '';
    if (!totpCode) {
      return res.status(401).json({
        error: '2段階認証コードを入力してください。',
        totp_required: true,
      });
    }
    const okByCode = verifyTotpCode(String((user as any).totp_secret || ''), totpCode);
    if (!okByCode) {
      const consumed = await consumeRecoveryCode(user.id, totpCode);
      if (!consumed) {
        return res.status(401).json({
          error: '2段階認証コードが正しくありません。',
          totp_required: true,
        });
      }
    }
  }

  const session = await createSession(user.id, req.headers["user-agent"]);
  const handle = `@${user.id}@${config.domain}`;

  res.json({
    user: {
      id: user.id,
      name: user.name,
      summary: user.summary,
      handle,
      actorUrl: `${config.origin}/users/${user.id}`,
      role: user.role,
      createdAt: user.created_at,
      // 本人にだけ返す自分のメール状態とパスワード設定の有無（ハッシュ類は返さない）
      email: user.email || '',
      email_verified: Number((user as any).email_verified) || 0,
      hasPassword: Boolean((user as any).password_hash),
      permissions: Array.from(await getUserPermissions({ id: user.id, role: user.role })),
      // 初期設定ウィザードの状態とプライバシー（未完了ならクライアントがウィザードを出す）
      onboarding_completed: Number((user as any).onboarding_completed ?? 1),
      noindex: Number((user as any).noindex ?? 0),
      no_ai_training: Number((user as any).no_ai_training ?? 0),
      is_locked: Number((user as any).is_locked ?? 0),
      discoverable: Number((user as any).discoverable ?? 1),
    },
    sessionToken: session.token,
    sessionExpiresAt: session.expiresAt,
  });
}));

// ログアウト
apiRouter.post('/auth/logout', asyncHandler(async (req: Request, res: Response) => {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    await destroySession(token);
  }
  res.json({ success: true });
}));

/** いま使われているセッショントークン（Bearer かクエリの token）を取り出す */
function currentSessionToken(req: Request): string {
  const header = req.headers['authorization'];
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  const queryToken = req.query?.token;
  return typeof queryToken === 'string' ? queryToken : '';
}

// ログイン中の端末（セッション）一覧。トークンそのものは返さず、ハッシュ id で扱う
apiRouter.get('/sessions', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const current = sessionPublicId(currentSessionToken(req));
  const sessions = await listUserSessions(user.id);
  res.json({ sessions: sessions.map((s) => ({ ...s, current: s.id === current })) });
}));

// 指定した端末（自分以外のセッション）からログアウトさせる
apiRouter.delete('/sessions/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const id = String(req.params.id);
  if (currentSessionToken(req) && sessionPublicId(currentSessionToken(req)) === id) {
    return res.status(400).json({ error: '現在の端末は「この端末からログアウト」から行ってください。' });
  }
  const removed = await destroySessionById(user.id, id);
  if (!removed) return res.status(404).json({ error: 'その端末は見つかりませんでした。' });
  res.json({ success: true });
}));

// 現在の端末以外をまとめてログアウト
apiRouter.post('/sessions/revoke-others', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const token = currentSessionToken(req);
  if (!token) return res.status(400).json({ error: 'セッションを特定できませんでした。' });
  const removed = await destroyOtherSessions(user.id, token);
  console.log(`[Sessions] 🔐 @${user.id} が他の端末 ${removed} 件をログアウトさせました`);
  res.json({ success: true, removed });
}));

// ==========================================
// 🔐 2段階認証（TOTP）
//
//   流れ: setup（秘密を発行・保存）→ 認証アプリで読む → enable（コードで確認して有効化）
//         → 以降のログインでコードが必須になる。リカバリーコードは enable 時に一度だけ表示する。
//   無効化・再発行にも現在のコード（またはリカバリーコード）を要求する
//   （端末を放置したまま乗っ取られて解除されないように）
// ==========================================

/** 現在のコード（またはリカバリーコード）が正しいか。無効化・再発行の確認に使う */
async function verifyCurrentTotp(user: any, code: string): Promise<boolean> {
  if (verifyTotpCode(String(user.totp_secret || ''), code)) return true;
  return consumeRecoveryCode(user.id, code);
}

apiRouter.get('/me/totp', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const state = await getTotpState(req.user!.id);
  res.json(state);
}));

// 有効化の準備: 秘密を発行して保存し、認証アプリに読み込ませる情報を返す（まだ有効ではない）
apiRouter.post('/me/totp/setup', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  if (Number((req.rawUser as any)?.totp_enabled) === 1) {
    return res.status(400).json({ error: 'すでに2段階認証は有効です。' });
  }
  const secret = generateTotpSecret();
  await setPendingTotpSecret(user.id, secret);
  const instanceName = getInstanceInfo().name || 'Spica';
  res.json({
    secret,
    otpauth_uri: buildOtpauthUri(secret, `@${user.id}@${config.domain}`, instanceName),
  });
}));

// 有効化の確定: アプリに出ているコードを確認してから有効にする。リカバリーコードはここで一度だけ返す
apiRouter.post('/me/totp/enable', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const raw = req.rawUser as any;
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const secret = String(raw?.totp_secret || '');
  if (!secret) {
    return res.status(400).json({ error: '先に「2段階認証を設定する」から手順を始めてください。' });
  }
  if (!verifyTotpCode(secret, code)) {
    return res.status(400).json({ error: 'コードが正しくありません。認証アプリに出ている6桁を入力してください。' });
  }
  const recoveryCodes = generateRecoveryCodes(10);
  await enableTotp(user.id, recoveryCodes);
  console.log(`[TOTP] 🔐 @${user.id} が2段階認証を有効にしました`);
  res.json({ success: true, recovery_codes: recoveryCodes });
}));

// 無効化: 現在のコード（またはリカバリーコード）が必要
apiRouter.post('/me/totp/disable', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const raw = req.rawUser as any;
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (Number(raw?.totp_enabled) !== 1) {
    return res.status(400).json({ error: '2段階認証は有効ではありません。' });
  }
  if (!(await verifyCurrentTotp({ id: user.id, totp_secret: raw?.totp_secret }, code))) {
    return res.status(401).json({ error: 'コードが正しくありません。' });
  }
  await disableTotp(user.id);
  console.log(`[TOTP] 🔓 @${user.id} が2段階認証を無効にしました`);
  res.json({ success: true });
}));

// リカバリーコードの再発行（古いコードは無効になる）
apiRouter.post('/me/totp/recovery-codes', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const raw = req.rawUser as any;
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (Number(raw?.totp_enabled) !== 1) {
    return res.status(400).json({ error: '2段階認証は有効ではありません。' });
  }
  if (!(await verifyCurrentTotp({ id: user.id, totp_secret: raw?.totp_secret }, code))) {
    return res.status(401).json({ error: 'コードが正しくありません。' });
  }
  const recoveryCodes = generateRecoveryCodes(10);
  await enableTotp(user.id, recoveryCodes);
  console.log(`[TOTP] ♻️ @${user.id} がリカバリーコードを再発行しました`);
  res.json({ success: true, recovery_codes: recoveryCodes });
}));

// 現在のログインユーザー情報
apiRouter.get('/auth/me', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const raw = req.rawUser;
  const myActorUrl = `${config.origin}/users/${user.id}`;
  const followerCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_url = ?').get(myActorUrl) as any).c;
  const followingCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE follower_url = ?').get(myActorUrl) as any).c;
  // 自分の投稿数に DM は数えない（DM はタイムラインに出ない投稿なので別扱い）
  const postCount = (await db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND COALESCE(visibility, 'public') != 'direct'").get(user.id) as any).c;

  res.json({
    ...user,
    handle: `@${user.id}@${config.domain}`,
    actorUrl: myActorUrl,
    followerCount,
    followingCount,
    postCount,
    // 本人にだけ返す自分のメール状態とパスワード設定の有無（ハッシュ類は返さない）
    email: raw?.email || '',
    email_verified: Number(raw?.email_verified) || 0,
    hasPassword: Boolean(raw?.password_hash),
    // 初期設定ウィザードの状態（0 = 未完了。クライアントはこれを見てウィザードを出す）
    onboarding_completed: Number(raw?.onboarding_completed ?? 1),
    // プライバシー設定（プロフィール HTML の robots に反映される）
    noindex: Number(raw?.noindex ?? 0),
    no_ai_training: Number(raw?.no_ai_training ?? 0),
    is_locked: Number(raw?.is_locked ?? 0),
    discoverable: Number(raw?.discoverable ?? 1),
    // 2段階認証（TOTP）が有効か
    totp_enabled: Number(raw?.totp_enabled ?? 0),
    // 権限の一覧（'admin' / 'moderate' など）。画面の出し分けはこの配列で判断する
    permissions: Array.from(await getUserPermissions(user)),
  });
}));

// 初期設定ウィザードの完了（「あとで」で閉じた場合も完了扱い。冪等）
apiRouter.post('/me/onboarding/complete', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  await db.prepare('UPDATE users SET onboarding_completed = 1 WHERE id = ?').run(req.user!.id);
  res.json({ success: true, onboarding_completed: 1 });
}));

// ==========================================
// 📡 リアルタイムストリーミング (SSE) エンドポイント
//    ?streams=local,home,tag:foo で「受け取りたいもの」を申告する（省略時は全部＝従来どおり）
// ==========================================
apiRouter.get('/streaming', asyncHandler(async (req: Request, res: Response) => {
  let user = req.user;
  if (!user && req.query.token && typeof req.query.token === 'string') {
    // 旧経路（互換のため残す）。アプリ本体は下のチケットを使う
    user = await getUserFromToken(req.query.token) || undefined;
  }
  if (!user && req.query.ticket && typeof req.query.ticket === 'string') {
    // ワンタイムチケット（60 秒・1 回だけ）。チケットを付けて無効なら、黙って
    // 未認証にせず断る（アプリは取り直して張り直す）
    user = await consumeStreamTicket(req.query.ticket) || undefined;
    if (!user) {
      res.status(401).json({ error: 'ストリーミングのチケットが無効です。' });
      return;
    }
  }
  // 常時接続の上限。溢れたら待たせずに断る（クライアントは少し待って張り直す）
  if (isStreamAtCapacity()) {
    res.setHeader('Retry-After', '30');
    res.status(503).json({ error: 'リアルタイム接続が混み合っています。しばらく待ってから再接続してください。' });
    return;
  }
  const clientId = addStreamClient(res, user?.id, parseStreams(req.query.streams));
  req.on('close', () => {
    removeStreamClient(clientId);
  });
}));

/**
 * ストリーミング接続用のワンタイムチケットを発行する
 * （EventSource はヘッダを付けられないため、トークンをクエリに載せないための経路）
 */
apiRouter.post('/streaming/ticket', asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'ログインが必要です。' });
    return;
  }
  const ticket = await issueStreamTicket(req.user.id);
  res.json({ ticket, expiresIn: 60 });
}));


// タイムライン取得（ローカル / ホーム / 連合 / タグ別）- リノート（RT）・リアクション・返信集計付き
export const handleTimeline = asyncHandler(async (req: Request, res: Response) => {
  const mode = req.query.mode as string; // 'local', 'home', 'all', 'tag'
  const tag = (req.query.tag as string || '').trim().replace(/^#/, '');
  const page = parsePageQuery(req, 50);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }

  // 条件は配列に溜めて AND で連結する（OR を含む条件を括弧で囲い、
  // カーソル条件と混ざっても優先順位が壊れないようにする）
  const postConds: string[] = [];
  const announceConds: string[] = [];
  const params: any[] = [];
  const announceParams: any[] = [];

  // DM（visibility = 'direct'）はどのタイムラインにも出さない（存在自体を見せない。docs/DM.md）
  postConds.push("COALESCE(p.visibility, 'public') != 'direct'");
  announceConds.push("COALESCE(p.visibility, 'public') != 'direct'");

  // ホームの「フォロー中」判定は follows を JOIN して行う。
  // `author_url IN (SELECT following_url FROM follows ...)` と書くと、PostgreSQL は
  // published_at の索引で「21 件そろった時点で止まる」ことができず、候補（数千〜10 万件）を
  // 全部読んでから並べ替える。JOIN にすると両エンジンとも索引の逆順走査で止まれる
  // （実測: 596ms → 0.1ms / PostgreSQL 265ms → 0.7ms）。
  let postFollowJoin = '';
  let announceFollowJoin = '';
  let followParam: string | null = null;
  // ホームでブーストを隠す設定のときは、ブースト側の枝ごと落とす（行を読まない）
  let hideAnnounces = false;

  // 投稿側の FROM 句。タグのときだけ FTS を噛ませる（下の tag 分岐を参照）
  let postFrom = 'posts p';
  const recentScanPosts = mode === 'tag' ? config.recentScanPosts : 0;

  if (mode === 'tag' && tag) {
    // タグは「本文に #tag を含む投稿を新しい順に」。`content LIKE '%#tag%'` だけだと
    // **毎回 全件走査**になり、32 万投稿で 300ms 超（SQLite は同期ドライバなので、
    // ハッシュタグを 1 回クリックされるだけでプロセスが止まる）。
    //
    // FTS（trigram）で候補を絞る手もあるが、**FTS の索引範囲は `fts_index_scope`（既定は
    // ローカル投稿のみ）**なので、リモート投稿のタグが出なくなる。タグは「いま何が話題か」を
    // 見る機能なので、**直近 N 件（`RECENT_SCAN_POSTS`・既定 2 万）に限って走査**し、
    // リモート投稿も今までどおり拾う（N 件の索引走査なので DB が育ってもコストは一定）。
    if (recentScanPosts > 0) {
      postConds.push(`p.published_at >= (
        SELECT COALESCE(MIN(published_at), '') FROM (SELECT published_at FROM posts ORDER BY published_at DESC LIMIT ?)
      )`);
      params.push(recentScanPosts);
    }
    postConds.push('(p.content LIKE ? OR p.content LIKE ?)');
    announceConds.push('(p.content LIKE ? OR p.content LIKE ?)');
    params.push(`%#${tag}%`, `%/tags/${tag}%`);
    announceParams.push(`%#${tag}%`, `%/tags/${tag}%`);
  } else if (mode === 'local') {
    postConds.push('p.is_local = 1');
    announceConds.push('a.is_local = 1');
  } else if (mode === 'home') {
    const myActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;
    if (myActorUrl) {
      postFollowJoin = 'LEFT JOIN follows f ON f.following_url = p.author_url AND f.follower_url = ?';
      announceFollowJoin = 'LEFT JOIN follows f ON f.following_url = a.user_id AND f.follower_url = ?';
      // ホームは「**自分 + フォロー中の人**」だけ（2026-10-15 に変更）。
      // 以前は `p.is_local = 1 OR フォロー中` で、ローカルの全員の投稿がホームに並んでいた
      // （小さいサーバーでもホームが賑わう利点はあったが、フォローしていない人の投稿が
      //  混ざる＝ホームとローカルの区別が付かない）。ローカルだけ見たいときは「ローカル」タブへ
      postConds.push('(p.author_url = ? OR f.follower_url IS NOT NULL)');
      announceConds.push('(a.user_id = ? OR f.follower_url IS NOT NULL)');
      params.push(myActorUrl); // 自分の投稿もホームに出す
      announceParams.push(myActorUrl); // 自分のブーストも
      followParam = myActorUrl;
      // 本人の設定（ホームでブースト・返信を隠す）。ゲストには設定が無いので触らない
      const homePrefs = await getUserPrefs(req.user!.id);
      if (homePrefs.hideRepliesInHome) {
        // 自分の返信は残す（自分が書いた返信が消えると会話の文脈が切れる）
        postConds.push('(p.in_reply_to IS NULL OR p.user_id = ?)');
        params.push(req.user!.id);
      }
      if (homePrefs.hideBoostsInHome) hideAnnounces = true;
    } else {
      postConds.push('p.is_local = 1');
      announceConds.push('a.is_local = 1');
    }
  }

  // 枝ごとに ORDER BY + LIMIT を押し込む。PostgreSQL は `UNION ALL` の外側に ORDER BY があると
  // 枝を全部読んでから並べ替える（LIMIT が押し込まれない）ため、投稿が増えるほど遅くなる。
  // 枝の中で並べ替えておけば、索引の逆順走査で「必要な件数だけ」読んで止まれる
  // （実測: 連合 812ms → 0.8ms、ローカル 226ms → 0.3ms。SQLite は元々 MERGE で流していた）。
  //
  // 除外（ブロック・ミュート・ミュートワード・フォロワー限定）は enrich の後で分かるので、
  // ここでは**カーソル位置と件数を受け取って読むだけ**にし、ページの組み立ては
  // collectVisiblePage に任せる（足りなければ読み足す）
  const fetchTimelineRows = async (cursor: PageCursor | null, n: number): Promise<any[]> => {
    const postCondsRun = [...postConds];
    const announceCondsRun = [...announceConds];
    const paramsRun = [...params];
    const announceParamsRun = [...announceParams];
    // 続きの読み込み（カーソル）：ORDER BY と同じ組で比較する
    if (cursor) {
      postCondsRun.push(cursorPredicate('p.published_at', 'p.id'));
      announceCondsRun.push(cursorPredicate('a.created_at', 'p.id'));
      paramsRun.push(cursor.at, cursor.at, cursor.id);
      announceParamsRun.push(cursor.at, cursor.at, cursor.id);
    }
    const postWhere = postCondsRun.length > 0 ? ` WHERE ${postCondsRun.join(' AND ')}` : '';
    const announceWhere = announceCondsRun.length > 0 ? ` WHERE ${announceCondsRun.join(' AND ')}` : '';

    const query = `
    SELECT * FROM (
    SELECT 
      p.id AS post_id,
      p.user_id,
      p.author_name,
      p.author_url,
      p.author_handle,
      p.content,
      p.cw,
      p.is_local,
      p.visibility,
      p.emojis,p.in_reply_to,
      p.quote_id,
      p.is_sensitive,
      p.media_attachments,
      p.published_at,
      p.edited_at,
      p.channel_id,
      COALESCE(
        NULLIF(p.author_icon, ''),
        NULLIF(u.icon_url, ''),
        NULLIF(ra.icon_url, ''),
        ''
      ) AS author_icon,
      NULL AS announce_id,
      NULL AS renoted_by_name,
      NULL AS renoted_by_handle,
      NULL AS renoted_by_icon,
      NULL AS renoted_by_url,
      p.published_at AS timeline_at
    FROM ${postFrom}
    ${postFollowJoin}
    LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
    LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
    ${postWhere}
    ORDER BY p.published_at DESC, p.id DESC
    LIMIT ?

    )${hideAnnounces ? '' : `
    UNION ALL SELECT * FROM (

    SELECT 
      p.id AS post_id,
      p.user_id,
      p.author_name,
      p.author_url,
      p.author_handle,
      p.content,
      p.cw,
      p.is_local,
      p.visibility,
      p.emojis,p.in_reply_to,
      p.quote_id,
      p.is_sensitive,
      p.media_attachments,
      p.published_at,
      p.edited_at,
      p.channel_id,
      COALESCE(
        NULLIF(p.author_icon, ''),
        NULLIF(u.icon_url, ''),
        NULLIF(ra.icon_url, ''),
        ''
      ) AS author_icon,
      a.id AS announce_id,
      a.user_name AS renoted_by_name,
      a.user_handle AS renoted_by_handle,
      COALESCE(NULLIF(a.user_icon, ''), NULLIF(ru.icon_url, ''), '') AS renoted_by_icon,
      a.user_id AS renoted_by_url,
      a.created_at AS timeline_at
    FROM announces a
    JOIN posts p ON a.post_id = p.id
    ${announceFollowJoin}
    LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
    LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
    LEFT JOIN users ru ON a.is_local = 1 AND a.user_id = ru.id
    ${announceWhere}
    ORDER BY a.created_at DESC, p.id DESC
    LIMIT ?

    )`}
    ORDER BY timeline_at DESC, post_id DESC
    LIMIT ?
  `;

    // パラメータは SQL に現れる順に並べる（枝の中の JOIN → 条件 → 枝の LIMIT、最後に外側の LIMIT）
    const postsBranchParams = [...(followParam ? [followParam] : []), ...paramsRun, n];
    const announcesBranchParams = [...(followParam ? [followParam] : []), ...announceParamsRun, n];
    return await db.prepare(query).all(
      ...postsBranchParams,
      ...(hideAnnounces ? [] : announcesBranchParams),
      n,
    ) as any[];
  };

  // 読み取りの結果を短い TTL でキャッシュする（同じ画面を何度も開いたときの組み立てを省く）。
  // **ユーザーごと**に鍵を分ける（リアクション・ブックマーク・投票の状態が混ざるため）。
  const cacheKey = [
    'timeline',
    req.user?.id || 'guest',
    mode || 'all',
    tag,
    encodeURIComponent(Array.isArray(req.query.cursor) ? String(req.query.cursor[0]) : String(req.query.cursor || '')),
    String(page.limit),
  ].join('|');

  if (isTimelineCacheEnabled()) {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      res.setHeader('X-Timeline-Cache', 'HIT');
      // **続きのカーソルも一緒に返す。** HIT 経路でヘッダを落とすと、15 秒以内の再アクセス
      // （＝スクロール直後の再取得）で「次ページ無し」と誤解され、無限スクロールが途切れる。
      // 古い形（配列だけ）がキャッシュに残っていたらカーソル無しとして扱う
      const entry = Array.isArray(cached)
        ? { rows: cached, nextCursor: null as string | null }
        : (cached as { rows: unknown; nextCursor?: string | null });
      if (entry.nextCursor) {
        res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor');
        res.setHeader('X-Next-Cursor', entry.nextCursor);
      }
      return res.json(entry.rows);
    }
  }

  const currentActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;
  // 除外（ブロック・ミュート・ミュートワード・フォロワー限定）でページが短くならないよう、
  // 足りない分は読み足してからカーソルを決める（以前は limit + 1 件でカーソルを確定していた）
  const { items: enriched, nextCursor } = await collectVisiblePage({
    limit: page.limit,
    cursor: page.cursor,
    fetchRows: fetchTimelineRows,
    filterRows: (rows) => enrichAndFilterPosts(rows, currentActorUrl, req.user?.id),
    sortKey: 'timeline_at',
    idKey: 'post_id',
  });
  // 続きがある場合のみ X-Next-Cursor ヘッダで通知（レスポンス形状は従来どおり配列）
  if (nextCursor) {
    res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor');
    res.setHeader('X-Next-Cursor', nextCursor);
  }

  if (isTimelineCacheEnabled()) {
    res.setHeader('X-Timeline-Cache', 'MISS');
    // 保存の完了は待たない（応答を遅らせない）。カーソルも一緒に持たせる
    void cacheSet(cacheKey, { rows: enriched, nextCursor }, config.timelineCacheTtlSec);
  }

  res.json(enriched);
});
apiRouter.get('/timeline', handleTimeline);

// 人気・トレンドハッシュタグ一覧
apiRouter.get('/tags/popular', asyncHandler(async (_req: Request, res: Response) => {
  try {
    // フォロワー限定投稿のタグは公開のトレンドに出さない（DM も同じく出さない）
    const recentPosts = await db.prepare("SELECT content FROM posts WHERE COALESCE(visibility, 'public') NOT IN ('followers', 'direct') ORDER BY published_at DESC LIMIT 200").all() as { content: string }[];
    const tagCountMap = new Map<string, number>();

    const tagRegex = /#([a-zA-Z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)/gu;
    for (const post of recentPosts) {
      const cleanContent = post.content.replace(/<[^>]*>/g, ' ');
      const matches = cleanContent.matchAll(tagRegex);
      const seenInPost = new Set<string>();
      for (const match of matches) {
        const tag = match[1].toLowerCase();
        if (tag.length >= 2 && !seenInPost.has(tag)) {
          seenInPost.add(tag);
          tagCountMap.set(tag, (tagCountMap.get(tag) || 0) + 1);
        }
      }
    }

    const popularTags = Array.from(tagCountMap.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    res.json(popularTags);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}));

// 統合検索 API (ユーザー、投稿、Fediverse外部アドレス即時解決)
apiRouter.get('/search', asyncHandler(async (req: Request, res: Response) => {
  const q = (req.query.q as string || '').trim();
  if (!q) {
    return res.json({ remoteUser: null, users: [], posts: [] });
  }

  // 🔎 検索演算子: from:user / before:YYYY-MM-DD / after:YYYY-MM-DD / has:media / -除外語
  interface ParsedSearchQuery {
    text: string;
    from: string | null;
    before: string | null;
    after: string | null;
    hasMedia: boolean;
    excludes: string[];
  }
  const parsedQuery: ParsedSearchQuery = (() => {
    let text = q;
    let from: string | null = null;
    let before: string | null = null;
    let after: string | null = null;
    let hasMedia = false;
    const excludes: string[] = [];

    text = text.replace(/(?:^|\s)from:([^\s]+)/gi, (_m, v: string) => { from = v.replace(/^@/, ''); return ' '; });
    text = text.replace(/(?:^|\s)before:([^\s]+)/gi, (_m, v: string) => { before = v; return ' '; });
    text = text.replace(/(?:^|\s)after:([^\s]+)/gi, (_m, v: string) => { after = v; return ' '; });
    text = text.replace(/(?:^|\s)has:media/gi, () => { hasMedia = true; return ' '; });
    text = text.replace(/(?:^|\s)-([^\s]+)/g, (_m, v: string) => { excludes.push(v); return ' '; });

    return { text: text.trim(), from, before, after, hasMedia, excludes };
  })();

  const searchText = parsedQuery.text;
  const hasOperators = Boolean(
    parsedQuery.from || parsedQuery.before || parsedQuery.after || parsedQuery.hasMedia || parsedQuery.excludes.length > 0,
  );

  // 演算子を SQL 条件に変換する（FTS / LIKE の両方に適用）
  const extraConds: string[] = [];
  const extraParams: any[] = [];
  // DM（visibility = 'direct'）は検索に絶対に出さない（本文も存在も見せない。docs/DM.md）
  extraConds.push("COALESCE(p.visibility, 'public') != 'direct'");
  if (parsedQuery.from) {
    extraConds.push('(p.user_id = ? OR p.author_handle LIKE ? OR p.author_url LIKE ?)');
    const pattern = parsedQuery.from.startsWith('http') ? parsedQuery.from : `%${parsedQuery.from}%`;
    extraParams.push(parsedQuery.from, pattern, pattern);
  }
  for (const term of parsedQuery.excludes) {
    extraConds.push('p.content NOT LIKE ?');
    extraParams.push(`%${term}%`);
  }
  if (parsedQuery.hasMedia) {
    extraConds.push("(p.media_attachments IS NOT NULL AND p.media_attachments != '[]' AND p.media_attachments != '')");
  }
  if (parsedQuery.after) {
    extraConds.push('p.published_at >= ?');
    extraParams.push(`${parsedQuery.after}T00:00:00.000Z`);
  }
  if (parsedQuery.before) {
    extraConds.push('p.published_at < ?');
    extraParams.push(`${parsedQuery.before}T00:00:00.000Z`);
  }
  const extraWhere = extraConds.length > 0 ? ` AND ${extraConds.join(' AND ')}` : '';

  const currentActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;
  let remoteUser: any = null;

  // 1. Fediverse アドレス直接解決 (@user@domain または URL)
  const isAddressOrUrl = searchText.includes('@') || searchText.startsWith('http://') || searchText.startsWith('https://');
  if (isAddressOrUrl) {
    try {
      let actorUrl = '';
      if (searchText.startsWith('http://') || searchText.startsWith('https://')) {
        actorUrl = searchText;
      } else {
        actorUrl = await resolveWebFinger(searchText);
      }

      if (actorUrl) {
        const actor = await fetchRemoteActor(actorUrl, false);
        let isFollowing = false;
        if (currentActorUrl) {
          const follow = await db.prepare('SELECT id FROM follows WHERE follower_url = ? AND following_url = ?').get(currentActorUrl, actor.id);
          isFollowing = Boolean(follow);
        }

        remoteUser = {
          id: actor.id,
          username: actor.username,
          domain: actor.domain,
          name: actor.name || actor.username,
          summary: actor.summary || '',
          icon_url: actor.icon_url || '',
          banner_url: actor.banner_url || '',
          is_following: isFollowing,
        };
      }
    } catch (err: any) {
      console.log(`[Search WebFinger Info] Could not resolve "${q}":`, err.message);
    }
  }

  // 2. ユーザー検索 (ローカルユーザー + キャッシュ済みリモートユーザー)
  const searchPattern = `%${searchText.replace(/^@/, '')}%`;
  const localUsers = searchText ? await db.prepare(`
    SELECT id, name, summary, icon_url, 1 as is_local, NULL as domain, ('@' || id) as handle
    FROM users
    WHERE approval_status = 'approved' AND (id LIKE ? OR name LIKE ?)
    LIMIT 10
  `).all(searchPattern, searchPattern) as any[] : [];

  // リモートアクターは連合で育ち続けるので、**直近に見た N 件**に限って走査する
  // （`LIKE '%語%'` は索引が使えず、全件だと件数に比例して重くなる）。
  // `RECENT_SCAN_ACTORS=0` で従来どおり全件（遅い代わりに古い相手も見つかる）
  const actorWindow = config.recentScanActors;
  const remoteActors = searchText ? await db.prepare(actorWindow > 0 ? `
    SELECT id, username, domain, name, summary, icon_url, 0 as is_local, ('@' || username || '@' || domain) as handle
    FROM (
      SELECT id, username, domain, name, summary, icon_url
      FROM remote_actors
      ORDER BY updated_at DESC
      LIMIT ?
    ) ra
    WHERE ra.username LIKE ? OR ra.name LIKE ? OR ra.domain LIKE ?
    LIMIT 10
  ` : `
    SELECT id, username, domain, name, summary, icon_url, 0 as is_local, ('@' || username || '@' || domain) as handle
    FROM remote_actors
    WHERE username LIKE ? OR name LIKE ? OR domain LIKE ?
    LIMIT 10
  `).all(...(actorWindow > 0 ? [actorWindow, searchPattern, searchPattern, searchPattern] : [searchPattern, searchPattern, searchPattern])) as any[] : [];

  const combinedUsers = await Promise.all([...localUsers, ...remoteActors].map(async (u) => {
    let isFollowing = false;
    const targetUrl = u.is_local ? `${config.origin}/users/${u.id}` : u.id;
    if (currentActorUrl) {
      const follow = await db.prepare('SELECT id FROM follows WHERE follower_url = ? AND following_url = ?').get(currentActorUrl, targetUrl);
      isFollowing = Boolean(follow);
    }
    return {
      ...u,
      is_following: isFollowing,
    };
  }));

  // 3. 投稿本文検索 (SQLite FTS5 / trigram 超高速・高精度検索 ＆ 短語・フェイルセーフ対応)
  let postRows: any[] = [];
  const terms = searchText.split(/\s+/).filter(Boolean);
  const hasLongTerm = terms.some((t) => t.length >= 3);

  if (hasLongTerm) {
    try {
      // 3文字以上の単語を安全にフレーズエスケープして FTS5 MATCH クエリ作成
      const ftsQuery = terms.filter((t) => t.length >= 3).map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
      if (ftsQuery) {
        postRows = await db.prepare(`
          SELECT 
            p.id AS post_id,
            p.user_id,
            p.author_name,
            p.author_url,
            p.author_handle,
            p.content,
            p.cw,
            p.is_local,
            p.visibility,
            p.emojis,p.in_reply_to,
            p.quote_id,
            p.is_sensitive,
            p.media_attachments,
            p.published_at,
            p.edited_at,
            COALESCE(
              NULLIF(p.author_icon, ''),
              NULLIF(u.icon_url, ''),
              NULLIF(ra.icon_url, ''),
              ''
            ) AS author_icon,
            NULL AS announce_id,
            NULL AS renoted_by_name,
            NULL AS renoted_by_handle,
            NULL AS renoted_by_icon,
            NULL AS renoted_by_url,
            p.published_at AS timeline_at
          FROM posts_fts f
          JOIN posts p ON f.post_id = p.id
          LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
          LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
          WHERE posts_fts MATCH ?${extraWhere}
          ORDER BY bm25(posts_fts), p.published_at DESC
          LIMIT 40
        `).all(ftsQuery, ...extraParams) as any[];
      }
    } catch (ftsErr: any) {
      console.warn('[FTS5 Search Fallback]:', ftsErr.message);
    }
  }

  // 短い単語（1〜2文字）の場合、または FTS5 で未ヒット時の LIKE 補完
  // 演算子のみの検索（例: has:media だけ）にも対応するため、本文が空でも実行する
  if (postRows.length === 0 && (terms.length > 0 || extraConds.length > 0)) {
    const postPattern = terms.length > 0 ? `%${searchText}%` : '%';
    // FTS にヒットしない語（リモート投稿にしか無い語・1〜2 文字の語）はここに落ちる。
    // 全件走査だと 32 万投稿で 250ms 超（SQLite は同期なのでプロセスが止まる）ので、
    // **直近 N 件に限る**（タグタイムラインと同じ `recentScanPosts`。既定 2 万）。
    const recentBound = config.recentScanPosts > 0
      ? [`p.published_at >= (
          SELECT COALESCE(MIN(published_at), '') FROM (SELECT published_at FROM posts ORDER BY published_at DESC LIMIT ?)
        )`, config.recentScanPosts] as const
      : null;
    postRows = await db.prepare(`
      SELECT 
        p.id AS post_id,
        p.user_id,
        p.author_name,
        p.author_url,
        p.author_handle,
        p.content,
        p.cw,
        p.is_local,
        p.visibility,
        p.emojis,p.in_reply_to,
        p.quote_id,
        p.is_sensitive,
        p.media_attachments,
        p.published_at,
        p.edited_at,
        COALESCE(
          NULLIF(p.author_icon, ''),
          NULLIF(u.icon_url, ''),
          NULLIF(ra.icon_url, ''),
          ''
        ) AS author_icon,
        NULL AS announce_id,
        NULL AS renoted_by_name,
        NULL AS renoted_by_handle,
        NULL AS renoted_by_icon,
        NULL AS renoted_by_url,
        p.published_at AS timeline_at
      FROM posts p
      LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
      LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
      WHERE (p.content LIKE ? OR p.cw LIKE ?)${extraWhere}${recentBound ? ` AND ${recentBound[0]}` : ''}
      ORDER BY p.published_at DESC
      LIMIT 30
    `).all(postPattern, postPattern, ...extraParams, ...(recentBound ? [recentBound[1]] : [])) as any[];
  }

  const posts = await enrichAndFilterPosts(postRows, currentActorUrl, req.user?.id);

  res.json({
    remoteUser,
    users: combinedUsers,
    posts,
  });
}));

// ==========================================
// メディアアップロード (S3 / Cloudflare R2 / ローカル)
// ==========================================

/**
 * アップロードされたファイルを保存し、ドライブの台帳に記録する（応答は書かない）。
 * 通常の API（`/api/media/upload`）と **Misskey 互換 API（`drive/files/create`）**の
 * 両方から呼ぶ（容量上限・台帳・サムネイルの扱いを二重実装しないため）。
 */
export async function saveUploadedMediaFiles(
  userId: string,
  files: Express.Multer.File[] | undefined,
): Promise<{ ok: true; mediaRows: any[] } | { ok: false; status: number; error: string }> {
  if (!files || files.length === 0) {
    return { ok: false, status: 400, error: 'アップロードするメディアファイルを選択してください。' };
  }
  if (files.length > MAX_POST_ATTACHMENTS) {
    return { ok: false, status: 400, error: `一度にアップロードできるファイルは最大${MAX_POST_ATTACHMENTS}件までです。` };
  }

  // 動画・音声はサイズが大きいため1件までに制限する
  const avFiles = files.filter((f) => f.mimetype.startsWith('video/') || f.mimetype.startsWith('audio/'));
  if (avFiles.length > 1) {
    return { ok: false, status: 400, error: '動画・音声は1件まで添付できます。' };
  }

  // 画像は従来どおり 15MB まで
  const oversizedImage = files.find((f) => f.mimetype.startsWith('image/') && f.size > IMAGE_MAX_BYTES);
  if (oversizedImage) {
    return { ok: false, status: 400, error: '画像サイズが大きすぎます (最大15MBまで)。' };
  }

  try {
    // ドライブの容量上限（MEDIA_QUOTA_MB。0 なら無制限）
    const incomingBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
    const quota = await checkMediaQuota(userId, incomingBytes);
    if (!quota.ok) {
      return { ok: false, status: 413, error: quota.error || 'ドライブの容量上限を超えています。' };
    }

    const uploaded = await Promise.all(
      files.map((file) =>
        uploadMediaFile({
          buffer: file.buffer,
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          userId,
        })
      )
    );

    // ドライブの台帳に記録する（投稿に添付されなくても一覧・削除できるようにする）
    const mediaRows = await Promise.all(
      uploaded.map(async (item) =>
        toClientMedia(await recordMedia({
          userId,
          url: item.url,
          key: item.key,
          mediaType: item.mediaType,
          size: item.size,
          name: item.name,
          thumbnailUrl: item.thumbnailUrl,
          thumbnailKey: item.thumbnailKey,
          width: item.width,
          height: item.height,
          duration: item.duration,
        }))
      )
    );

    return { ok: true, mediaRows };
  } catch (err: any) {
    console.error('[Media Upload Error]:', err);
    return { ok: false, status: 500, error: err.message || 'メディアのアップロードに失敗しました。' };
  }
}

/** multer のミドルウェア（Misskey 互換 API のドライブもこれを使う） */
export const mediaUploadMiddleware = (req: Request, res: Response, next: NextFunction) => {
  upload.any()(req, res, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: `ファイルサイズが大きすぎます (上限 ${Math.floor(MEDIA_MAX_BYTES / (1024 * 1024))}MB)。` });
        }
        return res.status(400).json({ error: `アップロードエラー: ${err.message}` });
      }
      return res.status(400).json({ error: err.message || 'アップロード処理中にエラーが発生しました。' });
    }
    next();
  });
};

// メディアアップロード (画像 最大4枚 / 動画・音声 は1件まで)
apiRouter.post(
  '/media/upload',
  requireAuth,
  mediaUploadMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.rawUser!;
    const files = (req.files as Express.Multer.File[]) || (req.file ? [req.file] : []);
    const result = await saveUploadedMediaFiles(user.id, files);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json({
      success: true,
      media: result.mediaRows,
      attachment: result.mediaRows[0], // 1ファイルアップロード時の互換性
    });
  })
);

// ==========================================
// 🗂️ ドライブ（自分のアップロード管理）
// ==========================================

// 自分のメディア一覧（使用量つき・新しい順）
apiRouter.get('/drive', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const page = parsePageQuery(req, 40);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }
  try {
    const items = await listMedia({ userId: user.id, limit: page.limit + 1, cursor: page.cursor });
    const pageRows = applyPageHeaders(res, items, page.limit, 'created_at', 'id');
    res.json({
      items: pageRows.map(toClientMedia),
      stats: await getMediaStats(user.id),
    });
  } catch (err: any) {
    console.error('[API Drive Error]:', err);
    res.status(500).json({ error: err.message || 'ドライブの取得に失敗しました。' });
  }
}));

// 使用量のみ（軽量）
apiRouter.get('/drive/stats', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  res.json(await getMediaStats(req.rawUser!.id));
}));

// メディアの削除（投稿で使用中のものは拒否）
apiRouter.delete('/drive/:id', requireAuth, async (req: Request, res: Response) => {
  const user = req.rawUser!;
  try {
    const mediaId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await deleteMedia(user.id, mediaId);
    if (!result.ok) {
      return res.status(result.inUse ? 409 : 404).json({ error: result.error, inUse: Boolean(result.inUse) });
    }
    console.log(`[Drive] 🗑️ @${user.id} がメディアを削除しました: ${mediaId}`);
    res.json({ success: true, stats: await getMediaStats(user.id) });
  } catch (err: any) {
    console.error('[API Drive Delete Error]:', err);
    res.status(500).json({ error: err.message || 'メディアの削除に失敗しました。' });
  }
});

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
apiRouter.post('/posts', requireAuth, handleCreatePost);

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
  if (await isPublicPost(postId)) {
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
apiRouter.delete('/posts/:id', requireAuth, handleDeletePost);

// ✏️ 投稿の編集（自分のローカル投稿のみ）。ActivityPub の Update で連合先にも反映する
apiRouter.put('/posts/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
apiRouter.post('/posts/:id/poll/vote', requireAuth, handleVotePoll);

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
apiRouter.post('/posts/:id/react', requireAuth, handleReactToPost);

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
apiRouter.post('/posts/:id/announce', requireAuth, handleAnnouncePost);

// 会話スレッド（親投稿・対象投稿・返信一覧）取得
apiRouter.get('/posts/:id/thread', asyncHandler(async (req: Request, res: Response) => {
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

// リモートまたはローカルユーザーのフォロー（認証必須）
/** フォロー。Misskey 互換 API（`following/create`）からも同じ関数を呼ぶ */
export const handleFollow = asyncHandler(async (req: Request, res: Response) => {
  const { targetHandle } = req.body;
  if (!targetHandle) {
    return res.status(400).json({ error: 'targetHandle が必要です。例: "@user@mastodon.social"' });
  }

  const user = req.rawUser!;
  const myActorUrl = `${config.origin}/users/${user.id}`;

  if (await isDomainBlocked(targetHandle)) {
    return res.status(400).json({ error: 'このサーバーはブロックされているためフォローできません。' });
  }

  try {
    let targetActorUrl: string;
    let isTargetLocal = false;
    let localTargetUser: any = null;

    if (targetHandle.startsWith('http://') || targetHandle.startsWith('https://')) {
      targetActorUrl = targetHandle;
      if (targetActorUrl.startsWith(config.origin)) {
        isTargetLocal = true;
        const uid = targetActorUrl.split('/').pop()!;
        localTargetUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      }
    } else if (targetHandle.includes(`@${config.domain}`) || !targetHandle.includes('@')) {
      const cleanId = targetHandle.replace(/^@/, '').replace(`@${config.domain}`, '');
      localTargetUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(cleanId);
      if (localTargetUser) {
        isTargetLocal = true;
        targetActorUrl = `${config.origin}/users/${localTargetUser.id}`;
      } else {
        targetActorUrl = await resolveWebFinger(targetHandle);
      }
    } else {
      targetActorUrl = await resolveWebFinger(targetHandle);
    }

    if (targetActorUrl === myActorUrl) {
      return res.status(400).json({ error: '自分自身をフォローすることはできません。' });
    }

    const followId = `${myActorUrl} -> ${targetActorUrl}`;
    const now = new Date().toISOString();

    if (isTargetLocal && localTargetUser) {
      // ローカルユーザー同士のフォロー: 外部配送なしで即時承認
      await db.prepare(`
        INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
        VALUES (?, ?, ?, ?, 1, 'accepted', ?)
        ON CONFLICT(follower_url, following_url) DO UPDATE SET
          status = 'accepted'
      `).run(followId, myActorUrl, targetActorUrl, `${targetActorUrl}/inbox`, now);
      // 新しいフォロー相手の投稿が、キャッシュ済みのホームにも出るようにする
      await invalidateTimelineCache();

      try {
        await createNotification({
          userId: localTargetUser.id,
          type: 'follow',
          actorId: user.id,
          actorName: user.name,
          actorHandle: `@${user.id}@${config.domain}`,
          actorIcon: user.icon_url || '',
        });
      } catch (e) {
        console.error('[Notification Error] Follow notification failed:', e);
      }

      return res.json({
        status: 'Followed',
        targetActor: targetActorUrl,
        delivered: true,
        target: {
          username: localTargetUser.id,
          name: localTargetUser.name,
          domain: config.domain,
        },
      });
    }

    // 相手のリモート Actor 情報を取得
    const remoteActor = await fetchRemoteActor(targetActorUrl);

    // Follow Activity を構築
    const followActivity = buildFollowActivity({
      actorUrl: myActorUrl,
      targetActorUrl,
    });

    // follows テーブルに登録
    await db.prepare(`
      INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
      VALUES (?, ?, ?, ?, 1, 'pending', ?)
      ON CONFLICT(follower_url, following_url) DO UPDATE SET
        status = 'pending',
        inbox_url = excluded.inbox_url
    `).run(followId, myActorUrl, targetActorUrl, remoteActor.inbox_url, now);
    // 承認後に相手の投稿が出るので、いまのうちに捨てておく（承認は別のプロセスで起き得る）
    await invalidateTimelineCache();

    // 相手の Inbox へ署名付き Follow Activity を配送
    const delivered = await deliverActivity({
      inboxUrl: remoteActor.inbox_url,
      activity: followActivity,
      senderUser: user,
    });

    res.json({
      status: 'Follow request sent',
      targetActor: targetActorUrl,
      delivered,
      target: {
        username: remoteActor.username,
        name: remoteActor.name,
        domain: remoteActor.domain,
      },
    });
  } catch (err: any) {
    console.error('[Follow Error]:', err);
    res.status(500).json({ error: err.message || 'フォローに失敗しました。' });
  }
});
apiRouter.post('/follow', requireAuth, handleFollow);

// フォロー解除
export const handleUnfollow = asyncHandler(async (req: Request, res: Response) => {
  const { targetHandle, targetActorUrl: explicitTargetUrl } = req.body;
  const user = req.rawUser!;
  const myActorUrl = `${config.origin}/users/${user.id}`;

  try {
    let targetActorUrl = explicitTargetUrl;
    if (!targetActorUrl && targetHandle) {
      if (targetHandle.startsWith('http://') || targetHandle.startsWith('https://')) {
        targetActorUrl = targetHandle;
      } else if (targetHandle.includes(`@${config.domain}`) || !targetHandle.includes('@')) {
        const cleanId = targetHandle.replace(/^@/, '').replace(`@${config.domain}`, '');
        targetActorUrl = `${config.origin}/users/${cleanId}`;
      } else {
        targetActorUrl = await resolveWebFinger(targetHandle);
      }
    }

    if (!targetActorUrl) {
      return res.status(400).json({ error: '解除対象のユーザーが指定されていません。' });
    }

    const followRow = await db.prepare('SELECT * FROM follows WHERE follower_url = ? AND following_url = ?').get(myActorUrl, targetActorUrl) as FollowRow | undefined;
    if (!followRow) {
      return res.status(400).json({ error: 'このユーザーをフォローしていません。' });
    }

    // follows テーブルから削除
    await db.prepare('DELETE FROM follows WHERE follower_url = ? AND following_url = ?').run(myActorUrl, targetActorUrl);
    await invalidateTimelineCache();

    // リモートユーザーなら Undo(Follow) を配送
    if (!targetActorUrl.startsWith(config.origin) && followRow.inbox_url) {
      try {
        const undoActivity = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${myActorUrl}/activities/undo-follow/${Date.now()}`,
          type: 'Undo',
          actor: myActorUrl,
          object: {
            id: followRow.id,
            type: 'Follow',
            actor: myActorUrl,
            object: targetActorUrl,
          },
        };
        await deliverActivity({
          inboxUrl: followRow.inbox_url,
          activity: undoActivity,
          senderUser: user,
        });
      } catch (err: any) {
        console.warn('[Unfollow Warning] Failed to deliver Undo activity:', err.message);
      }
    }

    res.json({ success: true, targetActorUrl });
  } catch (err: any) {
    console.error('[Unfollow Error]:', err);
    res.status(500).json({ error: err.message || 'フォロー解除に失敗しました。' });
  }
});
apiRouter.post('/unfollow', requireAuth, handleUnfollow);

// 自プロフィール更新 (名前, bio, アイコンURL, ヘッダーURL, 鍵アカウント設定)
// Misskey 互換の `i/update` からも呼ぶ（中身は Misskey の項目名へ読み替えて渡す）
export const handleUpdateProfile = asyncHandler(async (req: Request, res: Response) => {
  const { name, summary, icon_url, banner_url, is_locked, fields, discoverable, noindex, no_ai_training } = req.body;
  const user = req.rawUser!;

  const newName = typeof name === 'string' && name.trim() ? name.trim() : user.name;
  const newSummary = typeof summary === 'string' ? summary.trim() : (user.summary || '');
  const newIconUrl = typeof icon_url === 'string' ? icon_url.trim() : (user.icon_url || '');
  const newBannerUrl = typeof banner_url === 'string' ? banner_url.trim() : (user.banner_url || '');
  // 鍵アカウント（フォロー承認制）の切り替え。未指定なら現状維持
  const newIsLocked = typeof is_locked === 'boolean' ? (is_locked ? 1 : 0) : (user.is_locked ?? 0);
  // ディレクトリ掲載の可否
  const newDiscoverable = typeof discoverable === 'boolean' ? (discoverable ? 1 : 0) : ((user as any).discoverable ?? 1);
  // 検索エンジンによるインデックスの拒否 / 生成AIによる学習の拒否（プロフィール HTML の robots に出る）
  const newNoindex = typeof noindex === 'boolean' ? (noindex ? 1 : 0) : ((user as any).noindex ?? 0);
  const newNoAiTraining = typeof no_ai_training === 'boolean' ? (no_ai_training ? 1 : 0) : ((user as any).no_ai_training ?? 0);
  // プロフィール項目（最大4件・各40/200文字まで）
  const newFields = Array.isArray(fields)
    ? fields
        .filter((f: any) => f && typeof f.name === 'string' && typeof f.value === 'string')
        .slice(0, 4)
        .map((f: any) => ({ name: f.name.trim().slice(0, 40), value: f.value.trim().slice(0, 200) }))
        .filter((f: any) => f.name && f.value)
    : (() => {
        try { return JSON.parse((user as any).fields || '[]'); } catch { return []; }
      })();

  await db.prepare(`
    UPDATE users SET
      name = ?,
      summary = ?,
      icon_url = ?,
      banner_url = ?,
      is_locked = ?,
      fields = ?,
      discoverable = ?,
      noindex = ?,
      no_ai_training = ?
    WHERE id = ?
  `).run(newName, newSummary, newIconUrl, newBannerUrl, newIsLocked, JSON.stringify(newFields), newDiscoverable, newNoindex, newNoAiTraining, user.id);

  // 自身の過去投稿の author_name / author_icon も更新
  await db.prepare(`UPDATE posts SET author_name = ?, author_icon = ? WHERE is_local = 1 AND user_id = ?`).run(newName, newIconUrl, user.id);

  const updatedUser = await db.prepare('SELECT id, name, summary, icon_url, banner_url, role, is_frozen, is_locked, fields, discoverable, noindex, no_ai_training, onboarding_completed, created_at FROM users WHERE id = ?').get(user.id) as any;
  const myActorUrl = `${config.origin}/users/${user.id}`;
  const followerCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_url = ? AND status = ?').get(myActorUrl, 'accepted') as any).c;
  const followingCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE follower_url = ? AND status = ?').get(myActorUrl, 'accepted') as any).c;
  // 自分の投稿数に DM は数えない（DM はタイムラインに出ない投稿なので別扱い）
  const postCount = (await db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND COALESCE(visibility, 'public') != 'direct'").get(user.id) as any).c;

  res.json({
    ...updatedUser,
    handle: `@${user.id}@${config.domain}`,
    actorUrl: myActorUrl,
    followerCount,
    followingCount,
    postCount,
  });
});
apiRouter.put('/user/profile', requireAuth, handleUpdateProfile);

// ==========================================
// 📦 アカウントの引っ越し（Move / alsoKnownAs）
// ==========================================

// 引っ越しの状況（移行元・移行先・フォロワー数）
apiRouter.get('/user/migration', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const myActorUrl = `${config.origin}/users/${user.id}`;
  const followers = (
    await db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_url = ? AND follower_url != ?').get(myActorUrl, myActorUrl) as any
  ).c;

  res.json({
    actorUrl: myActorUrl,
    movedTo: (user as any).moved_to || '',
    alsoKnownAs: (user as any).also_known_as || '',
    followers,
  });
}));

// 引っ越し元アカウント（alsoKnownAs）の登録 — 他のサーバーからここへ引っ越す場合に必要
apiRouter.post('/user/migration/alias', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const input = typeof req.body?.alias === 'string' ? req.body.alias.trim() : '';
  const myActorUrl = `${config.origin}/users/${user.id}`;

  // 空文字で解除
  if (!input) {
    await db.prepare("UPDATE users SET also_known_as = '' WHERE id = ?").run(user.id);
    console.log(`[Migration] 📦 @${user.id} の引っ越し元を解除`);
    return res.json({ success: true, alsoKnownAs: '', message: '引っ越し元アカウントを解除しました。' });
  }

  try {
    // ハンドル (@user@host) でも Actor URL でも受け付ける
    let actorUrl = input;
    if (!/^https?:\/\//i.test(input)) {
      const handle = input.startsWith('@') ? input.slice(1) : input;
      if (!handle.includes('@')) {
        return res.status(400).json({ error: '@ユーザー名@サーバー の形式で入力してください。' });
      }
      const resolved = await resolveWebFinger(handle);
      if (!resolved) {
        return res.status(404).json({ error: '引っ越し元アカウントが見つかりませんでした。' });
      }
      actorUrl = resolved;
    }

    if (actorUrl === myActorUrl) {
      return res.status(400).json({ error: '自分自身は引っ越し元に指定できません。' });
    }

    await db.prepare('UPDATE users SET also_known_as = ? WHERE id = ?').run(actorUrl, user.id);
    console.log(`[Migration] 📦 @${user.id} の引っ越し元を登録: ${actorUrl}`);
    res.json({ success: true, alsoKnownAs: actorUrl, message: `引っ越し元アカウントを登録しました。Actor 文書の alsoKnownAs として公開されます。` });
  } catch (err: any) {
    console.error('[Migration] ❌ 引っ越し元の登録に失敗:', err);
    res.status(500).json({ error: err.message || '引っ越し元の登録に失敗しました。' });
  }
}));

// フォロワーへ Move を配送して引っ越す
apiRouter.post('/user/migration/move', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const target = typeof req.body?.target === 'string' ? req.body.target.trim() : '';
  if (!target) {
    return res.status(400).json({ error: '引っ越し先アカウント（@ユーザー名@サーバー または URL）を指定してください。' });
  }

  const myActorUrl = `${config.origin}/users/${user.id}`;

  try {
    // 1. 引っ越し先アカウントを解決する
    let targetActorUrl = target;
    if (!/^https?:\/\//i.test(target)) {
      const handle = target.startsWith('@') ? target.slice(1) : target;
      if (!handle.includes('@')) {
        return res.status(400).json({ error: '@ユーザー名@サーバー の形式で入力してください。' });
      }
      const resolved = await resolveWebFinger(handle);
      if (!resolved) {
        return res.status(404).json({ error: '引っ越し先アカウントが見つかりませんでした。' });
      }
      targetActorUrl = resolved;
    }

    if (targetActorUrl === myActorUrl) {
      return res.status(400).json({ error: '自分自身へは引っ越せません。' });
    }
    if (await isDomainBlocked(targetActorUrl)) {
      return res.status(400).json({ error: 'このサーバーはブロック対象のため引っ越せません。' });
    }

    // 2. 引っ越し先が alsoKnownAs にこのアカウントを宣言しているか検証する
    //    （連合先も同じ検証をするため、宣言が無いと Move は受理されない）
    const aliases = await fetchActorAliases(targetActorUrl);
    if (!aliases.includes(myActorUrl)) {
      return res.status(400).json({
        error: `引っ越し先（${targetActorUrl}）の alsoKnownAs にこのアカウント（${myActorUrl}）が含まれていません。先に引っ越し先アカウントで旧アカウントとして設定してください。`,
      });
    }

    // 3. フォロワー全員へ Move を配送する
    const followerRows = await db.prepare('SELECT * FROM follows WHERE following_url = ? AND follower_url != ?').all(
      myActorUrl,
      myActorUrl,
    ) as unknown as FollowRow[];
    const moveActivity = buildMoveActivity({ actorUrl: myActorUrl, targetActorUrl });

    let delivered = 0;
    let failed = 0;
    for (const row of followerRows) {
      const ok = await deliverActivity({ inboxUrl: row.inbox_url, activity: moveActivity, senderUser: user });
      if (ok) delivered++;
      else failed++;
    }

    // 4. 移行先を記録する（Actor 文書の movedTo として公開される）
    await db.prepare('UPDATE users SET moved_to = ? WHERE id = ?').run(targetActorUrl, user.id);

    console.log(
      `[Migration] 📦 @${user.id} が ${targetActorUrl} へ引っ越し（フォロワー ${followerRows.length}件 / 成功 ${delivered} / 失敗 ${failed}）`,
    );
    res.json({
      success: true,
      targetActorUrl,
      followers: followerRows.length,
      delivered,
      failed,
      message: `引っ越しを実行しました。フォロワー ${followerRows.length} 件へ通知（成功 ${delivered} / 失敗 ${failed}）しました。`,
    });
  } catch (err: any) {
    console.error('[Migration] ❌ 引っ越しに失敗:', err);
    res.status(500).json({ error: err.message || '引っ越しに失敗しました。' });
  }
}));

// 引っ越し先の記録を解除する（配送済みの Move は取り消せない）
apiRouter.post('/user/migration/cancel', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  await db.prepare("UPDATE users SET moved_to = '' WHERE id = ?").run(user.id);
  console.log(`[Migration] 📦 @${user.id} の引っ越し先を解除`);
  res.json({ success: true, message: '引っ越し先の記録を解除しました（連合先へ配送済みの Move は取り消せません）。' });
}));
// 📦 データエクスポート（非同期）
//
// 大きなアカウントでは ZIP の生成に時間がかかるので、**リクエストの中で待たせない**。
// 受け付けたらジョブを積み、`GET /api/user/export/:jobId` で状態を見て、
// 出来上がったら `GET /api/user/export/:jobId/file` でダウンロードする。
apiRouter.post('/user/export', requireAuth, async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const format = String(req.body?.format || req.query.format || 'json').toLowerCase() === 'zip' ? 'zip' : 'json';

  try {
    // 同じ人のエクスポートが走っている間は積まない（連打対策）
    const jobId = await enqueueJob('user_export', { userId: user.id, format }, { dedupeKey: `user_export:${user.id}`, maxAttempts: 2 });
    if (!jobId) {
      return res.status(503).json({ error: 'エクスポートを受け付けられませんでした。しばらくしてからお試しください。' });
    }
    res.status(202).json({ jobId, status: 'pending', format });
  } catch (err: any) {
    console.error(`[Export Error] Failed to enqueue export for @${user.id}:`, err);
    res.status(500).json({ error: 'データのエクスポートを開始できませんでした。' });
  }
});

/** エクスポートの状態（自分のジョブだけ見られる） */
apiRouter.get('/user/export/:jobId', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const job = await getJob(String(req.params.jobId));
  if (!job || job.kind !== 'user_export') {
    return res.status(404).json({ error: 'エクスポートが見つかりません。' });
  }
  const payload = JSON.parse(job.payload || '{}') as { userId?: string };
  if (payload.userId !== user.id) {
    return res.status(404).json({ error: 'エクスポートが見つかりません。' });
  }
  const result = job.result ? (JSON.parse(job.result) as { filename?: string; bytes?: number }) : null;
  res.json({
    status: job.status,
    error: job.status === 'failed' ? job.last_error || 'エクスポートに失敗しました。' : '',
    filename: result?.filename || '',
    bytes: result?.bytes || 0,
    downloadUrl: job.status === 'done' ? `/api/user/export/${job.id}/file` : '',
  });
}));

/** 出来上がったファイルを返す（返したら消す＝置き場を溜めない） */
apiRouter.get('/user/export/:jobId/file', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const job = await getJob(String(req.params.jobId));
  if (!job || job.kind !== 'user_export' || job.status !== 'done' || !job.result) {
    return res.status(404).json({ error: 'エクスポートが見つかりません。' });
  }
  const payload = JSON.parse(job.payload || '{}') as { userId?: string };
  if (payload.userId !== user.id) {
    return res.status(404).json({ error: 'エクスポートが見つかりません。' });
  }
  const result = JSON.parse(job.result) as { filePath?: string; filename?: string };
  if (!result.filePath || !fs.existsSync(result.filePath)) {
    // 期限切れ（1 時間で掃除される）や、別プロセスが作った場合
    return res.status(410).json({ error: 'エクスポートのファイルはもうありません。もう一度お試しください。' });
  }

  res.setHeader('Content-Type', result.filename?.endsWith('.zip') ? 'application/zip' : 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename || 'spica-export'}"`);
  res.sendFile(path.resolve(result.filePath), (err) => {
    // 送り終わったら消す（失敗しても消す。1 時間の掃除でも拾われる）
    try {
      fs.unlinkSync(result.filePath as string);
    } catch {
      // すでに無ければ何もしない
    }
    if (err && !res.headersSent) res.status(500).end();
  });
}));

// ユーザー自身によるアカウント削除（退会・データ完全抹消）
apiRouter.post('/user/delete-me', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const { confirmUserId, masterKey } = req.body;

  // 1. 誤操作防止の確認用ユーザーID検証
  if (!confirmUserId || String(confirmUserId).trim().toLowerCase() !== user.id.toLowerCase()) {
    return res.status(400).json({
      error: `確認用ユーザーIDが一致しません。「${user.id}」と正確に入力してください。`,
    });
  }

  // 2. マスターキーが送信されている場合は照合
  if (masterKey && String(masterKey).trim()) {
    const keyHash = hashMasterKey(String(masterKey).trim());
    if (keyHash !== user.master_key_hash) {
      return res.status(401).json({
        error: 'マスターキーが正しくありません。',
      });
    }
  }

  // 3. 最後の管理者を削除しない保護
  if (user.role === 'admin') {
    const adminCount = (await db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get() as any).c;
    if (adminCount <= 1) {
      return res.status(400).json({
        error: 'あなたはサーバーで唯一の管理者です。退会する前に別のユーザーを管理者に任命してください。',
      });
    }
  }

  // 4. 退会を受け付ける（その場で凍結 + セッション削除。実作業はジョブで。
  //    フォロワー全員への Delete 配信とメディア削除は時間がかかるため、リクエスト内で待たせない）
  const result = await beginUserDeletion(user.id);
  if (!result.success) {
    return res.status(400).json({ error: result.error || 'アカウントの削除に失敗しました。' });
  }

  res.json({
    success: true,
    jobId: result.jobId,
    message: '退会を受け付けました。アカウントと関連データを削除しています。ご利用ありがとうございました。',
  });
}));

/**
 * プロフィールの識別子から、リモートアクターの URL を決める。
 *
 * - URL はそのまま使う
 * - **裸のユーザー名**（例: "suiren"）は WebFinger では解決できないので、
 *   キャッシュ済みのリモートアクターから引く（フォロー一覧などが名前だけを渡してくるため）。
 *   同名のアクターが複数いるときは、誤った相手を開くより 404 の方が安全なので解決しない
 * - それ以外（`@user@domain` など）は WebFinger
 */
async function resolveRemoteActorUrl(identifier: string): Promise<string> {
  if (identifier.startsWith('http://') || identifier.startsWith('https://')) return identifier;

  const bare = identifier.replace(/^@/, '');
  if (!bare.includes('@') && /^[A-Za-z0-9_.-]+$/.test(bare)) {
    const rows = (await db.prepare('SELECT id FROM remote_actors WHERE username = ? LIMIT 2').all(bare)) as {
      id: string;
    }[];
    if (rows.length === 1) return rows[0].id;
  }

  return resolveWebFinger(identifier);
}

// ユーザー詳細プロフィール取得（ローカルまたはリモート）
apiRouter.get('/users/:identifier', asyncHandler(async (req: Request, res: Response) => {
  const rawIdentifier = decodeURIComponent(req.params.identifier as string);
  const myActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;

  // 1. ローカルユーザーの照合 (@id, id, @id@domain 等)
  let cleanId = rawIdentifier.replace(/^@/, '');
  if (cleanId.includes(`@${config.domain}`)) {
    cleanId = cleanId.replace(`@${config.domain}`, '');
  }

  const localUser = await db.prepare('SELECT id, name, summary, icon_url, banner_url, role, is_frozen, is_locked, fields, discoverable, created_at, approval_status FROM users WHERE id = ?').get(cleanId) as any;
  if (localUser && !isApprovedUser(localUser)) {
    // 承認待ち・却下の申請はプロフィールとして存在しない扱い（本人にも見せない）
    return res.status(404).json({ error: 'ユーザーが見つかりません。' });
  }
  if (localUser) {
    const actorUrl = `${config.origin}/users/${localUser.id}`;
    const followerCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_url = ? AND status = ?').get(actorUrl, 'accepted') as any).c;
    const followingCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE follower_url = ? AND status = ?').get(actorUrl, 'accepted') as any).c;
    const postCount = (await db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND COALESCE(visibility, 'public') != 'direct'").get(localUser.id) as any).c;

    let isFollowing = false;
    let isBlocked = false;
    let isMuted = false;
    let isBlockingMe = false;
    if (req.user && req.user.id !== localUser.id) {
      if (myActorUrl) {
        const f = await db.prepare('SELECT id FROM follows WHERE follower_url = ? AND following_url = ?').get(myActorUrl, actorUrl);
        isFollowing = !!f;
      }
      isBlocked = !!await db.prepare('SELECT 1 FROM user_blocks WHERE user_id = ? AND target_user_id = ?').get(req.user.id, localUser.id);
      isMuted = !!await db.prepare('SELECT 1 FROM user_mutes WHERE user_id = ? AND target_user_id = ?').get(req.user.id, localUser.id);
      isBlockingMe = !!await db.prepare('SELECT 1 FROM user_blocks WHERE user_id = ? AND target_user_id = ?').get(localUser.id, req.user.id);
    }

    // 📌 ピン留めノートの取得
    const pinnedRows = await db.prepare(`
      SELECT 
        p.*,
        p.id AS post_id,
        p.published_at AS timeline_at,
        COALESCE(
          NULLIF(p.author_icon, ''),
          NULLIF(u.icon_url, ''),
          ''
        ) AS author_icon
      FROM pinned_posts pp
      JOIN posts p ON pp.post_id = p.id
      LEFT JOIN users u ON p.user_id = u.id
      WHERE pp.user_id = ?
      ORDER BY pp.created_at DESC
    `).all(localUser.id) as any[];
    const pinnedPosts = await enrichAndFilterPosts(pinnedRows, myActorUrl, req.user?.id);

    return res.json({
      id: localUser.id,
      name: localUser.name,
      summary: localUser.summary || '',
      icon_url: localUser.icon_url || '',
      banner_url: localUser.banner_url || '',
      handle: `@${localUser.id}@${config.domain}`,
      actor_url: actorUrl,
      domain: config.domain,
      is_local: true,
      is_locked: Number((localUser as any).is_locked ?? 0) === 1,
      discoverable: Number((localUser as any).discoverable ?? 1) === 1,
      // 🏅 プロフィール項目とバッジ（付与ロール）
      fields: parseProfileFields((localUser as any).fields).map((f) => ({ name: f.name, value: f.value })),
      roles: await db.prepare(`
        SELECT r.id, r.name, r.color FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id = ?
        ORDER BY r.created_at ASC
      `).all(localUser.id),
      created_at: localUser.created_at,
      follower_count: followerCount,
      following_count: followingCount,
      post_count: postCount,
      is_following: isFollowing,
      is_blocked: isBlocked,
      is_muted: isMuted,
      is_blocking_me: isBlockingMe,
      pinned_posts: pinnedPosts,
    });
  }

  // 2. リモートユーザーの照合
  try {
    const targetActorUrl = await resolveRemoteActorUrl(rawIdentifier);

    // キャッシュを検索、未取得または画像未取得なら最新化
    let remoteActor: RemoteActorRow;
    const existing = await db.prepare('SELECT * FROM remote_actors WHERE id = ?').get(targetActorUrl) as RemoteActorRow | undefined;
    if (existing && existing.icon_url) {
      remoteActor = existing;
    } else {
      remoteActor = await fetchRemoteActor(targetActorUrl, true);
    }

    const postCount = (await db.prepare("SELECT COUNT(*) as c FROM posts WHERE is_local = 0 AND (author_url = ? OR user_id = ?) AND COALESCE(visibility, 'public') != 'direct'").get(targetActorUrl, targetActorUrl) as any).c;

    // フォロー/フォロワーの数は、こちらが把握している関係（follows テーブル）から数える。
    // リモートの相手でも、自分や自分のノードの利用者との関係はここに入っている
    const followerCount = (await db.prepare("SELECT COUNT(*) as c FROM follows WHERE following_url = ? AND status = 'accepted'").get(targetActorUrl) as any).c;
    const followingCount = (await db.prepare("SELECT COUNT(*) as c FROM follows WHERE follower_url = ? AND status = 'accepted'").get(targetActorUrl) as any).c;

    let isFollowing = false;
    let isBlocked = false;
    let isMuted = false;
    if (req.user) {
      if (myActorUrl) {
        const f = await db.prepare('SELECT id FROM follows WHERE follower_url = ? AND following_url = ?').get(myActorUrl, targetActorUrl);
        isFollowing = !!f;
      }
      isBlocked = !!await db.prepare('SELECT 1 FROM user_blocks WHERE user_id = ? AND target_user_id = ?').get(req.user.id, targetActorUrl);
      isMuted = !!await db.prepare('SELECT 1 FROM user_mutes WHERE user_id = ? AND target_user_id = ?').get(req.user.id, targetActorUrl);
    }

    return res.json({
      id: remoteActor.id,
      name: remoteActor.name || remoteActor.username,
      summary: remoteActor.summary || '',
      icon_url: remoteActor.icon_url || '',
      banner_url: remoteActor.banner_url || '',
      handle: `@${remoteActor.username}@${remoteActor.domain}`,
      actor_url: remoteActor.id,
      domain: remoteActor.domain,
      is_local: false,
      created_at: remoteActor.updated_at,
      follower_count: followerCount,
      following_count: followingCount,
      post_count: postCount,
      is_following: isFollowing,
      is_blocked: isBlocked,
      is_muted: isMuted,
      is_blocking_me: false,
      pinned_posts: [],
    });
  } catch (err: any) {
    console.error(`[User Profile Error] Failed to resolve user ${rawIdentifier}:`, err.message);
    return res.status(404).json({ error: 'ユーザーが見つかりませんでした。' });
  }
}));

// ユーザー投稿一覧取得
apiRouter.get('/users/:identifier/posts', asyncHandler(async (req: Request, res: Response) => {
  const rawIdentifier = decodeURIComponent(req.params.identifier as string);
  const page = parsePageQuery(req, 50);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }

  let cleanId = rawIdentifier.replace(/^@/, '');
  if (cleanId.includes(`@${config.domain}`)) {
    cleanId = cleanId.replace(`@${config.domain}`, '');
  }

  const localUser = await db.prepare('SELECT id FROM users WHERE id = ?').get(cleanId);

  const baseSelect = `
    SELECT 
      p.*,
      p.id AS post_id,
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
  `;

  // リモートは actor URL に正規化してから引く（裸のユーザー名でも投稿を出せるように）。
  // 読み足しのたびに解決し直さないよう、ここで 1 回だけ決める
  let targetActorUrl = '';
  const handleFromActorUrl = (url: string): string => {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/^\/users\/([^/]+)/);
      return match ? `@${decodeURIComponent(match[1])}@${parsed.host}` : '';
    } catch {
      return '';
    }
  };
  if (!localUser) {
    targetActorUrl = await resolveRemoteActorUrl(rawIdentifier).catch(() => rawIdentifier);
  }

  const currentActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;
  const { items: enriched, nextCursor } = await collectVisiblePage({
    limit: page.limit,
    cursor: page.cursor,
    fetchRows: async (cursor, n) => {
      const cursorCond = cursor ? ` AND ${cursorPredicate('p.published_at', 'p.id')}` : '';
      const cursorParams = cursor ? [cursor.at, cursor.at, cursor.id] : [];
      if (localUser) {
        return await db.prepare(`
          ${baseSelect}
          WHERE p.user_id = ? AND COALESCE(p.visibility, 'public') != 'direct'${cursorCond}
          ORDER BY p.published_at DESC, p.id DESC
          LIMIT ?
        `).all(cleanId, ...cursorParams, n) as any[];
      }
      return await db.prepare(`
        ${baseSelect}
        WHERE (p.author_url = ? OR p.user_id = ? OR p.author_handle = ?)
          AND COALESCE(p.visibility, 'public') != 'direct'${cursorCond}
        ORDER BY p.published_at DESC, p.id DESC
        LIMIT ?
      `).all(targetActorUrl, targetActorUrl, handleFromActorUrl(targetActorUrl), ...cursorParams, n) as any[];
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
}));

// この投稿を引用した人の一覧（Misskey の「引用」に相当）
apiRouter.get('/posts/:id/quotes', asyncHandler(async (req: Request, res: Response) => {
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
apiRouter.get('/me/reactions', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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

// 自分の投稿カレンダー（日付ごとの件数）
apiRouter.get('/me/post-calendar', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const monthParam = String(req.query.month || '');
  const month = /^[0-9]{4}-[0-9]{2}$/.test(monthParam) ? monthParam : new Date().toISOString().slice(0, 7);
  const [yearStr, monthStr] = month.split('-');
  const start = `${month}-01`;
  const nextYear = Number(monthStr) === 12 ? Number(yearStr) + 1 : Number(yearStr);
  const nextMonth = Number(monthStr) === 12 ? '01' : String(Number(monthStr) + 1).padStart(2, '0');
  const end = `${nextYear}-${nextMonth}-01`;
  try {
    const rows = await db.prepare(`
      SELECT substr(published_at, 1, 10) AS day, count(*) AS count
      FROM posts
      WHERE user_id = ? AND published_at >= ? AND published_at < ?
        AND COALESCE(visibility, 'public') != 'direct'
      GROUP BY day
      ORDER BY day
    `).all(user.id, start, end);
    res.json({ month, days: rows });
  } catch (err: any) {
    console.error('[API Post Calendar Error]:', err);
    res.status(500).json({ error: 'カレンダーの取得に失敗しました。' });
  }
}));

// フォロー中リスト
apiRouter.get('/following', asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.query.userId as string) || req.user?.id;
  if (!userId) {
    return res.status(400).json({ error: 'userId が必要です。' });
  }

  // userId はローカルの ID のほか、リモートのプロフィールから渡される actor URL も受け付ける
  const myActorUrl = userId.startsWith('http') ? userId : `${config.origin}/users/${userId}`;
  // ローカルの相手は users 側にしか名前・アイコンが無いので、両方を引いて埋める
  // （リモートは remote_actors、ローカルは users。`? || u.id` で actor URL を組み立てる）
  // どちら側かは follows.is_local（ローカル=1 / リモート=0）をそのまま使う。
  const following = await db.prepare(`
    SELECT f.*,
      COALESCE(NULLIF(r.name, ''), u.name, '') AS name,
      COALESCE(NULLIF(r.username, ''), u.id, '') AS username,
      COALESCE(NULLIF(r.domain, ''), ?) AS domain,
      COALESCE(NULLIF(r.icon_url, ''), NULLIF(u.icon_url, ''), '') AS icon_url
    FROM follows f
    LEFT JOIN remote_actors r ON f.following_url = r.id
    LEFT JOIN users u ON f.following_url = ? || u.id
    WHERE f.follower_url = ?
    ORDER BY f.created_at DESC
  `).all(config.domain, `${config.origin}/users/`, myActorUrl);

  res.json(following);
}));

// フォロワーリスト
apiRouter.get('/followers', asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.query.userId as string) || req.user?.id;
  if (!userId) {
    return res.status(400).json({ error: 'userId が必要です。' });
  }

  // userId はローカルの ID のほか、リモートのプロフィールから渡される actor URL も受け付ける
  const myActorUrl = userId.startsWith('http') ? userId : `${config.origin}/users/${userId}`;
  // 承認済みのフォロワーのみ（鍵アカウントの承認待ちは含めない）。表示用に相手の名前とアイコンも埋める
  const followers = await db.prepare(`
    SELECT f.*,
      COALESCE(NULLIF(r.name, ''), u.name, '') AS name,
      COALESCE(NULLIF(r.username, ''), u.id, '') AS username,
      COALESCE(NULLIF(r.domain, ''), ?) AS domain,
      COALESCE(NULLIF(r.icon_url, ''), NULLIF(u.icon_url, ''), '') AS icon_url
    FROM follows f
    LEFT JOIN remote_actors r ON f.follower_url = r.id
    LEFT JOIN users u ON f.follower_url = ? || u.id
    WHERE f.following_url = ? AND f.status = 'accepted'
    ORDER BY f.created_at DESC
  `).all(config.domain, `${config.origin}/users/`, myActorUrl);

  res.json(followers);
}));

// サーバー公開情報
/**
 * インスタンスの件数（`/api/server-info` の stats）。
 *
 * `COUNT(*) FROM posts WHERE is_local = 0` はリモート投稿の全件走査になる。実測で SQLite 12ms、
 * PostgreSQL 242ms（並列 seq scan）かかり、画面を開くたびに踏むには重すぎる。公開統計なので
 * 60 秒だけ覚えておく（負荷試験では読みの 3 分の 1 がこのエンドポイントだった）。
 */
const SERVER_INFO_COUNTS_TTL_MS = 60_000;
let serverInfoCountsCache: { at: number; users: number; localPosts: number; federatedPosts: number } | null = null;

async function getServerInfoCounts(): Promise<{ users: number; localPosts: number; federatedPosts: number }> {
  const now = Date.now();
  if (serverInfoCountsCache && now - serverInfoCountsCache.at < SERVER_INFO_COUNTS_TTL_MS) {
    return serverInfoCountsCache;
  }
  // 3 本は互いに独立なので並行に投げる（PostgreSQL ではプールから別々の接続で走る）
  const [users, localPosts, federatedPosts] = await Promise.all([
    db.prepare("SELECT COUNT(*) as c FROM users WHERE approval_status = 'approved'").get() as Promise<{ c: number }>,
    db.prepare('SELECT COUNT(*) as c FROM posts WHERE is_local = 1').get() as Promise<{ c: number }>,
    db.prepare('SELECT COUNT(*) as c FROM posts WHERE is_local = 0').get() as Promise<{ c: number }>,
  ]);
  serverInfoCountsCache = { at: now, users: Number(users.c), localPosts: Number(localPosts.c), federatedPosts: Number(federatedPosts.c) };
  return serverInfoCountsCache;
}

apiRouter.get('/server-info', asyncHandler(async (req: Request, res: Response) => {
  const counts = await getServerInfoCounts();
  const instanceInfo = getInstanceInfo();

  res.json({
    name: instanceInfo.name,
    description: instanceInfo.description,
    icon_url: instanceInfo.icon_url,
    banner_url: instanceInfo.banner_url,
    registration_mode: instanceInfo.registration_mode,
    tos_url: instanceInfo.tos_url,
    privacy_policy_url: instanceInfo.privacy_policy_url,
    contact_url: instanceInfo.contact_url,
    repository_url: instanceInfo.repository_url,
    operator_url: instanceInfo.operator_url,
    server_rules: instanceInfo.server_rules,
    require_rules_agreement: instanceInfo.require_rules_agreement,
    origin: config.origin,
    domain: config.domain,
    port: config.port,
    // 機能フラグ（クライアントは起動時に見て導線の出し分けを決める。既存の形は壊さず追加だけする）
    features: dmFeatureFlags(),
    stats: {
      users: counts.users,
      totalPosts: counts.localPosts,
      federatedPosts: counts.federatedPosts,
    },
  });
}));

// 公開カスタム絵文字一覧（投稿・リアクションのピッカー用）
apiRouter.get('/emojis', asyncHandler(async (req: Request, res: Response) => {
  try {
    const emojis = await db.prepare(`
      SELECT id, name, url, category, aliases FROM custom_emojis ORDER BY category ASC, name ASC
    `).all() as unknown as CustomEmojiRow[];
    res.json(emojis);
  } catch (err: any) {
    console.error('[API Emojis Error]:', err);
    res.status(500).json({ error: 'カスタム絵文字の取得に失敗しました。' });
  }
}));

apiRouter.use(notificationsRouter);

apiRouter.use(bookmarksRouter);

apiRouter.use(pinRouter);

apiRouter.use(blocksRouter);

// ==========================================
// 入力補完 (オートコンプリート: ユーザー & ハッシュタグ)
// ==========================================

// ユーザー入力補完 (@メンション用)
apiRouter.get('/autocomplete/users', asyncHandler(async (req: Request, res: Response) => {
  const q = ((req.query.q as string) || '').trim().replace(/^@/, '').toLowerCase();
  const currentUserId = req.user?.id;
  const currentActorUrl = currentUserId ? `${config.origin}/users/${currentUserId}` : null;

  try {
    const results: any[] = [];
    const seen = new Set<string>();

    // 1. ログインユーザーがフォロー中のユーザーから検索（優先度高）
    if (currentActorUrl) {
      const followRows = await db.prepare(`
        SELECT r.id, r.username, r.name, r.domain, r.icon_url
        FROM follows f
        JOIN remote_actors r ON f.following_url = r.id
        WHERE f.follower_url = ? AND (LOWER(r.username) LIKE ? OR LOWER(r.name) LIKE ?)
        LIMIT 6
      `).all(currentActorUrl, `%${q}%`, `%${q}%`) as any[];

      for (const r of followRows) {
        const handle = `@${r.username}@${r.domain}`;
        if (!seen.has(handle.toLowerCase())) {
          seen.add(handle.toLowerCase());
          results.push({
            id: r.id,
            username: r.username,
            name: r.name || r.username,
            handle,
            icon_url: r.icon_url || '',
            is_following: true,
          });
        }
      }
    }

    // 2. ローカルユーザーから検索
    const localUsers = await db.prepare(`
      SELECT id, name, icon_url
      FROM users
      WHERE LOWER(id) LIKE ? OR LOWER(name) LIKE ?
      LIMIT 6
    `).all(`%${q}%`, `%${q}%`) as any[];

    for (const u of localUsers) {
      const handle = `@${u.id}@${config.domain}`;
      if (!seen.has(handle.toLowerCase())) {
        seen.add(handle.toLowerCase());
        results.push({
          id: u.id,
          username: u.id,
          name: u.name,
          handle,
          icon_url: u.icon_url || '',
          is_following: false,
        });
      }
    }

    // 3. その他リモートアクターから検索（件数枠が余っている場合）
    if (results.length < 8) {
      const remainingLimit = 8 - results.length;
      const remoteUsers = await db.prepare(`
        SELECT id, username, name, domain, icon_url
        FROM remote_actors
        WHERE LOWER(username) LIKE ? OR LOWER(name) LIKE ?
        LIMIT ?
      `).all(`%${q}%`, `%${q}%`, remainingLimit) as any[];

      for (const r of remoteUsers) {
        const handle = `@${r.username}@${r.domain}`;
        if (!seen.has(handle.toLowerCase())) {
          seen.add(handle.toLowerCase());
          results.push({
            id: r.id,
            username: r.username,
            name: r.name || r.username,
            handle,
            icon_url: r.icon_url || '',
            is_following: false,
          });
        }
      }
    }

    res.json(results.slice(0, 8));
  } catch (err: any) {
    console.error('[Autocomplete Users Error]:', err);
    res.status(500).json({ error: 'ユーザー補完に失敗しました。' });
  }
}));

// ハッシュタグ入力補完 (#タグ用)
apiRouter.get('/autocomplete/tags', asyncHandler(async (req: Request, res: Response) => {
  const rawQ = ((req.query.q as string) || '').trim().replace(/^#/, '').toLowerCase();

  try {
    // フォロワー限定投稿のタグは候補に出さない
    // DM（visibility = 'direct'）はタグ候補に出さない
    const recentPosts = await db.prepare("SELECT content FROM posts WHERE COALESCE(visibility, 'public') NOT IN ('followers', 'direct') ORDER BY published_at DESC LIMIT 300").all() as { content: string }[];
    const tagCountMap = new Map<string, number>();

    const tagRegex = /#([a-zA-Z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)/gu;
    for (const post of recentPosts) {
      const cleanContent = post.content.replace(/<[^>]*>/g, ' ');
      const matches = cleanContent.matchAll(tagRegex);
      const seenInPost = new Set<string>();
      for (const match of matches) {
        const tag = match[1];
        const lower = tag.toLowerCase();
        if ((!rawQ || lower.includes(rawQ)) && !seenInPost.has(lower)) {
          seenInPost.add(lower);
          tagCountMap.set(tag, (tagCountMap.get(tag) || 0) + 1);
        }
      }
    }

    const matchedTags = Array.from(tagCountMap.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    res.json(matchedTags);
  } catch (err: any) {
    console.error('[Autocomplete Tags Error]:', err);
    res.status(500).json({ error: 'ハッシュタグ補完に失敗しました。' });
  }
}));

// ==========================================
// 🔔 Web Push 通知 API (PWA / VAPID)
// ==========================================

// VAPID 公開鍵取得
apiRouter.get('/push/vapid-public-key', (req: Request, res: Response) => {
  try {
    const publicKey = getVapidPublicKey();
    res.json({ publicKey });
  } catch (err: any) {
    console.error('[WebPush Error] Failed to get VAPID public key:', err);
    res.status(500).json({ error: 'VAPID 公開鍵の取得に失敗しました。' });
  }
});

// 📢 お知らせ（サーバーからの一斉告知）: 有効なもののみ公開
apiRouter.get('/announcements', asyncHandler(async (_req: Request, res: Response) => {
  try {
    const rows = await db.prepare(`
      SELECT id, title, content, created_at, updated_at FROM announcements
      WHERE is_active = 1
      ORDER BY created_at DESC LIMIT 20
    `).all();
    res.json(rows);
  } catch (err: any) {
    console.error('[Announcements Error]:', err);
    res.status(500).json({ error: 'お知らせの取得に失敗しました。' });
  }
}));

// 👥 ユーザーディレクトリ（公開プロフィールの一覧）
apiRouter.get('/directory', asyncHandler(async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100);
  const q = String(req.query.q || '').trim();
  // ログイン中は「自分」と「もうフォローしている人」を外す（「おすすめ」欄がフォロー済みで
  // 埋まらないように）。外すぶん多めに引いてから詰める。未ログインの公開一覧はそのまま
  const viewerActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;
  const fetchLimit = viewerActorUrl && !q ? Math.min(limit * 2, 100) : limit;

  try {
    const initialRows = await db.prepare(`
      SELECT id, name, summary, icon_url, banner_url, created_at, fields, discoverable
      FROM users
      WHERE is_frozen = 0 AND approval_status = 'approved' AND COALESCE(discoverable, 1) = 1
        AND (? = '' OR id LIKE ? OR name LIKE ?)
      ORDER BY created_at ASC
      LIMIT ?
    `).all(q, `%${q}%`, `%${q}%`, fetchLimit) as any[];

    // フォロー中（承認済み）の actor URL を 1 本で引いて落とす
    let rows = initialRows;
    if (viewerActorUrl) {
      const followedRows = (await db
        .prepare("SELECT following_url FROM follows WHERE follower_url = ? AND status = 'accepted'")
        .all(viewerActorUrl)) as { following_url: string }[];
      const followed = new Set(followedRows.map((row) => row.following_url));
      rows = initialRows
        .filter((user) => user.id !== req.user!.id && !followed.has(`${config.origin}/users/${user.id}`))
        .slice(0, limit);
    }

    // 利用者ごとに 3 本ずつ撃つと 50 人で 150 クエリになる。しかも投稿数の
    // `COUNT(*) FROM posts WHERE user_id = ?` は user_id に索引が無く全件走査（実測 116ms/人）。
    // **IN でまとめて 3 本**にし、数え上げは索引の効く author_url で行う（実測 6.2ms/人 → まとめると実質 0）。
    const actorUrls = rows.map((user) => `${config.origin}/users/${user.id}`);
    const userIds = rows.map((user) => user.id);
    const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');

    const [postCountRows, followerCountRows, roleRows] = rows.length === 0
      ? [[], [], []]
      : await Promise.all([
          db.prepare(`SELECT author_url AS k, COUNT(*) AS c FROM posts WHERE author_url IN (${marks(actorUrls.length)}) GROUP BY author_url`)
            .all(...actorUrls) as Promise<{ k: string; c: number }[]>,
          db.prepare(`SELECT following_url AS k, COUNT(*) AS c FROM follows WHERE following_url IN (${marks(actorUrls.length)}) AND status = 'accepted' GROUP BY following_url`)
            .all(...actorUrls) as Promise<{ k: string; c: number }[]>,
          db.prepare(`
            SELECT ur.user_id AS k, r.id, r.name, r.color FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id IN (${marks(userIds.length)})
            ORDER BY ur.user_id ASC, r.created_at ASC
          `).all(...userIds) as Promise<{ k: string; id: string; name: string; color: string }[]>,
        ]);

    const postCounts = new Map(postCountRows.map((row) => [row.k, Number(row.c)]));
    const followerCounts = new Map(followerCountRows.map((row) => [row.k, Number(row.c)]));
    const rolesByUser = new Map<string, { id: string; name: string; color: string }[]>();
    for (const row of roleRows) {
      const list = rolesByUser.get(row.k) ?? [];
      list.push({ id: row.id, name: row.name, color: row.color });
      rolesByUser.set(row.k, list);
    }

    const users = rows.map((user) => {
      const actorUrl = `${config.origin}/users/${user.id}`;
      return {
        id: user.id,
        name: user.name,
        summary: user.summary || '',
        icon_url: user.icon_url || '',
        banner_url: user.banner_url || '',
        handle: `@${user.id}@${config.domain}`,
        actor_url: actorUrl,
        created_at: user.created_at,
        post_count: postCounts.get(actorUrl) ?? 0,
        follower_count: followerCounts.get(actorUrl) ?? 0,
        fields: parseProfileFields((user as any).fields).map((f) => ({ name: f.name, value: f.value })),
        roles: rolesByUser.get(user.id) ?? [],
      };
    });

    res.json({ users, total: users.length });
  } catch (err: any) {
    console.error('[Directory Error]:', err);
    res.status(500).json({ error: 'ユーザーディレクトリの取得に失敗しました。' });
  }
}));

// 🔇 ワードフィルター（ミュートワード）管理
apiRouter.get('/muted-words', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const words = await db.prepare(
    'SELECT id, keyword, case_sensitive, whole_word, created_at FROM muted_words WHERE user_id = ? ORDER BY created_at DESC',
  ).all(user.id);
  res.json(words);
}));

apiRouter.post('/muted-words', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const { keyword, caseSensitive, wholeWord } = req.body;
  const value = typeof keyword === 'string' ? keyword.trim().slice(0, 100) : '';
  if (!value) {
    return res.status(400).json({ error: 'キーワードを入力してください。' });
  }

  const existing = await db.prepare('SELECT id FROM muted_words WHERE user_id = ? AND keyword = ?').get(user.id, value);
  if (existing) {
    return res.status(409).json({ error: '同じキーワードが既に登録されています。' });
  }

  const count = (await db.prepare('SELECT COUNT(*) AS c FROM muted_words WHERE user_id = ?').get(user.id) as { c: number }).c;
  if (count >= 200) {
    return res.status(400).json({ error: '登録できるキーワードは 200 件までです。' });
  }

  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO muted_words (id, user_id, keyword, case_sensitive, whole_word, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, user.id, value, caseSensitive ? 1 : 0, wholeWord ? 1 : 0, new Date().toISOString());
  // ミュートワードは自分の画面の絞り込みなので、設定した瞬間に効かせる
  invalidateMutedWords(user.id);
  await invalidateTimelineCache();

  console.log(`[WordFilter] 🔇 @${user.id} が「${value}」をミュートワードに追加しました`);
  res.status(201).json({ success: true, id, keyword: value });
}));

apiRouter.delete('/muted-words/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const result = await db.prepare('DELETE FROM muted_words WHERE id = ? AND user_id = ?').run(String(req.params.id), user.id);
  invalidateMutedWords(user.id);
  await invalidateTimelineCache();
  if (result.changes === 0) {
    return res.status(404).json({ error: 'キーワードが見つかりません。' });
  }
  res.json({ success: true });
}));

// 🔒 フォローリクエスト（鍵アカウントの承認待ち）
export const handleListFollowRequests = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const myActorUrl = `${config.origin}/users/${user.id}`;
  const rows = await db.prepare(`
    SELECT id, follower_url, inbox_url, created_at FROM follows
    WHERE following_url = ? AND status = 'pending'
    ORDER BY created_at DESC LIMIT 200
  `).all(myActorUrl) as { id: string; follower_url: string; inbox_url: string; created_at: string }[];

  const enriched = await Promise.all(rows.map(async (row) => {
    const remote = await db.prepare('SELECT username, domain, name, icon_url FROM remote_actors WHERE id = ?').get(row.follower_url) as
      | { username: string; domain: string; name: string | null; icon_url: string | null }
      | undefined;
    return {
      id: row.id,
      actor_url: row.follower_url,
      handle: remote ? `@${remote.username}@${remote.domain}` : row.follower_url,
      name: remote?.name || remote?.username || row.follower_url,
      icon_url: remote?.icon_url || '',
      created_at: row.created_at,
    };
  }));

  res.json(enriched);
});
apiRouter.get('/follow-requests', requireAuth, handleListFollowRequests);

// フォローリクエストの承認 / 拒否
export const handleRespondFollowRequest = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const actorUrl = typeof req.body?.actorUrl === 'string' ? req.body.actorUrl.trim() : '';
  const action = req.body?.action === 'accept' ? 'accept' : req.body?.action === 'reject' ? 'reject' : null;

  if (!actorUrl || !action) {
    return res.status(400).json({ error: 'actorUrl と action (accept / reject) が必要です。' });
  }

  const myActorUrl = `${config.origin}/users/${user.id}`;
  const row = await db.prepare('SELECT * FROM follows WHERE follower_url = ? AND following_url = ?').get(actorUrl, myActorUrl) as
    | { id: string; follower_url: string; following_url: string; inbox_url: string; status: string }
    | undefined;

  if (!row) {
    return res.status(404).json({ error: 'フォローリクエストが見つかりません。' });
  }

  // 承認・拒否の対象となる Follow Activity を組み立てる
  const followActivity = {
    '@context': ['https://www.w3.org/ns/activitystreams'],
    id: `${row.id}#follow`,
    type: 'Follow',
    actor: row.follower_url,
    object: myActorUrl,
  };

  if (action === 'accept') {
    await db.prepare("UPDATE follows SET status = 'accepted' WHERE follower_url = ? AND following_url = ?").run(actorUrl, myActorUrl);
    console.log(`[FollowRequest] ✅ @${user.id} が ${actorUrl} のフォローを承認しました`);
    if (row.inbox_url) {
      deliverActivity({
        inboxUrl: row.inbox_url,
        activity: buildAcceptActivity({ actorUrl: myActorUrl, followActivity }),
        senderUser: user,
      }).catch(() => {});
    }
  } else {
    await db.prepare('DELETE FROM follows WHERE follower_url = ? AND following_url = ?').run(actorUrl, myActorUrl);
    console.log(`[FollowRequest] 🚫 @${user.id} が ${actorUrl} のフォローを拒否しました`);
    if (row.inbox_url) {
      deliverActivity({
        inboxUrl: row.inbox_url,
        activity: buildRejectActivity({ actorUrl: myActorUrl, followActivity }),
        senderUser: user,
      }).catch(() => {});
    }
  }

  res.json({ success: true, action, actorUrl });
});
apiRouter.post('/follow-requests/respond', requireAuth, handleRespondFollowRequest);

apiRouter.use(listsRouter);

// 📥 アカウント移行インポート
//    - Spica 自身のエクスポート（ZIP / JSON）: 投稿に加えてメディア・フォロー・フォロワー・
//      ブックマーク・リアクションまで取り込む（メディアは ZIP に同梱された実ファイルを使う）
//    - Mastodon の outbox.json / Misskey の notes.json: 本文（CW・公開範囲・投稿日時つき）
const MAX_IMPORT_ARCHIVE_BYTES = 50 * 1024 * 1024;

const archiveUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_ARCHIVE_BYTES },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    if (file.mimetype.includes('json') || file.mimetype.includes('zip') || name.endsWith('.json') || name.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('インポートするファイル（Spica のエクスポート ZIP / JSON、Mastodon の outbox.json、Misskey の notes.json）を選択してください。'));
    }
  },
});

/** multer のエラー（サイズ超過・形式違い）を 400 で返す */
const archiveUploadMiddleware = (req: Request, res: Response, next: NextFunction) => {
  archiveUpload.single('archive')(req, res, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          error: `アーカイブのサイズが大きすぎます（上限 ${Math.floor(MAX_IMPORT_ARCHIVE_BYTES / (1024 * 1024))}MB）。`,
        });
      }
      return res.status(400).json({ error: err.message || 'アーカイブの受け取りに失敗しました。' });
    }
    next();
  });
};

apiRouter.post('/import/archive', requireAuth, archiveUploadMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const file = (req as Request & { file?: { buffer: Buffer } }).file;
  if (!file) {
    return res.status(400).json({ error: 'アーカイブファイル（ZIP / JSON）が必要です。' });
  }

  // 1. ZIP（Spica のエクスポート）: 中の JSON とメディアの実ファイルを読む
  //    パス検証（zip-slip 対策）と件数・サイズの上限はリーダー側で掛ける
  if (isZipBuffer(file.buffer)) {
    let entries: Map<string, Buffer>;
    try {
      const zip = readZipEntries(file.buffer);
      entries = zip.entries;
      if (zip.skipped.length > 0) {
        console.warn(
          `[Import] ⚠️ @${user.id} の ZIP で読み飛ばしたファイル: ${zip.skipped.slice(0, 5).join(', ')}` +
          (zip.skipped.length > 5 ? ` ほか ${zip.skipped.length - 5} 件` : ''),
        );
      }
    } catch (err: any) {
      return res.status(400).json({ error: `ZIP を読み込めませんでした: ${err?.message || err}` });
    }

    try {
      const bundle = buildSpicaBundleFromZip(entries);
      if (bundle.posts.length === 0 && bundle.media.length === 0) {
        return res.status(400).json({ error: '取り込めるデータが見つかりませんでした（Spica のエクスポート ZIP を選択してください）。' });
      }

      const result = await importSpicaArchive(user, bundle);
      console.log(
        `[Import] 📥 @${user.id} が Spica のエクスポート（ZIP）を取り込み: 投稿=${result.imported} メディア=${result.media.imported} ` +
        `フォロー=${result.following.imported} フォロワー=${result.followers.imported} ブックマーク=${result.bookmarks.imported} リアクション=${result.reactions.imported}`,
      );

      return res.json({ success: true, ...result, message: buildImportMessage(result) });
    } catch (err: any) {
      console.error('[Import Error]:', err);
      return res.status(500).json({ error: err.message || 'インポートに失敗しました。' });
    }
  }

  // 2. JSON（Spica のエクスポート / Mastodon / Misskey）: 形式を判定して取り込む
  let data: any;
  try {
    data = JSON.parse(file.buffer.toString('utf8'));
  } catch {
    return res.status(400).json({
      error: 'JSON の解析に失敗しました。Spica のエクスポート、Mastodon の outbox.json、Misskey の notes.json のいずれかを選択してください。',
    });
  }

  try {
    const { format, notes } = parseArchive(data);

    // Spica 自身のエクスポート（JSON 単体。メディアの実ファイルは無いのでスキップされる）
    if (format === 'spica') {
      const bundle = buildSpicaBundle(data);
      if (bundle.posts.length === 0) {
        return res.status(400).json({ error: '取り込める投稿が見つかりませんでした（ファイル形式をご確認ください）。', format });
      }

      const result = await importSpicaArchive(user, bundle);
      console.log(
        `[Import] 📥 @${user.id} が Spica のエクスポート（JSON）を取り込み: 投稿=${result.imported} メディア=${result.media.imported} ` +
        `フォロー=${result.following.imported} フォロワー=${result.followers.imported} ブックマーク=${result.bookmarks.imported} リアクション=${result.reactions.imported}`,
      );

      return res.json({ success: true, ...result, message: buildImportMessage(result) });
    }

    if (notes.length === 0) {
      return res.status(400).json({ error: '取り込める投稿が見つかりませんでした（ファイル形式をご確認ください）。', format });
    }

    const result = await importNotes(user, notes);
    console.log(
      `[Import] 📥 @${user.id} が投稿を取り込み: imported=${result.imported} skipped=${result.skipped} failed=${result.failed} (format=${format})`,
    );

    res.json({
      success: true,
      format,
      ...result,
      message: buildImportMessage(result),
    });
  } catch (err: any) {
    console.error('[Import Error]:', err);
    res.status(500).json({ error: err.message || 'インポートに失敗しました。' });
  }
}));

// 📧 メールアドレスの登録（任意・マスターキー方式のサーバー向け）
//     ※ ログインには使わず、マスターキーを紛失したときの復元手段としてのみ利用する

/** メールアドレスの形式チェック（厳密な完全検証ではなく実用範囲） */
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

/** メール登録が許可されているか（管理者設定） */
function isEmailRegistrationAllowed(): boolean {
  return String(getServerSetting('allow_email_registration', 'false')).toLowerCase() === 'true';
}

/** インスタンスの認証方式（master_key / password） */
async function getAuthMode(): Promise<'master_key' | 'password'> {
  return String(getServerSetting('auth_mode', 'master_key')).toLowerCase() === 'password' ? 'password' : 'master_key';
}

// メール登録・復元の利用可否（クライアントがUIを出し分けるための情報）
apiRouter.get('/auth/recovery/status', asyncHandler(async (_req: Request, res: Response) => {
  res.json({
    authMode: await getAuthMode(),
    allowEmailRegistration: isEmailRegistrationAllowed(),
    mailConfigured: await isMailConfigured(),
    recoveryAvailable: isEmailRegistrationAllowed() && (await isMailConfigured()),
  });
}));

// メールアドレスの登録（確認コードを送信）
// 🔑 パスワードの設定・変更（パスワード方式のサーバー向け）
//    既存ユーザー（登録時にパスワードが無いユーザー）はマスターキーで設定できる
apiRouter.post('/user/password', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  const masterKey = typeof req.body?.masterKey === 'string' ? req.body.masterKey.trim() : '';

  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'パスワードは8文字以上で入力してください。' });
  }

  const hasPassword = Boolean((user as any).password_hash);
  const masterKeyOk = masterKey ? hashMasterKey(masterKey) === user.master_key_hash : false;
  const currentPasswordOk = hasPassword && currentPassword ? verifyPassword(currentPassword, (user as any).password_hash) : false;

  // 設定済み: 現在のパスワードまたはマスターキー / 未設定: マスターキー で本人確認する
  if (hasPassword ? !(currentPasswordOk || masterKeyOk) : !masterKeyOk) {
    return res.status(403).json({
      error: hasPassword
        ? '現在のパスワードまたはマスターキーが正しくありません。'
        : 'パスワードを設定するにはマスターキーが必要です。',
    });
  }

  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
  console.log(`[Password] 🔑 @${user.id} のパスワードを${hasPassword ? '変更' : '設定'}しました`);
  res.json({ success: true, message: hasPassword ? 'パスワードを変更しました。' : 'パスワードを設定しました。' });
}));

apiRouter.post('/user/email', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';

  // 既に登録済みのメールアドレスの「確認」は、メール登録が許可されていないサーバーでも行える
  const existingEmail = String((user as any).email || '').toLowerCase();
  const isReverify = existingEmail !== '' && existingEmail === email;

  if (!isEmailRegistrationAllowed() && !isReverify) {
    return res.status(403).json({ error: 'このサーバーではメールアドレスの登録が許可されていません。' });
  }
  if (!(await isMailConfigured())) {
    return res.status(503).json({ error: 'サーバーのメール送信が設定されていないため登録できません。' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'メールアドレスの形式が正しくありません。' });
  }

  // 既に他のユーザーが確認済みで使っているメールは登録できない
  const taken = await db.prepare('SELECT id FROM users WHERE email = ? AND email_verified = 1 AND id != ?').get(email, user.id);
  if (taken) {
    return res.status(409).json({ error: 'このメールアドレスは既に使用されています。' });
  }

  try {
    const code = generateVerificationCode();
    await issueVerificationCode({ userId: user.id, email, purpose: 'verify_email', code });
    await db.prepare('UPDATE users SET email = ?, email_verified = 0 WHERE id = ?').run(email, user.id);

    const sent = await sendMail({
      to: email,
      subject: `【${config.instanceName}】メールアドレス確認コード`,
      text: [
        `${config.instanceName} (${config.domain}) のメールアドレス確認です。`,
        '',
        `確認コード: ${code}`,
        '',
        'このコードは10分間有効です。心当たりがない場合はこのメールを破棄してください。',
        (await getAuthMode()) === 'password'
          ? '※ このメールアドレスはログインとマスターキーの復元に使用します。'
          : '※ このメールアドレスはログインには使われません。マスターキーを紛失したときの復元にのみ使用します。',
      ].join('\n'),
    });

    if (!sent.ok) {
      return res.status(502).json({ error: `確認メールの送信に失敗しました: ${sent.error}` });
    }

    res.json({ success: true, message: '確認コードをメールで送信しました。' });
  } catch (err: any) {
    console.error('[Email Register Error]:', err);
    res.status(500).json({ error: 'メールアドレスの登録に失敗しました。' });
  }
}));

// 確認コードの検証（メールアドレスの有効化）
apiRouter.post('/user/email/verify', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';

  if (!code || !email) {
    return res.status(400).json({ error: 'メールアドレスと確認コードを入力してください。' });
  }

  const result = await verifyCode({ userId: user.id, email, code, purpose: 'verify_email' });
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  await db.prepare('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?').run(email, user.id);
  console.log(`[Email] ✅ @${user.id} のメールアドレスを確認しました`);
  res.json({ success: true, message: 'メールアドレスを確認しました。マスターキーを紛失した際に復元できます。' });
}));

// メールアドレスの削除
apiRouter.delete('/user/email', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  await db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(user.id);
  await db.prepare("UPDATE users SET email = '', email_verified = 0 WHERE id = ?").run(user.id);
  console.log(`[Email] 🗑️ @${user.id} がメールアドレスを削除しました`);
  res.json({ success: true });
}));

// 🔑 マスターキー紛失時の復元（手順: ID+メール → 確認コード → 新しいキーをメールで受領）
apiRouter.post('/auth/recovery/request', asyncHandler(async (req: Request, res: Response) => {
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim().replace(/^@/, '').toLowerCase() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';

  // 存在の有無を漏らさないため、どのような場合でも同じ応答を返す
  const genericResponse = {
    success: true,
    message: '入力された情報に一致するアカウントがあり、メールアドレスが確認済みの場合は、確認コードを送信しました。',
  };

  if (!userId || !isValidEmail(email) || !isEmailRegistrationAllowed() || !(await isMailConfigured())) {
    return res.json(genericResponse);
  }

  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as unknown as UserRow | undefined;
    if (!user || !user.email || user.email.toLowerCase() !== email || Number((user as any).email_verified) !== 1) {
      console.log(`[Recovery] 該当なし（存在秘匿）: id=${userId}`);
      return res.json(genericResponse);
    }

    const code = generateVerificationCode();
    await issueVerificationCode({ userId: user.id, email, purpose: 'recovery', code });

    const sent = await sendMail({
      to: email,
      subject: `【${config.instanceName}】マスターキー復元の確認コード`,
      text: [
        `${config.instanceName} (${config.domain}) のマスターキー復元リクエストを受け付けました。`,
        '',
        `確認コード: ${code}`,
        '',
        'このコードは10分間有効です。',
        'コードを入力すると、新しいマスターキーがこのメールアドレス宛に発行されます。',
        '',
        '※ 心当たりがない場合は、このメールを破棄してください。あなたの現在のマスターキーは変わりません。',
      ].join('\n'),
    });

    if (!sent.ok) {
      console.error('[Recovery] 確認コードの送信に失敗しました:', sent.error);
    }
    res.json(genericResponse);
  } catch (err: any) {
    console.error('[Recovery Request Error]:', err);
    res.json(genericResponse);
  }
}));

// 確認コードの検証 → 新しいマスターキーを発行してメールで送る
apiRouter.post('/auth/recovery/verify', asyncHandler(async (req: Request, res: Response) => {
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim().replace(/^@/, '').toLowerCase() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';

  if (!userId || !isValidEmail(email) || !code) {
    return res.status(400).json({ error: 'ユーザーID・メールアドレス・確認コードを入力してください。' });
  }
  if (!isEmailRegistrationAllowed() || !(await isMailConfigured())) {
    return res.status(403).json({ error: 'このサーバーでは復元機能が利用できません。' });
  }

  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as unknown as UserRow | undefined;
    if (!user || !user.email || user.email.toLowerCase() !== email || Number((user as any).email_verified) !== 1) {
      return res.status(400).json({ error: 'ユーザーIDまたはメールアドレスが正しくありません。' });
    }

    const verified = await verifyCode({ userId: user.id, email, code, purpose: 'recovery' });
    if (!verified.ok) {
      return res.status(400).json({ error: verified.error });
    }

    // 新しいマスターキーを生成して先にメール送信し、成功した場合のみDBを更新する
    // （送信に失敗したままキーを更新すると、ユーザーが締め出されるため）
    const newMasterKey = generateMasterKey();
    const sent = await sendMail({
      to: email,
      subject: `【${config.instanceName}】新しいマスターキー`,
      text: [
        `${config.instanceName} (${config.domain}) の新しいマスターキーです。`,
        '',
        `ユーザーID: ${user.id}`,
        `新しいマスターキー: ${newMasterKey}`,
        '',
        'このキーは再発行されません。安全な場所に保管してください。',
        '以前のマスターキーは無効になりました。',
      ].join('\n'),
    });

    if (!sent.ok) {
      return res.status(502).json({ error: `新しいマスターキーの送信に失敗しました: ${sent.error}` });
    }

    await db.prepare('UPDATE users SET master_key_hash = ? WHERE id = ?').run(hashMasterKey(newMasterKey), user.id);
    // 復元後は既存セッションをすべて無効化する（乗っ取り対策）
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

    console.log(`[Recovery] 🔑 @${user.id} のマスターキーを再発行しました`);
    res.json({
      success: true,
      message: '新しいマスターキーをメールで送信しました。以前のキーは無効になり、再ログインが必要です。',
    });
  } catch (err: any) {
    console.error('[Recovery Verify Error]:', err);
    res.status(500).json({ error: '復元処理に失敗しました。' });
  }
}));

// 🚩 通報の作成（投稿 / ユーザー）
apiRouter.post('/reports', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
apiRouter.get('/reports/mine', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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

// 端末の PushSubscription 登録
apiRouter.post('/push/subscribe', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return res.status(400).json({ error: '無効な PushSubscription 形式です。' });
  }

  // SSRF 対策: 内部アドレス等を送信先として登録させない（購読時に検証）
  const endpointSafety = await assertFetchableRemoteUrl(subscription.endpoint);
  if (!endpointSafety.safe) {
    return res.status(400).json({ error: `プッシュ通知の送信先 URL は許可されていません (${endpointSafety.reason})` });
  }

  try {
    await savePushSubscription({
      userId: req.user!.id,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    });

    res.json({ success: true, message: 'Web Push 通知の受信端末を登録しました。' });
  } catch (err: any) {
    console.error('[WebPush Error] Subscribe failed:', err);
    res.status(500).json({ error: 'プッシュ通知の購読登録に失敗しました。' });
  }
}));

// 端末の PushSubscription 解除
apiRouter.post('/push/unsubscribe', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { endpoint } = req.body;
  if (endpoint && typeof endpoint === 'string') {
    await removePushSubscription(endpoint);
  }
  res.json({ success: true, message: 'Web Push 通知の登録を解除しました。' });
}));

// プッシュ通知登録状況の確認
apiRouter.get('/push/status', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const isSubscribed = await isUserSubscribed(req.user!.id);
  res.json({ isSubscribed });
}));

// テスト用プッシュ通知送信
apiRouter.post('/push/test', requireAuth, async (req: Request, res: Response) => {
  try {
    await sendPushToUser(req.user!.id, {
      title: 'Spica テスト通知 ✦',
      body: 'おめでとうございます！Web Push 通知が正常に接続されました。',
      icon: '/logo.jpg',
      url: '/?view=notifications',
    });
    res.json({ success: true, message: 'テスト通知を送信しました。端末をご確認ください。' });
  } catch (err: any) {
    console.error('[WebPush Test Error]:', err);
    res.status(500).json({ error: 'テスト通知の送信に失敗しました。' });
  }
});

apiRouter.use(antennasRouter);

apiRouter.use(draftsRouter);

apiRouter.use(webauthnRouter);

apiRouter.use(channelsRouter);

// ==========================================
// ✉️ DM（1対1のメッセージ）エンドポイント
//
//   - サーバー管理者の設定 `dm_enabled` が off のときは 404（「物理的に無い」扱い。docs/DM.md）
//   - 認可は既存の投稿と同じく requireAuth。本文・添付の扱いも既存の投稿作成に倣う
//   - 会話は専用テーブルを持たず、`in_reply_to` の連鎖で表現する（最初の 1 通が会話の頭）
// ==========================================
const dmRouter = Router();

// off のときは「物理的に無い」。403 だと「機能はあるが禁止」と分かってしまうため 404 にする
dmRouter.use((_req: Request, res: Response, next: NextFunction) => {
  if (!isDmEnabled()) {
    return res.status(404).json({ error: 'Not Found' });
  }
  next();
});

// 会話一覧（相手・最終メッセージ・未読数）
dmRouter.get('/conversations', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  res.json(await listDmConversations(user.id));
}));

// 会話の本文（時系列）。`cursor` を付けると、その位置より古い方を返す
dmRouter.get('/conversations/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const page = parsePageQuery(req, 50);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }
  const result = await getDmConversationMessages(user.id, String(req.params.id), page);
  if (!result) {
    return res.status(404).json({ error: '会話が見つかりません。' });
  }
  // 続きの読み込みは既存の一覧と同じく X-Next-Cursor でも返す（本文の next_cursor と同値）
  if (result.nextCursor) {
    res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor');
    res.setHeader('X-Next-Cursor', result.nextCursor);
  }
  res.json({
    conversation: result.conversation,
    messages: result.messages,
    next_cursor: result.nextCursor,
  });
}));

// 既読にする
dmRouter.post('/conversations/:id/read', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const result = await markDmConversationRead(user.id, String(req.params.id));
  if (!result) {
    return res.status(404).json({ error: '会話が見つかりません。' });
  }
  res.json({ success: true, updated: result.updated });
}));

// 送信（`to` はハンドル。`media` はアップロード済みメディアの配列）
dmRouter.post('/messages', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const result = await sendDmMessage({
    user,
    to: body.to,
    content: body.content,
    cw: body.cw,
    attachments: body.media !== undefined ? body.media : body.attachments,
    in_reply_to: body.in_reply_to,
  });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }
  res.status(result.status).json({
    message: result.message,
    delivered: result.delivered,
    ...(result.reason ? { reason: result.reason } : {}),
    federatedTo: result.federatedTo,
  });
}));

apiRouter.use('/dm', dmRouter);
