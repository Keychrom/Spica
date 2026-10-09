/**
 * ノートの 1 枚（返信の連なりも一緒に見る）。
 * 通知・検索・リストから飛んだ先。`/users/:user/posts/:id`。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import ScreenHead from '../components/ScreenHead';
import PostCard from '../components/PostCard';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { reactToPost, renotePost, sharePost, toggleBookmark } from '../lib/postActions';
import type { Post } from '../lib/format';

interface Thread {
  post: Post | null;
  parent: Post | null;
  replies: Post[];
}

interface PostDetailViewProps {
  menuButton: ReactNode;
  signedIn: boolean;
  postId: string;
  /** 返信先の投稿者（見出しに出す） */
  author?: string;
  /** ログイン中の人（自分のノートに編集・削除を出す） */
  myId?: string;
  canModerate?: boolean;
  onReply: (post: Post) => void;
  onQuote: (post: Post) => void;
}

export default function PostDetailView({
  menuButton,
  signedIn,
  postId,
  author,
  myId,
  canModerate,
  onReply,
  onQuote,
}: PostDetailViewProps) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await api.get('/api/posts/' + encodeURIComponent(postId) + '/thread', { auth: signedIn });
    if (res.ok && res.data && typeof res.data === 'object') {
      const data = res.data as Thread;
      setThread({ post: data.post ?? null, parent: data.parent ?? null, replies: data.replies ?? [] });
    } else {
      setThread(null);
    }
    setLoading(false);
  }, [postId, signedIn]);

  useEffect(() => {
    void load();
  }, [load]);

  // 1 枚だけ直った / 消えたときの合図（編集・削除・ピン留め・投票）
  useEffect(() => {
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ postId: string; patch: Partial<Post> }>).detail;
      if (detail) patch(detail.postId, detail.patch);
    };
    const onRemoved = (event: Event) => {
      const detail = (event as CustomEvent<{ postId: string }>).detail;
      if (!detail) return;
      setThread((current) => {
        if (!current) return current;
        if (current.post?.id === detail.postId) return { post: null, parent: current.parent, replies: current.replies };
        return {
          post: current.post,
          parent: current.parent?.id === detail.postId ? null : current.parent,
          replies: current.replies.filter((r) => r.id !== detail.postId),
        };
      });
    };
    window.addEventListener('spica:post-updated', onUpdated);
    window.addEventListener('spica:post-removed', onRemoved);
    return () => {
      window.removeEventListener('spica:post-updated', onUpdated);
      window.removeEventListener('spica:post-removed', onRemoved);
    };
  }, []);

  /** 1 枚だけ直す（リアクションやブックマークの結果を反映する） */
  function patch(postIdToFix: string, patchData: Partial<Post>) {
    setThread((current) => {
      if (!current) return current;
      const fix = (p: Post) => (p.id === postIdToFix ? { ...p, ...patchData } : p);
      return {
        post: current.post ? fix(current.post) : null,
        parent: current.parent ? fix(current.parent) : null,
        replies: current.replies.map(fix),
      };
    });
  }

  const actions = (post: Post) => ({
    onReact: async (p: Post, reaction: string) => {
      if (!signedIn) return;
      const reactions = await reactToPost(p, reaction);
      if (reactions) patch(p.id, { reactions });
    },
    onBookmark: async (p: Post) => {
      if (!signedIn) return;
      const bookmarked = await toggleBookmark(p);
      if (bookmarked !== null) patch(p.id, { bookmarked });
    },
    onRenote: async (p: Post) => {
      if (!signedIn) return;
      if (await renotePost(p)) void load();
    },
    onReply,
    onQuote,
    onShare: sharePost,
  });

  return (
    <>
      <ScreenHead
        title="ノート"
        sub={author ? `@${author} のノート` : undefined}
        menuButton={menuButton}
        onReload={() => void load()}
        reloading={loading}
      />
      <div className="divider" />

      <div className="feed">
        {loading && !thread && <div className="feed__state">読み込んでいます…</div>}
        {!loading && !thread?.post && (
          <div className="feed__state">
            このノートは見つかりませんでした（削除されたか、見る権限がありません）。
            <br />
            <button type="button" className="btn btn--text" onClick={() => navigate('/')}>
              タイムラインへ戻る
            </button>
          </div>
        )}

        {thread?.parent && (
          <>
            <h2 className="plain__title">返信先</h2>
            <PostCard
              post={thread.parent}
              {...actions(thread.parent)}
              signedIn={signedIn}
              myId={myId}
              canModerate={canModerate}
            />
            <div className="divider" />
          </>
        )}

        {thread?.post && (
          <PostCard
            post={thread.post}
            {...actions(thread.post)}
            signedIn={signedIn}
            myId={myId}
            canModerate={canModerate}
          />
        )}

        {thread?.post && thread.replies.length > 0 && (
          <>
            <h2 className="plain__title">返信 {thread.replies.length}件</h2>
            {thread.replies.map((reply) => (
              <PostCard
                key={reply.id}
                post={reply}
                {...actions(reply)}
                signedIn={signedIn}
                myId={myId}
                canModerate={canModerate}
              />
            ))}
          </>
        )}

        {thread?.post && thread.replies.length === 0 && !loading && (
          <div className="feed__state">
            まだ返信はありません。
            <br />
            <button type="button" className="btn btn--text" onClick={() => onReply(thread.post as Post)}>
              返信を書く
            </button>
          </div>
        )}
      </div>
    </>
  );
}
