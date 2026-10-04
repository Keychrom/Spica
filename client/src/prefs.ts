/**
 * 表示・投稿の好み（ユーザーごと・サーバー保存）
 *
 * `server/src/userPrefs.ts` が検証の正で、ここは**同じ形を持ったクライアント側の写し**。
 * 値はログイン時に `GET /api/me/prefs` で読み、変更は `PUT /api/me/prefs` に飛ばす
 * （画面は先に更新して、あとから保存する＝待たせない）。
 *
 * ログインしていないとき・通信できないときは、localStorage の控えで動く。
 * 端末ごとだった旧設定（spica_theme_mode など）は初回に一度だけサーバーへ移す。
 */

import { useSyncExternalStore } from 'react';
import { api } from './api/client.js';

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
  mutedDomains: string[];

  // ✍️ 投稿
  defaultVisibility: 'public' | 'local' | 'followers';
  defaultSensitive: boolean;
  defaultCwText: string;
  afterPost: 'timeline' | 'stay';
  autoCompressImages: boolean;
  defaultReaction: string;

  // 🎛️ 操作
  /** キーボードショートカット（j/k 移動、n 投稿、/ 検索、? ヘルプ）。既定はオフ */
  keyboardShortcuts: boolean;
  /** よく使うリアクション（新しい順・最大 12 件。ピッカーの先頭に出す） */
  recentReactions: string[];

  // 🔔 通知
  notificationGrouping: 'group' | 'individual';
}

export const DEFAULT_PREFS: UserPrefs = {
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

  keyboardShortcuts: false,
  recentReactions: [],

  notificationGrouping: 'group',
};
/** 旧（端末ごと）設定のキー → 新しい設定のキー */
const LEGACY_KEYS: [string, keyof UserPrefs][] = [
  ['spica_theme_mode', 'themeMode'],
  ['spica_accent_color', 'accentColor'],
  ['spica_pref_visibility', 'defaultVisibility'],
  ['spica_pref_timeline', 'defaultTimeline'],
  ['spica_pref_emojis', 'showCustomEmojiImages'],
  ['spica_auto_compress', 'autoCompressImages'],
];
const LEGACY_MIGRATED_FLAG = 'spica_prefs_migrated_v1';

/** localStorage の控え（オフライン起動・未ログイン時に使う） */
function readLocalCache(): Partial<UserPrefs> {
  const out: Partial<UserPrefs> = {};
  try {
    for (const [legacyKey, prefKey] of LEGACY_KEYS) {
      const raw = localStorage.getItem(legacyKey) ?? localStorage.getItem(legacyKey.replace('spica_', 'astrabit_'));
      if (raw === null) continue;
      if (prefKey === 'showCustomEmojiImages' || prefKey === 'autoCompressImages') {
        (out as any)[prefKey] = raw === 'true';
      } else {
        (out as any)[prefKey] = raw;
      }
    }
  } catch {
    // localStorage が使えない環境では既定で動く
  }
  return out;
}

function writeLocalCache(prefs: UserPrefs): void {
  try {
    localStorage.setItem('spica_theme_mode', prefs.themeMode);
    localStorage.setItem('spica_accent_color', prefs.accentColor);
    localStorage.setItem('spica_pref_visibility', prefs.defaultVisibility);
    localStorage.setItem('spica_pref_timeline', prefs.defaultTimeline);
    localStorage.setItem('spica_pref_emojis', String(prefs.showCustomEmojiImages));
    localStorage.setItem('spica_auto_compress', String(prefs.autoCompressImages));
  } catch {
    // 保存できなくても動作は続ける
  }
}

/** 旧設定のうち、既定と違うものだけ（初回の引き継ぎに使う） */
function legacyDiff(): Partial<UserPrefs> {
  const legacy = readLocalCache();
  const patch: Partial<UserPrefs> = {};
  for (const key of Object.keys(legacy) as (keyof UserPrefs)[]) {
    const value = legacy[key];
    if (value !== undefined && value !== (DEFAULT_PREFS as any)[key]) {
      (patch as any)[key] = value;
    }
  }
  return patch;
}

let prefs: UserPrefs = { ...DEFAULT_PREFS, ...readLocalCache() };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 見た目まわり（文字サイズ・密度）を document に反映する */
function applyDocumentPrefs(): void {
  try {
    document.documentElement.setAttribute('data-font-size', prefs.fontSize);
    document.documentElement.setAttribute('data-density', prefs.density);
  } catch {
    // SSR など document が無い環境では何もしない
  }
}

export function getPrefs(): UserPrefs {
  return prefs;
}

function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** コンポーネントから設定を読む（変更すると自動で再描画される） */
export function usePrefs(): UserPrefs {
  return useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);
}

/** 設定を差し替える（画面 → 保存の順。保存の失敗は握って続ける） */
export function updatePrefs(patch: Partial<UserPrefs>): void {
  prefs = { ...prefs, ...patch };
  writeLocalCache(prefs);
  applyDocumentPrefs();
  emit();
  void api.put('/api/me/prefs', patch).catch(() => {
    // オフラインでも操作は続けられる。次の保存で上書きされる
  });
}

/**
 * サーバーから設定を読む（ログイン直後に呼ぶ）。
 * 初回だけ、端末に残っている旧設定をサーバーへ引き継ぐ。
 */
export async function loadPrefs(): Promise<void> {
  try {
    const res = await api.get('/api/me/prefs');
    if (!res.ok) return;
    const data = await res.json();
    const serverPrefs: Partial<UserPrefs> = data?.prefs && typeof data.prefs === 'object' ? data.prefs : {};

    if (!localStorage.getItem(LEGACY_MIGRATED_FLAG)) {
      const patch = legacyDiff();
      localStorage.setItem(LEGACY_MIGRATED_FLAG, '1');
      if (Object.keys(patch).length > 0) {
        prefs = { ...DEFAULT_PREFS, ...serverPrefs, ...patch };
        writeLocalCache(prefs);
        applyDocumentPrefs();
        emit();
        void api.put('/api/me/prefs', patch).catch(() => {});
        return;
      }
    }

    prefs = { ...DEFAULT_PREFS, ...serverPrefs };
    writeLocalCache(prefs);
    applyDocumentPrefs();
    emit();
  } catch {
    // 通信できないときは localStorage の控えのまま
  }
}

/** ログアウト時に端末の控えへ戻す */
export function resetPrefsToLocalCache(): void {
  prefs = { ...DEFAULT_PREFS, ...readLocalCache() };
  applyDocumentPrefs();
  emit();
}

// 起動直後に一度だけ、文字サイズ・密度を反映しておく
applyDocumentPrefs();
