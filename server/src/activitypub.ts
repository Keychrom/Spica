import { config } from './config.js';
import { db, UserRow, PostRow, RemoteActorRow, isDomainBlocked, isInboxBlockingSender } from './db.js';
import { signHeaders } from './crypto.js';
import { getInstanceActorKeyPair } from './instanceActor.js';
import { assertFetchableRemoteUrl } from './remoteFetchGuard.js';
import { enqueueDelivery, nextRetryDelayMs } from './deliveryQueue.js';
import crypto from 'node:crypto';

export const ACTIVITYSTREAMS_CONTEXT = [
  'https://www.w3.org/ns/activitystreams',
  'https://w3id.org/security/v1',
];

export const ACTIVITY_CONTENT_TYPE = 'application/activity+json';

/**
 * ローカルユーザーの Actor (Person) JSON-LD を構築
 */
export function buildPerson(user: UserRow) {
  const actorUrl = `${config.origin}/users/${user.id}`;
  return {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: actorUrl,
    type: 'Person',
    following: `${actorUrl}/following`,
    followers: `${actorUrl}/followers`,
    inbox: `${actorUrl}/inbox`,
    outbox: `${actorUrl}/outbox`,
    // ピン留め投稿のコレクション（Mastodon はここを読んで「固定投稿」を表示する）
    featured: `${actorUrl}/collections/featured`,
    preferredUsername: user.id,
    name: user.name,
    summary: user.summary || '',
    // 鍵アカウント（フォロー承認制）であることを連合先へ伝える
    manuallyApprovesFollowers: user.is_locked === 1,
    // プロフィール項目（リンク集）を PropertyValue として公開する
    attachment: parseProfileFields(user.fields),
    icon: user.icon_url ? {
      type: 'Image',
      mediaType: 'image/png',
      url: user.icon_url,
    } : undefined,
    image: user.banner_url ? {
      type: 'Image',
      mediaType: 'image/png',
      url: user.banner_url,
    } : undefined,
    url: actorUrl,
    // 引っ越し: 移行元アカウント（連合先が Move を検証するために参照する）
    alsoKnownAs: user.also_known_as ? [user.also_known_as] : undefined,
    // 引っ越し: 移行先アカウント（このアカウントが引っ越したことを示す）
    movedTo: user.moved_to || undefined,
    endpoints: {
      sharedInbox: `${config.origin}/inbox`,
    },
    publicKey: {
      id: `${actorUrl}#main-key`,
      owner: actorUrl,
      publicKeyPem: user.public_key_pem,
    },
  };
}

export interface NoteAttachment {
  url: string;
  mediaType?: string;
  /** 代替テキスト（alt）。連合先では添付の name として届く */
  name?: string;
  description?: string;
}

export interface NotePoll {
  choices: string[];
  multiple?: boolean;
  expiresAt?: string | null;
}

/**
 * users.fields（JSON）を ActivityPub の attachment (PropertyValue) に変換する
 * ※ Mastodon / Misskey のプロフィール項目（リンク集）として表示される
 */
export function parseProfileFields(raw: unknown): { type: string; name: string; value: string }[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((field: any) => field && typeof field.name === 'string' && typeof field.value === 'string')
      .slice(0, 4)
      .map((field: any) => ({
        type: 'PropertyValue',
        name: field.name.slice(0, 40),
        // 値はプレーンテキストとして扱う（HTMLを許すと XSS の温床になるため）
        value: field.value.slice(0, 200),
      }));
  } catch {
    return [];
  }
}

/**
 * 投稿 Note / Question オブジェクトを構築
 */
export function buildNote(params: {
  id: string;
  authorUrl: string;
  content: string;
  publishedAt: string;
  inReplyTo?: string | null;
  quoteUrl?: string | null;
  attachments?: NoteAttachment[];
  summary?: string | null;
  sensitive?: boolean;
  poll?: NotePoll | null;
  tags?: any[];
  /** 公開範囲。'followers' の場合は Public コレクションへ送らず、フォロワー限定として宛先を組む */
  visibility?: string;
}) {
  const attachmentList = (params.attachments || []).map((att) => ({
    type: 'Document',
    mediaType: att.mediaType || 'image/jpeg',
    url: att.url,
    // 代替テキスト（alt）を優先して name に載せる（無ければファイル名）
    name: (att.description && att.description.trim()) || att.name || undefined,
  }));

  const hasSummary = Boolean(params.summary && params.summary.trim());
  const isSensitive = Boolean(params.sensitive || hasSummary);
  // フォロワー限定は Public コレクションへ送らない（受け取ったサーバーが公開扱いしないよう、
  // to をフォロワーコレクションのみにする）
  const isFollowersOnly = params.visibility === 'followers';

  // アンケート（ActivityPub Question 仕様: oneOf / anyOf / endTime）
  const isQuestion = Boolean(params.poll && params.poll.choices && params.poll.choices.length > 0);
  let pollProps: any = {};
  if (isQuestion && params.poll) {
    const choiceObjects = params.poll.choices.map((choiceText) => ({
      type: 'Note',
      name: choiceText,
      replies: {
        type: 'Collection',
        totalItems: 0,
      },
      _misskey_votes: 0,
    }));

    if (params.poll.multiple) {
      pollProps.anyOf = choiceObjects;
    } else {
      pollProps.oneOf = choiceObjects;
    }

    pollProps.votersCount = 0;

    if (params.poll.expiresAt) {
      pollProps.endTime = params.poll.expiresAt;
      if (new Date(params.poll.expiresAt) <= new Date()) {
        pollProps.closed = params.poll.expiresAt;
      }
    }
  }

  return {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: params.id,
    type: isQuestion ? 'Question' : 'Note',
    attributedTo: params.authorUrl,
    summary: hasSummary ? params.summary!.trim() : undefined,
    content: params.content,
    url: params.id,
    published: params.publishedAt,
    to: isFollowersOnly ? [`${params.authorUrl}/followers`] : ['https://www.w3.org/ns/activitystreams#Public'],
    cc: isFollowersOnly ? [] : [`${params.authorUrl}/followers`],
    inReplyTo: params.inReplyTo || null,
    sensitive: isSensitive,
    _misskey_quote: params.quoteUrl || undefined,
    quoteUrl: params.quoteUrl || undefined,
    attachment: attachmentList.length > 0 ? attachmentList : undefined,
    tag: params.tags && params.tags.length > 0 ? params.tags : undefined,
    ...pollProps,
  };
}

/**
 * Create(Note) Activity を構築
 */
export function buildCreateActivity(params: {
  note: ReturnType<typeof buildNote>;
  actorUrl: string;
}) {
  return {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: `${params.note.id}/activity`,
    type: 'Create',
    actor: params.actorUrl,
    published: params.note.published,
    to: params.note.to,
    cc: params.note.cc,
    object: params.note,
  };
}

/**
 * Follow Activity を構築
 */
export function buildFollowActivity(params: {
  actorUrl: string;
  targetActorUrl: string;
}) {
  const uuid = crypto.randomUUID();
  return {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: `${config.origin}/activities/follow/${uuid}`,
    type: 'Follow',
    actor: params.actorUrl,
    object: params.targetActorUrl,
  };
}

/**
 * Accept Activity を構築 (Misskey/Mastodon 互換)
 */
export function buildAcceptActivity(params: {
  actorUrl: string;
  followActivity: any;
}) {
  const uuid = crypto.randomUUID();
  const recipient = typeof params.followActivity.actor === 'string'
    ? params.followActivity.actor
    : params.followActivity.actor?.id;

  return {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: `${config.origin}/activities/accept/${uuid}`,
    type: 'Accept',
    actor: params.actorUrl,
    to: recipient ? [recipient] : undefined,
    object: params.followActivity,
  };
}

/**
 * Reject(Follow) Activity を構築（鍵アカウントでフォローを拒否した場合）
 */
export function buildRejectActivity(params: {
  actorUrl: string;
  followActivity: any;
}) {
  const uuid = crypto.randomUUID();
  const recipient = typeof params.followActivity.actor === 'string'
    ? params.followActivity.actor
    : params.followActivity.actor?.id;

  return {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: `${config.origin}/activities/reject/${uuid}`,
    type: 'Reject',
    actor: params.actorUrl,
    to: recipient ? [recipient] : undefined,
    object: params.followActivity,
  };
}

/**
 * Undo(Follow) Activity を構築 (アンフォロー / リレー購読解除用)
 */
export function buildUndoFollowActivity(params: {
  actorUrl: string;
  followActivityId: string;
  targetActorUrl: string;
}) {
  const uuid = crypto.randomUUID();
  return {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: `${config.origin}/activities/undo/${uuid}`,
    type: 'Undo',
    actor: params.actorUrl,
    object: {
      id: params.followActivityId,
      type: 'Follow',
      actor: params.actorUrl,
      object: params.targetActorUrl,
    },
  };
}

/**
 * Misskey向け EmojiReact Activity を構築
 */
export function buildEmojiReactActivity(params: {
  id?: string;
  actorUrl: string;
  targetPostUrl: string;
  reaction: string;
  targetActorUrl?: string;
}) {
  const uuid = params.id || `${config.origin}/activities/react/${crypto.randomUUID()}`;
  return {
    '@context': [
      ...ACTIVITYSTREAMS_CONTEXT,
      {
        '_misskey_reaction': 'https://misskey-hub.net/ns#_misskey_reaction',
      },
    ],
    id: uuid,
    type: 'EmojiReact',
    actor: params.actorUrl,
    object: params.targetPostUrl,
    content: params.reaction,
    _misskey_reaction: params.reaction,
    to: ['https://www.w3.org/ns/activitystreams#Public', ...(params.targetActorUrl ? [params.targetActorUrl] : [])],
  };
}

/**
 * Mastodon向け Like Activity を構築 (content / _misskey_reaction も付与してハイブリッド互換)
 */
export function buildLikeActivity(params: {
  id?: string;
  actorUrl: string;
  targetPostUrl: string;
  reaction?: string;
  targetActorUrl?: string;
}) {
  const uuid = params.id || `${config.origin}/activities/like/${crypto.randomUUID()}`;
  return {
    '@context': [
      ...ACTIVITYSTREAMS_CONTEXT,
      {
        '_misskey_reaction': 'https://misskey-hub.net/ns#_misskey_reaction',
      },
    ],
    id: uuid,
    type: 'Like',
    actor: params.actorUrl,
    object: params.targetPostUrl,
    content: params.reaction || '⭐',
    _misskey_reaction: params.reaction || '⭐',
    to: ['https://www.w3.org/ns/activitystreams#Public', ...(params.targetActorUrl ? [params.targetActorUrl] : [])],
  };
}

/**
 * RT (Announce / ブースト) Activity を構築
 */
export function buildAnnounceActivity(params: {
  id?: string;
  actorUrl: string;
  targetPostUrl: string;
  targetActorUrl?: string;
}) {
  const uuid = params.id || `${config.origin}/activities/announce/${crypto.randomUUID()}`;
  return {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: uuid,
    type: 'Announce',
    actor: params.actorUrl,
    published: new Date().toISOString(),
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [
      `${params.actorUrl}/followers`,
      ...(params.targetActorUrl ? [params.targetActorUrl] : []),
    ],
    object: params.targetPostUrl,
  };
}

/**
 * 汎用 Undo Activity を構築 (Reaction / Like / Announce 解除用)
 */
export function buildUndoActivity(params: {
  actorUrl: string;
  activityToUndo: any;
  targetActorUrl?: string;
}) {
  const uuid = `${config.origin}/activities/undo/${crypto.randomUUID()}`;
  return {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: uuid,
    type: 'Undo',
    actor: params.actorUrl,
    to: ['https://www.w3.org/ns/activitystreams#Public', ...(params.targetActorUrl ? [params.targetActorUrl] : [])],
    object: params.activityToUndo,
  };
}

/**
 * 引っ越し（Move）Activity を構築する
 *   actor : 引っ越し元（このインスタンスのローカルユーザー）
 *   object: 引っ越し元（Mastodon 互換のため同じ URL を入れる）
 *   target: 引っ越し先アカウント
 * 受信側は「引っ越し先アカウントの alsoKnownAs に引っ越し元が含まれるか」で検証する。
 */
export function buildMoveActivity(params: {
  actorUrl: string;
  targetActorUrl: string;
}) {
  return {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: `${params.actorUrl}#moves/${crypto.randomUUID()}`,
    type: 'Move',
    actor: params.actorUrl,
    object: params.actorUrl,
    target: params.targetActorUrl,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
  };
}

/**
 * リモート Actor 文書から alsoKnownAs（引っ越し元アカウントの URL 一覧）を取得する
 * ※ Move のなりすまし防止のため、必ず移行先アカウントの文書で確認する
 */
export async function fetchActorAliases(actorUrl: string): Promise<string[]> {
  try {
    const safety = await assertFetchableRemoteUrl(actorUrl);
    if (!safety.safe) {
      console.log(`[Move] 🚫 alsoKnownAs の取得をスキップ（安全でない URL）: ${actorUrl}`);
      return [];
    }
    const res = await fetch(actorUrl, {
      headers: {
        Accept: `${ACTIVITY_CONTENT_TYPE}, application/ld+json; profile="https://www.w3.org/ns/activitystreams"`,
        'User-Agent': `Spica/1.0.0 (+${config.origin})`,
        ...signedFetchHeaders(actorUrl),
      },
    });
    if (!res.ok) {
      console.log(`[Move] ⚠️ alsoKnownAs の取得に失敗: ${actorUrl} (HTTP ${res.status})`);
      return [];
    }
    const doc: any = await res.json();
    const raw = doc?.alsoKnownAs;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list
      .map((entry: any) => (typeof entry === 'string' ? entry : entry?.id))
      .filter((value: any): value is string => typeof value === 'string' && value.length > 0);
  } catch (err: any) {
    console.log(`[Move] ⚠️ alsoKnownAs の取得でエラー: ${actorUrl} (${err?.message || err})`);
    return [];
  }
}

/**
 * 投稿削除用 Delete(Tombstone) Activity を構築
 */
export function buildDeleteActivity(params: {
  actorUrl: string;
  targetPostUrl: string;
}) {
  const uuid = `${params.targetPostUrl}#delete`;
  return {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: uuid,
    type: 'Delete',
    actor: params.actorUrl,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${params.actorUrl}/followers`],
    object: {
      id: params.targetPostUrl,
      type: 'Tombstone',
    },
  };
}

/**
 * アクター（アカウント）削除用 Delete(Actor) Activity を構築
 * W3C ActivityPub / Mastodon / Misskey 準拠
 */
export function buildDeleteActorActivity(params: {
  actorUrl: string;
}) {
  const uuid = `${params.actorUrl}#delete`;
  return {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: uuid,
    type: 'Delete',
    actor: params.actorUrl,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${params.actorUrl}/followers`],
    object: params.actorUrl,
  };
}

/**
 * WebFinger でアカウントから Actor URL を解決
 * 例: "alice@localhost:3000" または "@bob@example.com"
 */
export async function resolveWebFinger(handle: string): Promise<string> {
  const cleanHandle = handle.startsWith('@') ? handle.slice(1) : handle;
  const parts = cleanHandle.split('@');
  if (parts.length !== 2) {
    throw new Error(`無効なユーザーハンドル形式です: ${handle}`);
  }

  const [username, domain] = parts;
  if (isDomainBlocked(domain)) {
    throw new Error(`ドメイン "${domain}" はサーバーポリシーによりブロックされています。`);
  }

  const protocol = domain.startsWith('localhost') || domain.startsWith('127.0.0.1') ? 'http' : 'https';
  const url = `${protocol}://${domain}/.well-known/webfinger?resource=acct:${username}@${domain}`;

  // SSRF 対策: 内部アドレスや解決できないホストへの取得を拒否する
  const webfingerSafety = await assertFetchableRemoteUrl(url);
  if (!webfingerSafety.safe) {
    throw new Error(`安全でないホストのため WebFinger 解決を拒否しました: ${webfingerSafety.reason}`);
  }

  console.log(`[WebFinger] Querying: ${url}`);
  const res = await fetch(url, {
    headers: {
      Accept: 'application/jrd+json, application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`WebFinger解決失敗 (HTTP ${res.status}): ${url}`);
  }

  const data = (await res.json()) as any;
  const link = data.links?.find(
    (l: any) => l.rel === 'self' && (l.type === 'application/activity+json' || l.type?.includes('activity'))
  );

  if (!link || !link.href) {
    throw new Error(`WebFingerの応答に Actor URL が見つかりませんでした: ${url}`);
  }

  return link.href;
}

/**
 * ActivityStreams の icon / image プロパティから画像 URL を抽出
 */
export function extractImageUrl(mediaObj: any): string {
  if (!mediaObj) return '';
  if (typeof mediaObj === 'string') return mediaObj;
  if (typeof mediaObj.url === 'string') return mediaObj.url;
  if (Array.isArray(mediaObj.url) && mediaObj.url.length > 0) {
    const first = mediaObj.url[0];
    return typeof first === 'string' ? first : (first?.href || '');
  }
  return '';
}

/**
 * リモートの Actor (Person) を取得してローカルキャッシュDBに保存
 */
export async function fetchRemoteActor(actorUrl: string, forceRefresh = false): Promise<RemoteActorRow> {
  if (isDomainBlocked(actorUrl)) {
    throw new Error(`ブロックされたドメインのアクターは取得できません: ${actorUrl}`);
  }

  // すでにキャッシュにあるか確認（forceRefresh でない場合）
  if (!forceRefresh) {
    const existing = db.prepare('SELECT * FROM remote_actors WHERE id = ?').get(actorUrl) as unknown as RemoteActorRow | undefined;
    if (existing) {
      return existing;
    }
  }

  // SSRF 対策: キャッシュ済みアクターは対象外とし、実際に取得する URL のみ検証する
  const fetchSafety = await assertFetchableRemoteUrl(actorUrl);
  if (!fetchSafety.safe) {
    throw new Error(`安全でないアクターURLのため取得を拒否しました: ${fetchSafety.reason}`);
  }

  console.log(`[Actor] Fetching remote actor: ${actorUrl}`);
  const res = await fetch(actorUrl, {
    headers: {
      Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
      'User-Agent': `Spica/1.0.0 (+${config.origin})`,
      // Authorized Fetch 運用のサーバーからも取得できるよう、有効時は署名を付ける
      ...signedFetchHeaders(actorUrl),
    },
  });

  if (!res.ok) {
    throw new Error(`Actor取得失敗 (HTTP ${res.status}): ${actorUrl}`);
  }

  const data = (await res.json()) as any;
  const parsedUrl = new URL(actorUrl);
  const domain = parsedUrl.host;
  const username = data.preferredUsername || data.name || parsedUrl.pathname.split('/').pop() || 'unknown';
  const inboxUrl = data.inbox;
  const sharedInboxUrl = data.endpoints?.sharedInbox || null;
  const publicKeyId = data.publicKey?.id || `${actorUrl}#main-key`;
  const publicKeyPem = data.publicKey?.publicKeyPem;

  const iconUrl = extractImageUrl(data.icon);
  const bannerUrl = extractImageUrl(data.image);

  if (!inboxUrl || !publicKeyPem) {
    throw new Error(`Actor JSONに必要な情報（inboxまたはpublicKey）が含まれていません: ${actorUrl}`);
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO remote_actors (id, username, domain, name, summary, icon_url, banner_url, inbox_url, shared_inbox_url, public_key_id, public_key_pem, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      domain = excluded.domain,
      name = excluded.name,
      summary = excluded.summary,
      icon_url = excluded.icon_url,
      banner_url = excluded.banner_url,
      inbox_url = excluded.inbox_url,
      shared_inbox_url = excluded.shared_inbox_url,
      public_key_id = excluded.public_key_id,
      public_key_pem = excluded.public_key_pem,
      updated_at = excluded.updated_at
  `).run(
    actorUrl,
    username,
    domain,
    data.name || username,
    data.summary || '',
    iconUrl,
    bannerUrl,
    inboxUrl,
    sharedInboxUrl,
    publicKeyId,
    publicKeyPem,
    now
  );

  return {
    id: actorUrl,
    username,
    domain,
    name: data.name || username,
    summary: data.summary || '',
    icon_url: iconUrl,
    banner_url: bannerUrl,
    inbox_url: inboxUrl,
    shared_inbox_url: sharedInboxUrl,
    public_key_id: publicKeyId,
    public_key_pem: publicKeyPem,
    updated_at: now,
  };
}

/**
 * 一時的な失敗か（再送する価値があるか）を判定する
 *  - ネットワークエラー / タイムアウト / 408 / 429 / 5xx → 再送する
 *  - その他の 4xx（401・403・404・410 など）は恒久的な失敗として再送しない
 */
function isRetryableDeliveryStatus(status: number | null): boolean {
  if (status === null) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

export interface DeliveryAttemptResult {
  ok: boolean;
  status: number | null;
  error: string;
  retryable: boolean;
}

/**
 * Authorized Fetch 対応: 取得（GET）にインスタンスアクターの署名ヘッダーを付ける
 *  - AUTHORIZED_FETCH=true のときのみ付与する（無効時は従来どおり未署名で取得）
 */
export function signedFetchHeaders(url: string): Record<string, string> {
  if (!config.authorizedFetch) {
    return {};
  }
  try {
    const pair = getInstanceActorKeyPair();
    return signHeaders({
      method: 'GET',
      url,
      keyId: `${config.origin}/actor#main-key`,
      privateKeyPem: pair.privateKeyPem,
    });
  } catch (err) {
    console.error('[Authorized Fetch] ❌ 取得用の署名生成に失敗:', err);
    return {};
  }
}

/**
 * リモートの Inbox へ署名付きで「1回だけ」配送を試行する
 * （再送キューの登録は行わない。再送ワーカーからも使う）
 */
export async function attemptDelivery(params: {
  inboxUrl: string;
  activity: any;
  senderUser?: UserRow;
  useInstanceActor?: boolean;
}): Promise<DeliveryAttemptResult> {
  if (isDomainBlocked(params.inboxUrl)) {
    console.log(`[Delivery Skipped] 🚫 Skipping delivery to blocked domain inbox: ${params.inboxUrl}`);
    return { ok: false, status: null, error: 'ブロック済みドメイン', retryable: false };
  }

  // 相手がこちらをブロックしている場合は配送しない（受信した Block を尊重する）
  const senderActorUrl =
    params.useInstanceActor || !params.senderUser
      ? `${config.origin}/actor`
      : `${config.origin}/users/${params.senderUser.id}`;
  if (isInboxBlockingSender(params.inboxUrl, senderActorUrl)) {
    console.log(`[Delivery Skipped] 🚫 相手がブロックしているためスキップ: ${senderActorUrl} -> ${params.inboxUrl}`);
    return { ok: false, status: null, error: '相手にブロックされています', retryable: false };
  }

  // SSRF 対策: 配送先はリモートの Actor 文書由来（外部入力）のため、
  // 内部アドレス等へ署名済みリクエストを送ってしまわないよう検証する
  const deliverySafety = await assertFetchableRemoteUrl(params.inboxUrl);
  if (!deliverySafety.safe) {
    console.log(`[Delivery Skipped] 🚫 安全でない配送先のためスキップ: ${params.inboxUrl} (${deliverySafety.reason})`);
    return { ok: false, status: null, error: `安全でない配送先: ${deliverySafety.reason}`, retryable: false };
  }

  const body = JSON.stringify(params.activity);
  let keyId: string;
  let privateKeyPem: string;

  if (params.useInstanceActor || !params.senderUser) {
    const pair = getInstanceActorKeyPair();
    keyId = `${config.origin}/actor#main-key`;
    privateKeyPem = pair.privateKeyPem;
  } else {
    keyId = `${config.origin}/users/${params.senderUser.id}#main-key`;
    privateKeyPem = params.senderUser.private_key_pem;
  }

  const headers = signHeaders({
    method: 'POST',
    url: params.inboxUrl,
    body,
    keyId,
    privateKeyPem,
  });

  headers['User-Agent'] = `Spica/1.0.0 (+${config.origin})`;

  console.log(`[Delivery] Sending activity (${params.activity.type}) to ${params.inboxUrl}`);

  try {
    const res = await fetch(params.inboxUrl, {
      method: 'POST',
      headers,
      body,
    });

    console.log(`[Delivery] Result from ${params.inboxUrl}: HTTP ${res.status}`);
    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[Delivery Warning] ${params.inboxUrl} responded ${res.status}: ${errText.slice(0, 200)}`);
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}${errText ? ': ' + errText.slice(0, 200) : ''}`,
        retryable: isRetryableDeliveryStatus(res.status),
      };
    }
    return { ok: true, status: res.status, error: '', retryable: false };
  } catch (err: any) {
    console.error(`[Delivery Error] Failed to deliver to ${params.inboxUrl}:`, err);
    return {
      ok: false,
      status: null,
      error: err?.message || 'ネットワークエラー',
      retryable: true,
    };
  }
}

/**
 * リモートの Inbox に署名付きで Activity を送信（配送）
 * 一時的な失敗は再送キューに積み、指数バックオフで再送する
 */
export async function deliverActivity(params: {
  inboxUrl: string;
  activity: any;
  senderUser?: UserRow;
  useInstanceActor?: boolean;
}): Promise<boolean> {
  const result = await attemptDelivery(params);
  if (result.ok) {
    return true;
  }

  if (!result.retryable) {
    console.warn(`[Delivery] ⛔ 再送しない失敗: ${params.inboxUrl} (${result.error})`);
    return false;
  }

  const queued = enqueueDelivery({
    inboxUrl: params.inboxUrl,
    activity: params.activity,
    senderUserId: params.senderUser?.id ?? null,
    useInstanceActor: params.useInstanceActor,
    status: result.status,
    error: result.error,
  });
  if (queued) {
    console.log(
      `[Delivery] 📮 再送キューに登録: ${params.activity?.type || 'Activity'} -> ${params.inboxUrl} (約${Math.round(nextRetryDelayMs(1) / 1000)}秒後に再送)`,
    );
  }
  return false;
}

export interface CustomEmoji {
  name: string; // 例: ":ohayo:"
  url: string;  // 例: "https://example.com/files/ohayo.png"
}

/**
 * ActivityPub Note オブジェクトからカスタム絵文字 (Emoji) を抽出
 */
export function extractCustomEmojis(note: any): CustomEmoji[] {
  if (!note || !Array.isArray(note.tag)) return [];

  const emojis: CustomEmoji[] = [];
  for (const t of note.tag) {
    if (!t) continue;
    const isEmoji = t.type === 'Emoji' || t.type === 'http://joinmastodon.org/ns#Emoji';
    if (isEmoji && t.name) {
      let name = String(t.name);
      if (!name.startsWith(':')) name = `:${name}`;
      if (!name.endsWith(':')) name = `${name}:`;

      const url = typeof t.icon === 'string' ? t.icon : t.icon?.url;
      if (url && typeof url === 'string') {
        emojis.push({ name, url });
      }
    }
  }
  return emojis;
}

/**
 * 本文中の :emoji_name: を HTML <img> タグに置換してレンダリング可能にする
 */
export function replaceCustomEmojis(content: string, emojis: CustomEmoji[]): string {
  if (!content || emojis.length === 0) return content;

  let replaced = content;
  for (const emoji of emojis) {
    const rawShortcode = emoji.name;
    const cleanName = emoji.name.replace(/^:|:$/g, '');
    const escapedName = rawShortcode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // タグの属性値内（="...:shortcode:..."）を誤置換しないよう、タグ外のみにマッチ
    const regex = new RegExp(`${escapedName}(?![^<]*>)`, 'g');
    const imgTag = `<img src="${emoji.url}" alt="${cleanName}" title="${rawShortcode}" class="custom-emoji inline-block h-6 w-auto align-middle" loading="lazy" />`;
    replaced = replaced.replace(regex, imgTag);
  }
  return replaced;
}

/**
 * 📊 アンケート更新 (Update Question) Activity を構築
 * Misskey (_misskey_votes) & Mastodon (replies.totalItems, votersCount) 両対応
 */
export function buildUpdateQuestionActivity(params: {
  post: PostRow;
  poll: {
    id: string;
    multiple: boolean;
    expires_at: string | null;
    choices: { choice_index: number; text: string; votes_count: number }[];
  };
  authorUser: UserRow;
}) {
  const authorUrl = `${config.origin}/users/${params.authorUser.id}`;
  const totalVotes = params.poll.choices.reduce((sum, c) => sum + (c.votes_count || 0), 0);

  const choiceObjects = params.poll.choices.map((c) => ({
    name: c.text,
    type: 'Note',
    replies: {
      type: 'Collection',
      totalItems: c.votes_count,
    },
    _misskey_votes: c.votes_count,
  }));

  const questionObject: any = {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: params.post.id,
    type: 'Question',
    attributedTo: authorUrl,
    content: params.post.content,
    url: params.post.id,
    published: params.post.published_at,
    to: params.post.visibility === 'followers'
      ? [`${authorUrl}/followers`]
      : ['https://www.w3.org/ns/activitystreams#Public'],
    cc: params.post.visibility === 'followers' ? [] : [`${authorUrl}/followers`],
    inReplyTo: params.post.in_reply_to || null,
    votersCount: totalVotes,
  };

  if (params.poll.multiple) {
    questionObject.anyOf = choiceObjects;
  } else {
    questionObject.oneOf = choiceObjects;
  }

  if (params.poll.expires_at) {
    questionObject.endTime = params.poll.expires_at;
    if (new Date(params.poll.expires_at) <= new Date()) {
      questionObject.closed = params.poll.expires_at;
    }
  }

  return {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: `${params.post.id}#updates/${Date.now()}`,
    type: 'Update',
    actor: authorUrl,
    to: questionObject.to,
    cc: questionObject.cc,
    object: questionObject,
  };
}

/**
 * 📡 アンケートの最新得票結果をリモートノード（Misskey / Mastodon）へ Update Activity として配信
 */
export async function federatePollUpdate(params: {
  postId: string;
  senderVoterActorUrl?: string;
}) {
  try {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(params.postId) as PostRow | undefined;
    if (!post || post.is_local !== 1) return;

    const poll = db.prepare('SELECT * FROM polls WHERE post_id = ?').get(post.id) as any;
    if (!poll) return;

    const choices = db.prepare('SELECT choice_index, text, votes_count FROM poll_choices WHERE poll_id = ? ORDER BY choice_index ASC').all(poll.id) as any[];
    const authorUser = db.prepare('SELECT * FROM users WHERE id = ?').get(post.user_id) as UserRow | undefined;
    if (!authorUser) return;

    const updateActivity = buildUpdateQuestionActivity({
      post,
      poll: {
        id: poll.id,
        multiple: Boolean(poll.multiple),
        expires_at: poll.expires_at,
        choices,
      },
      authorUser,
    });

    // 配信先 Inbox の収集 (フォロワー + リレー + 投票者リモートサーバー)
    const authorUrl = `${config.origin}/users/${authorUser.id}`;
    const followerInboxes = (db.prepare(`
      SELECT DISTINCT inbox_url FROM follows
      WHERE following_url = ? AND status = 'accepted' AND inbox_url IS NOT NULL AND inbox_url != ''
    `).all(authorUrl) as { inbox_url: string }[]).map((f) => f.inbox_url);

    // リレーは不特定多数へ再配信するため、公開投稿以外では使用しない
    const relayInboxes = post.visibility === 'public'
      ? (db.prepare(`
          SELECT DISTINCT inbox_url FROM relays WHERE status = 'accepted'
        `).all() as { inbox_url: string }[]).map((r) => r.inbox_url)
      : [];

    const directInboxes: string[] = [];
    if (params.senderVoterActorUrl) {
      try {
        const voterActor = await fetchRemoteActor(params.senderVoterActorUrl);
        if (voterActor?.inbox_url) directInboxes.push(voterActor.inbox_url);
      } catch {}
    }

    const allInboxes = Array.from(new Set([...followerInboxes, ...relayInboxes, ...directInboxes]));
    if (allInboxes.length === 0) return;

    console.log(`[Poll Federation] 📡 Broadcasting Update(Question) for post ${post.id} to ${allInboxes.length} inboxes...`);

    // 非同期で配信
    Promise.allSettled(
      allInboxes.map((inboxUrl) =>
        deliverActivity({
          inboxUrl,
          activity: updateActivity,
          senderUser: authorUser,
        })
      )
    ).then((results) => {
      const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value).length;
      console.log(`[Poll Federation] Sent update to ${succeeded}/${allInboxes.length} inboxes.`);
    }).catch((err) => {
      console.error('[Poll Federation Error] Broadcast failed:', err);
    });
  } catch (err: any) {
    console.error('[Poll Federation Error]:', err.message);
  }
}
