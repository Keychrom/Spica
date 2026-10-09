/**
 * TOTP（RFC 6238）とリカバリーコード
 *
 * 外部ライブラリは使わない（HMAC-SHA1 と base32 だけで足りる）。
 * 認証アプリ（Google Authenticator / 1Password / iOS パスワード等）と互換。
 *
 * 設計:
 *   - 30 秒ステップ・6 桁・SHA-1（最も互換性が高い組み合わせ）
 *   - 検証は前後 1 ステップまで許容する（時計のずれ・入力の遅れのため）
 *   - 秘密は users.totp_secret に base32 で保存する（DB を読める立場の人には見える。
 *     パスワードのハッシュとは違い、これは「本人しか持っていない何か」の控えなので、
 *     ノードの DB を守ることは別途必要）
 *   - リカバリーコードは 10 個を一度だけ表示し、DB にはハッシュだけを残す
 */
import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
/** 前後 1 ステップ（±30 秒）まで許容する */
const WINDOW_STEPS = 1;

/** base32（RFC 4648・パディング無し）でエンコードする */
function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** base32（大文字小文字・空白・ハイフン・パディングを許容）をバイト列に戻す */
export function base32Decode(input: string): Buffer {
  const clean = String(input || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue; // 未知の文字は無視する（QR の読み取りゆれ対策）
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 新しい秘密（160bit）を作る */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** 認証アプリに読み込ませる otpauth:// URI */
export function buildOtpauthUri(secret: string, accountLabel: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** 指定時刻のコードを計算する（テストで使う。通常は now を省略する） */
export function generateTotpCode(secret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** 入力されたコードを検証する（前後 1 ステップまで許容） */
export function verifyTotpCode(secret: string, code: string, atMs: number = Date.now()): boolean {
  const input = String(code || '').replace(/\D/g, '');
  if (!secret || input.length !== DIGITS) return false;
  for (let step = -WINDOW_STEPS; step <= WINDOW_STEPS; step++) {
    const expected = generateTotpCode(secret, atMs + step * STEP_SECONDS * 1000);
    // 一致する文字列でも比較時間を一定にする
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(input.padStart(DIGITS, '0')))) {
      return true;
    }
  }
  return false;
}

/** リカバリーコード（1 回だけ使える）。人が書き写せる形にする */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 文字
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

/** DB にはハッシュだけを残す（漏れても使い回せないように） */
export function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(String(code || '').trim().toUpperCase()).digest('hex');
}
