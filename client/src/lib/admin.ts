/**
 * 管理パネルの通信（/api/admin/*）。運営（admin / moderate）だけが使う。
 */
import { api, messageOf } from './api';

export interface AdminStats {
  system?: { name?: string; domain?: string; protocol?: string; port?: number; description?: string };
  stats?: {
    users?: number;
    pendingRegistrations?: number;
    admins?: number;
    localPosts?: number;
    remotePosts?: number;
    federatedPosts?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AdminUser {
  id: string;
  name: string;
  role?: string;
  roles?: { id: string; name: string; color?: string }[];
  is_frozen?: number;
  approval_status?: string;
  approval_note?: string;
  created_at?: string;
  post_count?: number;
  follower_count?: number;
}

export interface AdminReport {
  id: string;
  reporter_handle?: string;
  reporter_user_id?: string;
  target_handle?: string;
  target_user_id?: string;
  target_post_id?: string;
  target_post_preview?: string;
  category?: string;
  comment?: string;
  status?: string;
  created_at?: string;
  resolution_note?: string;
}

export interface AuditAction {
  id: string;
  actor_id?: string;
  action?: string;
  method?: string;
  path?: string;
  target_type?: string;
  target_id?: string;
  detail?: string;
  label?: string;
  status?: number;
  created_at?: string;
}

export interface AdminFederation {
  actors?: { id?: string; name?: string; domain?: string; last_seen?: string }[];
  domainStats?: { domain?: string; posts?: number; actors?: number }[];
}

export async function loadStats(): Promise<AdminStats | null> {
  const res = await api.get('/api/admin/stats');
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  return res.data as AdminStats;
}

export async function loadAdminUsers(): Promise<AdminUser[]> {
  const res = await api.get('/api/admin/users');
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as AdminUser[];
}

export async function loadReports(): Promise<{ reports: AdminReport[]; open: number }> {
  const res = await api.get('/api/admin/reports');
  if (!res.ok || !res.data || typeof res.data !== 'object') return { reports: [], open: 0 };
  const data = res.data as { reports?: AdminReport[] };
  return { reports: data.reports ?? [], open: 0 };
}

export async function loadAudit(): Promise<AuditAction[]> {
  const res = await api.get('/api/admin/audit');
  if (!res.ok || !res.data || typeof res.data !== 'object') return [];
  return (res.data as { actions?: AuditAction[] }).actions ?? [];
}

export async function loadFederation(): Promise<AdminFederation> {
  const res = await api.get('/api/admin/federation');
  if (!res.ok || !res.data || typeof res.data !== 'object') return {};
  return res.data as AdminFederation;
}

/** 凍結 / 解除 */
export async function freezeUser(id: string, isFrozen: boolean): Promise<string | null> {
  const res = await api.post('/api/admin/users/' + encodeURIComponent(id) + '/freeze', { isFrozen });
  return res.ok ? null : messageOf(res.data, '変更できませんでした。');
}

/** 役割（admin / user） */
export async function setUserRole(id: string, role: 'admin' | 'user'): Promise<string | null> {
  const res = await api.post('/api/admin/users/' + encodeURIComponent(id) + '/role', { role });
  return res.ok ? null : messageOf(res.data, '変更できませんでした。');
}

/** 退会させる（その人のアカウントを消す） */
export async function deleteUser(id: string): Promise<string | null> {
  const res = await api.del('/api/admin/users/' + encodeURIComponent(id));
  return res.ok ? null : messageOf(res.data, '削除できませんでした。');
}

/** 通報への対応（resolve / reject / reopen） */
export async function resolveReport(id: string, action: 'resolve' | 'reject' | 'reopen', note?: string): Promise<string | null> {
  const res = await api.post('/api/admin/reports/' + encodeURIComponent(id) + '/resolve', { action, note: note || '' });
  return res.ok ? null : messageOf(res.data, '変更できませんでした。');
}

/* ---- サーバーの設定 ---- */

export interface InstanceSettings {
  name?: string;
  description?: string;
  icon_url?: string;
  banner_url?: string;
  tos_url?: string;
  privacy_policy_url?: string;
  contact_url?: string;
  repository_url?: string;
  operator_url?: string;
  server_rules?: string[];
  require_rules_agreement?: boolean;
  registration_mode?: string;
  dm_enabled?: boolean;
}

export async function loadInstanceSettings(): Promise<InstanceSettings | null> {
  const res = await api.get('/api/admin/server-settings');
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  const data = res.data as { settings?: InstanceSettings };
  return (data.settings ?? data) as InstanceSettings;
}

export async function saveInstanceSettings(patch: InstanceSettings): Promise<string | null> {
  const res = await api.post('/api/admin/server-settings', patch);
  return res.ok ? null : messageOf(res.data, '保存できませんでした。');
}

/* ---- 登録の承認 ---- */

export interface RegistrationRequest {
  id: string;
  user_id?: string;
  name?: string;
  summary?: string;
  note?: string;
  message?: string;
  created_at?: string;
}

export async function loadRegistrationRequests(): Promise<RegistrationRequest[]> {
  const res = await api.get('/api/admin/registration-requests');
  if (!res.ok || !res.data || typeof res.data !== 'object') return [];
  return (res.data as { requests?: RegistrationRequest[] }).requests ?? [];
}

export async function approveRegistration(id: string): Promise<string | null> {
  const res = await api.post('/api/admin/registration-requests/' + encodeURIComponent(id) + '/approve', {});
  return res.ok ? null : messageOf(res.data, '承認できませんでした。');
}

export async function rejectRegistration(id: string, reason: string): Promise<string | null> {
  const res = await api.post('/api/admin/registration-requests/' + encodeURIComponent(id) + '/reject', { reason });
  return res.ok ? null : messageOf(res.data, '断れませんでした。');
}

/* ---- 招待コード ---- */

export interface Invitation {
  code: string;
  max_uses?: number;
  uses?: number;
  expires_at?: string | null;
  memo?: string;
  created_at?: string;
}

export async function loadInvitations(): Promise<Invitation[]> {
  const res = await api.get('/api/admin/invitations');
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as Invitation[];
}

export async function createInvitation(maxUses: number, expiresInDays: number | null, memo: string): Promise<string | null> {
  const res = await api.post('/api/admin/invitations', { maxUses, expiresInDays, memo });
  return res.ok ? null : messageOf(res.data, '作れませんでした。');
}

export async function deleteInvitation(code: string): Promise<boolean> {
  return (await api.del('/api/admin/invitations/' + encodeURIComponent(code))).ok;
}

/* ---- 絵文字 ---- */

export interface CustomEmojiRow {
  id: string;
  name: string;
  url: string;
  category?: string;
}

export async function loadAdminEmojis(): Promise<CustomEmojiRow[]> {
  const res = await api.get('/api/admin/emojis');
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as CustomEmojiRow[];
}

export async function addAdminEmoji(name: string, url: string, category: string): Promise<string | null> {
  const res = await api.post('/api/admin/emojis', { name, url, category });
  return res.ok ? null : messageOf(res.data, '登録できませんでした。');
}

export async function deleteAdminEmoji(id: string): Promise<boolean> {
  return (await api.del('/api/admin/emojis/' + encodeURIComponent(id))).ok;
}
/** 未対応の通報の数（左ナビの印に使う） */
export async function loadOpenReportCount(): Promise<number> {
  const res = await api.get('/api/admin/reports/count');
  if (!res.ok || !res.data) return 0;
  return Number((res.data as { open?: number }).open ?? 0);
}
