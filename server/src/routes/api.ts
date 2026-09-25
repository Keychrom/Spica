import { asyncHandler } from '../asyncHandler.js';
import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { db, UserRow, PostRow, FollowRow, RemoteActorRow, ReactionRow, AnnounceRow, isDomainBlocked, matchesBlockedDomainRule, loadBlockedDomainRules, createNotification, NotificationRow, getInstanceInfo, InvitationCodeRow, CustomEmojiRow, AntennaRow, DraftRow, ScheduledPostRow, ChannelRow, WebAuthnCredentialRow, getServerSetting, setServerSetting, NOTIFICATION_TYPES, NOTIFICATION_TYPE_LABELS, getNotificationPrefs, saveNotificationPrefs, getDisabledNotificationTypes } from '../db.js';
import { getEmailNotificationStatus, setEmailNotificationEnabled } from '../emailNotifier.js';
import { getUserPermissions } from '../auth.js';
import { config } from '../config.js';
import { generateKeyPair } from '../crypto.js';
import { assertFetchableRemoteUrl } from '../remoteFetchGuard.js';
import { applyPageHeaders, cursorPredicate, parsePageQuery } from '../pagination.js';
import { canViewPost, filterVisiblePosts, isPublicPost, normalizeVisibility } from '../postVisibility.js';
import { createReport, logNewReport } from '../reportService.js';
import { getMutedWords, postMatchesMutedWords } from '../wordFilter.js';
import { extractFirstUrl, getCachedPreviews } from '../linkPreview.js';
import { parseArchive, importNotes } from '../importService.js';
import { parseProfileFields } from '../activitypub.js';
import { isMailConfigured, sendMail, generateVerificationCode, issueVerificationCode, verifyCode, getMailConfig, saveMailConfig, verifyMailConnection } from '../mailService.js';

import { uploadMediaFile } from '../storage.js';
import { checkMediaQuota, deleteMedia, getMediaStats, listMedia, recordMedia, toClientMedia, unlinkMediaFromPost } from '../mediaService.js';
import { executeCreatePost } from '../postService.js';
import {
  createWebAuthnRegistrationOptions,
  verifyWebAuthnRegistration,
  createWebAuthnAuthenticationOptions,
  verifyWebAuthnAuthentication,
} from '../webauthnService.js';
import {
  generateMasterKey,
  hashMasterKey,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  requireAuth,
  getUserFromToken,
} from '../auth.js';
import { deleteUserAccount } from '../accountService.js';
import { exportUserData, streamUserExportZip } from '../exportService.js';
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
} from '../streaming.js';
import { parseStreams } from '../streamRouting.js';
import { cacheGet, cacheSet, isTimelineCacheEnabled } from '../timelineCache.js';
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
} from '../activitypub.js';

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
  const { id, name, summary, inviteCode, agreedToRules } = req.body;
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

  // ユーザー数の確認 (最初のユーザーは自動的に管理者)
  const userCount = (await db.prepare('SELECT COUNT(*) as c FROM users').get() as any).c;
  const role = userCount === 0 ? 'admin' : 'user';

  // 招待コード検証および利用規約・ルール同意検証（最初の管理者以外の登録時）
  let verifiedInviteCode: string | null = null;
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

    // 3. 招待制モード、または招待コードが入力された場合
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

  // 3. DB にユーザー保存
  await db.prepare(`
    INSERT INTO users (id, name, summary, master_key_hash, role, is_frozen, public_key_pem, private_key_pem, created_at, password_hash, email, email_verified)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
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
  );

  // 4. 招待コードの使用回数をインクリメント
  if (verifiedInviteCode) {
    try {
      await db.prepare('UPDATE invitation_codes SET used_count = used_count + 1 WHERE code = ?').run(verifiedInviteCode);
    } catch (e) {
      console.error('[Spica Register] Failed to increment invite code usage:', e);
    }
  }

  // 4. 初回セッションを発行
  const session = await createSession(cleanId);

  const actorUrl = `${config.origin}/users/${cleanId}`;
  const handle = `@${cleanId}@${config.domain}`;

  console.log(`[Spica Register] Account created successfully for ${handle}`);

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
    },
    masterKey, // ⚠️ ユーザーが安全に保存する秘密鍵
    sessionToken: session.token,
    sessionExpiresAt: session.expiresAt,
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

  const session = await createSession(user.id);
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

// 現在のログインユーザー情報
apiRouter.get('/auth/me', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const raw = req.rawUser;
  const myActorUrl = `${config.origin}/users/${user.id}`;
  const followerCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_url = ?').get(myActorUrl) as any).c;
  const followingCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE follower_url = ?').get(myActorUrl) as any).c;
  const postCount = (await db.prepare('SELECT COUNT(*) as c FROM posts WHERE user_id = ?').get(user.id) as any).c;

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
    // 権限の一覧（'admin' / 'moderate' など）。画面の出し分けはこの配列で判断する
    permissions: Array.from(await getUserPermissions(user)),
  });
}));

// ==========================================
// 📡 リアルタイムストリーミング (SSE) エンドポイント
//    ?streams=local,home,tag:foo で「受け取りたいもの」を申告する（省略時は全部＝従来どおり）
// ==========================================
apiRouter.get('/streaming', asyncHandler(async (req: Request, res: Response) => {
  let user = req.user;
  if (!user && req.query.token && typeof req.query.token === 'string') {
    user = await getUserFromToken(req.query.token) || undefined;
  }
  const clientId = addStreamClient(res, user?.id, parseStreams(req.query.streams));
  req.on('close', () => {
    removeStreamClient(clientId);
  });
}));

/**
 * 単一投稿用のアンケート情報を取得するヘルパー
 */
export async function getPollDataForPost(postId: string, currentUserId?: string | null) {
  try {
    const poll = await db.prepare('SELECT id, post_id, multiple, expires_at, created_at FROM polls WHERE post_id = ?').get(postId) as any;
    if (!poll) return null;

    const choices = await db.prepare(`
      SELECT choice_index, text, votes_count
      FROM poll_choices
      WHERE poll_id = ?
      ORDER BY choice_index ASC
    `).all(poll.id) as { choice_index: number; text: string; votes_count: number }[];

    let myVotedIndices = new Set<number>();
    if (currentUserId) {
      const myVotes = await db.prepare('SELECT choice_index FROM poll_votes WHERE poll_id = ? AND user_id = ?').all(poll.id, currentUserId) as { choice_index: number }[];
      myVotedIndices = new Set(myVotes.map((v) => v.choice_index));
    }

    const now = new Date().toISOString();
    const isExpired = poll.expires_at ? poll.expires_at < now : false;
    const totalVotes = choices.reduce((sum, c) => sum + (c.votes_count || 0), 0);

    return {
      id: poll.id,
      multiple: Boolean(poll.multiple),
      expires_at: poll.expires_at,
      is_expired: isExpired,
      total_votes: totalVotes,
      my_voted: myVotedIndices.size > 0,
      choices: choices.map((c) => ({
        choice_index: c.choice_index,
        text: c.text,
        votes_count: c.votes_count,
        me: myVotedIndices.has(c.choice_index),
      })),
    };
  } catch (err) {
    console.error('[getPollDataForPost] Error:', err);
    return null;
  }
}

// ==========================================
// タイムライン・投稿・フォロー
// ==========================================

// 投稿リストにリアクション・RT・返信情報を付与し、ブロック済みドメインを除外する共通ヘルパー
async function enrichAndFilterPosts(rows: any[], currentActorUrl: string | null, currentUserId?: string | null) {
  if (rows.length === 0) return [];

  const postIds = Array.from(new Set(rows.map((r) => r.post_id || r.id)));
  const placeholders = postIds.map(() => '?').join(',');

  const allReactions = await db.prepare(`
    SELECT post_id, reaction, count(*) as count,
      max(case when user_id = ? then 1 else 0 end) as me
    FROM reactions
    WHERE post_id IN (${placeholders})
    GROUP BY post_id, reaction
  `).all(currentActorUrl || '', ...postIds) as { post_id: string; reaction: string; count: number; me: number }[];

  const allAnnounces = await db.prepare(`
    SELECT post_id, count(*) as count,
      max(case when user_id = ? then 1 else 0 end) as me
    FROM announces
    WHERE post_id IN (${placeholders})
    GROUP BY post_id
  `).all(currentActorUrl || '', ...postIds) as { post_id: string; count: number; me: number }[];

  const allReplies = await db.prepare(`
    SELECT in_reply_to as post_id, count(*) as count
    FROM posts
    WHERE in_reply_to IN (${placeholders})
    GROUP BY in_reply_to
  `).all(...postIds) as { post_id: string; count: number }[];

  // 📊 アンケート情報の取得
  const pollsMap = new Map<string, any>();
  try {
    const pollRows = await db.prepare(`
      SELECT id, post_id, multiple, expires_at, created_at
      FROM polls
      WHERE post_id IN (${placeholders})
    `).all(...postIds) as any[];

    if (pollRows.length > 0) {
      const pollIds = pollRows.map((p) => p.id);
      const pollPlaceholders = pollIds.map(() => '?').join(',');

      const choiceRows = await db.prepare(`
        SELECT id, poll_id, choice_index, text, votes_count
        FROM poll_choices
        WHERE poll_id IN (${pollPlaceholders})
        ORDER BY choice_index ASC
      `).all(...pollIds) as any[];

      let userVotesMap = new Map<string, Set<number>>();
      if (currentUserId) {
        const voteRows = await db.prepare(`
          SELECT poll_id, choice_index
          FROM poll_votes
          WHERE poll_id IN (${pollPlaceholders}) AND user_id = ?
        `).all(...pollIds, currentUserId) as any[];
        for (const v of voteRows) {
          if (!userVotesMap.has(v.poll_id)) userVotesMap.set(v.poll_id, new Set());
          userVotesMap.get(v.poll_id)!.add(v.choice_index);
        }
      }

      const choicesByPoll = new Map<string, any[]>();
      for (const c of choiceRows) {
        if (!choicesByPoll.has(c.poll_id)) choicesByPoll.set(c.poll_id, []);
        const myVotes = userVotesMap.get(c.poll_id);
        choicesByPoll.get(c.poll_id)!.push({
          choice_index: c.choice_index,
          text: c.text,
          votes_count: c.votes_count,
          me: myVotes ? myVotes.has(c.choice_index) : false,
        });
      }

      const now = new Date().toISOString();
      for (const p of pollRows) {
        const choices = choicesByPoll.get(p.id) || [];
        const totalVotes = choices.reduce((sum, c) => sum + (c.votes_count || 0), 0);
        const myVotes = userVotesMap.get(p.id);
        const isExpired = p.expires_at ? p.expires_at < now : false;

        pollsMap.set(p.post_id, {
          id: p.id,
          multiple: Boolean(p.multiple),
          expires_at: p.expires_at,
          is_expired: isExpired,
          total_votes: totalVotes,
          my_voted: Boolean(myVotes && myVotes.size > 0),
          choices,
        });
      }
    }
  } catch (e) {
    console.error('[enrichAndFilterPosts] Error fetching polls:', e);
  }

  // 🔖 ブックマーク状態判定
  let bookmarkedSet = new Set<string>();
  if (currentUserId) {
    try {
      const bookmarkedRows = await db.prepare(`
        SELECT post_id FROM bookmarks
        WHERE user_id = ? AND post_id IN (${placeholders})
      `).all(currentUserId, ...postIds) as { post_id: string }[];
      bookmarkedSet = new Set(bookmarkedRows.map((b) => b.post_id));
    } catch {}
  }

  // 📌 ピン留め状態判定（該当ユーザーがピン留めしているか）
  let pinnedSet = new Set<string>();
  if (currentUserId) {
    try {
      const pinnedRows = await db.prepare(`
        SELECT post_id FROM pinned_posts
        WHERE user_id = ? AND post_id IN (${placeholders})
      `).all(currentUserId, ...postIds) as { post_id: string }[];
      pinnedSet = new Set(pinnedRows.map((b) => b.post_id));
    } catch {}
  }

  // 🚫 個人ブロック & ミュート対象ユーザーの取得
  const blockedOrMutedUserIds = new Set<string>();
  if (currentUserId) {
    try {
      const blockedRows = await db.prepare(`
        SELECT target_user_id FROM user_blocks WHERE user_id = ?
      `).all(currentUserId) as { target_user_id: string }[];
      const mutedRows = await db.prepare(`
        SELECT target_user_id FROM user_mutes WHERE user_id = ?
      `).all(currentUserId) as { target_user_id: string }[];
      for (const r of blockedRows) if (r.target_user_id) blockedOrMutedUserIds.add(r.target_user_id.toLowerCase());
      for (const r of mutedRows) if (r.target_user_id) blockedOrMutedUserIds.add(r.target_user_id.toLowerCase());
    } catch {}
  }

  // 🔇 ワードフィルター（ミュートワード）
  const mutedWords = await getMutedWords(currentUserId);

  const reactionsMap = new Map<string, { reaction: string; count: number; me: boolean }[]>();
  for (const r of allReactions) {
    if (!reactionsMap.has(r.post_id)) reactionsMap.set(r.post_id, []);
    reactionsMap.get(r.post_id)!.push({ reaction: r.reaction, count: r.count, me: Boolean(r.me) });
  }

  const announcesMap = new Map<string, { count: number; me: boolean }>();
  for (const a of allAnnounces) {
    announcesMap.set(a.post_id, { count: a.count, me: Boolean(a.me) });
  }

  const repliesMap = new Map<string, number>();
  for (const rp of allReplies) {
    repliesMap.set(rp.post_id, rp.count);
  }

  // 💬 引用ノート (Quote) 情報の一括取得
  const quotesMap = new Map<string, any>();
  const quoteIds = Array.from(new Set(rows.map((r) => r.quote_id).filter(Boolean)));
  if (quoteIds.length > 0) {
    try {
      const qPlaceholders = quoteIds.map(() => '?').join(',');
      const quoteRows = await db.prepare(`
        SELECT id, user_id, author_name, author_url, author_handle, author_icon, content, cw, emojis, media_attachments, is_sensitive, published_at
        FROM posts
        WHERE id IN (${qPlaceholders})
      `).all(...quoteIds) as any[];

      for (const q of quoteRows) {
        quotesMap.set(q.id, {
          id: q.id,
          user_id: q.user_id,
          author_name: q.author_name,
          author_url: q.author_url,
          author_handle: q.author_handle,
          author_icon: q.author_icon,
          content: q.content,
          cw: q.cw || null,
          emojis: q.emojis,
          is_sensitive: Boolean(q.is_sensitive),
          media_attachments: (() => {
            try {
              return typeof q.media_attachments === 'string' ? JSON.parse(q.media_attachments || '[]') : (q.media_attachments || []);
            } catch {
              return [];
            }
          })(),
          published_at: q.published_at,
        });
      }
    } catch (e) {
      console.error('[enrichAndFilterPosts] Error fetching quotes:', e);
    }
  }

  // 📢 チャンネル (Channels) 情報の一括取得
  const channelsMap = new Map<string, any>();
  const channelIds = Array.from(new Set(rows.map((r) => r.channel_id).filter(Boolean)));
  if (channelIds.length > 0) {
    try {
      const cPlaceholders = channelIds.map(() => '?').join(',');
      const channelRows = await db.prepare(`
        SELECT id, name, description, banner_url, color, posts_count, followers_count
        FROM channels
        WHERE id IN (${cPlaceholders})
      `).all(...channelIds) as any[];

      for (const ch of channelRows) {
        channelsMap.set(ch.id, ch);
      }
    } catch (e) {
      console.error('[enrichAndFilterPosts] Error fetching channels:', e);
    }
  }

  // 🔗 リンクプレビューは 1 回のクエリでまとめて取る（行ごとに問い合わせない）
  const previewUrls = Array.from(
    new Set(rows.map((r) => extractFirstUrl(r.content)).filter((url): url is string => Boolean(url))),
  );
  const linkPreviews = await getCachedPreviews(previewUrls);
  // 遮断ドメインは 1 回だけ読み込む（投稿ごとに問い合わせない）
  const blockedDomainRules = await loadBlockedDomainRules();

  const enrichedItems = rows.map((r) => {
    const pid = r.post_id || r.id;
    const cid = r.channel_id || null;
    return {
      id: pid,
      feed_id: r.announce_id ? `rn_${r.announce_id}` : pid,
      user_id: r.user_id,
      author_name: r.author_name,
      author_url: r.author_url,
      author_handle: r.author_handle,
      author_icon: r.author_icon,
      content: r.content,
      cw: r.cw || null,
      quote_id: r.quote_id || null,
      quote: r.quote_id ? (quotesMap.get(r.quote_id) || null) : null,
      is_sensitive: Boolean(r.is_sensitive),
      poll: pollsMap.get(pid) || null,
      is_pinned: pinnedSet.has(pid),
      is_local: r.is_local,
      visibility: r.visibility,
      emojis: r.emojis,
      in_reply_to: r.in_reply_to,
      media_attachments: (() => {
        try {
          return typeof r.media_attachments === 'string' ? JSON.parse(r.media_attachments || '[]') : (r.media_attachments || []);
        } catch {
          return [];
        }
      })(),
      published_at: r.published_at,
      timeline_at: r.timeline_at || r.published_at,
      // 🔗 リンクプレビュー（OGP カード）: キャッシュ済みのものだけ添付する
      link_preview: (() => {
        const url = extractFirstUrl(r.content);
        return url ? linkPreviews.get(url) ?? null : null;
      })(),
      renote: r.announce_id ? {
        id: r.announce_id,
        name: r.renoted_by_name || '誰か',
        handle: r.renoted_by_handle || '',
        icon: r.renoted_by_icon || '',
        url: r.renoted_by_url || '',
        at: r.timeline_at,
      } : null,
      reactions: reactionsMap.get(pid) || [],
      announce_count: announcesMap.get(pid)?.count || 0,
      my_announced: announcesMap.get(pid)?.me || false,
      reply_count: repliesMap.get(pid) || 0,
      bookmarked: bookmarkedSet.has(pid),
      channel_id: cid,
      channel: cid ? (channelsMap.get(cid) || null) : null,
    };
  });

  // ブロック対象ドメインおよび個人ブロック・ミュート対象ユーザーの投稿を除外
  const filteredItems = enrichedItems.filter((item) => {
    if (blockedOrMutedUserIds.size > 0) {
      if (item.user_id && blockedOrMutedUserIds.has(item.user_id.toLowerCase())) return false;
      if (item.author_url && blockedOrMutedUserIds.has(item.author_url.toLowerCase())) return false;
      if (item.author_handle && blockedOrMutedUserIds.has(item.author_handle.toLowerCase())) return false;
      if (item.renote) {
        if (item.renote.url && blockedOrMutedUserIds.has(item.renote.url.toLowerCase())) return false;
        if (item.renote.handle && blockedOrMutedUserIds.has(item.renote.handle.toLowerCase())) return false;
      }
    }
    if (item.is_local === 1) return true;
    // 表示の絞り込みは suspend / silence のどちらでも隠す（判定は読み込み済みルールに対して同期で行う）
    if (matchesBlockedDomainRule(blockedDomainRules, item.author_url) || matchesBlockedDomainRule(blockedDomainRules, item.author_handle)) return false;
    if (item.renote && (matchesBlockedDomainRule(blockedDomainRules, item.renote.url) || matchesBlockedDomainRule(blockedDomainRules, item.renote.handle))) return false;
    return true;
  });

  // 🔇 ミュートワードに一致する投稿を除外
  const wordFilteredItems = mutedWords.length > 0
    ? filteredItems.filter((item) => !postMatchesMutedWords(item, mutedWords))
    : filteredItems;

  // 閲覧権限のない投稿（フォロワー限定で、閲覧者が本人でもフォロワーでもないもの）を除外
  return await filterVisiblePosts(wordFilteredItems, currentActorUrl);
}

// タイムライン取得（ローカル / ホーム / 連合 / タグ別）- リノート（RT）・リアクション・返信集計付き
apiRouter.get('/timeline', asyncHandler(async (req: Request, res: Response) => {
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

  // ホームの「フォロー中」判定は follows を JOIN して行う。
  // `author_url IN (SELECT following_url FROM follows ...)` と書くと、PostgreSQL は
  // published_at の索引で「21 件そろった時点で止まる」ことができず、候補（数千〜10 万件）を
  // 全部読んでから並べ替える。JOIN にすると両エンジンとも索引の逆順走査で止まれる
  // （実測: 596ms → 0.1ms / PostgreSQL 265ms → 0.7ms）。
  let postFollowJoin = '';
  let announceFollowJoin = '';
  let followParam: string | null = null;

  if (mode === 'tag' && tag) {
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
      postConds.push('(p.is_local = 1 OR f.follower_url IS NOT NULL)');
      announceConds.push('(a.is_local = 1 OR f.follower_url IS NOT NULL)');
      followParam = myActorUrl;
    } else {
      postConds.push('p.is_local = 1');
      announceConds.push('a.is_local = 1');
    }
  }

  // 続きの読み込み（カーソル）：ORDER BY と同じ組で比較する
  if (page.cursor) {
    postConds.push(cursorPredicate('p.published_at', 'p.id'));
    announceConds.push(cursorPredicate('a.created_at', 'p.id'));
    params.push(page.cursor.at, page.cursor.at, page.cursor.id);
    announceParams.push(page.cursor.at, page.cursor.at, page.cursor.id);
  }

  const postWhere = postConds.length > 0 ? ` WHERE ${postConds.join(' AND ')}` : '';
  const announceWhere = announceConds.length > 0 ? ` WHERE ${announceConds.join(' AND ')}` : '';

  // 枝ごとに ORDER BY + LIMIT を押し込む。PostgreSQL は `UNION ALL` の外側に ORDER BY があると
  // 枝を全部読んでから並べ替える（LIMIT が押し込まれない）ため、投稿が増えるほど遅くなる。
  // 枝の中で並べ替えておけば、索引の逆順走査で「必要な件数だけ」読んで止まれる
  // （実測: 連合 812ms → 0.8ms、ローカル 226ms → 0.3ms。SQLite は元々 MERGE で流していた）。
  const branchLimit = page.limit + 1;

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
      p.emojis,
      p.in_reply_to,
      p.media_attachments,
      p.published_at,
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
    FROM posts p
    ${postFollowJoin}
    LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
    LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
    ${postWhere}
    ORDER BY p.published_at DESC, p.id DESC
    LIMIT ?

    ) UNION ALL SELECT * FROM (

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
      p.emojis,
      p.in_reply_to,
      p.media_attachments,
      p.published_at,
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

    )
    ORDER BY timeline_at DESC, post_id DESC
    LIMIT ?
  `;

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
      return res.json(cached);
    }
  }

  // パラメータは SQL に現れる順に並べる（枝の中の JOIN → 条件 → 枝の LIMIT、最後に外側の LIMIT）
  const postsBranchParams = [...(followParam ? [followParam] : []), ...params, branchLimit];
  const announcesBranchParams = [...(followParam ? [followParam] : []), ...announceParams, branchLimit];
  const rows = await db.prepare(query).all(...postsBranchParams, ...announcesBranchParams, branchLimit) as any[];
  const currentActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;
  // 続きがある場合のみ X-Next-Cursor ヘッダで通知（レスポンス形状は従来どおり配列）
  const pageRows = applyPageHeaders(res, rows, page.limit, 'timeline_at', 'post_id');
  const enriched = await enrichAndFilterPosts(pageRows, currentActorUrl, req.user?.id);

  if (isTimelineCacheEnabled()) {
    res.setHeader('X-Timeline-Cache', 'MISS');
    // 保存の完了は待たない（応答を遅らせない）
    void cacheSet(cacheKey, enriched, config.timelineCacheTtlSec);
  }

  res.json(enriched);
}));

// 人気・トレンドハッシュタグ一覧
apiRouter.get('/tags/popular', asyncHandler(async (_req: Request, res: Response) => {
  try {
    // フォロワー限定投稿のタグは公開のトレンドに出さない
    const recentPosts = await db.prepare("SELECT content FROM posts WHERE visibility IS NULL OR visibility != 'followers' ORDER BY published_at DESC LIMIT 200").all() as { content: string }[];
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
    WHERE id LIKE ? OR name LIKE ?
    LIMIT 10
  `).all(searchPattern, searchPattern) as any[] : [];

  const remoteActors = searchText ? await db.prepare(`
    SELECT id, username, domain, name, summary, icon_url, 0 as is_local, ('@' || username || '@' || domain) as handle
    FROM remote_actors
    WHERE username LIKE ? OR name LIKE ? OR domain LIKE ?
    LIMIT 10
  `).all(searchPattern, searchPattern, searchPattern) as any[] : [];

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
            p.emojis,
            p.in_reply_to,
            p.media_attachments,
            p.published_at,
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
        p.emojis,
        p.in_reply_to,
        p.media_attachments,
        p.published_at,
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
      WHERE (p.content LIKE ? OR p.cw LIKE ?)${extraWhere}
      ORDER BY p.published_at DESC
      LIMIT 30
    `).all(postPattern, postPattern, ...extraParams) as any[];
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

// メディアアップロード (画像 最大4枚 / 動画・音声 は1件まで)
apiRouter.post(
  '/media/upload',
  requireAuth,
  (req: Request, res: Response, next: NextFunction) => {
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
  },
  async (req: Request, res: Response) => {
    const user = req.rawUser!;
    const files = (req.files as Express.Multer.File[]) || (req.file ? [req.file] : []);

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'アップロードするメディアファイルを選択してください。' });
    }

    if (files.length > 4) {
      return res.status(400).json({ error: '一度にアップロードできるファイルは最大4件までです。' });
    }

    // 動画・音声はサイズが大きいため1件までに制限する
    const avFiles = files.filter((f) => f.mimetype.startsWith('video/') || f.mimetype.startsWith('audio/'));
    if (avFiles.length > 1) {
      return res.status(400).json({ error: '動画・音声は1件まで添付できます。' });
    }

    // 画像は従来どおり 15MB まで
    const oversizedImage = files.find((f) => f.mimetype.startsWith('image/') && f.size > IMAGE_MAX_BYTES);
    if (oversizedImage) {
      return res.status(400).json({ error: '画像サイズが大きすぎます (最大15MBまで)。' });
    }

    try {
      // ドライブの容量上限（MEDIA_QUOTA_MB。0 なら無制限）
      const incomingBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
      const quota = await checkMediaQuota(user.id, incomingBytes);
      if (!quota.ok) {
        return res.status(413).json({ error: quota.error });
      }

      const uploaded = await Promise.all(
        files.map((file) =>
          uploadMediaFile({
            buffer: file.buffer,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
            userId: user.id,
          })
        )
      );

      // ドライブの台帳に記録する（投稿に添付されなくても一覧・削除できるようにする）
      const mediaRows = await Promise.all(
        uploaded.map(async (item) =>
          toClientMedia(await recordMedia({
            userId: user.id,
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

      res.json({
        success: true,
        media: mediaRows,
        attachment: mediaRows[0], // 1ファイルアップロード時の互換性
      });
    } catch (err: any) {
      console.error('[Media Upload Error]:', err);
      res.status(500).json({ error: err.message || 'メディアのアップロードに失敗しました。' });
    }
  }
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
apiRouter.post('/posts', requireAuth, async (req: Request, res: Response) => {
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
});

// 投稿の削除 (作成者本人または管理者)
apiRouter.delete('/posts/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

// 📊 アンケートへの投票 (認証必須)
apiRouter.post('/posts/:id/poll/vote', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
  const voteTarget = await db.prepare('SELECT author_url, visibility FROM posts WHERE id = ?').get(postId) as
    | { author_url: string; visibility: string | null }
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

  // 選択肢の存在検証
  const pollChoices = await db.prepare('SELECT choice_index FROM poll_choices WHERE poll_id = ?').all(poll.id) as { choice_index: number }[];
  const validIndices = new Set(pollChoices.map((c) => c.choice_index));
  for (const c of choices) {
    if (typeof c !== 'number' || !validIndices.has(c)) {
      return res.status(400).json({ error: '無効な選択肢が含まれています。' });
    }
  }

  const now = new Date().toISOString();
  const insertVote = await db.prepare('INSERT INTO poll_votes (id, poll_id, choice_index, user_id, created_at) VALUES (?, ?, ?, ?, ?)');
  const updateCount = await db.prepare('UPDATE poll_choices SET votes_count = votes_count + 1 WHERE poll_id = ? AND choice_index = ?');

  try {
    await db.exec('BEGIN');
    for (const choiceIdx of choices) {
      insertVote.run(crypto.randomUUID(), poll.id, choiceIdx, user.id, now);
      updateCount.run(poll.id, choiceIdx);
    }
    await db.exec('COMMIT');
  } catch (err) {
    try {
      await db.exec('ROLLBACK');
    } catch {}
    throw err;
  }

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

  // 🌐 リモート連合（Misskey / Mastodon）へ Update(Question) を非同期配信
  federatePollUpdate({ postId });

  res.json({ success: true, poll: updatedPoll });
}));

// 絵文字リアクションの付与 / 解除 (Misskey & Mastodon 相互互換)
apiRouter.post('/posts/:id/react', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

// RT (ブースト / Announce) の付与 / 解除
apiRouter.post('/posts/:id/announce', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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

  const existing = await db.prepare(`
    SELECT * FROM announces WHERE post_id = ? AND user_id = ?
  `).get(postId, actorUrl) as AnnounceRow | undefined;

  let announced = false;
  if (existing) {
    // 解除
    await db.prepare('DELETE FROM announces WHERE id = ?').run(existing.id);
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
}));

// 会話スレッド（親投稿・対象投稿・返信一覧）取得
apiRouter.get('/posts/:id/thread', asyncHandler(async (req: Request, res: Response) => {
  const rawPostId = String(req.params.id);
  const postId = decodeURIComponent(rawPostId);
  const currentActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;

  // 対象投稿
  const post = await db.prepare(`
    SELECT 
      p.id, p.user_id, p.author_name, p.author_url, p.author_handle, p.content,
      p.is_local, p.visibility, p.emojis, p.in_reply_to, p.quote_id, p.is_sensitive, p.media_attachments, p.published_at,
      COALESCE(NULLIF(p.author_icon, ''), NULLIF(u.icon_url, ''), NULLIF(ra.icon_url, ''), '') AS author_icon
    FROM posts p
    LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
    LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
    WHERE p.id = ?
  `).get(postId) as any;

  if (!post) {
    return res.status(404).json({ error: '投稿が見つかりません。' });
  }

  // 親投稿（in_reply_to がある場合）
  let parent = null;
  if (post.in_reply_to) {
    parent = await db.prepare(`
      SELECT 
        p.id, p.user_id, p.author_name, p.author_url, p.author_handle, p.content,
        p.is_local, p.visibility, p.emojis, p.in_reply_to, p.quote_id, p.is_sensitive, p.media_attachments, p.published_at,
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
      p.is_local, p.visibility, p.emojis, p.in_reply_to, p.quote_id, p.is_sensitive, p.media_attachments, p.published_at,
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

  const enrichedList = await enrichAndFilterPosts(allRows, currentActorUrl, req.user?.id);
  const enrichedMap = new Map<string, any>(enrichedList.map((p) => [p.id, p]));

  res.json({
    post: enrichedMap.get(post.id) || null,
    parent: parent ? (enrichedMap.get(parent.id) || null) : null,
    replies: replies.map((r) => enrichedMap.get(r.id)).filter(Boolean),
  });
}));

// リモートまたはローカルユーザーのフォロー（認証必須）
apiRouter.post('/follow', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

// フォロー解除
apiRouter.post('/unfollow', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

// 自プロフィール更新 (名前, bio, アイコンURL, ヘッダーURL, 鍵アカウント設定)
apiRouter.put('/user/profile', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { name, summary, icon_url, banner_url, is_locked, fields, discoverable } = req.body;
  const user = req.rawUser!;

  const newName = typeof name === 'string' && name.trim() ? name.trim() : user.name;
  const newSummary = typeof summary === 'string' ? summary.trim() : (user.summary || '');
  const newIconUrl = typeof icon_url === 'string' ? icon_url.trim() : (user.icon_url || '');
  const newBannerUrl = typeof banner_url === 'string' ? banner_url.trim() : (user.banner_url || '');
  // 鍵アカウント（フォロー承認制）の切り替え。未指定なら現状維持
  const newIsLocked = typeof is_locked === 'boolean' ? (is_locked ? 1 : 0) : (user.is_locked ?? 0);
  // ディレクトリ掲載の可否
  const newDiscoverable = typeof discoverable === 'boolean' ? (discoverable ? 1 : 0) : ((user as any).discoverable ?? 1);
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
      discoverable = ?
    WHERE id = ?
  `).run(newName, newSummary, newIconUrl, newBannerUrl, newIsLocked, JSON.stringify(newFields), newDiscoverable, user.id);

  // 自身の過去投稿の author_name / author_icon も更新
  await db.prepare(`UPDATE posts SET author_name = ?, author_icon = ? WHERE is_local = 1 AND user_id = ?`).run(newName, newIconUrl, user.id);

  const updatedUser = await db.prepare('SELECT id, name, summary, icon_url, banner_url, role, is_frozen, is_locked, fields, discoverable, created_at FROM users WHERE id = ?').get(user.id) as any;
  const myActorUrl = `${config.origin}/users/${user.id}`;
  const followerCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_url = ? AND status = ?').get(myActorUrl, 'accepted') as any).c;
  const followingCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE follower_url = ? AND status = ?').get(myActorUrl, 'accepted') as any).c;
  const postCount = (await db.prepare('SELECT COUNT(*) as c FROM posts WHERE user_id = ?').get(user.id) as any).c;

  res.json({
    ...updatedUser,
    handle: `@${user.id}@${config.domain}`,
    actorUrl: myActorUrl,
    followerCount,
    followingCount,
    postCount,
  });
}));

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
apiRouter.get('/user/export', requireAuth, async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const format = (req.query.format as string)?.toLowerCase();
  const dateStr = new Date().toISOString().split('T')[0];

  try {
    if (format === 'zip') {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="spica-export-${user.id}-${dateStr}.zip"`);
      await streamUserExportZip(user.id, res);
    } else {
      const data = exportUserData(user.id);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="spica-export-${user.id}-${dateStr}.json"`);
      res.send(JSON.stringify(data, null, 2));
    }
  } catch (err: any) {
    console.error(`[Export Error] Failed to export data for @${user.id}:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'データのエクスポートに失敗しました。' });
    }
  }
});

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

  // 4. アカウント完全消去
  const result = await deleteUserAccount(user.id);
  if (!result.success) {
    return res.status(400).json({ error: result.error || 'アカウントの削除に失敗しました。' });
  }

  res.json({
    success: true,
    message: 'アカウントと関連データを完全に削除しました。ご利用ありがとうございました。',
  });
}));

// ユーザー詳細プロフィール取得（ローカルまたはリモート）
apiRouter.get('/users/:identifier', asyncHandler(async (req: Request, res: Response) => {
  const rawIdentifier = decodeURIComponent(req.params.identifier as string);
  const myActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;

  // 1. ローカルユーザーの照合 (@id, id, @id@domain 等)
  let cleanId = rawIdentifier.replace(/^@/, '');
  if (cleanId.includes(`@${config.domain}`)) {
    cleanId = cleanId.replace(`@${config.domain}`, '');
  }

  const localUser = await db.prepare('SELECT id, name, summary, icon_url, banner_url, role, is_frozen, is_locked, fields, discoverable, created_at FROM users WHERE id = ?').get(cleanId) as any;
  if (localUser) {
    const actorUrl = `${config.origin}/users/${localUser.id}`;
    const followerCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_url = ? AND status = ?').get(actorUrl, 'accepted') as any).c;
    const followingCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE follower_url = ? AND status = ?').get(actorUrl, 'accepted') as any).c;
    const postCount = (await db.prepare('SELECT COUNT(*) as c FROM posts WHERE user_id = ?').get(localUser.id) as any).c;

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
    let targetActorUrl = rawIdentifier;
    if (!targetActorUrl.startsWith('http://') && !targetActorUrl.startsWith('https://')) {
      targetActorUrl = await resolveWebFinger(rawIdentifier);
    }

    // キャッシュを検索、未取得または画像未取得なら最新化
    let remoteActor: RemoteActorRow;
    const existing = await db.prepare('SELECT * FROM remote_actors WHERE id = ?').get(targetActorUrl) as RemoteActorRow | undefined;
    if (existing && existing.icon_url) {
      remoteActor = existing;
    } else {
      remoteActor = await fetchRemoteActor(targetActorUrl, true);
    }

    const postCount = (await db.prepare('SELECT COUNT(*) as c FROM posts WHERE is_local = 0 AND (author_url = ? OR user_id = ?)').get(targetActorUrl, targetActorUrl) as any).c;

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
      follower_count: 0,
      following_count: 0,
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
  const cursorCond = page.cursor ? ` AND ${cursorPredicate('p.published_at', 'p.id')}` : '';
  const cursorParams = page.cursor ? [page.cursor.at, page.cursor.at, page.cursor.id] : [];

  let cleanId = rawIdentifier.replace(/^@/, '');
  if (cleanId.includes(`@${config.domain}`)) {
    cleanId = cleanId.replace(`@${config.domain}`, '');
  }

  const localUser = await db.prepare('SELECT id FROM users WHERE id = ?').get(cleanId);
  let posts: any[] = [];

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

  if (localUser) {
    posts = await db.prepare(`
      ${baseSelect}
      WHERE p.user_id = ?${cursorCond}
      ORDER BY p.published_at DESC, p.id DESC
      LIMIT ?
    `).all(cleanId, ...cursorParams, page.limit + 1);
  } else {
    posts = await db.prepare(`
      ${baseSelect}
      WHERE (p.author_url = ? OR p.user_id = ? OR p.author_handle = ?)${cursorCond}
      ORDER BY p.published_at DESC, p.id DESC
      LIMIT ?
    `).all(rawIdentifier, rawIdentifier, rawIdentifier.startsWith('@') ? rawIdentifier : `@${rawIdentifier}`, ...cursorParams, page.limit + 1);
  }

  const currentActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;
  const pageRows = applyPageHeaders(res, posts, page.limit, 'published_at', 'id');
  const enriched = await enrichAndFilterPosts(pageRows, currentActorUrl, req.user?.id);
  res.json(enriched);
}));

// フォロー中リスト
apiRouter.get('/following', asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.query.userId as string) || req.user?.id;
  if (!userId) {
    return res.status(400).json({ error: 'userId が必要です。' });
  }

  const myActorUrl = `${config.origin}/users/${userId}`;
  const following = await db.prepare(`
    SELECT f.*, r.name, r.username, r.domain
    FROM follows f
    LEFT JOIN remote_actors r ON f.following_url = r.id
    WHERE f.follower_url = ?
  `).all(myActorUrl);

  res.json(following);
}));

// フォロワーリスト
apiRouter.get('/followers', asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.query.userId as string) || req.user?.id;
  if (!userId) {
    return res.status(400).json({ error: 'userId が必要です。' });
  }

  const myActorUrl = `${config.origin}/users/${userId}`;
  // 承認済みのフォロワーのみ（鍵アカウントの承認待ちは含めない）
  const followers = await db.prepare(`
    SELECT f.*, r.name, r.username, r.domain
    FROM follows f
    LEFT JOIN remote_actors r ON f.follower_url = r.id
    WHERE f.following_url = ? AND f.status = 'accepted'
    ORDER BY f.created_at DESC
  `).all(myActorUrl);

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
    db.prepare('SELECT COUNT(*) as c FROM users').get() as Promise<{ c: number }>,
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

// ==========================================
// 通知 (Notifications) エンドポイント
// ==========================================

// 通知一覧の取得 (最新順、ブロック・ミュート除外)
apiRouter.get('/notifications', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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

    const filtered = pageRows.filter((n) => {
      if (n.actor_id && excludeIds.has(n.actor_id.toLowerCase())) return false;
      if (n.actor_handle && excludeIds.has(n.actor_handle.toLowerCase())) return false;
      // サイレンス / ブロックしたサーバーからの通知は一覧に出さない
      if (matchesBlockedDomainRule(blockedDomainRules, n.actor_id)) return false;
      if (matchesBlockedDomainRule(blockedDomainRules, n.actor_handle)) return false;
      if (matchesBlockedDomainRule(blockedDomainRules, (n as any).origin_url)) return false;
      return true;
    });

    res.json(filtered);
  } catch (err: any) {
    console.error('[API Notification Error]:', err);
    res.status(500).json({ error: err.message });
  }
}));

// 通知の種類別設定（フォロー・返信・メンション・リアクション・リノート・アンテナ・引っ越し）
apiRouter.get('/notifications/settings', requireAuth, async (req: Request, res: Response) => {
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

apiRouter.post('/notifications/settings', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
apiRouter.post('/notifications/email', requireAuth, async (req: Request, res: Response) => {
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
apiRouter.get('/notifications/unread-count', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
apiRouter.post('/notifications/read-all', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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

// 単一の通知を既読にする
apiRouter.post('/notifications/:id/read', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

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
apiRouter.post('/bookmarks/toggle', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

// 🔖 投稿のブックマーク追加 / 解除 (後方互換: パスパラメータ)
apiRouter.post('/posts/:id/bookmark', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
apiRouter.get('/bookmarks', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const page = parsePageQuery(req, 50);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }
  const cursorCond = page.cursor ? ` AND ${cursorPredicate('b.created_at', 'p.id')}` : '';
  const cursorParams = page.cursor ? [page.cursor.at, page.cursor.at, page.cursor.id] : [];

  try {
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
      WHERE b.user_id = ?${cursorCond}
      ORDER BY b.created_at DESC, p.id DESC
      LIMIT ?
    `;

    const rows = await db.prepare(query).all(user.id, ...cursorParams, page.limit + 1) as any[];
    const currentActorUrl = `${config.origin}/users/${user.id}`;
    const pageRows = applyPageHeaders(res, rows, page.limit, 'timeline_at', 'post_id');
    const enriched = await enrichAndFilterPosts(pageRows, currentActorUrl, user.id);
    res.json(enriched);
  } catch (err: any) {
    console.error('[Get Bookmarks Error]:', err);
    res.status(500).json({ error: 'ブックマーク一覧の取得に失敗しました。' });
  }
}));

// ==========================================
// 📌 プロフィールピン留め (Pinned Posts) エンドポイント
// ==========================================

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
apiRouter.post('/posts/pin/toggle', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
apiRouter.post('/posts/:id/pin', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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

// ==========================================
// 🚫 個人単位のミュート / ブロック エンドポイント
// ==========================================

// ユーザーブロック
apiRouter.post('/users/:identifier/block', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

// ユーザーブロック解除
apiRouter.post('/users/:identifier/unblock', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

// ユーザーミュート
apiRouter.post('/users/:identifier/mute', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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

    res.json({ success: true, is_muted: true });
  } catch (err: any) {
    console.error('[User Mute Error]:', err);
    res.status(500).json({ error: 'ユーザーのミュートに失敗しました。' });
  }
}));

// ユーザーミュート解除
apiRouter.post('/users/:identifier/unmute', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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

    res.json({ success: true, is_muted: false });
  } catch (err: any) {
    console.error('[User Unmute Error]:', err);
    res.status(500).json({ error: 'ミュート解除に失敗しました。' });
  }
}));

// ブロック中ユーザー一覧取得
apiRouter.get('/user/blocks', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

// ミュート中ユーザー一覧取得
apiRouter.get('/user/mutes', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

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
    const recentPosts = await db.prepare("SELECT content FROM posts WHERE visibility IS NULL OR visibility != 'followers' ORDER BY published_at DESC LIMIT 300").all() as { content: string }[];
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

  try {
    const rows = await db.prepare(`
      SELECT id, name, summary, icon_url, banner_url, created_at, fields, discoverable
      FROM users
      WHERE is_frozen = 0 AND COALESCE(discoverable, 1) = 1
        AND (? = '' OR id LIKE ? OR name LIKE ?)
      ORDER BY created_at ASC
      LIMIT ?
    `).all(q, `%${q}%`, `%${q}%`, limit) as any[];

    const users = await Promise.all(rows.map(async (user) => {
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
        post_count: (await db.prepare('SELECT COUNT(*) AS c FROM posts WHERE user_id = ?').get(user.id) as { c: number }).c,
        follower_count: (await db.prepare("SELECT COUNT(*) AS c FROM follows WHERE following_url = ? AND status = 'accepted'").get(actorUrl) as { c: number }).c,
        fields: parseProfileFields((user as any).fields).map((f) => ({ name: f.name, value: f.value })),
        roles: await db.prepare(`
          SELECT r.id, r.name, r.color FROM user_roles ur
          JOIN roles r ON ur.role_id = r.id
          WHERE ur.user_id = ?
          ORDER BY r.created_at ASC
        `).all(user.id),
      };
    }));

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

  console.log(`[WordFilter] 🔇 @${user.id} が「${value}」をミュートワードに追加しました`);
  res.status(201).json({ success: true, id, keyword: value });
}));

apiRouter.delete('/muted-words/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const result = await db.prepare('DELETE FROM muted_words WHERE id = ? AND user_id = ?').run(String(req.params.id), user.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'キーワードが見つかりません。' });
  }
  res.json({ success: true });
}));

// 🔒 フォローリクエスト（鍵アカウントの承認待ち）
apiRouter.get('/follow-requests', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

// フォローリクエストの承認 / 拒否
apiRouter.post('/follow-requests/respond', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

// 📋 リスト（ユーザーを束ねた専用タイムライン）
//    アンテナの「ユーザー指定」と同じ考え方で、登録したメンバーの投稿だけを時系列で返す

// 自分のリスト一覧
apiRouter.get('/lists', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
apiRouter.post('/lists', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

// リスト名の変更
apiRouter.put('/lists/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

// リスト削除
apiRouter.delete('/lists/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const id = String(req.params.id);
  const existing = await db.prepare('SELECT id FROM lists WHERE id = ? AND user_id = ?').get(id, user.id);
  if (!existing) {
    return res.status(404).json({ error: 'リストが見つかりません。' });
  }
  await db.prepare('DELETE FROM list_members WHERE list_id = ?').run(id);
  await db.prepare('DELETE FROM lists WHERE id = ?').run(id);
  res.json({ success: true });
}));

// メンバー追加（ローカルID / ハンドル / actor URL を受け付ける）
apiRouter.post('/lists/:id/members', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

// メンバー削除
apiRouter.delete('/lists/:id/members/:memberId', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

// リストのタイムライン（メンバーの投稿のみ / 公開範囲とミュートワードを尊重）
apiRouter.get('/lists/:id/timeline', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
  if (page.cursor) {
    conditions.push(cursorPredicate('p.published_at', 'p.id'));
    params.push(page.cursor.at, page.cursor.at, page.cursor.id);
  }
  params.push(page.limit + 1);

  const rows = await db.prepare(`
    SELECT
      p.id AS post_id,
      p.*,
      COALESCE(NULLIF(p.author_icon, ''), NULLIF(u.icon_url, ''), NULLIF(ra.icon_url, ''), '') AS author_icon,
      p.published_at AS timeline_at
    FROM posts p
    LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
    LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
    WHERE ${conditions.join(' AND ')}
    ORDER BY p.published_at DESC, p.id DESC
    LIMIT ?
  `).all(...params) as any[];

  const pageRows = applyPageHeaders(res, rows, page.limit, 'timeline_at', 'post_id');
  const viewerActor = `${config.origin}/users/${user.id}`;
  const listMutedWords = await getMutedWords(user.id);
  const visible = (await filterVisiblePosts(pageRows, viewerActor))
    .filter((post) => !postMatchesMutedWords(post, listMutedWords));
  const enriched = await enrichAndFilterPosts(visible, viewerActor, user.id);

  res.json({ list: { id: list.id, name: list.name }, posts: enriched, memberCount: members.length });
}));

// 📥 アカウント移行インポート（Mastodon の outbox.json / Misskey の notes.json）
const archiveUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.includes('json') || file.originalname.toLowerCase().endsWith('.json')) {
      cb(null, true);
    } else {
      cb(new Error('JSON ファイル（Mastodon の outbox.json / Misskey の notes.json）を選択してください。'));
    }
  },
});

apiRouter.post('/import/archive', requireAuth, archiveUpload.single('archive'), asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const file = (req as Request & { file?: { buffer: Buffer } }).file;
  if (!file) {
    return res.status(400).json({ error: 'アーカイブファイル（JSON）が必要です。' });
  }

  let data: any;
  try {
    data = JSON.parse(file.buffer.toString('utf8'));
  } catch {
    return res.status(400).json({
      error: 'JSON の解析に失敗しました。Mastodon の outbox.json か Misskey の notes.json を選択してください。',
    });
  }

  try {
    const { format, notes } = parseArchive(data);
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
      message: `${result.imported} 件の投稿を取り込みました（重複スキップ ${result.skipped} 件）。`,
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
      const post = await db.prepare('SELECT id, user_id, author_url, author_handle, content, is_local FROM posts WHERE id = ?').get(String(targetPostId)) as any;
      if (!post) {
        return res.status(404).json({ error: '通報対象の投稿が見つかりません。' });
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

// 端末の PushSubscription 登録
apiRouter.post('/push/subscribe', requireAuth, async (req: Request, res: Response) => {
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
});

// 端末の PushSubscription 解除
apiRouter.post('/push/unsubscribe', requireAuth, async (req: Request, res: Response) => {
  const { endpoint } = req.body;
  if (endpoint && typeof endpoint === 'string') {
    await removePushSubscription(endpoint);
  }
  res.json({ success: true, message: 'Web Push 通知の登録を解除しました。' });
});

// プッシュ通知登録状況の確認
apiRouter.get('/push/status', requireAuth, async (req: Request, res: Response) => {
  const isSubscribed = await isUserSubscribed(req.user!.id);
  res.json({ isSubscribed });
});

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

// ==========================================
// 📡 アンテナ (Antenna) エンドポイント
// ==========================================

// アンテナ一覧取得
apiRouter.get('/antennas', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
apiRouter.post('/antennas', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

// アンテナ詳細取得
apiRouter.get('/antennas/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

// アンテナ更新
apiRouter.put('/antennas/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
}));

// アンテナ削除
apiRouter.delete('/antennas/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const antId = String(req.params.id);
  const resDel = await db.prepare('DELETE FROM antennas WHERE id = ? AND user_id = ?').run(antId, user.id);
  if (resDel.changes === 0) {
    return res.status(404).json({ error: 'アンテナが見つかりません。' });
  }
  res.json({ success: true });
}));

// アンテナタイムライン取得
apiRouter.get('/antennas/:id/timeline', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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

  // 続きの読み込み（カーソル）：ORDER BY と同じ組で比較する
  if (page.cursor) {
    conditions.push(cursorPredicate('p.published_at', 'p.id'));
    params.push(page.cursor.at, page.cursor.at, page.cursor.id);
  }
  params.push(page.limit + 1);

  const sql = `
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
    WHERE ${conditions.join(' AND ')}
    ORDER BY p.published_at DESC, p.id DESC
    LIMIT ?
  `;

  const rows = await db.prepare(sql).all(...params) as any[];
  const pageRows = applyPageHeaders(res, rows, page.limit, 'timeline_at', 'id');
  // 閲覧権限のない投稿（フォロワー限定など）とミュートワード該当投稿を除外
  const antennaViewer = `${config.origin}/users/${user.id}`;
  const antennaMutedWords = await getMutedWords(user.id);
  const visibleRows = (await filterVisiblePosts(pageRows, antennaViewer))
    .filter((post) => !postMatchesMutedWords(post, antennaMutedWords));

  // 各ノートのリアクション、アンケート、引用、ブックマーク状態の補完
  const decorated = await Promise.all(visibleRows.map(async (post) => {
    // 添付メディア
    let parsedAttachments: any[] = [];
    try {
      if (typeof post.media_attachments === 'string') parsedAttachments = JSON.parse(post.media_attachments || '[]');
      else if (Array.isArray(post.media_attachments)) parsedAttachments = post.media_attachments;
    } catch {}

    // アンケート
    let pollData = null;
    const pollRow = await db.prepare('SELECT * FROM polls WHERE post_id = ?').get(post.id) as any;
    if (pollRow) {
      const choices = await db.prepare('SELECT * FROM poll_choices WHERE poll_id = ? ORDER BY choice_index ASC').all(pollRow.id) as any[];
      const myVotes = await db.prepare('SELECT choice_index FROM poll_votes WHERE poll_id = ? AND user_id = ?').all(pollRow.id, user.id) as any[];
      const myVotedIndices = new Set(myVotes.map((v) => v.choice_index));
      pollData = {
        id: pollRow.id,
        multiple: Boolean(pollRow.multiple),
        expires_at: pollRow.expires_at,
        is_expired: pollRow.expires_at ? new Date(pollRow.expires_at) <= new Date() : false,
        total_votes: choices.reduce((acc, c) => acc + (c.votes_count || 0), 0),
        my_voted: myVotes.length > 0,
        choices: choices.map((c) => ({
          choice_index: c.choice_index,
          text: c.text,
          votes_count: c.votes_count || 0,
          me: myVotedIndices.has(c.choice_index),
        })),
      };
    }

    // 引用投稿
    let quotePostData: any = null;
    if (post.quote_id) {
      const qRow = await db.prepare('SELECT id, user_id, author_name, author_url, author_handle, author_icon, content, cw, emojis, media_attachments, is_sensitive, published_at FROM posts WHERE id = ?').get(post.quote_id) as any;
      if (qRow) {
        quotePostData = {
          ...qRow,
          is_sensitive: Boolean(qRow.is_sensitive),
          media_attachments: (() => {
            try { return typeof qRow.media_attachments === 'string' ? JSON.parse(qRow.media_attachments || '[]') : (qRow.media_attachments || []); }
            catch { return []; }
          })(),
        };
      }
    }

    // リアクション
    const reactionRows = await db.prepare(`
      SELECT reaction, count(*) as count, max(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as me
      FROM reactions
      WHERE post_id = ?
      GROUP BY reaction
    `).all(user.id, post.id) as any[];

    // リノート集計
    const announceCount = (await db.prepare('SELECT count(*) as c FROM announces WHERE post_id = ?').get(post.id) as any).c;
    const myAnnounced = Boolean((await db.prepare('SELECT 1 FROM announces WHERE post_id = ? AND user_id = ?').get(post.id, user.id) as any));

    // 返信カウント
    const replyCount = (await db.prepare('SELECT count(*) as c FROM posts WHERE in_reply_to = ?').get(post.id) as any).c;

    // ブックマーク判定
    const isBookmarked = Boolean((await db.prepare('SELECT 1 FROM bookmarks WHERE user_id = ? AND post_id = ?').get(user.id, post.id) as any));

    return {
      ...post,
      is_sensitive: Boolean(post.is_sensitive),
      media_attachments: parsedAttachments,
      poll: pollData,
      quote: quotePostData,
      reactions: reactionRows.map((r) => ({
        reaction: r.reaction,
        count: r.count,
        me: Boolean(r.me),
      })),
      announce_count: announceCount,
      my_announced: myAnnounced,
      reply_count: replyCount,
      bookmarked: isBookmarked,
    };
  }));

  res.json({
    antenna: {
      id: ant.id,
      name: ant.name,
    },
    posts: decorated,
  });
}));

// ==========================================
// 📝 下書き (Drafts) エンドポイント
// ==========================================

// 下書き一覧取得
apiRouter.get('/drafts', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
apiRouter.post('/drafts', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
apiRouter.delete('/drafts/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
apiRouter.get('/scheduled-posts', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
apiRouter.post('/scheduled-posts', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
  if (!contentText && parsedAttachments.length === 0 && !quote_id) {
    return res.status(400).json({ error: '投稿内容または画像を入力してください。' });
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
apiRouter.delete('/scheduled-posts/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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

// ==========================================
// 🔐 WebAuthn / パスキー (Passkey) エンドポイント
// ==========================================

// パスキー登録オプション生成 (要認証)
apiRouter.post('/webauthn/register/options', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.rawUser!;
    const reqOrigin = req.headers.origin as string | undefined;
    const options = await createWebAuthnRegistrationOptions(user, reqOrigin);
    res.json(options);
  } catch (e: any) {
    console.error('[WebAuthn] register/options error:', e);
    res.status(500).json({ error: e.message || 'パスキー登録オプションの生成に失敗しました。' });
  }
});

// パスキー登録レスポンス検証 (要認証)
apiRouter.post('/webauthn/register/verify', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.rawUser!;
    const { device_name } = req.body;
    const reqOrigin = req.headers.origin as string | undefined;
    const result = await verifyWebAuthnRegistration(user, req.body, device_name || '', reqOrigin);
    res.json({ success: true, credential: result });
  } catch (e: any) {
    console.error('[WebAuthn] register/verify error:', e);
    res.status(400).json({ error: e.message || 'パスキー登録の検証に失敗しました。' });
  }
});

// パスキーログイン用 認証オプション生成 (認証不要)
apiRouter.post('/webauthn/authenticate/options', async (req: Request, res: Response) => {
  try {
    const { user_id } = req.body;
    const reqOrigin = req.headers.origin as string | undefined;
    const options = await createWebAuthnAuthenticationOptions(user_id || undefined, reqOrigin);
    res.json(options);
  } catch (e: any) {
    console.error('[WebAuthn] authenticate/options error:', e);
    res.status(500).json({ error: e.message || '認証オプションの生成に失敗しました。' });
  }
});

// パスキーログイン用 認証レスポンス検証 & ログイン (認証不要)
apiRouter.post('/webauthn/authenticate/verify', async (req: Request, res: Response) => {
  try {
    const reqOrigin = req.headers.origin as string | undefined;
    const result = await verifyWebAuthnAuthentication(req.body, reqOrigin);
    if (result.verified && result.user) {
      const token = createSession(result.user.id);
      res.json({
        success: true,
        token,
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
    res.status(401).json({ error: e.message || 'パスキー認証に失敗しました。' });
  }
});

// 登録済みパスキー一覧取得 (要認証)
apiRouter.get('/webauthn/credentials', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
apiRouter.delete('/webauthn/credentials/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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

// ==========================================
// 📢 チャンネル (Channels) エンドポイント
// ==========================================

// チャンネル一覧取得
apiRouter.get('/channels', asyncHandler(async (req: Request, res: Response) => {
  const category = (req.query.category as string || '').trim();
  const sort = req.query.sort === 'newest' ? 'newest' : 'popular';
  const myUserId = req.user?.id || null;

  let whereClause = 'WHERE is_archived = 0';
  const params: any[] = [];
  if (category) {
    whereClause += ' AND category = ?';
    params.push(category);
  }

  const orderBy = sort === 'newest' ? 'created_at DESC' : 'followers_count DESC, posts_count DESC, created_at DESC';

  const rows = await db.prepare(`
    SELECT c.*,
      CASE WHEN ? IS NOT NULL AND EXISTS(
        SELECT 1 FROM channel_follows cf WHERE cf.channel_id = c.id AND cf.user_id = ?
      ) THEN 1 ELSE 0 END AS is_following
    FROM channels c
    ${whereClause}
    ORDER BY ${orderBy}
  `).all(myUserId, myUserId, ...params) as unknown as (ChannelRow & { is_following: number })[];

  const channels = rows.map((c) => ({
    ...c,
    is_following: Boolean(c.is_following),
    is_archived: Boolean(c.is_archived),
  }));

  res.json(channels);
}));

// チャンネル新規作成 (要認証)
apiRouter.post('/channels', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const { name, description, banner_url, color, category } = req.body;

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName || trimmedName.length > 50) {
    return res.status(400).json({ error: 'チャンネル名は1〜50文字で入力してください。' });
  }

  const channelId = crypto.randomUUID();
  const now = new Date().toISOString();
  const desc = typeof description === 'string' ? description.trim() : '';
  const banner = typeof banner_url === 'string' ? banner_url.trim() : '';
  const col = typeof color === 'string' && color.trim() ? color.trim() : '#6366f1';
  const cat = typeof category === 'string' && category.trim() ? category.trim() : 'general';

  await db.prepare(`
    INSERT INTO channels (id, user_id, name, description, banner_url, color, category, posts_count, followers_count, is_archived, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 0, ?)
  `).run(channelId, user.id, trimmedName, desc, banner, col, cat, now);

  // 作成者を初期フォロワーとして登録
  await db.prepare(`
    INSERT OR IGNORE INTO channel_follows (channel_id, user_id, created_at)
    VALUES (?, ?, ?)
  `).run(channelId, user.id, now);

  res.status(201).json({
    id: channelId,
    user_id: user.id,
    name: trimmedName,
    description: desc,
    banner_url: banner,
    color: col,
    category: cat,
    posts_count: 0,
    followers_count: 1,
    is_archived: false,
    is_following: true,
    created_at: now,
  });
}));

// チャンネル詳細取得
apiRouter.get('/channels/:id', asyncHandler(async (req: Request, res: Response) => {
  const chId = String(req.params.id);
  const myUserId = req.user?.id || null;

  const row = await db.prepare(`
    SELECT c.*,
      CASE WHEN ? IS NOT NULL AND EXISTS(
        SELECT 1 FROM channel_follows cf WHERE cf.channel_id = c.id AND cf.user_id = ?
      ) THEN 1 ELSE 0 END AS is_following
    FROM channels c
    WHERE c.id = ?
  `).get(myUserId, myUserId, chId) as unknown as (ChannelRow & { is_following: number }) | undefined;

  if (!row) {
    return res.status(404).json({ error: 'チャンネルが見つかりません。' });
  }

  res.json({
    ...row,
    is_following: Boolean(row.is_following),
    is_archived: Boolean(row.is_archived),
  });
}));

// チャンネル編集 (要認証・作成者または管理者)
apiRouter.put('/channels/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const chId = String(req.params.id);

  const existing = await db.prepare('SELECT * FROM channels WHERE id = ?').get(chId) as ChannelRow | undefined;
  if (!existing) {
    return res.status(404).json({ error: 'チャンネルが見つかりません。' });
  }

  if (existing.user_id !== user.id && user.role !== 'admin') {
    return res.status(403).json({ error: 'このチャンネルを編集する権限がありません。' });
  }

  const { name, description, banner_url, color, category, is_archived } = req.body;
  const newName = typeof name === 'string' && name.trim() ? name.trim() : existing.name;
  const newDesc = typeof description === 'string' ? description.trim() : existing.description;
  const newBanner = typeof banner_url === 'string' ? banner_url.trim() : existing.banner_url;
  const newColor = typeof color === 'string' && color.trim() ? color.trim() : (existing.color || '#6366f1');
  const newCat = typeof category === 'string' && category.trim() ? category.trim() : (existing.category || 'general');
  const newArchived = typeof is_archived === 'boolean' ? (is_archived ? 1 : 0) : existing.is_archived;

  await db.prepare(`
    UPDATE channels
    SET name = ?, description = ?, banner_url = ?, color = ?, category = ?, is_archived = ?
    WHERE id = ?
  `).run(newName, newDesc, newBanner, newColor, newCat, newArchived, chId);

  res.json({
    ...existing,
    name: newName,
    description: newDesc,
    banner_url: newBanner,
    color: newColor,
    category: newCat,
    is_archived: Boolean(newArchived),
  });
}));

// チャンネル参加 / 解除トグル (要認証)
apiRouter.post('/channels/:id/follow', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const chId = String(req.params.id);

  const channel = await db.prepare('SELECT * FROM channels WHERE id = ?').get(chId) as ChannelRow | undefined;
  if (!channel) {
    return res.status(404).json({ error: 'チャンネルが見つかりません。' });
  }

  const existingFollow = await db.prepare('SELECT 1 FROM channel_follows WHERE channel_id = ? AND user_id = ?').get(chId, user.id);

  if (existingFollow) {
    // 解除
    await db.prepare('DELETE FROM channel_follows WHERE channel_id = ? AND user_id = ?').run(chId, user.id);
    await db.prepare('UPDATE channels SET followers_count = MAX(0, followers_count - 1) WHERE id = ?').run(chId);
    return res.json({ following: false, message: 'チャンネルの参加を解除しました。' });
  } else {
    // 参加
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO channel_follows (channel_id, user_id, created_at) VALUES (?, ?, ?)').run(chId, user.id, now);
    await db.prepare('UPDATE channels SET followers_count = followers_count + 1 WHERE id = ?').run(chId);
    return res.json({ following: true, message: 'チャンネルに参加しました！' });
  }
}));

// チャンネル内タイムライン取得
apiRouter.get('/channels/:id/timeline', asyncHandler(async (req: Request, res: Response) => {
  const chId = String(req.params.id);
  const page = parsePageQuery(req, 50);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }
  const cursorCond = page.cursor ? ` AND ${cursorPredicate('p.published_at', 'p.id')}` : '';
  const cursorParams = page.cursor ? [page.cursor.at, page.cursor.at, page.cursor.id] : [];

  const channel = await db.prepare('SELECT * FROM channels WHERE id = ?').get(chId) as ChannelRow | undefined;
  if (!channel) {
    return res.status(404).json({ error: 'チャンネルが見つかりません。' });
  }

  const query = `
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
      p.emojis,
      p.in_reply_to,
      p.media_attachments,
      p.published_at,
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
    FROM posts p
    LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
    LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
    WHERE p.channel_id = ?${cursorCond}
    ORDER BY p.published_at DESC, p.id DESC
    LIMIT ?
  `;

  const rows = await db.prepare(query).all(chId, ...cursorParams, page.limit + 1) as any[];
  const currentActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;
  const pageRows = applyPageHeaders(res, rows, page.limit, 'timeline_at', 'post_id');
  const enriched = await enrichAndFilterPosts(pageRows, currentActorUrl, req.user?.id);

  res.json({
    channel: {
      ...channel,
      is_archived: Boolean(channel.is_archived),
    },
    posts: enriched,
  });
}));

