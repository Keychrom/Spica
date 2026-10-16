import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { db, UserRow, WebAuthnCredentialRow } from './db.js';
import { config } from './config.js';

// チャレンジの有効期限: 5分
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** オリジン比較用の正規化（末尾のスラッシュだけ落とす。スキームとホストはそのまま比べる） */
function normalizeOrigin(value: string | undefined | null): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

/** このノードで WebAuthn に使ってよいオリジン（設定の `origin` + `WEBAUTHN_EXTRA_ORIGINS`） */
export function allowedWebAuthnOrigins(): string[] {
  return [normalizeOrigin(config.origin), ...config.webauthnExtraOrigins.map(normalizeOrigin)].filter(Boolean);
}

/**
 * クライアント側の事情で断るエラー（サーバーの不具合ではない）。
 * ルートは `statusCode` を見て 403 を返す（500 で「内部エラー」に化けないように）
 */
function forbidden(message: string): Error {
  const error: any = new Error(message);
  error.statusCode = 403;
  return error;
}

/**
 * リクエストの Origin を検証する。
 *
 * **WebAuthn の安全性は「オリジンに束縛されていること」そのもの**なので、リクエストが名乗った
 * Origin を expectedOrigin / rpID に流用してはいけない（以前はそうしていて、任意のオリジンから
 * パスキーを作れる＝束縛が無効な状態だった。2026-10-16 に修正）。
 * ブラウザは POST に Origin を付けるので、付いていて設定と違えば**その場で拒否**する。
 * 付いていない場合（非ブラウザのクライアント）は、そもそも有効な assertion を作れないので素通しする。
 */
export function assertWebAuthnOrigin(requestOrigin?: string): void {
  const value = normalizeOrigin(requestOrigin);
  if (!value) return;
  if (!allowedWebAuthnOrigins().includes(value)) {
    throw forbidden(
      `このオリジン（${value}）からのパスキー操作は許可されていません。設定の DOMAIN / PROTOCOL（${config.origin}）から開いてください。`,
    );
  }
}

/**
 * WebAuthn の RP 情報。
 *
 * **リクエストが名乗ったオリジンは（許可リストに載っている場合を除いて）使わない。**
 * 既定は設定（`config.origin` / `config.domain`）で、これは受信箱が署名の宛先を
 * 自分で決めるのと同じ考え方（自己申告を信じない）。
 * 許可リスト（`WEBAUTHN_EXTRA_ORIGINS`）に載っているオリジンだけは、**管理者が明示した**
 * ものなのでそのオリジンに合わせる（そうしないと開発サーバーなど別のオリジンから
 * パスキーを作れない。ブラウザはページのオリジンでしか手続きをしないため）。
 * rpID はポートを含めないホスト名（`localhost:3000` → `localhost`）。
 */
export function getRPInfo(requestOrigin?: string) {
  const value = normalizeOrigin(requestOrigin);
  const origin = value && allowedWebAuthnOrigins().includes(value) ? value : config.origin;
  let rpID: string;
  try {
    rpID = new URL(origin).hostname;
  } catch {
    // origin が URL にならない異常時だけ domain からポートを落とす
    rpID = String(config.domain).split(':')[0];
  }
  return {
    rpName: 'Spica',
    rpID,
    origin,
  };
}

/**
 * チャレンジをDBに保存
 *
 * `totp` は「パスキーの検証は済んだが 2段階認証コードがまだ」の一時トークン
 * （5 分で失効・1 回だけ使える。パスキーをもう一度やり直さずにコードを入れ直せるようにするため）
 */
export async function saveChallenge(
  challenge: string,
  type: 'registration' | 'authentication' | 'totp',
  userId?: string,
) {
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  await db.prepare(`
    INSERT OR REPLACE INTO webauthn_challenges (challenge, user_id, type, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(challenge, userId || null, type, expiresAt);
}

/**
 * チャレンジを取得＆検証後に消費（ワンタイム）
 */
export async function consumeChallenge(
  challenge: string,
  type: 'registration' | 'authentication' | 'totp',
): Promise<{ userId: string | null }> {
  const now = Date.now();
  const row = await db.prepare(`
    SELECT * FROM webauthn_challenges 
    WHERE challenge = ? AND type = ? AND expires_at >= ?
  `).get(challenge, type, now) as { challenge: string; user_id: string | null } | undefined;

  if (!row) {
    throw new Error('チャレンジが無効か、有効期限が切れています。もう一度やり直してください。');
  }

  await db.prepare('DELETE FROM webauthn_challenges WHERE challenge = ?').run(challenge);
  return { userId: row.user_id };
}

/**
 * 🔐 1. パスキー登録オプション生成
 */
export async function createWebAuthnRegistrationOptions(user: UserRow, requestOrigin?: string) {
  assertWebAuthnOrigin(requestOrigin);
  const { rpName, rpID } = getRPInfo(requestOrigin);

  // すでに登録済みのクレデンシャルを除外リストに入れる
  const userCreds = await db.prepare('SELECT id, transports FROM webauthn_credentials WHERE user_id = ?').all(user.id) as { id: string; transports: string }[];
  const excludeCredentials = userCreds.map((c) => ({
    id: c.id,
    transports: (() => {
      try { return JSON.parse(c.transports || '[]'); } catch { return undefined; }
    })(),
  }));

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.name || user.id,
    userDisplayName: user.name || user.id,
    attestationType: 'none',
    excludeCredentials,
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  await saveChallenge(options.challenge, 'registration', user.id);
  return options;
}

/**
 * 🔐 2. パスキー登録検証
 */
export async function verifyWebAuthnRegistration(
  user: UserRow,
  body: any,
  deviceName: string,
  requestOrigin?: string
) {
  const { expectedChallenge } = body;
  if (!expectedChallenge) {
    throw new Error('チャレンジ情報が不足しています。');
  }
  assertWebAuthnOrigin(requestOrigin);

  // チャレンジは**発行時に紐付けた利用者**のものだけ消費できる
  // （他人宛てのチャレンジを使い回せないようにする）
  const { userId: challengeUserId } = await consumeChallenge(expectedChallenge, 'registration');
  if (challengeUserId && challengeUserId !== user.id) {
    throw new Error('このチャレンジは別の利用者に発行されたものです。');
  }
  const { rpID, origin } = getRPInfo(requestOrigin);

  const verification = await verifyRegistrationResponse({
    response: body.credential,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('パスキーの検証に失敗しました。');
  }

  const { credential, credentialDeviceType } = verification.registrationInfo;

  // 公開鍵を Base64 文字列として保存
  const pubKeyBase64 = Buffer.from(credential.publicKey).toString('base64');
  const now = new Date().toISOString();
  const cleanDeviceName = deviceName.trim() || credentialDeviceType || '生体認証デバイス';
  const transportsJson = JSON.stringify(body.credential.response?.transports || []);

  await db.prepare(`
    INSERT INTO webauthn_credentials (id, user_id, public_key, counter, device_name, transports, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    credential.id,
    user.id,
    pubKeyBase64,
    credential.counter,
    cleanDeviceName,
    transportsJson,
    now
  );

  return {
    verified: true,
    credentialId: credential.id,
    deviceName: cleanDeviceName,
  };
}

/**
 * 🔐 3. パスキー認証オプション生成
 */
export async function createWebAuthnAuthenticationOptions(userId?: string, requestOrigin?: string) {
  assertWebAuthnOrigin(requestOrigin);
  const { rpID } = getRPInfo(requestOrigin);

  let allowCredentials: any[] | undefined = undefined;
  if (userId) {
    const creds = await db.prepare('SELECT id, transports FROM webauthn_credentials WHERE user_id = ?').all(userId) as { id: string; transports: string }[];
    if (creds.length > 0) {
      allowCredentials = creds.map((c) => ({
        id: c.id,
        transports: (() => {
          try { return JSON.parse(c.transports || '[]'); } catch { return undefined; }
        })(),
      }));
    }
  }

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials,
    userVerification: 'preferred',
  });

  await saveChallenge(options.challenge, 'authentication', userId);
  return options;
}

/**
 * 🔐 4. パスキー認証検証
 */
export async function verifyWebAuthnAuthentication(body: any, requestOrigin?: string) {
  const { expectedChallenge, credential } = body;
  if (!expectedChallenge || !credential) {
    throw new Error('認証パラメータが不足しています。');
  }
  assertWebAuthnOrigin(requestOrigin);

  // クレデンシャルの確認を**チャレンジを消費する前**に行う
  // （知らない ID で叩かれたときに、正しい利用者のチャレンジを無駄に燃やさないため）
  const credRow = await db.prepare('SELECT * FROM webauthn_credentials WHERE id = ?').get(credential.id) as WebAuthnCredentialRow | undefined;
  if (!credRow) {
    throw new Error('登録されていないパスキーです。');
  }

  // チャレンジを消費し、発行時に紐付けた利用者と**このクレデンシャルの持ち主**が一致することを確かめる
  const { userId: challengeUserId } = await consumeChallenge(expectedChallenge, 'authentication');
  if (challengeUserId && challengeUserId !== credRow.user_id) {
    throw new Error('このチャレンジは別の利用者に発行されたものです。');
  }

  const { rpID, origin } = getRPInfo(requestOrigin);

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(credRow.user_id) as UserRow | undefined;
  if (!user) {
    throw new Error('ユーザーが見つかりません。');
  }
  if (user.is_frozen === 1) {
    throw new Error('アカウントが凍結されているためログインできません。');
  }

  const publicKeyBuffer = Buffer.from(credRow.public_key, 'base64');

  const verification = await verifyAuthenticationResponse({
    response: credential,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: credRow.id,
      publicKey: new Uint8Array(publicKeyBuffer),
      counter: credRow.counter,
    },
  });

  if (!verification.verified) {
    throw new Error('生体認証の署名検証に失敗しました。');
  }

  // サインカウンターと最終利用日時を更新
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE webauthn_credentials 
    SET counter = ?, last_used_at = ?
    WHERE id = ?
  `).run(verification.authenticationInfo.newCounter, now, credRow.id);

  return {
    verified: true,
    user,
  };
}
