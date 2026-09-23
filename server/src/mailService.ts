import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { db, getServerSetting, setServerSetting } from './db.js';
import { config } from './config.js';

/**
 * メール送信（マスターキー復元・メールアドレス確認用）
 *
 *  - SMTP 設定は管理画面（server_settings）を優先し、無ければ環境変数を使う
 *  - 未設定の場合は送信せずに失敗を返す（呼び出し側で機能を無効化する）
 *  - 送信に失敗した場合、復元フローでは「新しいマスターキーを発行しない」
 *    （メールが届かないままキーを更新すると、ユーザーが締め出されるため）
 */

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export async function getMailConfig(): Promise<MailConfig> {
  const envFallback = (key: string, envKey: string): string =>
    getServerSetting(key as any, process.env[envKey] || '') || '';

  const portRaw = getServerSetting('smtp_port' as any, process.env.SMTP_PORT || '587');
  const secureRaw = getServerSetting('smtp_secure' as any, process.env.SMTP_SECURE || '');

  return {
    host: envFallback('smtp_host', 'SMTP_HOST'),
    port: parseInt(String(portRaw) || '587', 10) || 587,
    secure: String(secureRaw).toLowerCase() === 'true' || String(portRaw) === '465',
    user: envFallback('smtp_user', 'SMTP_USER'),
    pass: envFallback('smtp_pass', 'SMTP_PASS'),
    from: getServerSetting('smtp_from' as any, process.env.SMTP_FROM || '') || '',
  };
}

export async function saveMailConfig(cfg: Partial<MailConfig>): Promise<void> {
  const map: [keyof MailConfig, string][] = [
    ['host', 'smtp_host'],
    ['port', 'smtp_port'],
    ['secure', 'smtp_secure'],
    ['user', 'smtp_user'],
    ['pass', 'smtp_pass'],
    ['from', 'smtp_from'],
  ];
  for (const [field, key] of map) {
    if (cfg[field] === undefined) continue;
    const value = field === 'port' ? String(cfg.port) : field === 'secure' ? String(cfg.secure) : String(cfg[field]);
    await setServerSetting(key as any, value.trim());
  }
}

export async function isMailConfigured(cfg?: MailConfig): Promise<boolean> {
  const resolved = cfg || (await getMailConfig());
  return Boolean(resolved.host && resolved.from);
}

async function buildTransport(cfg: MailConfig): Promise<Transporter> {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    // 自己署名証明書のサーバーでも動くよう、暗号化は TLS に任せる
    tls: { rejectUnauthorized: false },
  });
}

export interface SendMailResult {
  ok: boolean;
  error?: string;
}

export async function sendMail(params: { to: string; subject: string; text: string }): Promise<SendMailResult> {
  const cfg = await getMailConfig();
  if (!(await isMailConfigured(cfg))) {
    return { ok: false, error: 'SMTP が設定されていません。' };
  }

  try {
    const transporter = await buildTransport(cfg);
    await transporter.sendMail({
      from: cfg.from,
      to: params.to,
      subject: params.subject,
      text: params.text,
    });
    console.log(`[Mail] ✉️ 送信しました: ${params.subject} -> ${params.to}`);
    return { ok: true };
  } catch (err: any) {
    console.error('[Mail] 送信に失敗しました:', err?.message || err);
    return { ok: false, error: err?.message || 'メール送信に失敗しました。' };
  }
}

/** 管理画面の「接続テスト」用: 接続と認証のみ確認する */
export async function verifyMailConnection(cfg?: MailConfig): Promise<SendMailResult> {
  if (!(await isMailConfigured(cfg))) {
    return { ok: false, error: 'SMTP が設定されていません。' };
  }
  try {
    const transporter = await buildTransport(cfg ?? (await getMailConfig()));
    await transporter.verify();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'SMTP への接続に失敗しました。' };
  }
}

/** 6桁の確認コードを生成する */
export function generateVerificationCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export interface EmailVerificationRow {
  id: string;
  user_id: string;
  email: string;
  code_hash: string;
  purpose: string;
  expires_at: string;
  attempts: number;
  created_at: string;
}

/**
 * 確認コードを発行して保存する（同じ用途の古いコードは無効化）
 *
 * purpose = 'register' はアカウント登録前の確認用で、まだユーザーが存在しないため
 * userId に `register:<メールアドレス>` という擬似IDを渡してメール単位で管理する。
 */
export async function issueVerificationCode(params: {
  userId: string;
  email: string;
  purpose: 'verify_email' | 'recovery' | 'register';
  code: string;
  ttlMinutes?: number;
}): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (params.ttlMinutes ?? 10) * 60 * 1000).toISOString();

  await db.prepare('DELETE FROM email_verifications WHERE user_id = ? AND purpose = ?').run(params.userId, params.purpose);
  await db.prepare(`
    INSERT INTO email_verifications (id, user_id, email, code_hash, purpose, expires_at, attempts, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    crypto.randomUUID(),
    params.userId,
    params.email.toLowerCase(),
    hashVerificationCode(params.code),
    params.purpose,
    expiresAt,
    now.toISOString(),
  );
}

/** 確認コードのハッシュ（DBに平文で残さない） */
export function hashVerificationCode(code: string): string {
  return crypto.createHash('sha256').update(`${code}:${config.origin}`).digest('hex');
}

export interface VerifyCodeResult {
  ok: boolean;
  error?: string;
}

/** 確認コードを検証する（期限・試行回数つき） */
export async function verifyCode(params: {
  userId: string;
  email: string;
  code: string;
  purpose: 'verify_email' | 'recovery' | 'register';
}): Promise<VerifyCodeResult> {
  const row = await db.prepare(
    'SELECT * FROM email_verifications WHERE user_id = ? AND purpose = ?',
  ).get(params.userId, params.purpose) as unknown as EmailVerificationRow | undefined;

  if (!row) {
    return { ok: false, error: '確認コードが見つかりません。もう一度お試しください。' };
  }
  if (new Date(row.expires_at) < new Date()) {
    await db.prepare('DELETE FROM email_verifications WHERE id = ?').run(row.id);
    return { ok: false, error: '確認コードの有効期限が切れています。' };
  }
  if (row.attempts >= 5) {
    await db.prepare('DELETE FROM email_verifications WHERE id = ?').run(row.id);
    return { ok: false, error: '試行回数の上限に達しました。もう一度お試しください。' };
  }
  if (row.email !== params.email.toLowerCase()) {
    return { ok: false, error: 'メールアドレスが一致しません。' };
  }
  if (row.code_hash !== hashVerificationCode(params.code)) {
    await db.prepare('UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return { ok: false, error: '確認コードが正しくありません。' };
  }

  await db.prepare('DELETE FROM email_verifications WHERE id = ?').run(row.id);
  return { ok: true };
}
