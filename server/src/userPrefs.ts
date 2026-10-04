/**
 * ユーザーごとの「表示と投稿の好み」（`users.prefs` に JSON で保存）
 *
 * ここが**唯一の正**。API（`GET/PUT /api/me/prefs`）も、タイムラインや通知の判定も
 * このモジュールを通す。保存時は必ず検証し、**知らないキーは捨てる**（あとから項目を
 * 増やしても、古いクライアントが壊れない）。
 *
 * 以前は端末ごとの localStorage だった設定（テーマ・既定の公開範囲など）をここへ
 * 移したので、別の端末でログインしても同じ見た目になる。
 *
 * 使い分け:
 *   - クライアントだけで効くもの（テーマ・文字サイズ・時刻表示など）… 値を配るだけ
 *   - サーバー側の判定に要るもの（ホームでブースト/返信を隠す・ドメインミュート）…
 *     `getUserPrefs` をタイムラインの中で読んで WHERE / フィルタに使う
 */

import { db } from './db.js';

export interface UserPrefs {
  // 🎨 表示
  themeMode: 'dark' | 'pure_black' | 'light';
  accentColor: 'indigo' | 'cyan' | 'emerald' | 'purple' | 'rose' | 'amber';
  fontSize: 'small' | 'normal' | 'large';
  density: 'comfortable' | 'compact';
  timeFormat: 'relative' | 'absolute';
  showCustomEmojiImages: boolean;
  autoPlayMedia: boolean;
  muteMediaByDefault: boolean;
  alwaysHideSensitive: boolean;

  // 🏠 タイムライン
  defaultTimeline: 'home' | 'local' | 'all';
  newPostsBehavior: 'auto' | 'badge' | 'manual';
  hideBoostsInHome: boolean;
  hideRepliesInHome: boolean;
  /** 自分用のドメインミュート（ホスト名。例: "example.com"） */
  mutedDomains: string[];

  // ✍️ 投稿
  defaultVisibility: 'public' | 'local' | 'followers';
  defaultSensitive: boolean;
  /** 投稿フォームの CW 欄に入れておく文言（空なら通常どおり閉じておく） */
  defaultCwText: string;
  afterPost: 'timeline' | 'stay';
  autoCompressImages: boolean;
  /** リアクションのピッカーで最初に選ばれている絵文字 */
  defaultReaction: string;

  // 🔔 通知
  notificationGrouping: 'group' | 'individual';
}

export const USER_PREFS_DEFAULTS: UserPrefs = {
  themeMode: 'dark',
  accentColor: 'indigo',
  fontSize: 'normal',
  density: 'comfortable',
  timeFormat: 'absolute',
  showCustomEmojiImages: true,
  autoPlayMedia: false,
  muteMediaByDefault: true,
  alwaysHideSensitive: false,

  defaultTimeline: 'home',
  newPostsBehavior: 'badge',
  hideBoostsInHome: false,
  hideRepliesInHome: false,
  mutedDomains: [],

  defaultVisibility: 'public',
  defaultSensitive: false,
  defaultCwText: '',
  afterPost: 'timeline',
  autoCompressImages: true,
  defaultReaction: '👍',

  notificationGrouping: 'group',
};

/** 自分用ドメインミュートの上限（暴走して settings が巨大になるのを防ぐ） */
const MAX_MUTED_DOMAINS = 200;
/** CW の既定文言の上限 */
const MAX_CW_TEXT = 200;
/** 既定リアクションの上限（絵文字は数文字で足りる） */
const MAX_REACTION_TEXT = 48;

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickText(value: unknown, fallback: string, maxLen: number): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

/** ホスト名として正規化する（URL や @ 付きで保存されても拾えるように） */
export function normalizeMutedDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let host = value.trim().toLowerCase();
  if (!host) return null;
  host = host.replace(/^https?:\/\//, '').replace(/^@/, '');
  // パスやポートを落とす（"example.com/path" のような貼り付けに対応）
  host = host.split('/')[0].split(':')[0];
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  if (!host.includes('.')) return null;
  if (host.length > 253) return null;
  return host;
}

function pickMutedDomains(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out: string[] = [];
  for (const item of value) {
    const host = normalizeMutedDomain(item);
    if (host && !out.includes(host)) out.push(host);
    if (out.length >= MAX_MUTED_DOMAINS) break;
  }
  return out;
}

/**
 * 保存された生の JSON を検証して、既定値に重ねた完全な設定を返す。
 * 壊れた値・知らないキーは既定値で埋める（例外は投げない）。
 */
export function sanitizeUserPrefs(raw: unknown): UserPrefs {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = USER_PREFS_DEFAULTS;
  return {
    themeMode: pickEnum(source.themeMode, ['dark', 'pure_black', 'light'] as const, d.themeMode),
    accentColor: pickEnum(source.accentColor, ['indigo', 'cyan', 'emerald', 'purple', 'rose', 'amber'] as const, d.accentColor),
    fontSize: pickEnum(source.fontSize, ['small', 'normal', 'large'] as const, d.fontSize),
    density: pickEnum(source.density, ['comfortable', 'compact'] as const, d.density),
    timeFormat: pickEnum(source.timeFormat, ['relative', 'absolute'] as const, d.timeFormat),
    showCustomEmojiImages: pickBool(source.showCustomEmojiImages, d.showCustomEmojiImages),
    autoPlayMedia: pickBool(source.autoPlayMedia, d.autoPlayMedia),
    muteMediaByDefault: pickBool(source.muteMediaByDefault, d.muteMediaByDefault),
    alwaysHideSensitive: pickBool(source.alwaysHideSensitive, d.alwaysHideSensitive),

    defaultTimeline: pickEnum(source.defaultTimeline, ['home', 'local', 'all'] as const, d.defaultTimeline),
    newPostsBehavior: pickEnum(source.newPostsBehavior, ['auto', 'badge', 'manual'] as const, d.newPostsBehavior),
    hideBoostsInHome: pickBool(source.hideBoostsInHome, d.hideBoostsInHome),
    hideRepliesInHome: pickBool(source.hideRepliesInHome, d.hideRepliesInHome),
    mutedDomains: pickMutedDomains(source.mutedDomains, d.mutedDomains),

    defaultVisibility: pickEnum(source.defaultVisibility, ['public', 'local', 'followers'] as const, d.defaultVisibility),
    defaultSensitive: pickBool(source.defaultSensitive, d.defaultSensitive),
    defaultCwText: pickText(source.defaultCwText, d.defaultCwText, MAX_CW_TEXT),
    afterPost: pickEnum(source.afterPost, ['timeline', 'stay'] as const, d.afterPost),
    autoCompressImages: pickBool(source.autoCompressImages, d.autoCompressImages),
    defaultReaction: pickText(source.defaultReaction, d.defaultReaction, MAX_REACTION_TEXT) || d.defaultReaction,

    notificationGrouping: pickEnum(source.notificationGrouping, ['group', 'individual'] as const, d.notificationGrouping),
  };
}

/** DB から読んで検証済みの設定を返す（毎回 1 クエリ。タイムラインでも使う） */
export async function getUserPrefs(userId: string): Promise<UserPrefs> {
  try {
    const row = (await db.prepare('SELECT prefs FROM users WHERE id = ?').get(userId)) as
      | { prefs?: string | null }
      | undefined;
    if (!row?.prefs) return { ...USER_PREFS_DEFAULTS };
    return sanitizeUserPrefs(JSON.parse(row.prefs));
  } catch {
    // 壊れた JSON は既定に戻す（設定が読めないだけでアプリは止めない）
    return { ...USER_PREFS_DEFAULTS };
  }
}

/** 設定を部分更新する（渡されたキーだけを検証して重ねる） */
export async function saveUserPrefs(userId: string, patch: unknown): Promise<UserPrefs> {
  const current = await getUserPrefs(userId);
  const sanitized = sanitizeUserPrefs({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) });
  await db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(sanitized), userId);
  return sanitized;
}

/** 投稿のドメインがミュート対象か（ホスト名の完全一致と、サブドメイン指定の両方を見る） */
export function isDomainMutedByPrefs(mutedDomains: readonly string[], urlOrHandle: string | null | undefined): boolean {
  if (!urlOrHandle || mutedDomains.length === 0) return false;
  let host = '';
  try {
    const value = urlOrHandle.trim();
    if (value.startsWith('@')) {
      // @user@example.com 形式
      const parts = value.split('@');
      host = (parts[parts.length - 1] || '').toLowerCase();
    } else {
      host = new URL(value).hostname.toLowerCase();
    }
  } catch {
    return false;
  }
  if (!host) return false;
  return mutedDomains.some((muted) => host === muted || host.endsWith(`.${muted}`));
}
