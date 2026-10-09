/**
 * 投稿への操作（リアクション / ブックマーク / リノート / 共有 / 編集 / 削除 / 通報 / ピン留め / 投票）。
 * タイムラインでも検索結果でも同じ関数を使う（二重に書かない）。
 *
 * 画面をまたいで 1 枚だけ直したいときは窓の合図（spica:post-updated / spica:post-removed）で伝える。
 * 受け取る側は useTimeline・PostDetailView・SearchView。
 */
import { api, messageOf } from './api';
import { getPrefs, updatePrefs } from './prefs';
import { postPermalink } from './permalink';
import type { Post, PostReaction } from './format';

function announceUpdated(postId: string, patch: Partial<Post>): void {
  window.dispatchEvent(new CustomEvent('spica:post-updated', { detail: { postId, patch } }));
}

function announceRemoved(postId: string): void {
  window.dispatchEvent(new CustomEvent('spica:post-removed', { detail: { postId } }));
}

/** リアクションを付ける / 外す。成功したら新しい内訳を返す */
export async function reactToPost(post: Post, reaction: string): Promise<PostReaction[] | null> {
  const res = await api.post('/api/posts/' + encodeURIComponent(post.id) + '/react', { reaction });
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  const data = res.data as { reactions?: PostReaction[]; added?: boolean };
  // 付けたものは「よく使うリアクション」の先頭へ（設定に保存。最大 12）
  if (data.added) {
    const current = getPrefs().recentReactions ?? [];
    if (current[0] !== reaction) {
      void updatePrefs({
        recentReactions: [reaction, ...current.filter((item) => item !== reaction)].slice(0, 12),
      });
    }
  }
  return data.reactions ?? null;
}

/** ブックマークの切り替え。成功したら新しい状態を返す */
export async function toggleBookmark(post: Post): Promise<boolean | null> {
  const res = await api.post('/api/bookmarks/toggle', { postId: post.id });
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  const data = res.data as { bookmarked?: boolean };
  return typeof data.bookmarked === 'boolean' ? data.bookmarked : !post.bookmarked;
}

/** リノート */
export async function renotePost(post: Post): Promise<boolean> {
  const res = await api.post('/api/posts/' + encodeURIComponent(post.id) + '/announce');
  return res.ok;
}

/** 共有 = パーマリンクをコピー（ローカルはサーバーが OGP を返す正規 URL、リモートは `/?post=`） */
export function sharePost(post: Post): void {
  void navigator.clipboard?.writeText(postPermalink(post));
}

/** 本文と CW の編集（公開範囲・添付は変えられない）。失敗したら理由を返す */
export async function editPost(post: Post, content: string, cw: string): Promise<string | null> {
  const res = await api.put('/api/posts/' + encodeURIComponent(post.id), {
    content,
    cw: cw.trim() ? cw : null,
  });
  if (!res.ok) return messageOf(res.data, '編集できませんでした。');
  announceUpdated(post.id, { content, cw: cw.trim() ? cw : null } as Partial<Post>);
  return null;
}

/** 削除（自分のローカル投稿だけ）。失敗したら理由を返す */
export async function deletePost(post: Post): Promise<string | null> {
  const res = await api.del('/api/posts/' + encodeURIComponent(post.id));
  if (!res.ok) return messageOf(res.data, '削除できませんでした。');
  announceRemoved(post.id);
  return null;
}

/** ピン留めの切り替え。成功したら新しい状態を返す */
export async function togglePin(post: Post): Promise<boolean | null> {
  const res = await api.post('/api/posts/pin/toggle', { postId: post.id });
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  const data = res.data as { success?: boolean; pinned?: boolean };
  if (!data.success || typeof data.pinned !== 'boolean') return null;
  announceUpdated(post.id, { is_pinned: data.pinned } as Partial<Post>);
  return data.pinned;
}

/** 通報の理由（サーバーは自由文。旧画面と同じ 5 つを出す） */
export const REPORT_REASONS: { value: string; label: string }[] = [
  { value: 'spam', label: 'スパム' },
  { value: 'abuse', label: '嫌がらせ・誹謗中傷' },
  { value: 'sensitive', label: '不適切な内容' },
  { value: 'impersonation', label: 'なりすまし' },
  { value: 'other', label: 'その他' },
];

/** 投稿または人を通報する */
export async function reportTarget(target: {
  postId?: string;
  userId?: string;
  category: string;
  comment?: string;
}): Promise<string | null> {
  const res = await api.post('/api/reports', {
    ...(target.postId ? { targetPostId: target.postId } : {}),
    ...(target.userId ? { targetUserId: target.userId } : {}),
    category: target.category,
    comment: target.comment || '',
  });
  if (!res.ok) return messageOf(res.data, '通報できませんでした。');
  return null;
}

/** アンケートに投票する。成功したら新しい状態を返す */
export async function votePoll(post: Post, choices: number[]): Promise<unknown | null> {
  const res = await api.post('/api/posts/' + encodeURIComponent(post.id) + '/poll/vote', { choices });
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  const data = res.data as { poll?: unknown };
  if (!data.poll) return null;
  announceUpdated(post.id, { poll: data.poll } as Partial<Post>);
  return data.poll;
}
