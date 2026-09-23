import { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { adb, UserRow } from './db.js';
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
async function isAcceptedRelayActor(keyActorUrl: string): Promise<boolean> {
  const normalized = normalizeActorUrl(keyActorUrl);
  if (!normalized) {
    return false;
  }
  try {
    const rows = await adb.prepare("SELECT actor_url, inbox_url FROM relays WHERE status = 'accepted'").all() as {
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
export async function resolvePublicKey(keyActorUrl: string): Promise<{ publicKeyPem: string | null; error?: string }> {
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
      const localUser = await adb.prepare('SELECT * FROM users WHERE id = ?').get(userId) as unknown as UserRow | undefined;
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
        config.inboxForwardedPolicy === 'any' || (await isAcceptedRelayActor(keyActorUrl));
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

// ==========================================
// 🔒 Authorized Fetch（署名必須モード）
// ==========================================

export interface FetchAuthResult {
  verified: boolean;
  /** 署名したアクター（= 鍵の所有者）。取得要求ではこれが実質の「閲覧者」になる */
  signerActorUrl?: string;
  error?: string;
}

/** 検証結果をリクエストに紐付けて再利用する（多重検証を防ぐ） */
const SIGNER_CACHE_KEY = '__spicaVerifiedSigner';

/**
 * ActivityPub の「取得（GET）」リクエストの署名を検証する
 *  - 取得には Activity が無いため actor との照合は行わず、鍵の所有者を署名者とする
 *  - ボディが無いため digest は要求しない（署名対象は (request-target) host date など）
 */
export async function verifyFetchSignature(req: Request): Promise<FetchAuthResult> {
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

  const key = await resolvePublicKey(keyActorUrl);
  if (!key.publicKeyPem) {
    return { verified: false, signerActorUrl: keyActorUrl, error: key.error || 'Public key not found' };
  }

  const result = verifyHttpSignatureDetailed({
    method: req.method,
    path: req.originalUrl,
    headers: req.headers,
    publicKeyPem: key.publicKeyPem,
    requireDigest: false,
    maxAgeSeconds: config.signatureMaxAgeSeconds,
    extraHostCandidates: [config.domain],
  });

  return {
    verified: result.valid,
    signerActorUrl: keyActorUrl,
    error: result.valid ? undefined : result.reason,
  };
}

/** 署名を検証して結果を使い回す（既に検証済みならその結果を返す） */
export async function getVerifiedSigner(req: Request): Promise<FetchAuthResult> {
  const cached = (req as Request & { [SIGNER_CACHE_KEY]?: FetchAuthResult })[SIGNER_CACHE_KEY];
  if (cached) {
    return cached;
  }
  const result = await verifyFetchSignature(req);
  (req as Request & { [SIGNER_CACHE_KEY]?: FetchAuthResult })[SIGNER_CACHE_KEY] = result;
  return result;
}

/** 指定アクターがローカルユーザーの承認済みフォロワーかどうか */
export async function isAcceptedFollower(followerActorUrl: string, followedActorUrl: string): Promise<boolean> {
  if (!followerActorUrl || !followedActorUrl) return false;
  try {
    return Boolean(
      await adb.prepare("SELECT 1 FROM follows WHERE follower_url = ? AND following_url = ? AND status = 'accepted'").get(
        followerActorUrl,
        followedActorUrl,
      ),
    );
  } catch {
    return false;
  }
}

/** Authorized Fetch の対象外にするパス（公開情報・静的配信・API） */
function isPublicFetchPath(path: string): boolean {
  return (
    path === '/' ||
    path === '/health' ||
    path.startsWith('/api/') ||
    path.startsWith('/.well-known/') ||
    path.startsWith('/nodeinfo') ||
    path.startsWith('/uploads/') ||
    path.startsWith('/assets/') ||
    path === '/sw.js' ||
    path === '/manifest.json' ||
    path === '/manifest.webmanifest' ||
    path === '/favicon.jpg' ||
    path === '/logo.jpg'
  );
}

/**
 * Authorized Fetch ミドルウェア
 *
 * `AUTHORIZED_FETCH=true` のとき、ActivityPub の取得（GET/HEAD）に有効な
 * HTTP Signature を必須にする。ブラウザ（Accept: text/html）からの画面表示や
 * WebFinger / NodeInfo / API / 静的ファイルは対象外。
 */
export async function requireAuthorizedFetch(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!config.authorizedFetch) {
    return next();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return next();
  }
  if (isPublicFetchPath(req.path)) {
    return next();
  }

  // ブラウザからの HTML 表示は署名を持たないため対象外（SPA / OGP 配信）
  const accept = String(req.headers.accept || '');
  if (accept.includes('text/html') && !accept.includes('activity+json') && !accept.includes('ld+json')) {
    return next();
  }

  const result = await getVerifiedSigner(req);
  if (!result.verified) {
    console.log(`[Authorized Fetch] 🔒 署名が無効な取得を拒否: ${req.method} ${req.originalUrl} (${result.error})`);
    res.status(401).json({
      error: 'HTTP Signature is required for fetching this resource.',
      reason: result.error,
    });
    return;
  }

  console.log(`[Authorized Fetch] ✅ 署名済みの取得: ${req.method} ${req.originalUrl} by ${result.signerActorUrl}`);
  next();
}
