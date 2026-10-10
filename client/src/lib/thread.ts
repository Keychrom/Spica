/**
 * 会話の続きをタイムライン上で分かるようにする（純関数）。
 *
 * 1) 親が上・返信が下になるように並べ替える（隣り合った組だけ）。
 *    タイムラインは新しい順なので、放っておくと返信が親より上に来て、どちらが親か分からない。
 * 2) 親のすぐ下に来ている返信に印を付ける（線を描くため）。
 *    - railTop   : 自分の1つ上が返信先（= 自分は子。上とつながる）
 *    - railBottom: 自分の1つ下が自分への返信（= 自分は親。下へつながる）
 *
 * 3) 返信には「@user@domain への返信」の行き先を添える（押すと親を開ける）。
 */
import type { Post } from './format';
import { postPath } from './permalink';

export interface ThreadEntry {
  post: Post;
  /** 上の投稿とつながっている（自分は返信） */
  railTop: boolean;
  /** 下の投稿とつながっている（自分は親） */
  railBottom: boolean;
  /** 返信先（表示用の文言と行き先） */
  replyTo: { label: string; href: string } | null;
}

/**
 * 返信先の正規 ID（URL）から、読める形の案内を作る。
 *   - `…/users/<user>/posts/<id>` / `…/users/<user>/statuses/<id>` → `@user@domain への返信`
 *   - ユーザー名を含まない形（Misskey など `…/notes/<id>`）→ `domain の投稿への返信`
 */
export function describeReplyTarget(canonicalId: string): { label: string; href: string } {
  const href = postPath({ id: canonicalId });
  try {
    const parsed = new URL(canonicalId);
    const match = parsed.pathname.match(/^\/users\/([^/]+)\/(?:posts|statuses)\/([^/]+)/);
    if (match) {
      return { label: `@${decodeURIComponent(match[1])}@${parsed.host} への返信`, href };
    }
    return { label: `${parsed.host} の投稿への返信`, href };
  } catch {
    return { label: '返信', href };
  }
}

/** 並べ替えと印付けをまとめて行う（並びは元の配列を壊さない） */
export function groupThreads(posts: Post[]): ThreadEntry[] {
  const ordered: Post[] = [];
  for (let i = 0; i < posts.length; i += 1) {
    const current = posts[i];
    const next = posts[i + 1];
    // 「返信が上・親が下」の並びだけを入れ替える（親を先に出す）
    if (next && current.in_reply_to && current.in_reply_to === next.id) {
      ordered.push(next, current);
      i += 1;
      continue;
    }
    ordered.push(current);
  }

  return ordered.map((post, index) => {
    const prev = index > 0 ? ordered[index - 1] : null;
    const next = index < ordered.length - 1 ? ordered[index + 1] : null;
    const railTop = Boolean(prev?.id && post.in_reply_to && post.in_reply_to === prev.id);
    const railBottom = Boolean(next?.in_reply_to && next.in_reply_to === post.id);
    return {
      post,
      railTop,
      railBottom,
      replyTo: post.in_reply_to ? describeReplyTarget(post.in_reply_to) : null,
    };
  });
}
