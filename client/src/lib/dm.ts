/**
 * メッセージ（DM）の通信。
 * サーバーで dm_enabled が on のときだけ生きている（off のときは 404 が返る）。
 * 有効かどうかは /api/server-info の features.dm で分かる。
 */
import { api, messageOf } from './api';

export interface DmPartner {
  actor_url: string;
  user_id: string | null;
  name?: string;
  handle?: string;
  icon_url?: string;
  is_local?: boolean;
  accepts_dm?: boolean | null;
}

export interface DmMessage {
  id: string;
  conversation_id: string;
  content: string;
  cw?: string | null;
  published_at: string;
  is_mine: boolean;
  is_read: boolean;
  author?: { name?: string; handle?: string; icon_url?: string };
}

export interface DmConversation {
  id: string;
  partner: DmPartner;
  last_message?: { id: string; content: string; has_media?: boolean; published_at: string; is_mine: boolean };
  unread_count?: number;
  message_count?: number;
  updated_at?: string;
}

export async function loadConversations(): Promise<DmConversation[]> {
  const res = await api.get('/api/dm/conversations');
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as DmConversation[];
}

export interface DmThread {
  conversation?: DmConversation;
  messages: DmMessage[];
  nextCursor: string | null;
}

export async function loadThread(id: string): Promise<DmThread | null> {
  const res = await api.get('/api/dm/conversations/' + encodeURIComponent(id));
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  const data = res.data as { conversation?: DmConversation; messages?: DmMessage[] };
  return {
    conversation: data.conversation,
    messages: data.messages ?? [],
    nextCursor: res.headers.get('X-Next-Cursor'),
  };
}

export async function markRead(id: string): Promise<void> {
  await api.post('/api/dm/conversations/' + encodeURIComponent(id) + '/read');
}

/** to は @user@domain / user@domain / user（同じサーバー）/ actor URL */
export async function sendMessage(to: string, content: string, inReplyTo?: string): Promise<string | null> {
  const res = await api.post('/api/dm/messages', {
    to,
    content,
    ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
  });
  if (res.ok) return null;
  const data = res.data as { error?: string; reason?: string } | null;
  if (res.status === 429) return '新しい相手に送れる数が今日の上限に達しました。';
  return messageOf(data, data?.reason === 'recipient_policy' ? 'この相手はメッセージを受け取らない設定です。' : '送れませんでした。');
}
