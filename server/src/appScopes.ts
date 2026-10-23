/**
 * MiAuth（サードパーティアプリ）の権限スコープ。
 *
 * Misskey の `permission` 文字列を、Spica の粗いスコープへ正規化する。
 * - `read:*` … 読み取り（タイムライン・投稿・プロフィールなど）
 * - `write:notes` … 投稿・リアクション・投票・ブースト
 * - `write:follows` … フォロー・フォロー解除
 * - `write:bookmarks` … ブックマーク・ピン留め
 * - `write:blocks` … ミュート・ブロック
 * - `write:drive` … メディアのアップロード・削除
 * - `write:messages` … DM
 * - `write:lists` … リスト・アンテナ
 * - `write:channels` … チャンネル
 * - `write:profile` … プロフィール・設定
 *
 * アカウントの安全に関わる操作（パスワード・メール・TOTP・セッション・引っ越し・
 * エクスポート/インポート・退会・管理 API・パスキー登録）は**スコープに関係なく拒否**する。
 * 既存の MiAuth トークン（`scopes = 'legacy'`）は通常の読み書きを許すが、安全に関わる操作は拒否する。
 */
import type { NextFunction, Request, Response } from 'express';

export const APP_SCOPES = [
  'read',
  'write:notes',
  'write:follows',
  'write:bookmarks',
  'write:blocks',
  'write:drive',
  'write:messages',
  'write:lists',
  'write:channels',
  'write:profile',
] as const;

export type AppScope = (typeof APP_SCOPES)[number];

export const APP_SCOPE_LABELS: Record<AppScope, string> = {
  read: '読み取り（タイムライン・投稿・プロフィールなど）',
  'write:notes': '投稿の作成・削除・編集、リアクション、投票、ブースト',
  'write:follows': 'フォロー・フォロー解除',
  'write:bookmarks': 'ブックマーク・ピン留め',
  'write:blocks': 'ミュート・ブロック',
  'write:drive': 'メディアのアップロード・削除',
  'write:messages': 'DM の送受信',
  'write:lists': 'リスト・アンテナの管理',
  'write:channels': 'チャンネルの作成・編集・フォロー',
  'write:profile': 'プロフィール・設定の変更',
};

/**
 * Misskey の permission → Spica のスコープ。
 * 実装していない機能の `read:*` は読み取りに寄せる（読み取りは低リスク）。
 * 実装していない `write:*` は付与しない（未対応として承認画面に出す）。
 */
const PERMISSION_MAP: Record<string, AppScope[]> = {
  'read:account': ['read'],
  'read:notes': ['read'],
  'read:following': ['read'],
  'read:messages': ['read'],
  'read:drive': ['read'],
  'read:notifications': ['read'],
  'read:lists': ['read'],
  'read:antennas': ['read'],
  'read:channels': ['read'],
  'read:favorites': ['read'],
  'read:blocks': ['read'],
  'read:mutes': ['read'],
  'read:reactions': ['read'],
  'write:notes': ['write:notes'],
  'write:reactions': ['write:notes'],
  'write:polls': ['write:notes'],
  'write:favorites': ['write:bookmarks'],
  'write:following': ['write:follows'],
  'write:messages': ['write:messages'],
  'write:drive': ['write:drive'],
  'write:lists': ['write:lists'],
  'write:antennas': ['write:lists'],
  'write:channels': ['write:channels'],
  // プロフィール変更だけを許す。メール・パスワード等は安全に関わるので常に拒否される
  'write:account': ['write:profile'],
  'write:profile': ['write:profile'],
  'write:blocks': ['write:blocks'],
  'write:mutes': ['write:blocks'],
};

/** Misskey の permission 文字列（カンマ区切り）を Spica のスコープへ正規化する */
export function normalizePermissions(permissions: string[]): { scopes: AppScope[]; unknown: string[] } {
  const granted = new Set<AppScope>();
  const unknown: string[] = [];
  for (const raw of permissions) {
    const permission = String(raw || '').trim();
    if (!permission) continue;
    const mapped = PERMISSION_MAP[permission];
    if (mapped) {
      for (const scope of mapped) granted.add(scope);
    } else if (permission.startsWith('read:')) {
      // 未実装の読み取り権限は read に寄せる
      granted.add('read');
    } else {
      unknown.push(permission);
    }
  }
  return { scopes: APP_SCOPES.filter((scope) => granted.has(scope)), unknown };
}

/** セッションの scopes 列（カンマ区切り）を配列にする */
export function parseStoredScopes(raw: string | null | undefined): string[] {
  return String(raw || '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

/** アカウントの安全に関わる操作（アプリのトークンでは常に拒否） */
const SENSITIVE_PATTERNS: RegExp[] = [
  /^\/api\/admin(\/|$)/,
  /^\/api\/sessions(\/|$)/,
  /^\/api\/api-keys(\/|$)/,
  /^\/api\/miauth(\/|$)/,
  /^\/miauth(\/|$)/,
  /^\/api\/import(\/|$)/,
  /^\/api\/user\/(password|email|migration|export|delete-me)(\/|$)/,
  /^\/api\/me\/totp(\/|$)/,
  /^\/api\/webauthn\/(register|credentials)(\/|$)/,
];

/** 認証不要の書き込み（アプリのトークンでも通す） */
const PUBLIC_WRITE_PATTERNS: RegExp[] = [
  /^\/api\/auth\/(register|login|logout|recovery)(\/|$)/,
  /^\/api\/webauthn\/authenticate(\/|$)/,
];

/** Misskey API で POST だが「読み取り」のもの */
const MISSKEY_READ_POSTS = new Set([
  '/api/antennas/list',
  '/api/antennas/notes',
  '/api/antennas/show',
  '/api/ap/show',
  '/api/blocking/list',
  '/api/channels/featured',
  '/api/channels/followed',
  '/api/channels/show',
  '/api/channels/timeline',
  '/api/clips/list',
  '/api/clips/notes',
  '/api/clips/show',
  '/api/drive',
  '/api/drive/files',
  '/api/drive/files/show',
  '/api/drive/stream',
  '/api/emojis',
  '/api/following/requests/list',
  '/api/get-online-users-count',
  '/api/hashtags/trend',
  '/api/i',
  '/api/i/favorites',
  '/api/i/following/requests/list',
  '/api/i/notifications',
  '/api/i/read-all-notifications',
  '/api/i/read-notification',
  '/api/meta',
  '/api/mute/list',
  '/api/notes/children',
  '/api/notes/conversation',
  '/api/notes/featured',
  '/api/notes/global-timeline',
  '/api/notes/hybrid-timeline',
  '/api/notes/local-timeline',
  '/api/notes/mentions',
  '/api/notes/reactions',
  '/api/notes/renotes',
  '/api/notes/replies',
  '/api/notes/search',
  '/api/notes/search-by-tag',
  '/api/notes/show',
  '/api/notes/timeline',
  '/api/notes/user-list-timeline',
  '/api/stream/ticket',
  '/api/streaming/ticket',
  '/api/users/featured-notes',
  '/api/users/followers',
  '/api/users/following',
  '/api/users/lists/list',
  '/api/users/lists/show',
  '/api/users/notes',
  '/api/users/relation',
  '/api/users/search',
  '/api/users/show',
]);

const MISSKEY_WRITE_SCOPES: [RegExp, AppScope][] = [
  [/^\/api\/notes\/favorites\/(create|delete)$/, 'write:bookmarks'],
  // クリップ（ブックマークのフォルダ）はブックマークと同じ権限に寄せる
  [/^\/api\/clips\/(create|update|delete|add-note|remove-note)$/, 'write:bookmarks'],
  [/^\/api\/notes\/(create|delete|update|polls\/vote|renotes|reactions\/(create|delete))$/, 'write:notes'],
  [/^\/api\/notes\/unrenote$/, 'write:notes'],
  [/^\/api\/users\/report-abuse$/, 'write:notes'],
  [/^\/api\/following\/(create|delete)$/, 'write:follows'],
  [/^\/api\/following\/requests\/(accept|cancel|reject)$/, 'write:follows'],
  [/^\/api\/(mute|blocking)\/(create|delete)$/, 'write:blocks'],
  [/^\/api\/drive\/files\/delete$/, 'write:drive'],
  [/^\/api\/(lists|antennas)\/(create|update|delete)$/, 'write:lists'],
  [/^\/api\/users\/lists\/(create|update|delete|push|pull)$/, 'write:lists'],
  [/^\/api\/(channels)\/(create|update|delete)$/, 'write:channels'],
  [/^\/api\/messages\/(create|delete)$/, 'write:messages'],
  [/^\/api\/(i\/pin|i\/unpin)$/, 'write:bookmarks'],
  [/^\/api\/i\/update$/, 'write:profile'],
];

const REST_WRITE_SCOPES: [RegExp, AppScope][] = [
  [/^\/api\/posts(\/|$)/, 'write:notes'],
  [/^\/api\/reports(\/|$)/, 'write:notes'],
  [/^\/api\/(media|drive)(\/|$)/, 'write:drive'],
  [/^\/api\/(bookmarks|pin)(\/|$)/, 'write:bookmarks'],
  [/^\/api\/clips(\/|$)/, 'write:bookmarks'],
  [/^\/api\/(follow|unfollow|follow-requests)(\/|$)/, 'write:follows'],
  // ブロック・ミュート（Spica の REST は /users/:id/...、互換名も受ける）
  [/^\/api\/(users\/[^/]+\/(block|unblock|mute|unmute)|block|mute)(\/|$)/, 'write:blocks'],
  // 下書き・予約投稿は投稿と同じ write:notes
  [/^\/api\/(drafts|scheduled-posts)(\/|$)/, 'write:notes'],
  [/^\/api\/(lists|antennas)(\/|$)/, 'write:lists'],
  [/^\/api\/channels(\/|$)/, 'write:channels'],
  [/^\/api\/dm(\/|$)/, 'write:messages'],
  [/^\/api\/(user\/profile|me\/|muted-words|push|notifications)(\/|$)/, 'write:profile'],
];

type Requirement = AppScope | 'public' | null;

function requiredScopeForRequest(method: string, pathname: string): Requirement {
  if (PUBLIC_WRITE_PATTERNS.some((pattern) => pattern.test(pathname))) return 'public';
  if (method === 'GET' || method === 'HEAD') return 'read';
  if (method === 'POST' && MISSKEY_READ_POSTS.has(pathname)) return 'read';
  for (const [pattern, scope] of MISSKEY_WRITE_SCOPES) {
    if (pattern.test(pathname)) return scope;
  }
  for (const [pattern, scope] of REST_WRITE_SCOPES) {
    if (pattern.test(pathname)) return scope;
  }
  return null;
}

export interface ScopeDenial {
  error: string;
  required?: string;
}

/**
 * アプリのトークンでこのリクエストを行えるか。問題なければ null。
 * 第一者のセッション（`sessionKind !== 'app'`）は常に null。
 */
export function appScopeDenial(
  user: { sessionKind?: string; sessionScopes?: string[] } | null | undefined,
  method: string,
  originalUrl: string,
): ScopeDenial | null {
  if (!user || user.sessionKind !== 'app') return null;
  const pathname = String(originalUrl || '').split('?')[0];

  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(pathname))) {
    return { error: 'この操作はアプリのトークンでは許可されていません。' };
  }

  const scopes = user.sessionScopes || [];
  // 既存の MiAuth トークンは通常の読み書きを許す（安全に関わる操作は上で拒否済み）
  if (scopes.includes('legacy')) return null;

  const required = requiredScopeForRequest(method, pathname);
  if (required === 'public') return null;
  if (required === null) {
    return { error: 'この操作に必要な権限がありません。アプリを承認し直してください。' };
  }
  if (!scopes.includes(required)) {
    return {
      error: `この操作には「${required}」の権限が必要です。アプリを承認し直してください。`,
      required,
    };
  }
  return null;
}

/** グローバル認証（`authenticate`）の直後に置くミドルウェア */
export function appScopeGuard(req: Request, res: Response, next: NextFunction): void {
  const denial = appScopeDenial(req.user, req.method, req.originalUrl);
  if (denial) {
    res.status(403).json({
      error: denial.error,
      code: 'INSUFFICIENT_SCOPE',
      ...(denial.required ? { required: denial.required } : {}),
    });
    return;
  }
  next();
}
