/**
 * パスキー（WebAuthn）の登録・一覧とログイン。
 * ブラウザの作法（ArrayBuffer ⇄ base64url）はここにだけ書く。
 * ※ 実機の指紋・顔認証が要るため、まだ動作確認はできていない。
 */
import { api, messageOf } from './api';

export interface Passkey {
  id: string;
  device_name?: string;
  created_at?: string;
  last_used_at?: string;
}

function b64urlToBuffer(value: string): ArrayBuffer {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

function bufferToB64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let raw = '';
  for (let i = 0; i < bytes.length; i += 1) raw += String.fromCharCode(bytes[i]);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface OptionsJSON {
  challenge: string;
  user?: { id: string; name: string; displayName: string };
  excludeCredentials?: { id: string; type?: string; transports?: string[] }[];
  allowCredentials?: { id: string; type?: string; transports?: string[] }[];
  [key: string]: unknown;
}

/** パスキーログインの結果（2段階認証が要る場合は pendingToken を返す） */
export interface PasskeyLoginResult {
  ok: boolean;
  token?: string;
  user?: {
    id: string;
    name: string;
    icon_url?: string;
    is_admin?: boolean;
    [key: string]: unknown;
  };
  error?: string;
  totpRequired?: boolean;
  pendingToken?: string;
}

export async function loadPasskeys(): Promise<Passkey[]> {
  const res = await api.get('/api/webauthn/credentials');
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as Passkey[];
}

export async function removePasskey(id: string): Promise<boolean> {
  return (await api.del('/api/webauthn/credentials/' + encodeURIComponent(id))).ok;
}

/** 端末の認証（指紋・顔・PIN）でパスキーを作る */
export async function registerPasskey(deviceName: string): Promise<string | null> {
  if (typeof window.PublicKeyCredential === 'undefined') {
    return 'このブラウザはパスキーに対応していません。';
  }
  const optionsRes = await api.post('/api/webauthn/register/options');
  if (!optionsRes.ok || !optionsRes.data) {
    return messageOf(optionsRes.data, '登録を始められませんでした。');
  }
  const options = optionsRes.data as OptionsJSON;

  const publicKey: PublicKeyCredentialCreationOptions = {
    ...(options as unknown as PublicKeyCredentialCreationOptions),
    challenge: b64urlToBuffer(options.challenge),
    user: {
      ...(options.user as unknown as PublicKeyCredentialUserEntity),
      id: b64urlToBuffer(options.user?.id || ''),
    },
    ...(options.excludeCredentials
      ? {
          excludeCredentials: options.excludeCredentials.map((item) => ({
            ...item,
            id: b64urlToBuffer(item.id),
          })) as PublicKeyCredentialDescriptor[],
        }
      : {}),
  };

  let credential: Credential | null = null;
  try {
    credential = await navigator.credentials.create({ publicKey });
  } catch (err) {
    return err instanceof Error && err.name === 'NotAllowedError'
      ? '端末の認証が取り消されました。'
      : 'パスキーを作れませんでした。';
  }
  if (!credential) return 'パスキーを作れませんでした。';

  const cred = credential as PublicKeyCredential;
  const response = cred.response as AuthenticatorAttestationResponse;
  const verifyRes = await api.post('/api/webauthn/register/verify', {
    credential: {
      id: cred.id,
      rawId: bufferToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufferToB64url(response.clientDataJSON),
        attestationObject: bufferToB64url(response.attestationObject),
        // 認証器の種類（internal / hybrid / usb など）。ログイン時の allowCredentials に使う
        transports: response.getTransports?.() ?? [],
      },
      clientExtensionResults: cred.getClientExtensionResults(),
    },
    expectedChallenge: options.challenge,
    device_name: deviceName || 'この端末',
  });
  return verifyRes.ok ? null : messageOf(verifyRes.data, 'パスキーを登録できませんでした。');
}

/**
 * 端末の認証でパスキーログインする。
 *
 * `userId` を渡すとそのアカウントのパスキーに絞り込む（省略すると、この端末に保存された
 * パスキーから選ぶ discoverable の経路。サーバーはどちらも受け付ける）。
 * 2段階認証が有効なアカウントは、パスキーの確認後にコードを求める（pendingToken を返す）。
 */
export async function loginWithPasskey(userId?: string): Promise<PasskeyLoginResult> {
  if (typeof window.PublicKeyCredential === 'undefined') {
    return { ok: false, error: 'このブラウザはパスキーに対応していません。' };
  }
  const optionsRes = await api.post('/api/webauthn/authenticate/options', userId ? { user_id: userId } : {});
  if (!optionsRes.ok || !optionsRes.data) {
    return { ok: false, error: messageOf(optionsRes.data, 'パスキーの準備をできませんでした。') };
  }
  const options = optionsRes.data as OptionsJSON;

  const publicKey: PublicKeyCredentialRequestOptions = {
    ...(options as unknown as PublicKeyCredentialRequestOptions),
    challenge: b64urlToBuffer(options.challenge),
    ...(options.allowCredentials
      ? {
          allowCredentials: options.allowCredentials.map((item) => ({
            ...item,
            id: b64urlToBuffer(item.id),
          })) as PublicKeyCredentialDescriptor[],
        }
      : {}),
  };

  let credential: Credential | null = null;
  try {
    credential = await navigator.credentials.get({ publicKey });
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && err.name === 'NotAllowedError'
          ? '端末の認証が取り消されました。'
          : 'パスキーでログインできませんでした。',
    };
  }
  if (!credential) return { ok: false, error: 'パスキーでログインできませんでした。' };

  const assertion = credential as PublicKeyCredential;
  const response = assertion.response as AuthenticatorAssertionResponse;
  const verifyRes = await api.post('/api/webauthn/authenticate/verify', {
    credential: {
      id: assertion.id,
      rawId: bufferToB64url(assertion.rawId),
      type: assertion.type,
      response: {
        clientDataJSON: bufferToB64url(response.clientDataJSON),
        authenticatorData: bufferToB64url(response.authenticatorData),
        signature: bufferToB64url(response.signature),
        ...(response.userHandle ? { userHandle: bufferToB64url(response.userHandle) } : {}),
      },
      clientExtensionResults: assertion.getClientExtensionResults(),
    },
    expectedChallenge: options.challenge,
  });

  const data = verifyRes.data as
    | { token?: string; user?: PasskeyLoginResult['user']; totp_required?: boolean; pendingToken?: string }
    | null;
  if (verifyRes.ok && data?.token) {
    return { ok: true, token: data.token, user: data.user };
  }
  if (verifyRes.status === 401 && data?.totp_required) {
    return {
      ok: false,
      error: messageOf(verifyRes.data, '2段階認証コードを入力してください。'),
      totpRequired: true,
      pendingToken: data.pendingToken,
    };
  }
  return { ok: false, error: messageOf(verifyRes.data, 'パスキー認証に失敗しました。') };
}

/**
 * パスキーのあとの 2段階認証コードを送る（パスキーをもう一度やり直さずに済む）。
 * コードを間違えても pendingToken はサーバー側で消費されないので、入れ直せる。
 */
export async function completePasskeyTotp(pendingToken: string, totpCode: string): Promise<PasskeyLoginResult> {
  const res = await api.post('/api/webauthn/authenticate/totp', { pendingToken, totpCode });
  const data = res.data as
    | { token?: string; user?: PasskeyLoginResult['user']; totp_required?: boolean }
    | null;
  if (res.ok && data?.token) {
    return { ok: true, token: data.token, user: data.user };
  }
  return {
    ok: false,
    error: messageOf(res.data, '2段階認証コードが正しくありません。'),
    totpRequired: Boolean(data?.totp_required),
  };
}
