import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { adb, UserRow } from './db.js';

export interface AuthenticatedUser {
  id: string;
  name: string;
  summary: string;
  icon_url?: string;
  banner_url?: string;
  role: 'admin' | 'user';
  is_frozen: number;
  created_at: string;
}

// Request型を拡張して user を持てるようにする
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser | null;
      rawUser?: UserRow | null;
    }
  }
}

/**
 * 暗号学的に安全なマスターキー（秘密鍵）を生成
 * 例: "spica_sk_4f8a9b2c..." (64 hex characters)
 */
export function generateMasterKey(): string {
  const randomBytes = crypto.randomBytes(32).toString('hex');
  return `spica_sk_${randomBytes}`;
}

/**
 * マスターキーのハッシュ（SHA-256）を計算
 */
export function hashMasterKey(masterKey: string): string {
  return crypto.createHash('sha256').update(masterKey.trim()).digest('hex');
}

/**
 * パスワードのハッシュ（Node 標準の scrypt。追加依存なし）
 * 形式: "scrypt$<salt(hex)>$<hash(hex)>"
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/** パスワードの検証（タイミング攻撃を避けるため timingSafeEqual を使う） */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored || !stored.startsWith('scrypt$')) {
    return false;
  }
  const [, salt, expected] = stored.split('$');
  if (!salt || !expected) {
    return false;
  }
  try {
    const actual = crypto.scryptSync(password, salt, 64).toString('hex');
    const actualBuf = Buffer.from(actual, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (actualBuf.length !== expectedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(actualBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * セッショントークンを発行して DB に保存（有効期限: 30日）
 */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: string }> {
  const token = `spica_sess_${crypto.randomBytes(32).toString('hex')}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await adb.prepare(`
    INSERT INTO sessions (token, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(token, userId, now.toISOString(), expiresAt);

  return { token, expiresAt };
}

/**
 * セッショントークンを破棄（ログアウト）
 */
export async function destroySession(token: string): Promise<void> {
  await adb.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/**
 * トークンからユーザーを検証・取得
 */
export async function getUserFromToken(token: string): Promise<AuthenticatedUser | null> {
  const now = new Date().toISOString();
  const session = await adb.prepare(`
    SELECT user_id, expires_at FROM sessions WHERE token = ? AND expires_at > ?
  `).get(token, now) as { user_id: string; expires_at: string } | undefined;

  if (!session) {
    return null;
  }

  const user = await adb.prepare(`
    SELECT id, name, summary, icon_url, banner_url, role, is_frozen, created_at FROM users WHERE id = ?
  `).get(session.user_id) as unknown as AuthenticatedUser | undefined;

  if (!user || user.is_frozen === 1) {
    return null;
  }

  return user;
}

/**
 * 認証ミドルウェア（リクエストヘッダーからセッションを読み取る）
 */
export function authenticate(req: Request, res: Response, next: NextFunction) {
  // 非同期の失敗は next(err) に流す（Express 4 は reject を拾わないため）
  void (async () => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }

    const token = authHeader.slice(7).trim();
    const user = await getUserFromToken(token);
    req.user = user;

    if (user) {
      req.rawUser = await adb.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as unknown as UserRow;
    }

    next();
  })().catch(next);
}

/**
 * ログイン必須ミドルウェア
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: '認証が必要です。マスターキーでログインしてください。' });
  }
  next();
}

/**
 * ユーザーが持つ権限の集合を解決する
 *   - users.role が 'admin' の場合は admin 権限を持つ（既存の管理者）
 *   - 付与されたロール（roles.permissions）の権限も加える
 */
export async function getUserPermissions(user: { id: string; role: string }): Promise<Set<string>> {
  const permissions = new Set<string>();
  if (user.role === 'admin') {
    permissions.add('admin');
  }
  try {
    const rows = await adb.prepare(`
      SELECT r.permissions FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id = ?
    `).all(user.id) as { permissions: string }[];
    for (const row of rows) {
      for (const permission of String(row.permissions || '').split(',').map((p) => p.trim()).filter(Boolean)) {
        permissions.add(permission);
      }
    }
  } catch {
    // テーブル未作成などは無視（権限なしとして扱う）
  }
  return permissions;
}

/** 指定権限を持つか（'admin' は全権限を包含する） */
export async function hasPermission(user: { id: string; role: string } | null | undefined, permission: string): Promise<boolean> {
  if (!user) {
    return false;
  }
  const permissions = await getUserPermissions(user);
  return permissions.has(permission) || permissions.has('admin');
}

/**
 * 管理者（Admin）必須ミドルウェア
 * 付与ロールに 'admin' 権限がある場合も許可する
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  void (async () => {
    if (!(await hasPermission(req.user, 'admin'))) {
      return res.status(403).json({ error: 'この操作には管理者権限が必要です。' });
    }
    next();
  })().catch(next);
}

/**
 * モデレーター権限（通報対応・凍結・ドメインブロックなど）必須ミドルウェア
 * 'moderate' 権限を持つロールを付与されたユーザーが利用できる
 */
export function requireModerator(req: Request, res: Response, next: NextFunction) {
  void (async () => {
    if (!(await hasPermission(req.user, 'moderate'))) {
      return res.status(403).json({ error: 'この操作にはモデレーター権限が必要です。' });
    }
    next();
  })().catch(next);
}
