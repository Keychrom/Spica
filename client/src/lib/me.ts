/**
 * 自分の活動まわり（設定画面から使う小さな通信）。
 * リアクションの履歴・投稿カレンダー・DM の受け取り設定。
 */
import { api, messageOf } from './api';
import type { Prefs } from './settings';

/* ---- 自分のリアクションの履歴 ---- */

export interface MyReaction {
  id: string;
  reaction: string;
  created_at?: string;
  post?: {
    id: string;
    content?: string;
    cw?: string | null;
    is_local?: boolean | number;
    published_at?: string;
    author_name?: string;
    author_handle?: string;
    user_id?: string;
  };
}

export async function loadMyReactions(limit: number): Promise<MyReaction[]> {
  const res = await api.get('/api/me/reactions?limit=' + limit);
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as MyReaction[];
}

/* ---- 投稿カレンダー ---- */

export interface CalendarDay {
  day: string;
  count: number;
}

export async function loadPostCalendar(month: string): Promise<CalendarDay[]> {
  const res = await api.get('/api/me/post-calendar?month=' + encodeURIComponent(month));
  if (!res.ok || !res.data || typeof res.data !== 'object') return [];
  const data = res.data as { days?: CalendarDay[] };
  return data.days ?? [];
}

/* ---- DM（1対1のメッセージ）の受け取り ---- */

export type DmPolicy = 'noone' | 'allowlist';

export interface DmPrefs {
  dmPolicy: DmPolicy;
  dmAllow: string[];
}

export async function loadDmPrefs(): Promise<DmPrefs | null> {
  const res = await api.get('/api/me/prefs');
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  const prefs = ((res.data as { prefs?: Prefs }).prefs ?? {}) as Prefs;
  return {
    dmPolicy: prefs.dmPolicy === 'allowlist' ? 'allowlist' : 'noone',
    dmAllow: Array.isArray(prefs.dmAllow) ? (prefs.dmAllow as string[]) : [],
  };
}

export async function saveDmPrefs(patch: Partial<DmPrefs>): Promise<string | null> {
  const res = await api.put('/api/me/prefs', patch);
  return res.ok ? null : messageOf(res.data, '保存できませんでした。');
}

/** サーバーで DM が使えるかどうか（/api/server-info の features.dm） */
export async function dmEnabled(): Promise<boolean> {
  const res = await api.get('/api/server-info');
  if (!res.ok || !res.data || typeof res.data !== 'object') return false;
  const features = (res.data as { features?: { dm?: unknown } }).features;
  return Boolean(features?.dm);
}
