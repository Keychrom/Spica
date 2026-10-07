import { Response } from 'express';
import crypto from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { config } from './config.js';
import { isRedisReady, publishEvent } from './redis.js';
import { getUserFromToken } from './auth.js';
import {
  buildNoteRouting,
  shouldDeliverNote,
  type NoteRouting,
  type RoutableNote,
} from './streamRouting.js';
import {
  buildMisskeyNote,
  buildMisskeyNotification,
  collectReferenceTimes,
} from './misskeyFormat.js';

/**
 * リアルタイム更新（SSE + Misskey 互換の WebSocket）
 *
 * `REDIS_URL` が設定されているときは、イベントを Redis の Pub/Sub に流して**全プロセス**に届ける
 * （どのプロセスに接続した利用者にも同じ更新が見える）。未設定なら今までどおり自分のプロセス内の
 * クライアントにだけ配る。Redis への配信に失敗したときも、その場は自プロセスへ配って終わる。
 *
 * **新着投稿（note）は必要な人にだけ配る。** クライアントは接続時に見たいストリームを申告し
 * （`?streams=local,home,tag:foo`）、`streamRouting.ts` の判定に通ったクライアントにだけ送る。
 * 申告が無い（古いクライアント）ときは今までどおり全部に配る。
 *
 * Misskey 互換の WebSocket（`/streaming?i=<トークン>`）は、この SSE と**同じイベント源**
 * （`deliverLocalEvent` / `deliverLocalUserNotification`）から配る。Redis 経由で他プロセスに
 * 届いたイベントも同じ関数を通るので、どのプロセスに繋いだクライアントにも流れる。
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

/**
 * 1 プロセスが同時に持てる SSE 接続の上限（`SSE_MAX_CLIENTS`、既定 1000）。
 * 常時接続なので、上限が無いと 1 プロセスのメモリを食い尽くす（まずここが枯れる）。
 * 溢れた接続は待たせずに 503 で断る（クライアントは少し待って張り直す）。
 */
const MAX_CLIENTS = config.sseMaxClients;
/**
 * 1 クライアントの送信バッファの上限（`SSE_MAX_BUFFER_BYTES`、既定 2MB）。
 * 遅いクライアントを放置するとバッファが無限に膨らむので、超えたら切る。
 * 切ってもクライアントは自動で張り直す（SSE の再接続）ので、失うのは数イベントぶん。
 */
const MAX_BUFFER_BYTES = config.sseMaxBufferBytes;

/**
 * バックプレッシャ対応の書き込み。
 *
 * `res.write()` の戻り値が false のときは**送信バッファが詰まっている**。
 * それを無視して書き続けるとバッファが膨らみ続けるので、詰まったら切断する。
 */
function writeToClient(id: string, client: StreamClient, payload: string): void {
  try {
    if (client.res.writableEnded || client.res.destroyed) {
      clients.delete(id);
      return;
    }
    const ok = client.res.write(payload);
    if (!ok || client.res.writableLength > MAX_BUFFER_BYTES) {
      console.warn(
        `[Streaming] ⚠️ 送信が追いつかないため切断します: ${id} (buffer ${client.res.writableLength} bytes)`,
      );
      clients.delete(id);
      try {
        client.res.end();
      } catch {
        // すでに切れている
      }
    }
  } catch {
    clients.delete(id);
  }
}

/** これ以上受け入れられないか（接続時に 503 で断る判定） */
export function isStreamAtCapacity(): boolean {
  return MAX_CLIENTS > 0 && clients.size >= MAX_CLIENTS;
}

/** プロセスをまたぐときに Pub/Sub へ流すメッセージ */
type StreamMessage =
  | { k: 'event'; e: string; d: any; r?: NoteRouting }
  | { k: 'user'; u: string; d: any };

// 定期ハートビート（25秒ごとに ping を送り、プロキシ・ルーターによるタイムアウト切断を防止）
setInterval(() => {
  if (clients.size === 0) return;
  const pingPayload = `:keepalive\n\n`;
  for (const [id, client] of clients.entries()) {
    writeToClient(id, client, pingPayload);
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
 *
 * Misskey 互換の WebSocket クライアントにも同じイベントを配る（`note` のみ）。
 * Redis 経由で他プロセスから届いたイベントも `handleRemoteStreamEvent` からここを通るので、
 * WS にも同じように流れる。
 */
function deliverLocalEvent(eventName: string, data: any, routing?: NoteRouting): void {
  // note は Misskey 互換の WS クライアントにも配るので、そちらの接続も数える
  if (clients.size === 0 && misskeyClients.size === 0) return;
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  const note = eventName === 'note' && routing ? (data as RoutableNote) : null;

  for (const [id, client] of clients.entries()) {
    if (note && routing && !shouldDeliverNote({ userId: client.userId ?? null, streams: client.streams }, note, routing)) {
      continue;
    }
    writeToClient(id, client, payload);
  }

  if (eventName === 'note') {
    deliverNoteToMisskeyClients(data, routing);
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

/** 自プロセスの該当ユーザーへ配る（Misskey 互換の WS の main チャンネルにも配る） */
function deliverLocalUserNotification(cleanTarget: string, notification: any): void {
  const payload = `event: notification\ndata: ${JSON.stringify(notification)}\n\n`;

  for (const [id, client] of clients.entries()) {
    if (client.userId && client.userId === cleanTarget) {
      writeToClient(id, client, payload);
    }
  }

  deliverNotificationToMisskeyClients(cleanTarget, notification);
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

  // Misskey 互換の WebSocket 接続も閉じる
  if (misskeyClients.size > 0) {
    const wsCount = misskeyClients.size;
    for (const client of misskeyClients) {
      try {
        client.ws.close(1001, 'server shutdown');
      } catch {
        // 既に切断済みなら無視
      }
    }
    misskeyClients.clear();
    console.log(`[Streaming] 🔌 終了に伴い ${wsCount} 件の Misskey 接続を閉じました`);
  }
  return count;
}

// ===========================================================================
// Misskey 互換の WebSocket ストリーミング（`/streaming?i=<トークン>`）
//
// Misskey のサードパーティ製クライアントは WebSocket に繋ぎ、チャンネルを購読して
// ノート・通知をリアルタイムに受け取る。配信は Spica 自身の SSE と同じイベント源
// （`deliverLocalEvent` / `deliverLocalUserNotification`）から行うので、Redis 経由で
// 他プロセスに届いたイベントもそのまま WS に流れる。
//
//   受信: { type: 'connect',    body: { channel: '<名前>', id: '<任意の id>' } }
//   送信: { type: 'connected',  body: { id: '<id>' } }
//   受信: { type: 'channel',    body: { id: '<id>', params: {...} } }   … 購読中チャンネルのパラメータ変更
//   受信: { type: 'disconnect', body: { id: '<id>' } }
//   送信: { type: 'channel', body: { id: '<id>', type: 'note',         body: { note: {...} } } }
//   送信: { type: 'channel', body: { id: '<id>', type: 'notification', body: { notification: {...} } } }
//   送信: { type: 'ping' } / 受信: { type: 'pong' } （逆方向の ping にも pong を返す）
//
// 対応チャンネル: homeTimeline / localTimeline / hybridTimeline / globalTimeline / main（自分の通知）。
// 匿名接続（`i` 無し）は localTimeline と globalTimeline だけ購読でき、homeTimeline と main は
// `CREDENTIAL_REQUIRED` のエラーで断る（Misskey と同じ扱い）。
// ===========================================================================

/** Misskey のチャンネル名（これ以外は知らないチャンネルとして断る） */
const MISSKEY_CHANNEL_SET = new Set<string>([
  'homeTimeline',
  'localTimeline',
  'hybridTimeline',
  'globalTimeline',
  'main',
]);

/** 匿名では購読できないチャンネル（Misskey は資格情報が必要とする） */
const MISSKEY_AUTH_CHANNELS = new Set<string>(['homeTimeline', 'hybridTimeline', 'main']);

/**
 * 無通信の切断を検知するための ping の間隔（既定 30 秒）。
 * 検査（scripts/test-misskey-streaming.ts）で短くできるよう、環境変数で上書きできる。
 * ping を送った次の間隔までに何も受信できなければ閉じる（1 回ぶんは待つ）。
 */
const MISSKEY_PING_INTERVAL_MS = Math.max(100, Number(process.env.MISSKEY_PING_INTERVAL_MS) || 30_000);

/** 1 接続ぶんの状態 */
interface MisskeyWsClient {
  ws: WebSocket;
  /** 認証中のユーザー ID（小文字にそろえる。匿名は null） */
  userId: string | null;
  /** 購読中のチャンネル（`connect` の id → チャンネル名） */
  channels: Map<string, string>;
  /** ping を送ってから、何か受信するのを待っているか */
  awaitingPong: boolean;
  /** 送信の順序を守るための直列キュー（Misskey 形式への整形が非同期のため） */
  queue: Promise<void>;
}

/** プロセス内で接続中の Misskey 互換 WS クライアント */
const misskeyClients = new Set<MisskeyWsClient>();

/** 受信データを文字列にする（ws は Buffer / Buffer の配列で渡してくる） */
function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

/** Misskey 互換クライアントへ 1 通送る（詰まっている接続は切る） */
function sendToMisskeyClient(client: MisskeyWsClient, payload: unknown): void {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  if (client.ws.bufferedAmount > MAX_BUFFER_BYTES) {
    console.warn(
      `[Streaming] ⚠️ Misskey クライアントの送信が追いつかないため切断します (buffer ${client.ws.bufferedAmount} bytes)`,
    );
    try {
      client.ws.close(1013, 'buffer limit');
    } catch {
      // すでに切れている
    }
    return;
  }
  try {
    client.ws.send(JSON.stringify(payload));
  } catch {
    // すでに切れている
  }
}

/** チャンネルのイベントを送る（ノート・通知の共通形） */
function sendMisskeyChannelEvent(client: MisskeyWsClient, id: string, type: string, body: unknown): void {
  sendToMisskeyClient(client, { type: 'channel', body: { id, type, body } });
}

/**
 * このチャンネルへこのノートを配るか。
 * `routing` が無い（判定に失敗した）ときは、SSE と同じく「取りこぼさない側」に倒す。
 */
function channelWantsNote(
  channel: string,
  userId: string | null,
  note: RoutableNote,
  routing?: NoteRouting,
): boolean {
  // 連合タイムラインはすべてのノートが出る
  if (channel === 'globalTimeline') return true;

  const isLocalNote = routing ? routing.local : note.is_local === true || Number(note.is_local) === 1;
  // ローカルタイムラインはローカルのノートだけ
  if (channel === 'localTimeline') return isLocalNote;

  if (channel === 'homeTimeline' || channel === 'hybridTimeline') {
    if (!userId) return false; // 匿名は connect の時点で断っている（保険）
    if (!routing) return true; // 判定材料が無いときは全員へ（取りこぼすよりは良い）
    // hybrid は「ローカル + ホーム」。Spica のホームにはローカルが含まれるので同じ判定でよい
    return shouldDeliverNote({ userId, streams: new Set(['home']) }, note, routing);
  }

  // main は通知専用（ノートは流さない）
  return false;
}

/** 配信ペイロードの型ゆれ（JSON 文字列で来た添付・リアクション）を配列に整える */
function normalizeStreamNote(note: any): any {
  const parseArray = (value: unknown): any[] => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value) {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  };
  return {
    ...note,
    media_attachments: parseArray(note?.media_attachments),
    reactions: parseArray(note?.reactions),
  };
}

/** 配信用に 1 件のノートを Misskey 形式へ整形する（整形できなければ null） */
async function buildStreamMisskeyNote(note: any): Promise<any | null> {
  const normalized = normalizeStreamNote(note);
  try {
    const referenceTimes = await collectReferenceTimes([normalized.in_reply_to, normalized.quote_id]);
    return buildMisskeyNote(normalized, false, referenceTimes);
  } catch {
    // 参照先の解決に失敗しても、ノート自体は送る（replyId などが欠けるだけ）
    try {
      return buildMisskeyNote(normalized, false);
    } catch (err: any) {
      console.warn('[Streaming] Misskey 形式への整形に失敗しました:', err?.message || err);
      return null;
    }
  }
}

/** note イベントを購読中の Misskey 互換クライアントへ配る */
function deliverNoteToMisskeyClients(note: any, routing?: NoteRouting): void {
  if (misskeyClients.size === 0 || !note) return;

  for (const client of misskeyClients) {
    const ids = [...client.channels.entries()]
      .filter(([, channel]) => channelWantsNote(channel, client.userId, note, routing))
      .map(([id]) => id);
    if (ids.length === 0) continue;

    // 整形は非同期（参照先の時刻を DB から引く）。接続ごとに直列化して配信順を守る
    client.queue = client.queue
      .then(async () => {
        const misskeyNote = await buildStreamMisskeyNote(note);
        if (!misskeyNote) return;
        for (const id of ids) {
          if (!client.channels.has(id)) continue; // 整形中に disconnect された
          sendMisskeyChannelEvent(client, id, 'note', { note: misskeyNote });
        }
      })
      .catch(() => {});
  }
}

/** 通知を main を購読している本人の Misskey 互換クライアントへ配る */
function deliverNotificationToMisskeyClients(userId: string, notification: any): void {
  if (misskeyClients.size === 0 || !notification) return;

  let misskeyNotification: any;
  try {
    misskeyNotification = buildMisskeyNotification(notification);
  } catch (err: any) {
    console.warn('[Streaming] 通知の Misskey 形式への変換に失敗しました:', err?.message || err);
    return;
  }

  for (const client of misskeyClients) {
    if (client.userId !== userId) continue;
    for (const [id, channel] of client.channels) {
      if (channel !== 'main') continue;
      sendMisskeyChannelEvent(client, id, 'notification', { notification: misskeyNotification });
    }
  }
}

/** クライアントからの 1 通を処理する（Misskey のプロトコル） */
function handleMisskeyClientMessage(client: MisskeyWsClient, raw: string): void {
  let message: any;
  try {
    message = JSON.parse(raw);
  } catch {
    return; // 壊れたメッセージは無視する
  }
  if (!message || typeof message !== 'object') return;
  const body = message.body && typeof message.body === 'object' ? message.body : {};

  switch (message.type) {
    case 'ping':
      // クライアントからの ping には pong を返す（Misskey はどちらの向きにも ping を出す）
      sendToMisskeyClient(client, { type: 'pong' });
      return;
    case 'pong':
      return;
    case 'connect': {
      const id = String(body.id ?? '');
      const channel = String(body.channel ?? '');
      if (!MISSKEY_CHANNEL_SET.has(channel)) {
        sendToMisskeyClient(client, { type: 'error', body: { id, code: 'NO_SUCH_CHANNEL' } });
        return;
      }
      if (!client.userId && MISSKEY_AUTH_CHANNELS.has(channel)) {
        // Misskey と同じく、資格情報が要るチャンネルは匿名では購読できない
        sendToMisskeyClient(client, { type: 'error', body: { id, code: 'CREDENTIAL_REQUIRED' } });
        return;
      }
      client.channels.set(id, channel);
      sendToMisskeyClient(client, { type: 'connected', body: { id } });
      return;
    }
    case 'disconnect':
      client.channels.delete(String(body.id ?? ''));
      return;
    case 'channel': {
      // 購読中チャンネルのパラメータ変更。Spica が対応するチャンネルはパラメータを使わないので、
      // 購読の有無だけ確かめて受け入れる（知らない id はチャンネル不明として断る）
      const id = String(body.id ?? '');
      if (!client.channels.has(id)) {
        sendToMisskeyClient(client, { type: 'error', body: { id, code: 'NO_SUCH_CHANNEL' } });
      }
      return;
    }
    default:
      return; // 知らないメッセージは無視する
  }
}

/** 認証を通った WebSocket を Misskey 互換クライアントとして登録する */
function registerMisskeyClient(ws: WebSocket, userId: string | null): void {
  const client: MisskeyWsClient = {
    ws,
    userId,
    channels: new Map(),
    awaitingPong: false,
    queue: Promise.resolve(),
  };
  misskeyClients.add(client);
  console.log(
    `[Streaming] 📡 Misskey client connected (user: ${userId || 'guest'}). Total: ${misskeyClients.size}`,
  );

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) return; // プロトコルは JSON のテキストのみ
    // 何か受信したら生存しているとみなす（ping への pong もここで拾える）
    client.awaitingPong = false;
    handleMisskeyClientMessage(client, rawDataToString(data));
  });
  ws.on('error', () => {
    // 切断は close でも来る。未処理エラーにしないための受け皿
  });
  ws.on('close', () => {
    misskeyClients.delete(client);
    console.log(
      `[Streaming] 🔌 Misskey client disconnected (user: ${userId || 'guest'}). Remaining: ${misskeyClients.size}`,
    );
  });
}

/**
 * `/streaming` への HTTP upgrade を Misskey 互換の WebSocket として扱う（index.ts から呼ぶ）。
 *
 * `i` クエリのトークンを `getUserFromToken` で検証し、無効ならハンドシェイクせず 401 で閉じる。
 * `i` が無い接続は匿名として受け入れ、購読できるチャンネルを絞る（connect のとき判定）。
 */
export function attachMisskeyStreaming(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/streaming') {
      // 他の WebSocket は提供していない。心当たりのない upgrade は切る
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('i') || '';
    void (async () => {
      let userId: string | null = null;
      if (token) {
        const user = await getUserFromToken(token);
        if (!user) {
          // トークンが無効なときは 101 に切り替えず 401 を返して閉じる
          try {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          } catch {
            // 書けなくても閉じるだけ
          }
          socket.destroy();
          return;
        }
        userId = user.id.toLowerCase();
      }
      wss.handleUpgrade(req, socket, head, (ws) => registerMisskeyClient(ws, userId));
    })().catch(() => {
      socket.destroy();
    });
  });
}

/**
 * 無通信の切断検知（Misskey は ping/pong を使う）:
 * 30 秒ごとに `{"type":"ping"}` を送り、次の間隔までに何も受信できなければ閉じる。
 * 黙って死んだ接続を残すと、プロセスがメモリとファイルディスクリプタを抱え続ける。
 */
setInterval(() => {
  if (misskeyClients.size === 0) return;
  for (const client of misskeyClients) {
    if (client.awaitingPong) {
      console.warn('[Streaming] ⚠️ Misskey クライアントが ping に応答しないため切断します');
      try {
        client.ws.close(1000, 'ping timeout');
      } catch {
        // すでに切れている
      }
      misskeyClients.delete(client);
      continue;
    }
    client.awaitingPong = true;
    sendToMisskeyClient(client, { type: 'ping' });
  }
}, MISSKEY_PING_INTERVAL_MS);

/** 接続中の Misskey 互換 WS クライアント数（検査・ログ用） */
export function getMisskeyStreamClientCount(): number {
  return misskeyClients.size;
}
