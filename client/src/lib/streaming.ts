/**
 * リアルタイム更新（SSE）。
 *  ・EventSource はヘッダを付けられないので、ワンタイムチケットを取ってから張る
 *  ・チケットは 60 秒・1 回きりなので、切れたら取り直して張り直す
 *  ・受け取った出来事は窓の合図（spica:stream-*）に流し、画面側が拾う
 */
import { api } from './api';

const EVENTS = ['connected', 'note', 'reaction', 'renote', 'poll_updated', 'delete_post', 'notification'];

export interface StreamNote {
  type: string;
  data: unknown;
}

export async function ticket(): Promise<string | null> {
  const res = await api.post('/api/streaming/ticket');
  if (!res.ok || !res.data) return null;
  const value = (res.data as { ticket?: string }).ticket;
  return value || null;
}

/** 窓の合図に流す（画面側はこれだけ知っていればよい） */
function fanOut(type: string, data: unknown): void {
  const detail = data as Record<string, unknown> | null;
  switch (type) {
    case 'notification':
      window.dispatchEvent(new CustomEvent('spica:stream-notification', { detail: { notification: detail } }));
      return;
    case 'note':
      window.dispatchEvent(new CustomEvent('spica:stream-note', { detail: { post: detail } }));
      return;
    case 'delete_post': {
      const postId = String((detail?.postId as string) || '');
      if (postId) window.dispatchEvent(new CustomEvent('spica:post-removed', { detail: { postId } }));
      return;
    }
    case 'reaction': {
      const postId = String((detail?.postId as string) || '');
      const reactions = detail?.reactions;
      if (postId && reactions) {
        window.dispatchEvent(new CustomEvent('spica:post-updated', { detail: { postId, patch: { reactions } } }));
      }
      return;
    }
    case 'renote': {
      const postId = String((detail?.postId as string) || '');
      if (postId) {
        window.dispatchEvent(
          new CustomEvent('spica:post-updated', {
            detail: { postId, patch: { announce_count: detail?.announceCount } },
          }),
        );
      }
      return;
    }
    case 'poll_updated': {
      const postId = String((detail?.postId as string) || '');
      if (postId && detail?.poll) {
        window.dispatchEvent(new CustomEvent('spica:post-updated', { detail: { postId, patch: { poll: detail.poll } } }));
      }
      return;
    }
    default:
      return;
  }
}

/**
 * つなぐ。戻り値を呼ぶと切る。
 * onStatus は接続できたかどうかを画面に伝えるため（接続中 / 切れている）。
 */
export function openStream(onStatus?: (live: boolean) => void): () => void {
  let source: EventSource | null = null;
  let closed = false;
  let timer = 0;
  let wait = 2000;

  function later() {
    if (closed || timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      wait = Math.min(wait * 2, 60_000);
      void connect();
    }, wait);
  }

  async function connect() {
    if (closed) return;
    const value = await ticket();
    if (closed) return;
    if (!value) {
      onStatus?.(false);
      later();
      return;
    }
    const next = new EventSource('/api/streaming?ticket=' + encodeURIComponent(value));
    source = next;
    next.addEventListener('open', () => {
      wait = 2000;
      onStatus?.(true);
    });
    for (const name of EVENTS) {
      next.addEventListener(name, (event) => {
        if (name === 'connected') return;
        let data: unknown = null;
        try {
          data = JSON.parse((event as MessageEvent).data);
        } catch {
          data = null;
        }
        fanOut(name, data);
      });
    }
    next.addEventListener('error', () => {
      // チケットは 1 回きりなので、自動の張り直しには任せず自分で張り直す
      next.close();
      if (source === next) source = null;
      onStatus?.(false);
      later();
    });
  }

  void connect();

  return () => {
    closed = true;
    if (timer) window.clearTimeout(timer);
    source?.close();
    source = null;
    onStatus?.(false);
  };
}
