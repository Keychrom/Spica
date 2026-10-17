/**
 * 下書きと予約投稿の通信。
 * どちらも「まだ出していないノート」なので、同じ形（content / cw / visibility / 添付 / アンケート / 引用）で扱う。
 */
import { api, messageOf } from './api';
import type { Attachment } from './media';

/** 編集中のアンケート（下書きに保存する形。空の選択肢もそのまま残す） */
export interface DraftPoll {
  choices: string[];
  multiple: boolean;
  /** 締切までの時間（秒）。0 なら締め切らない */
  expiresIn: number;
}

export interface DraftedPost {
  id: string;
  content: string;
  cw?: string;
  visibility?: string;
  in_reply_to?: string;
  quote_id?: string;
  media_attachments?: Attachment[];
  poll?: DraftPoll | null;
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
  attachments?: Attachment[];
  poll?: DraftPoll | null;
}

/** 予約・投稿に使うアンケート（`/api/posts` と同じ形。公開時にそのまま投稿へ回る） */
export interface PollPayload {
  choices: string[];
  multiple: boolean;
  expires_in?: number;
}

export interface ScheduledInput {
  content: string;
  cw?: string;
  visibility?: string;
  in_reply_to?: string;
  quote_id?: string;
  attachments?: Attachment[];
  poll?: PollPayload | null;
}

/**
 * 保存されているアンケートを編集中の形へ。
 * 下書きは `expiresIn`（編集中の形）で、予約は `expires_in`（API の形）で保存するので
 * どちらでも読めるようにしておく
 */
function toDraftPoll(raw: any): DraftPoll | null {
  if (!raw || !Array.isArray(raw.choices) || raw.choices.length === 0) return null;
  const expiresIn = Number(raw.expiresIn ?? raw.expires_in);
  return {
    choices: raw.choices.map((choice: any) => String(choice ?? '')),
    multiple: Boolean(raw.multiple),
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 0,
  };
}

function toDraftedPost(raw: any): DraftedPost {
  return {
    ...raw,
    media_attachments: Array.isArray(raw?.media_attachments) ? raw.media_attachments : [],
    poll: toDraftPoll(raw?.poll),
  };
}

export async function loadDrafts(): Promise<DraftedPost[]> {
  const res = await api.get('/api/drafts');
  if (!res.ok || !Array.isArray(res.data)) return [];
  return (res.data as any[]).map(toDraftedPost);
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
  return (res.data as any[]).map(toDraftedPost);
}

/** scheduled_at は ISO 文字列（1 分以上先であること） */
export async function schedulePost(input: ScheduledInput & { scheduled_at: string }): Promise<string | null> {
  const res = await api.post('/api/scheduled-posts', input);
  return res.ok ? null : messageOf(res.data, '予約できませんでした。');
}

export async function cancelScheduled(id: string): Promise<boolean> {
  return (await api.del('/api/scheduled-posts/' + encodeURIComponent(id))).ok;
}
