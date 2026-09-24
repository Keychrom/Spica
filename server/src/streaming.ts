import { Response } from 'express';
import crypto from 'node:crypto';
import { isRedisReady, publishEvent } from './redis.js';
import {
  buildNoteRouting,
  shouldDeliverNote,
  type NoteRouting,
  type RoutableNote,
} from './streamRouting.js';

/**
 * リアルタイム更新（SSE）
 *
 * `REDIS_URL` が設定されているときは、イベントを Redis の Pub/Sub に流して**全プロセス**に届ける
 * （どのプロセスに接続した利用者にも同じ更新が見える）。未設定なら今までどおり自分のプロセス内の
 * クライアントにだけ配る。Redis への配信に失敗したときも、その場は自プロセスへ配って終わる。
 *
 * **新着投稿（note）は必要な人にだけ配る。** クライアントは接続時に見たいストリームを申告し
 * （`?streams=local,home,tag:foo`）、`streamRouting.ts` の判定に通ったクライアントにだけ送る。
 * 申告が無い（古いクライアント）ときは今までどおり全部に配る。
 *
 * 取りこぼしについて: Pub/Sub は「その瞬間に繋がっている相手」にしか届かない（履歴を持たない）。
 * リアルタイム更新は接続中のクライアントに届けばよく、クライアントは再接続時に取り直す前提なので、
 * ここは今までと同じ性質（プロセス内でも、配信中に切れたクライアントには届かない）。
 */

interface StreamClient {
  id: string;
  userId?: string | null;
  res: Response;
  createdAt: number;
  /** 受け取りたいストリーム（`*` なら全部） */
  streams: Set<string>;
}

const clients = new Map<string, StreamClient>();

/** プロセスをまたぐときに Pub/Sub へ流すメッセージ */
type StreamMessage =
  | { k: 'event'; e: string; d: any; r?: NoteRouting }
  | { k: 'user'; u: string; d: any };

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
 *
 * `streams` は接続時に申告された「見たいストリーム」（`streamRouting.parseStreams` でパース済み）。
 * 省略したときは全部（`*`）＝今までどおりの配信。
 */
export function addStreamClient(res: Response, userId?: string | null, streams?: Set<string>): string {
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
    streams: streams && streams.size > 0 ? streams : new Set(['*']),
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
 * 自プロセスの全クライアントへ配る。
 * `eventName` が `note` で `routing` があるときは、必要なクライアントにだけ配る。
 */
function deliverLocalEvent(eventName: string, data: any, routing?: NoteRouting): void {
  if (clients.size === 0) return;
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  const note = eventName === 'note' && routing ? (data as RoutableNote) : null;

  for (const [id, client] of clients.entries()) {
    if (note && routing && !shouldDeliverNote({ userId: client.userId ?? null, streams: client.streams }, note, routing)) {
      continue;
    }
    try {
      client.res.write(payload);
    } catch {
      clients.delete(id);
    }
  }
}

/**
 * 📡 新着ノートを配信する。
 * ローカル投稿はローカル/ホームを購読している人へ、リモート投稿は「連合を見ている人」と
 * 「作者をフォローしている人」へだけ届ける（材料は `streamRouting.ts` が作る）。
 */
export function broadcastNote(post: RoutableNote & Record<string, any>): void {
  void buildNoteRouting(post)
    .then((routing) => {
      if (isRedisReady()) {
        const message: StreamMessage = { k: 'event', e: 'note', d: post, r: routing };
        return publishEvent('stream', message).then((sent) => {
          if (!sent) deliverLocalEvent('note', post, routing);
        });
      }
      deliverLocalEvent('note', post, routing);
    })
    .catch((err) => {
      // 判定に失敗したら今までどおり全員へ（取りこぼすよりは良い）
      console.warn('[Streaming] 配信先の判定に失敗しました。全クライアントへ配ります:', err?.message || err);
      deliverLocalEvent('note', post);
    });
}

/**
 * 全接続クライアントにイベントをブロードキャスト（note 以外の小さな更新: リアクション・リノート数など）。
 * Redis が使えるときは全プロセスへ配る（配れなかったときだけ自プロセスへ配る）
 */
export function broadcastEvent(eventName: string, data: any): void {
  if (isRedisReady()) {
    const message: StreamMessage = { k: 'event', e: eventName, d: data };
    void publishEvent('stream', message).then((sent) => {
      if (!sent) deliverLocalEvent(eventName, data);
    });
    return;
  }
  deliverLocalEvent(eventName, data);
}

/** 他プロセスから届いたイベントを自プロセスのクライアントへ配る（購読は index.ts が張る） */
export function handleRemoteStreamEvent(raw: string): void {
  let message: StreamMessage;
  try {
    message = JSON.parse(raw) as StreamMessage;
  } catch {
    return; // 壊れたメッセージは無視する
  }
  if (message?.k === 'event') deliverLocalEvent(message.e, message.d, message.r);
  else if (message?.k === 'user') deliverLocalUserNotification(String(message.u).toLowerCase(), message.d);
}

/** 接続中の SSE クライアント数（`/health` と検査で使う） */
export function getStreamClientCount(): number {
  return clients.size;
}

/** 検査用: 接続中のクライアントのストリーム（どのストリームを購読しているか） */
export function getStreamSubscriptions(): { id: string; userId: string | null; streams: string[] }[] {
  return [...clients.values()].map((client) => ({
    id: client.id,
    userId: client.userId ?? null,
    streams: [...client.streams],
  }));
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

/** 自プロセスの該当ユーザーへ配る */
function deliverLocalUserNotification(cleanTarget: string, notification: any): void {
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

/**
 * 📡 特定ユーザー宛てにリアルタイム通知をプッシュ。
 * Redis が使えるときは全プロセスへ配る（そのユーザーがどのプロセスに繋いでいても届く）
 */
export function sendNotificationToUser(targetUserId: string, notification: any): void {
  const cleanTarget = targetUserId.toLowerCase();
  if (isRedisReady()) {
    const message: StreamMessage = { k: 'user', u: cleanTarget, d: notification };
    void publishEvent('stream', message).then((sent) => {
      if (!sent) deliverLocalUserNotification(cleanTarget, notification);
    });
    return;
  }
  deliverLocalUserNotification(cleanTarget, notification);
}

/** 終了時に SSE 接続をすべて閉じる（グレースフルシャットダウン用） */
export function closeAllStreams(): number {
  const count = clients.size;
  for (const [id, client] of clients.entries()) {
    try {
      client.res.end();
    } catch {
      // 既に切断済みなら無視
    }
    clients.delete(id);
  }
  if (count > 0) console.log(`[Streaming] 🔌 終了に伴い ${count} 件の SSE 接続を閉じました`);
  return count;
}
