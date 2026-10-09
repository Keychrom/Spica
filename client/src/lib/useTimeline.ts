/**
 * タイムラインの状態（取得・ページネーション・投稿への操作）。
 * ホーム / ブックマーク / リスト / アンテナ / チャンネル / タグが同じものを使う。
 *
 * path に null を渡すと「読まない」（コレクション未選択のときなど）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { renotePost, reactToPost, sharePost, toggleBookmark } from './postActions';
import type { Post } from './format';

/**
 * 応答の形は 2 通りある（サーバーの流儀に合わせる）。
 *   素の配列          … /api/timeline, /api/bookmarks
 *   { …, posts: [] }  … /api/lists/:id/timeline, /api/antennas/:id/timeline, /api/channels/:id/timeline
 */
function extractPosts(data: unknown): Post[] | null {
  if (Array.isArray(data)) return data as Post[];
  if (data && typeof data === 'object') {
    const posts = (data as { posts?: unknown }).posts;
    if (Array.isArray(posts)) return posts as Post[];
  }
  return null;
}

export interface Timeline {
  posts: Post[];
  loading: boolean;
  loadingMore: boolean;
  cursor: string | null;
  /** 読み込み直して上に増えた件数（押すと先頭へ） */
  newCount: number;
  clearNewCount: () => void;
  reload: (options?: { keepScroll?: boolean }) => Promise<void>;
  loadMore: () => Promise<void>;
  applyPatch: (postId: string, patch: Partial<Post>) => void;
  react: (post: Post, reaction: string) => Promise<void>;
  bookmark: (post: Post) => Promise<void>;
  renote: (post: Post) => Promise<void>;
  share: (post: Post) => void;
}

export function useTimeline(path: string | null, signedIn: boolean): Timeline {
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const postsRef = useRef<Post[]>([]);
  postsRef.current = posts;

  const reload = useCallback(
    async (options: { keepScroll?: boolean } = {}) => {
      abortRef.current?.abort();
      if (!path) {
        setPosts([]);
        setCursor(null);
        setNewCount(0);
        setLoading(false);
        return;
      }
      const ac = new AbortController();
      abortRef.current = ac;
      setLoading(true);
      try {
        const res = await api.get(path, { signal: ac.signal, auth: signedIn });
        if (!res.ok) return;
        const next = extractPosts(res.data);
        if (!next) return;
        const previousTop = postsRef.current[0]?.id;
        const nextTop = next[0]?.id;
        const changed = previousTop && nextTop && previousTop !== nextTop;
        if (changed && options.keepScroll && window.scrollY > 400) {
          // 読んでいる位置を保ったまま、新着は上に積む（押されたら先頭へ）
          const index = next.findIndex((p) => p.id === previousTop);
          setNewCount(index > 0 ? index : 1);
        } else {
          setNewCount(0);
        }
        setPosts(next);
        setCursor(res.headers.get('X-Next-Cursor'));
      } catch (err) {
        if (!ac.signal.aborted) console.error(err);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    },
    [path, signedIn],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // リアルタイムで新着が届いたら読み直す（読み込み直すボタンと同じ扱い）
  useEffect(() => {
    const onNote = () => void reload({ keepScroll: true });
    window.addEventListener('spica:stream-note', onNote);
    return () => window.removeEventListener('spica:stream-note', onNote);
  }, [reload]);

  // 投稿したら読み直す（Composer からの合図）
  useEffect(() => {
    const onPosted = () => void reload();
    window.addEventListener('spica:posted', onPosted);
    return () => window.removeEventListener('spica:posted', onPosted);
  }, [reload]);

  // 1 枚だけ直った / 消えたときの合図（編集・削除・ピン留め・投票）
  useEffect(() => {
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ postId: string; patch: Partial<Post> }>).detail;
      if (!detail) return;
      setPosts((current) => current.map((p) => (p.id === detail.postId ? { ...p, ...detail.patch } : p)));
    };
    const onRemoved = (event: Event) => {
      const detail = (event as CustomEvent<{ postId: string }>).detail;
      if (!detail) return;
      setPosts((current) => current.filter((p) => p.id !== detail.postId));
    };
    window.addEventListener('spica:post-updated', onUpdated);
    window.addEventListener('spica:post-removed', onRemoved);
    return () => {
      window.removeEventListener('spica:post-updated', onUpdated);
      window.removeEventListener('spica:post-removed', onRemoved);
    };
  }, []);

  async function loadMore(): Promise<void> {
    if (!cursor || loadingMore || !path) return;
    setLoadingMore(true);
    const joiner = path.includes('?') ? '&' : '?';
    const res = await api.get(path + joiner + 'cursor=' + encodeURIComponent(cursor), { auth: signedIn });
    if (res.ok) {
      const more = extractPosts(res.data);
      if (more && more.length > 0) setPosts((current) => [...current, ...more]);
      setCursor(res.headers.get('X-Next-Cursor'));
    }
    setLoadingMore(false);
  }

  const applyPatch = useCallback((postId: string, patch: Partial<Post>) => {
    setPosts((current) => current.map((p) => (p.id === postId ? { ...p, ...patch } : p)));
  }, []);

  return {
    posts,
    loading,
    loadingMore,
    cursor,
    newCount,
    reload,
    loadMore,
    applyPatch,
    clearNewCount: () => setNewCount(0),
    react: async (post, reaction) => {
      if (!signedIn) return;
      const reactions = await reactToPost(post, reaction);
      if (reactions) applyPatch(post.id, { reactions });
    },
    bookmark: async (post) => {
      if (!signedIn) return;
      const bookmarked = await toggleBookmark(post);
      if (bookmarked !== null) applyPatch(post.id, { bookmarked });
    },
    renote: async (post) => {
      if (!signedIn) return;
      if (await renotePost(post)) void reload();
    },
    share: sharePost,
  };
}
