/**
 * 設定の読み書き。
 * ・プリファレンス（/api/me/prefs）
 * ・プロフィール（/api/user/profile）
 * ・通知の設定（/api/notifications/settings, /api/notifications/email）
 * ・端末（/api/sessions）
 * ・メール / パスワード / エクスポート
 * 画面は views/SettingsView.tsx、部品は components/settings/ にある。
 */
import { api, messageOf } from './api';
import type { ProfileField } from './profile';

export interface Prefs {
  fontSize?: 'small' | 'normal' | 'large';
  density?: 'comfortable' | 'compact';
  defaultTimeline?: 'home' | 'local' | 'all';
  newPostsBehavior?: 'auto' | 'badge' | 'manual';
  hideBoostsInHome?: boolean;
  hideRepliesInHome?: boolean;
  defaultVisibility?: 'public' | 'local' | 'followers';
  defaultSensitive?: boolean;
  afterPost?: 'timeline' | 'stay';
  notificationGrouping?: 'group' | 'individual';
  /* ---- 見え方 ---- */
  timeFormat?: 'relative' | 'absolute';
  showCustomEmojiImages?: boolean;
  autoPlayMedia?: boolean;
  muteMediaByDefault?: boolean;
  alwaysHideSensitive?: boolean;
  /* ---- 投稿の既定 ---- */
  defaultCwText?: string;
  autoCompressImages?: boolean;
  defaultReaction?: string;
  recentReactions?: string[];
  /* ---- 操作 ---- */
  keyboardShortcuts?: boolean;
  /* ---- つながり ---- */
  mutedDomains?: string[];
  /* ---- DM ---- */
  dmPolicy?: 'noone' | 'allowlist';
  dmAllow?: string[];
  [key: string]: unknown;
}

export async function loadPrefs(): Promise<Prefs | null> {
  const res = await api.get('/api/me/prefs');
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  return ((res.data as { prefs?: Prefs }).prefs ?? null) as Prefs | null;
}

export async function savePrefs(patch: Prefs): Promise<Prefs | null> {
  const res = await api.put('/api/me/prefs', patch);
  if (!res.ok) return null;
  return ((res.data as { prefs?: Prefs }).prefs ?? null) as Prefs | null;
}

/* ---- プロフィール ---- */

export interface ProfileDraft {
  name: string;
  summary: string;
  icon_url: string;
  banner_url: string;
  is_locked: boolean;
  discoverable: boolean;
  noindex: boolean;
  no_ai_training: boolean;
  fields: ProfileField[];
}

export async function loadProfileDraft(myId: string): Promise<ProfileDraft | null> {
  // 表示用の項目（アイコン・バナー・プロフィール項目）は /api/users/:id、
  // 公開範囲まわりのフラグは /api/auth/me にある（同じ人が別の形で返る）
  const [profileRes, meRes] = await Promise.all([
    api.get('/api/users/' + encodeURIComponent(myId)),
    api.get('/api/auth/me'),
  ]);
  if (!profileRes.ok || !profileRes.data || typeof profileRes.data !== 'object') return null;
  const profile = profileRes.data as Record<string, unknown>;
  const me = (meRes.ok && meRes.data && typeof meRes.data === 'object' ? meRes.data : {}) as Record<string, unknown>;

  let fields: ProfileField[] = [];
  const raw = profile.fields ?? me.fields;
  if (Array.isArray(raw)) fields = raw as ProfileField[];
  else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) fields = parsed as ProfileField[];
    } catch {
      fields = [];
    }
  }

  return {
    name: String(profile.name ?? ''),
    summary: String(profile.summary ?? ''),
    icon_url: String(profile.icon_url ?? ''),
    banner_url: String(profile.banner_url ?? ''),
    is_locked: Boolean(profile.is_locked),
    discoverable: profile.discoverable === undefined ? true : Boolean(profile.discoverable),
    noindex: Boolean(me.noindex),
    no_ai_training: Boolean(me.no_ai_training),
    fields,
  };
}

export async function saveProfile(draft: ProfileDraft): Promise<string | null> {
  const res = await api.put('/api/user/profile', {
    name: draft.name.trim(),
    summary: draft.summary,
    icon_url: draft.icon_url.trim(),
    banner_url: draft.banner_url.trim(),
    is_locked: draft.is_locked,
    discoverable: draft.discoverable,
    noindex: draft.noindex,
    no_ai_training: draft.no_ai_training,
    fields: draft.fields.filter((field) => field.name.trim()).slice(0, 4),
  });
  if (res.ok) return null;
  return messageOf(res.data, '保存できませんでした。');
}

/** 画像を 1 枚上げて URL を返す（アイコン・バナー用。フィールド名は file） */
export async function uploadImage(file: File): Promise<string | null> {
  const form = new FormData();
  form.append('file', file);
  const res = await api.post('/api/media/upload', form);
  if (!res.ok || !res.data) return null;
  const data = res.data as { attachment?: { url?: string }; media?: { url?: string }[] };
  return data.attachment?.url || data.media?.[0]?.url || null;
}

/* ---- 通知 ---- */

export interface NotificationSettings {
  prefs: Record<string, boolean>;
  types: { type: string; label: string }[];
  email: { available: boolean; enabled: boolean; email: string; verified: boolean };
}

export async function loadNotificationSettings(): Promise<NotificationSettings | null> {
  const res = await api.get('/api/notifications/settings');
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  return res.data as NotificationSettings;
}

export async function saveNotificationPrefs(prefs: Record<string, boolean>): Promise<Record<string, boolean> | null> {
  const res = await api.post('/api/notifications/settings', prefs);
  if (!res.ok) return null;
  return ((res.data as { prefs?: Record<string, boolean> }).prefs ?? null);
}

export async function setEmailNotify(enabled: boolean): Promise<NotificationSettings['email'] | null> {
  const res = await api.post('/api/notifications/email', { enabled });
  if (!res.ok) return null;
  return ((res.data as { email?: NotificationSettings['email'] }).email ?? null);
}

/* ---- 端末（セッション） ---- */

export interface DeviceSession {
  id: string;
  created_at?: string;
  expires_at?: string;
  user_agent?: string;
  current?: boolean;
}

export async function loadSessions(): Promise<DeviceSession[]> {
  const res = await api.get('/api/sessions');
  if (!res.ok || !res.data) return [];
  return (res.data as { sessions?: DeviceSession[] }).sessions ?? [];
}

export async function revokeSession(id: string): Promise<boolean> {
  return (await api.del('/api/sessions/' + encodeURIComponent(id))).ok;
}

export async function revokeOtherSessions(): Promise<boolean> {
  return (await api.post('/api/sessions/revoke-others')).ok;
}

/* ---- メール / パスワード ---- */

export async function setPassword(newPassword: string, currentPassword: string, masterKey: string): Promise<string | null> {
  const res = await api.post('/api/user/password', {
    newPassword,
    ...(currentPassword ? { currentPassword } : {}),
    ...(masterKey ? { masterKey } : {}),
  });
  return res.ok ? null : messageOf(res.data, '変更できませんでした。');
}

export async function requestEmailChange(email: string): Promise<string | null> {
  const res = await api.post('/api/user/email', { email });
  return res.ok ? null : messageOf(res.data, '送信できませんでした。');
}

export async function verifyEmail(email: string, code: string): Promise<string | null> {
  const res = await api.post('/api/user/email/verify', { email, code });
  return res.ok ? null : messageOf(res.data, '確認できませんでした。');
}

export async function removeEmail(): Promise<boolean> {
  return (await api.del('/api/user/email')).ok;
}

/* ---- ミュートワード ---- */

export interface MutedWord {
  id: string;
  keyword: string;
  case_sensitive?: boolean | number;
  whole_word?: boolean | number;
  created_at?: string;
}

export async function loadMutedWords(): Promise<MutedWord[]> {
  const res = await api.get('/api/muted-words');
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as MutedWord[];
}

export async function addMutedWord(keyword: string): Promise<string | null> {
  const res = await api.post('/api/muted-words', { keyword });
  return res.ok ? null : messageOf(res.data, '追加できませんでした。');
}

export async function removeMutedWord(id: string): Promise<boolean> {
  return (await api.del('/api/muted-words/' + encodeURIComponent(id))).ok;
}

/* ---- 認証の方式（従来型はメール＋パスワード） ---- */

/** このサーバーの認証方式。'password' ならマスターキーを使わない入口がある */
export async function loadAuthMode(): Promise<'master_key' | 'password'> {
  const res = await api.get('/api/auth/recovery/status', { auth: false });
  if (!res.ok || !res.data) return 'master_key';
  const mode = (res.data as { authMode?: string }).authMode;
  return mode === 'password' ? 'password' : 'master_key';
}

/** パスワード（＋必要なら 2 段階認証コード）で本人確認する。通れば null */
export async function verifyPassword(
  identifier: string,
  password: string,
  totpCode?: string,
): Promise<string | null> {
  const res = await api.post(
    '/api/auth/login',
    { id: identifier, password, ...(totpCode ? { totpCode } : {}) },
    { auth: false },
  );
  if (res.ok) return null;
  const data = res.data as { totp_required?: boolean } | null;
  if (res.status === 401 && data?.totp_required) {
    return totpCode ? '2段階認証コードが正しくありません。' : 'TOTP_REQUIRED';
  }
  return messageOf(res.data, 'パスワードが正しくありません。');
}

/* ---- エクスポート ---- */

export interface ExportJob {
  jobId?: string;
  status?: string;
  error?: string | null;
  filename?: string;
  bytes?: number;
  downloadUrl?: string;
}

export async function startExport(format: 'json' | 'zip'): Promise<ExportJob | string> {
  const res = await api.post('/api/user/export', { format });
  if (res.status === 202 || res.ok) return res.data as ExportJob;
  return messageOf(res.data, 'エクスポートを開始できませんでした。');
}

export async function loadExport(jobId: string): Promise<ExportJob | null> {
  const res = await api.get('/api/user/export/' + encodeURIComponent(jobId));
  if (!res.ok || !res.data) return null;
  return res.data as ExportJob;
}
