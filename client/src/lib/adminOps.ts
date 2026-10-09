/**
 * 管理パネルの通信 その2（ブロックしたサーバー・リレー・メンテナンス）。
 */
import { api, messageOf } from './api';

/* ---- ブロックしたサーバー ---- */

export interface BlockedDomain {
  domain: string;
  reason?: string;
  severity?: string;
  created_at?: string;
}

export async function loadBlockedDomains(): Promise<BlockedDomain[]> {
  const res = await api.get('/api/admin/blocks');
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as BlockedDomain[];
}

export async function blockDomain(domain: string, reason: string): Promise<string | null> {
  const res = await api.post('/api/admin/blocks', { domain, reason });
  return res.ok ? null : messageOf(res.data, 'ブロックできませんでした。');
}

export async function unblockDomain(domain: string): Promise<boolean> {
  return (await api.del('/api/admin/blocks/' + encodeURIComponent(domain))).ok;
}

/* ---- リレー（連合先の中継） ---- */

export interface Relay {
  id?: string;
  inbox_url?: string;
  url?: string;
  status?: string;
  created_at?: string;
}

export async function loadRelays(): Promise<Relay[]> {
  const res = await api.get('/api/admin/relays');
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as Relay[];
}

export async function addRelay(url: string): Promise<string | null> {
  const res = await api.post('/api/admin/relays', { url });
  return res.ok ? null : messageOf(res.data, '追加できませんでした。');
}

export async function setRelayStatus(inboxUrl: string, status: 'accepted' | 'rejected' | string): Promise<string | null> {
  const res = await api.post('/api/admin/relays/toggle-status', { inboxUrl, status });
  return res.ok ? null : messageOf(res.data, '変更できませんでした。');
}

export async function resendRelay(inboxUrl: string): Promise<string | null> {
  const res = await api.post('/api/admin/relays/resend', { inboxUrl });
  return res.ok ? null : messageOf(res.data, '再送できませんでした。');
}

export async function removeRelay(inboxUrl: string): Promise<string | null> {
  // サーバーは DELETE でも本文から読む
  const res = await api.del('/api/admin/relays', { body: { inboxUrl } });
  return res.ok ? null : messageOf(res.data, '外せませんでした。');
}

/* ---- 配信キュー（ほかのサーバーへの配送） ---- */

export interface DeliveryRow {
  id: string;
  activity_id?: string;
  activity_type?: string;
  inbox_url?: string;
  attempts?: number;
  next_attempt_at?: string;
  last_status?: number | null;
  last_error?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface DeliveryQueue {
  stats?: {
    pending?: number;
    delivering?: number;
    delivered?: number;
    failed?: number;
    nextAttemptAt?: string | null;
    oldestPendingAt?: string | null;
  };
  pending?: DeliveryRow[];
  recentFailures?: DeliveryRow[];
  maxAttempts?: number;
}

export async function loadDeliveryQueue(): Promise<DeliveryQueue | null> {
  const res = await api.get('/api/admin/delivery-queue');
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  return res.data as DeliveryQueue;
}

/** サーバーからの一言（「3 件の再送を開始しました。」など）を返す */
async function queueAction(path: string): Promise<{ ok: boolean; message: string }> {
  const res = await api.post(path, {});
  const data = res.data as { message?: string; error?: string } | null;
  if (!res.ok) return { ok: false, message: data?.error || '実行できませんでした。' };
  return { ok: true, message: data?.message || '実行しました。' };
}

export function retryDeliveries() {
  return queueAction('/api/admin/delivery-queue/retry');
}

export function clearFailedDeliveries() {
  return queueAction('/api/admin/delivery-queue/clear-failed');
}

/* ---- お知らせ ---- */

export interface Announcement {
  id: string;
  title: string;
  content: string;
  is_active?: number | boolean;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
}

export async function loadAnnouncements(): Promise<Announcement[]> {
  const res = await api.get('/api/admin/announcements');
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as Announcement[];
}

export async function saveAnnouncement(row: {
  id?: string;
  title: string;
  content: string;
  isActive: boolean;
}): Promise<string | null> {
  const body = { title: row.title, content: row.content, isActive: row.isActive };
  const res = row.id
    ? await api.put('/api/admin/announcements/' + encodeURIComponent(row.id), body)
    : await api.post('/api/admin/announcements', body);
  return res.ok ? null : messageOf(res.data, 'お知らせを保存できませんでした。');
}

export async function deleteAnnouncement(id: string): Promise<boolean> {
  return (await api.del('/api/admin/announcements/' + encodeURIComponent(id))).ok;
}

/* ---- リモートの扱い（検索の索引・ブーストの保存） ---- */

export interface ContentPolicy {
  ftsIndexScope: string;
  remoteAnnouncePolicy: string;
}

export async function loadContentPolicy(): Promise<ContentPolicy | null> {
  const res = await api.get('/api/admin/server-settings');
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  const data = res.data as { settings?: Record<string, unknown> };
  const settings = (data.settings ?? res.data) as Record<string, unknown>;
  return {
    ftsIndexScope: String(settings.fts_index_scope ?? 'local'),
    remoteAnnouncePolicy: String(settings.remote_announce_policy ?? 'follows'),
  };
}

export async function saveContentPolicy(patch: Partial<ContentPolicy>): Promise<string | null> {
  const res = await api.post('/api/admin/content-policy', patch);
  return res.ok ? null : messageOf(res.data, '保存できませんでした。');
}

/* ---- 監査ログの整理 ---- */

export async function pruneAudit(days: number): Promise<{ ok: boolean; message: string }> {
  const res = await api.post('/api/admin/audit/prune', { days });
  const data = res.data as { message?: string; error?: string } | null;
  if (!res.ok) return { ok: false, message: data?.error || '整理できませんでした。' };
  return { ok: true, message: data?.message || '整理しました。' };
}

/* ---- メンテナンス ---- */

export interface MaintenanceState {
  db?: { sizeBytes?: number; walBytes?: number; pageCount?: number };
  posts?: { total?: number; local?: number; remote?: number; prunableRemote?: number; ftsRows?: number };
  media?: { count?: number; bytes?: number; quotaBytes?: number };
  imageProxy?: { enabled?: boolean; files?: number; bytes?: number; maxBytes?: number; ttlDays?: number };
  automation?: { enabled?: boolean; hour?: number; lastRunAt?: string | null; backupEnabled?: boolean };
  policy?: { retentionDays?: number };
}

export async function loadMaintenance(): Promise<MaintenanceState | null> {
  const res = await api.get('/api/admin/maintenance');
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  return res.data as MaintenanceState;
}

export async function runMaintenance(): Promise<string | null> {
  const res = await api.post('/api/admin/maintenance/run', {});
  return res.ok ? null : messageOf(res.data, '実行できませんでした。');
}

export async function saveMaintenanceSettings(patch: {
  autoMaintenance?: boolean;
  hour?: number;
  imageProxy?: boolean;
  imageProxyMaxMb?: number;
}): Promise<string | null> {
  const res = await api.post('/api/admin/maintenance/settings', patch);
  return res.ok ? null : messageOf(res.data, '保存できませんでした。');
}

export async function clearTimelineCache(): Promise<string | null> {
  const res = await api.post('/api/admin/cache/clear', { clearPosts: true });
  return res.ok ? null : messageOf(res.data, '消せませんでした。');
}

export async function clearImageProxyCache(): Promise<string | null> {
  const res = await api.post('/api/admin/image-proxy/cache', {});
  return res.ok ? null : messageOf(res.data, '消せませんでした。');
}
