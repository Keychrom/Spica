import { Response } from 'express';
import crypto from 'node:crypto';

interface StreamClient {
  id: string;
  userId?: string | null;
  res: Response;
  createdAt: number;
}

const clients = new Map<string, StreamClient>();

// 定期ハートビート（25秒ごとに ping を送り、プロキシ・ルーターによるタイムアウト切断を防止）
setInterval(() => {
  if (clients.size === 0) return;
  const pingPayload = `:keepalive\n\n`;
  for (const [id, client] of clients.entries()) {
    try {
      client.res.write(pingPayload);
    } catch {
      clients.delete(id);
    }
  }
}, 25000);

/**
 * SSE クライアントを登録
 */
export function addStreamClient(res: Response, userId?: string | null): string {
  const clientId = crypto.randomUUID();

  // SSE ヘッダー設定
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  // 初回接続確認パケット
  res.write(`event: connected\ndata: ${JSON.stringify({ clientId, timestamp: new Date().toISOString() })}\n\n`);

  clients.set(clientId, {
    id: clientId,
    userId: userId ? userId.toLowerCase() : null,
    res,
    createdAt: Date.now(),
  });

  console.log(`[Streaming] 📡 Client connected: ${clientId} (user: ${userId || 'guest'}). Total clients: ${clients.size}`);
  return clientId;
}

/**
 * SSE クライアントを切断・削除
 */
export function removeStreamClient(clientId: string): void {
  if (clients.has(clientId)) {
    clients.delete(clientId);
    console.log(`[Streaming] 🔌 Client disconnected: ${clientId}. Remaining clients: ${clients.size}`);
  }
}

/**
 * 全接続クライアントにイベントをブロードキャスト
 */
export function broadcastEvent(eventName: string, data: any): void {
  if (clients.size === 0) return;
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, client] of clients.entries()) {
    try {
      client.res.write(payload);
    } catch {
      clients.delete(id);
    }
  }
}

/**
 * 📡 新着ノート（投稿）をブロードキャスト
 */
export function broadcastNote(post: any): void {
  broadcastEvent('note', post);
}

/**
 * 📡 リアクション更新をブロードキャスト
 */
export function broadcastReaction(data: {
  postId: string;
  reaction: string;
  count: number;
  user_id?: string;
  action: 'add' | 'remove';
}): void {
  broadcastEvent('reaction', data);
}

/**
 * 📡 リノート更新をブロードキャスト
 */
export function broadcastAnnounce(data: {
  postId: string;
  count: number;
  renote?: any;
}): void {
  broadcastEvent('renote', data);
}

/**
 * 📡 アンケート投票の更新をブロードキャスト
 */
export function broadcastPoll(data: {
  postId: string;
  poll: any;
}): void {
  broadcastEvent('poll_updated', data);
}

/**
 * 📡 投稿削除をブロードキャスト
 */
export function broadcastDeletePost(postId: string): void {
  broadcastEvent('delete_post', { postId });
}

/**
 * 📡 特定ユーザー宛てにリアルタイム通知をプッシュ
 */
export function sendNotificationToUser(targetUserId: string, notification: any): void {
  const cleanTarget = targetUserId.toLowerCase();
  const payload = `event: notification\ndata: ${JSON.stringify(notification)}\n\n`;

  for (const [id, client] of clients.entries()) {
    if (client.userId && client.userId === cleanTarget) {
      try {
        client.res.write(payload);
      } catch {
        clients.delete(id);
      }
    }
  }
}
