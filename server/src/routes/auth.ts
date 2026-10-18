/**
 * 認証・アカウント設定（マスターキー / パスワード / 2段階認証 / メール復元）。
 *
 * api.ts から切り出したルーター。マウント位置（api.ts）は元の登録順と同じ。
 */
import { asyncHandler } from '../asyncHandler.js';
import { Router, Request, Response } from 'express';
import { db, UserRow, getInstanceInfo, InvitationCodeRow, getServerSetting } from '../db.js';
import { getUserPermissions } from '../auth.js';
import { config } from '../config.js';
import { generateKeyPair } from '../crypto.js';
import {
  isMailConfigured,
  sendMail,
  generateVerificationCode,
  issueVerificationCode,
  verifyCode,
} from '../mailService.js';
import { buildOtpauthUri, generateRecoveryCodes, generateTotpSecret, verifyTotpCode } from '../totp.js';
import { consumeRecoveryCode, disableTotp, enableTotp, getTotpState, setPendingTotpSecret } from '../totpService.js';
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
} from '../auth.js';

const router = Router();

// ==========================================
// 認証 (Auth) エンドポイント - マスターキー方式
// ==========================================

// 📧 登録前のメールアドレス確認コード送信（パスワード方式の新規登録で使用）
router.post('/auth/register/email-code', asyncHandler(async (req: Request, res: Response) => {
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
router.post('/auth/register', asyncHandler(async (req: Request, res: Response) => {
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
router.post('/auth/login', asyncHandler(async (req: Request, res: Response) => {
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
router.post('/auth/logout', asyncHandler(async (req: Request, res: Response) => {
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
router.get('/sessions', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const current = sessionPublicId(currentSessionToken(req));
  const sessions = await listUserSessions(user.id);
  res.json({ sessions: sessions.map((s) => ({ ...s, current: s.id === current })) });
}));

// 指定した端末（自分以外のセッション）からログアウトさせる
router.delete('/sessions/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
router.post('/sessions/revoke-others', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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

router.get('/me/totp', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const state = await getTotpState(req.user!.id);
  res.json(state);
}));

// 有効化の準備: 秘密を発行して保存し、認証アプリに読み込ませる情報を返す（まだ有効ではない）
router.post('/me/totp/setup', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
router.post('/me/totp/enable', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
router.post('/me/totp/disable', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
router.post('/me/totp/recovery-codes', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
router.get('/auth/me', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const raw = req.rawUser;
  const myActorUrl = `${config.origin}/users/${user.id}`;
  const followerCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_url = ?').get(myActorUrl) as any).c;
  const followingCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE follower_url = ?').get(myActorUrl) as any).c;
  // 自分の投稿数に DM は数えない（DM はタイムラインに出ない投稿なので別扱い）
  const postCount = (await db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND COALESCE(visibility, 'public') != 'direct'").get(user.id) as any).c;

  const isApp = user.sessionKind === 'app';
  const base = {
    ...user,
    handle: `@${user.id}@${config.domain}`,
    actorUrl: myActorUrl,
    followerCount,
    followingCount,
    postCount,
    // 初期設定ウィザードの状態（0 = 未完了。クライアントはこれを見てウィザードを出す）
    onboarding_completed: Number(raw?.onboarding_completed ?? 1),
    // プライバシー設定（プロフィール HTML の robots に反映される）
    noindex: Number(raw?.noindex ?? 0),
    no_ai_training: Number(raw?.no_ai_training ?? 0),
    is_locked: Number(raw?.is_locked ?? 0),
    discoverable: Number(raw?.discoverable ?? 1),
  };
  // MiAuth のアプリには、メール・パスワード・TOTP・権限一覧を返さない
  if (isApp) {
    return res.json(base);
  }
  res.json({
    ...base,
    // 本人にだけ返す自分のメール状態とパスワード設定の有無（ハッシュ類は返さない）
    email: raw?.email || '',
    email_verified: Number(raw?.email_verified) || 0,
    hasPassword: Boolean(raw?.password_hash),
    // 2段階認証（TOTP）が有効か
    totp_enabled: Number(raw?.totp_enabled ?? 0),
    // 権限の一覧（'admin' / 'moderate' など）。画面の出し分けはこの配列で判断する
    permissions: Array.from(await getUserPermissions(user)),
  });
}));

// 初期設定ウィザードの完了（「あとで」で閉じた場合も完了扱い。冪等）
router.post('/me/onboarding/complete', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  await db.prepare('UPDATE users SET onboarding_completed = 1 WHERE id = ?').run(req.user!.id);
  res.json({ success: true, onboarding_completed: 1 });
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
router.get('/auth/recovery/status', asyncHandler(async (_req: Request, res: Response) => {
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
router.post('/user/password', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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

router.post('/user/email', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
router.post('/user/email/verify', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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
router.delete('/user/email', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  await db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(user.id);
  await db.prepare("UPDATE users SET email = '', email_verified = 0 WHERE id = ?").run(user.id);
  console.log(`[Email] 🗑️ @${user.id} がメールアドレスを削除しました`);
  res.json({ success: true });
}));

// 🔑 マスターキー紛失時の復元（手順: ID+メール → 確認コード → 新しいキーをメールで受領）
router.post('/auth/recovery/request', asyncHandler(async (req: Request, res: Response) => {
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
router.post('/auth/recovery/verify', asyncHandler(async (req: Request, res: Response) => {
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


export default router;
