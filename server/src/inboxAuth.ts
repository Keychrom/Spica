import { Request } from 'express';
import { config } from './config.js';
import { db, UserRow } from './db.js';
import { fetchRemoteActor } from './activitypub.js';
import { getInstanceActorKeyPair } from './instanceActor.js';
import { parseSignatureHeader, verifyHttpSignatureDetailed } from './crypto.js';

/**
 * ActivityPub の Inbox に届いたリクエストが、Activity の actor 本人によって
 * 正しく署名されているかを検証する。
 *
 * 検証項目:
 *   1. Signature ヘッダーが存在し、パースできること
 *   2. 署名鍵 (keyId) の所有者 URL が Activity の actor と一致すること（なりすまし防止）
 *   3. 署名が実際にその公開鍵で検証できること
 *   4. ボディ付きリクエストでは digest が署名対象に含まれ、実ボディと一致すること
 *   5. Date ヘッダーが許容幅内であること（リプレイ防止）
 */

export interface InboxAuthResult {
  verified: boolean;
  keyActorUrl?: string;
  /** 署名鍵の持ち主と Activity の actor が異なる「代理転送」として受理したか */
  forwarded?: boolean;
  error?: string;
}

// 鍵取得に失敗した actor を一時的に記憶し、未認証リクエストによる
// 外向き fetch の繰り返し（DoS・SSRF の踏み台化）を防ぐ
const NEGATIVE_KEY_CACHE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_KEY_CACHE_MAX = 1000;
const negativeKeyCache = new Map<string, number>();

function isNegativelyCached(actorUrl: string): boolean {
  const expiresAt = negativeKeyCache.get(actorUrl);
  if (expiresAt === undefined) {
    return false;
  }
  if (expiresAt <= Date.now()) {
    negativeKeyCache.delete(actorUrl);
    return false;
  }
  return true;
}

function rememberNegativeKey(actorUrl: string): void {
  if (negativeKeyCache.size >= NEGATIVE_KEY_CACHE_MAX) {
    const oldest = negativeKeyCache.keys().next().value;
    if (oldest !== undefined) {
      negativeKeyCache.delete(oldest);
    }
  }
  negativeKeyCache.set(actorUrl, Date.now() + NEGATIVE_KEY_CACHE_TTL_MS);
}

/**
 * actor URL を比較用に正規化（フラグメント除去・ホスト小文字化・末尾スラッシュ除去）
 */
export function normalizeActorUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return null;
  }
}

/**
 * 管理画面で accepted 済みのリレー（またはその inbox）かどうかを判定する
 */
function isAcceptedRelayActor(keyActorUrl: string): boolean {
  const normalized = normalizeActorUrl(keyActorUrl);
  if (!normalized) {
    return false;
  }
  try {
    const rows = db.prepare("SELECT actor_url, inbox_url FROM relays WHERE status = 'accepted'").all() as {
      actor_url: string;
      inbox_url: string;
    }[];
    return rows.some(
      (row) => normalizeActorUrl(row.actor_url) === normalized || normalizeActorUrl(row.inbox_url) === normalized,
    );
  } catch {
    return false;
  }
}

/**
 * keyId から公開鍵を解決する（自インスタンスの鍵はネットワーク取得せずに解決）
 */
async function resolvePublicKey(keyActorUrl: string): Promise<{ publicKeyPem: string | null; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(keyActorUrl);
  } catch {
    return { publicKeyPem: null, error: `keyId is not a valid URL: ${keyActorUrl}` };
  }

  let localOrigin: string | null = null;
  try {
    localOrigin = new URL(config.origin).origin.toLowerCase();
  } catch {
    localOrigin = null;
  }

  if (localOrigin && parsed.origin.toLowerCase() === localOrigin) {
    if (parsed.pathname === '/actor' || parsed.pathname === '/actor/') {
      return { publicKeyPem: getInstanceActorKeyPair().publicKeyPem };
    }

    const userMatch = parsed.pathname.match(/^\/users\/([^/]+)\/?$/);
    if (userMatch) {
      const userId = decodeURIComponent(userMatch[1]).toLowerCase();
      const localUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as unknown as UserRow | undefined;
      if (!localUser?.public_key_pem) {
        return { publicKeyPem: null, error: `Local actor not found for keyId: ${keyActorUrl}` };
      }
      return { publicKeyPem: localUser.public_key_pem };
    }

    return { publicKeyPem: null, error: `Unsupported local keyId path: ${parsed.pathname}` };
  }

  // 実際の取得可否（SSRF 対策）とキャッシュ判定は fetchRemoteActor 側で行う。
  // ここでは取得に失敗した actor を短期記憶し、未認証リクエストによる
  // 外向き fetch の繰り返しを抑止する。
  if (isNegativelyCached(keyActorUrl)) {
    return { publicKeyPem: null, error: 'Remote key lookup recently failed (cached)' };
  }

  try {
    const remoteActor = await fetchRemoteActor(keyActorUrl);
    if (!remoteActor.public_key_pem) {
      rememberNegativeKey(keyActorUrl);
      return { publicKeyPem: null, error: `Remote actor has no public key: ${keyActorUrl}` };
    }
    return { publicKeyPem: remoteActor.public_key_pem };
  } catch (err) {
    rememberNegativeKey(keyActorUrl);
    return { publicKeyPem: null, error: `Remote actor fetch failed: ${(err as Error).message}` };
  }
}

/**
 * Inbox リクエストの署名を検証する
 */
export async function verifyInboxSignature(req: Request, activityActorUrl?: string): Promise<InboxAuthResult> {
  const sigHeader = req.headers['signature'];
  if (!sigHeader || typeof sigHeader !== 'string') {
    return { verified: false, error: 'Signature header missing' };
  }

  const parsedHeader = parseSignatureHeader(sigHeader);
  if (!parsedHeader) {
    return { verified: false, error: 'Malformed Signature header' };
  }

  const keyActorUrl = parsedHeader.keyId.split('#')[0];
  if (!keyActorUrl) {
    return { verified: false, error: `keyId does not contain an actor URL: ${parsedHeader.keyId}` };
  }

  // 署名鍵の持ち主と Activity の actor が一致しないリクエストはなりすましとして拒否する。
  // ただしリレーによる代理転送（他サーバーの Activity を自分の鍵で転送する挙動）は
  // 連合の標準的な運用のため、信頼済みリレーからの転送に限って受理する。
  let forwarded = false;
  if (activityActorUrl) {
    const keyOwner = normalizeActorUrl(keyActorUrl);
    const activityActor = normalizeActorUrl(activityActorUrl);
    if (!keyOwner || !activityActor) {
      return { verified: false, keyActorUrl, error: 'Activity actor or keyId is not a valid URL' };
    }
    if (keyOwner !== activityActor) {
      const forwardingAllowed =
        config.inboxForwardedPolicy === 'any' || isAcceptedRelayActor(keyActorUrl);
      if (!forwardingAllowed) {
        return {
          verified: false,
          keyActorUrl,
          error: `keyId owner (${keyOwner}) does not match the activity actor (${activityActor})`,
        };
      }
      forwarded = true;
    }
  }

  const key = await resolvePublicKey(keyActorUrl);
  if (!key.publicKeyPem) {
    return { verified: false, keyActorUrl, error: key.error || 'Public key not found' };
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const result = verifyHttpSignatureDetailed({
    method: req.method,
    path: req.originalUrl,
    headers: req.headers,
    rawBody,
    publicKeyPem: key.publicKeyPem,
    requireDigest: Boolean(rawBody && rawBody.length > 0),
    maxAgeSeconds: config.signatureMaxAgeSeconds,
    // リバースプロキシ（Cloudflare Tunnel 等）が Host を書き換える構成に対応するため、
    // 設定上の公開ドメインを host 候補に加える
    extraHostCandidates: [config.domain],
  });

  return {
    verified: result.valid,
    keyActorUrl,
    forwarded,
    error: result.valid ? undefined : result.reason,
  };
}
