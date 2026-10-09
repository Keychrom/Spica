/**
 * 下書きと予約投稿の通信。
 * どちらも「まだ出していないノート」なので、同じ形（content / cw / visibility / 添付 / 引用）で扱う。
 */
import { api, messageOf } from './api';

export interface DraftedPost {
  id: string;
  content: string;
  cw?: string;
  visibility?: string;
  in_reply_to?: string;
  quote_id?: string;
  created_at?: string;
  updated_at?: string;
  /** 予約投稿だけ */
  scheduled_at?: string;
  status?: 'pending' | 'published' | 'failed';
  error_message?: string;
}

export interface DraftInput {
  content: string;
  cw?: string;
  visibility?: string;
  in_reply_to?: string;
  quote_id?: string;
}

export async function loadDrafts(): Promise<DraftedPost[]> {
  const res = await api.get('/api/drafts');
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as DraftedPost[];
}

export async function saveDraft(input: DraftInput): Promise<string | null> {
  const res = await api.post('/api/drafts', input);
  return res.ok ? null : messageOf(res.data, '下書きを保存できませんでした。');
}

export async function deleteDraft(id: string): Promise<boolean> {
  return (await api.del('/api/drafts/' + encodeURIComponent(id))).ok;
}

export async function loadScheduled(): Promise<DraftedPost[]> {
  const res = await api.get('/api/scheduled-posts');
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as DraftedPost[];
}

/** scheduled_at は ISO 文字列（1 分以上先であること） */
export async function schedulePost(input: DraftInput & { scheduled_at: string }): Promise<string | null> {
  const res = await api.post('/api/scheduled-posts', input);
  return res.ok ? null : messageOf(res.data, '予約できませんでした。');
}

export async function cancelScheduled(id: string): Promise<boolean> {
  return (await api.del('/api/scheduled-posts/' + encodeURIComponent(id))).ok;
}
