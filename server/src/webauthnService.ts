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

/**
 * リクエスト元のオリジンや設定から WebAuthn RP 情報を取得
 */
export function getRPInfo(reqOrigin?: string) {
  let rpID = config.domain;
  let origin = config.origin;

  if (reqOrigin) {
    try {
      const urlStr = reqOrigin.includes('://') ? reqOrigin : `http://${reqOrigin}`;
      const u = new URL(urlStr);
      rpID = u.hostname;
      origin = u.origin;
    } catch {}
  }
  return {
    rpName: 'Spica',
    rpID,
    origin,
  };
}

/**
 * チャレンジをDBに保存
 */
export async function saveChallenge(challenge: string, type: 'registration' | 'authentication', userId?: string) {
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  await db.prepare(`
    INSERT OR REPLACE INTO webauthn_challenges (challenge, user_id, type, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(challenge, userId || null, type, expiresAt);
}

/**
 * チャレンジを取得＆検証後に消費（ワンタイム）
 */
export async function consumeChallenge(challenge: string, type: 'registration' | 'authentication'): Promise<{ userId: string | null }> {
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
export async function createWebAuthnRegistrationOptions(user: UserRow, reqOrigin?: string) {
  const { rpName, rpID } = getRPInfo(reqOrigin);

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
  reqOrigin?: string
) {
  const { expectedChallenge } = body;
  if (!expectedChallenge) {
    throw new Error('チャレンジ情報が不足しています。');
  }

  await consumeChallenge(expectedChallenge, 'registration');
  const { rpID, origin } = getRPInfo(reqOrigin);

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
export async function createWebAuthnAuthenticationOptions(userId?: string, reqOrigin?: string) {
  const { rpID } = getRPInfo(reqOrigin);

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
export async function verifyWebAuthnAuthentication(body: any, reqOrigin?: string) {
  const { expectedChallenge, credential } = body;
  if (!expectedChallenge || !credential) {
    throw new Error('認証パラメータが不足しています。');
  }

  await consumeChallenge(expectedChallenge, 'authentication');
  const { rpID, origin } = getRPInfo(reqOrigin);

  // DBから該当するクレデンシャルを探索
  const credRow = await db.prepare('SELECT * FROM webauthn_credentials WHERE id = ?').get(credential.id) as WebAuthnCredentialRow | undefined;
  if (!credRow) {
    throw new Error('登録されていないパスキーです。');
  }

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
