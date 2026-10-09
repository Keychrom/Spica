/**
 * 投稿の一覧（読み込み中・空・本体・続き）。
 * タイムライン系の画面はこれを使う（ホーム / ブックマーク / リスト / アンテナ / チャンネル / タグ）。
 */
import type { ReactNode } from 'react';
import PostCard from './PostCard';
import type { Timeline } from '../lib/useTimeline';
import type { Post } from '../lib/format';

interface PostListProps {
  timeline: Timeline;
  signedIn: boolean;
  /** 自分のノートに編集・削除を出すための ID */
  myId?: string;
  /** 運営として削除できるか */
  canModerate?: boolean;
  onReply: (post: Post) => void;
  onQuote: (post: Post) => void;
  /** 空のときの案内（画面ごとに変える） */
  empty?: ReactNode;
  /** ログインしていない人向けの案内を下に出すか */
  showSignInHint?: boolean;
  onSignIn?: () => void;
}

export default function PostList({
  timeline,
  signedIn,
  myId,
  canModerate,
  onReply,
  onQuote,
  empty,
  showSignInHint,
  onSignIn,
}: PostListProps) {
  const { posts, loading, loadingMore, cursor, loadMore } = timeline;

  return (
    <div className="feed">
      {loading && posts.length === 0 && <div className="feed__state">読み込んでいます…</div>}

      {!loading && posts.length === 0 && <div className="feed__state">{empty}</div>}

      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          onReact={(p, reaction) => void timeline.react(p, reaction)}
          onBookmark={(p) => void timeline.bookmark(p)}
          onRenote={(p) => void timeline.renote(p)}
          onReply={onReply}
          onQuote={onQuote}
          onShare={timeline.share}
          signedIn={signedIn}
          myId={myId}
          canModerate={canModerate}
        />
      ))}

      {cursor && posts.length > 0 && (
        <div className="feed__more">
          <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? '読み込んでいます…' : '過去のノートを読み込む'}
          </button>
        </div>
      )}

      {showSignInHint && !signedIn && posts.length > 0 && (
        <div className="feed__state" style={{ paddingTop: 18 }}>
          ログインすると、フォロー中のノートとリアクションが使えます。
          <br />
          <button type="button" className="btn btn--text" onClick={onSignIn}>
            ログイン / 新規登録
          </button>
        </div>
      )}
    </div>
  );
}
