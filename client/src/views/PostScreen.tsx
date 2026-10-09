/**
 * ノートの 1 枚を開く入口（URL の形が 2 つある）。
 *   `/users/<user>/posts/<短い ID>` … 正規のパーマリンク（サーバーが OGP を返す形）
 *   `/?post=<正規 ID>`             … リモートのノートの共有 URL
 *
 * 後ろは同じ `PostDetailView`（投稿の ID だけで読める）。
 * 正規 ID は自分で組み立てる（パスの短い ID のまま API に投げると 404 になる）。
 */
import type { ReactNode } from 'react';
import PostDetailView from './PostDetailView';
import { canonicalPostIdFromPath } from '../lib/permalink';
import { canModerate } from '../lib/nav';
import type { Post, SessionUser } from '../lib/format';

interface PostScreenProps {
  menuButton: ReactNode;
  signedIn: boolean;
  /** ログイン中の人（自分のノートに編集・削除を出し、運営かどうかを決める） */
  user: SessionUser | null;
  /** パーマリンクから開いたときの `<user>` と `<短い ID>` */
  fromPath?: { author: string; postPathId: string };
  /** `/?post=` から開いたときの正規 ID */
  canonicalId?: string;
  onReply: (post: Post) => void;
  onQuote: (post: Post) => void;
}

export default function PostScreen({
  menuButton,
  signedIn,
  user,
  fromPath,
  canonicalId,
  onReply,
  onQuote,
}: PostScreenProps) {
  const postId = fromPath ? canonicalPostIdFromPath(fromPath.author, fromPath.postPathId) : canonicalId || '';
  return (
    <PostDetailView
      menuButton={menuButton}
      signedIn={signedIn}
      myId={user?.id}
      canModerate={canModerate(user?.role)}
      postId={postId}
      author={fromPath?.author}
      onReply={onReply}
      onQuote={onQuote}
    />
  );
}
