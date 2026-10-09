/**
 * パスキー（WebAuthn）の登録と一覧。
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
  [key: string]: unknown;
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
      },
    },
    expectedChallenge: options.challenge,
    device_name: deviceName || 'この端末',
  });
  return verifyRes.ok ? null : messageOf(verifyRes.data, 'パスキーを登録できませんでした。');
}
