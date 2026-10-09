/**
 * 2段階認証（TOTP）の保存まわり
 *
 * 秘密そのものは users.totp_secret（base32）に置き、有効・無効は users.totp_enabled で持つ。
 * リカバリーコードはハッシュだけを users.totp_recovery_codes（JSON 配列）に残す。
 *
 * 関連: server/src/totp.ts（アルゴリズム本体）、docs/SECURITY-2FA.md
 */
import { db } from './db.js';
import { hashRecoveryCode } from './totp.js';

/** 設定画面に出す状態 */
export async function getTotpState(userId: string): Promise<{ enabled: boolean; remainingCodes: number }> {
  const row = (await db
    .prepare('SELECT totp_enabled, totp_recovery_codes FROM users WHERE id = ?')
    .get(userId)) as { totp_enabled?: number; totp_recovery_codes?: string } | undefined;
  let remainingCodes = 0;
  try {
    const parsed = JSON.parse(String(row?.totp_recovery_codes || '[]'));
    if (Array.isArray(parsed)) remainingCodes = parsed.length;
  } catch {
    remainingCodes = 0;
  }
  return { enabled: Number(row?.totp_enabled) === 1, remainingCodes };
}

/** 有効化の途中: 秘密を保存するが、まだ有効にはしない（コードで確認できてから有効にする） */
export async function setPendingTotpSecret(userId: string, secret: string): Promise<void> {
  await db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_recovery_codes = ? WHERE id = ?').run(secret, '[]', userId);
}

/** 有効化を確定する（リカバリーコードのハッシュを一緒に保存） */
export async function enableTotp(userId: string, recoveryCodes: string[]): Promise<void> {
  const hashed = JSON.stringify(recoveryCodes.map(hashRecoveryCode));
  await db.prepare('UPDATE users SET totp_enabled = 1, totp_recovery_codes = ? WHERE id = ?').run(hashed, userId);
}

/** 無効にする（秘密もリカバリーコードも消す） */
export async function disableTotp(userId: string): Promise<void> {
  await db.prepare("UPDATE users SET totp_enabled = 0, totp_secret = '', totp_recovery_codes = '[]' WHERE id = ?").run(userId);
}

/** リカバリーコードを 1 回だけ使える形で消費する。一致したら true（配列からは消えて再利用できない） */
export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const row = (await db.prepare('SELECT totp_recovery_codes FROM users WHERE id = ?').get(userId)) as
    | { totp_recovery_codes?: string }
    | undefined;
  let codes: string[] = [];
  try {
    const parsed = JSON.parse(String(row?.totp_recovery_codes || '[]'));
    if (Array.isArray(parsed)) codes = parsed.filter((c) => typeof c === 'string');
  } catch {
    return false;
  }
  const target = hashRecoveryCode(code);
  if (!codes.includes(target)) return false;
  await db
    .prepare('UPDATE users SET totp_recovery_codes = ? WHERE id = ?')
    .run(JSON.stringify(codes.filter((c) => c !== target)), userId);
  return true;
}
