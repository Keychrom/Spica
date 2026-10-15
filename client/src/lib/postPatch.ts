/**
 * 1 枚だけ投稿を差し替えるときの合成（タイムライン・詳細・検索で同じ形にする）。
 *
 * アンケートは「自分がどの選択肢に入れたか（`me`）」が**利用者ごとに違う**。
 * 他のサーバーで入った票の更新（`poll_updated`）は全員へ同じ内容で配るので
 * `me` を持てず、そのまま被せると自分の印が消えて投票前の見た目に戻ってしまう。
 * ここで選択肢のテキストを手がかりに引き継ぐ（票数は新しい方をそのまま使う）。
 */
import type { Post } from './format';

export function withPostPatch(post: Post, patch: Partial<Post>): Post {
  if (!patch.poll || !post.poll) return { ...post, ...patch };

  const mine = new Set(
    (post.poll.choices || []).filter((choice) => choice.me).map((choice) => choice.text),
  );
  if (mine.size === 0) return { ...post, ...patch };

  return {
    ...post,
    ...patch,
    poll: {
      ...patch.poll,
      my_voted: true,
      choices: (patch.poll.choices || []).map((choice) =>
        mine.has(choice.text) ? { ...choice, me: true } : choice,
      ),
    },
  };
}
