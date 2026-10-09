/**
 * 見つける（検索）。
 * ・検索は q をそのまま API に渡す（from: / before: / has:media などの演算子も使える）
 * ・結果は「ユーザー」と「ノート」に分けて出す
 * ・まだ何も打っていないときは、話題のタグを入口として出す
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import ScreenHead from '../components/ScreenHead';
import PostCard from '../components/PostCard';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { formatCount, type DirectoryUser, type Post, type TagCount } from '../lib/format';
import { reactToPost, sharePost, toggleBookmark } from '../lib/postActions';

interface SearchViewProps {
  menuButton: ReactNode;
  onReply: (post: Post) => void;
  onQuote: (post: Post) => void;
  signedIn: boolean;
  /** ログイン中の人（自分のノートに編集・削除を出す） */
  myId?: string;
  canModerate?: boolean;
  /** /search?q=... の q */
  query: string;
}

export default function SearchView({
  menuButton,
  onReply,
  onQuote,
  signedIn,
  myId,
  canModerate,
  query,
}: SearchViewProps) {
  const [input, setInput] = useState(query);
  const [posts, setPosts] = useState<Post[]>([]);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  // URL の q が変わったら、それで検索する
  useEffect(() => {
    setInput(query);
    if (!query.trim()) {
      setPosts([]);
      setUsers([]);
      setSearched(false);
      return;
    }
    let alive = true;
    setLoading(true);
    void (async () => {
      const res = await api.get('/api/search?q=' + encodeURIComponent(query.trim()), { auth: signedIn });
      if (!alive) return;
      if (res.ok && res.data && typeof res.data === 'object') {
        const data = res.data as { posts?: Post[]; users?: DirectoryUser[] };
        setPosts(data.posts ?? []);
        setUsers(data.users ?? []);
      }
      setLoading(false);
      setSearched(true);
    })();
    return () => {
      alive = false;
    };
  }, [query, signedIn]);

  // 入口（何も打っていないとき）に話題のタグを出す
  useEffect(() => {
    void (async () => {
      const res = await api.get('/api/tags/popular', { auth: false });
      if (res.ok && Array.isArray(res.data)) setTags(res.data as TagCount[]);
    })();
  }, []);

  const runSearch = useCallback((text: string) => {
    const q = text.trim();
    navigate(q ? '/search?q=' + encodeURIComponent(q) : '/search');
  }, []);

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      runSearch(input);
    },
    [input, runSearch],
  );

  function patchPost(id: string, patch: Partial<Post>) {
    setPosts((current) => current.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  // 1 枚だけ直った / 消えたときの合図
  useEffect(() => {
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ postId: string; patch: Partial<Post> }>).detail;
      if (detail) patchPost(detail.postId, detail.patch);
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

  return (
    <>
      <ScreenHead title="見つける" sub={query ? `「${query}」の結果` : undefined} menuButton={menuButton} />
      <div className="divider" />

      <form className="searchbox" onSubmit={submit}>
        <Search size={18} strokeWidth={1.5} />
        <input
          className="searchbox__input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            // Enter で確実に検索する（環境によって暗黙の送信が効かないことがあるため）
            if (event.key === 'Enter') {
              event.preventDefault();
              runSearch(input);
            }
          }}
          placeholder="キーワード / @user@host / #タグ / from:user / has:media / before:2026-09-01"
          aria-label="検索"
        />
        <button type="submit" className="btn btn--quiet" disabled={loading}>
          {loading ? '検索中…' : '検索'}
        </button>
      </form>

      <div className="feed">
        {!searched && tags.length > 0 && (
          <section className="plain">
            <h2 className="plain__title">話題のタグ</h2>
            <div className="chips">
              {tags.slice(0, 12).map((tag) => (
                <a className="tg" key={tag.tag} href={`/tags/${encodeURIComponent(tag.tag)}`}>
                  #{tag.tag}
                  <span className="chips__count">{formatCount(tag.count)}</span>
                </a>
              ))}
            </div>
          </section>
        )}

        {searched && users.length > 0 && (
          <section className="plain">
            <h2 className="plain__title">ユーザー</h2>
            {users.slice(0, 5).map((user) => (
              <a className="card__who" key={user.id} href={`/users/${user.id}`}>
                <span className="av av--s">
                  {user.icon_url ? <img src={user.icon_url} alt="" /> : user.name.slice(0, 1)}
                </span>
                <span className="card__who-body">
                  <b>{user.name}</b>
                  <span>{user.handle}</span>
                </span>
              </a>
            ))}
          </section>
        )}

        {searched && (
          <>
            <h2 className="plain__title" style={{ paddingTop: 18 }}>
              ノート {posts.length > 0 ? `（${formatCount(posts.length)}件）` : ''}
            </h2>
            {loading && <div className="feed__state">検索しています…</div>}
            {!loading && posts.length === 0 && (
              <div className="feed__state">
                見つかりませんでした。
                <br />
                別の言葉や <code>from:</code> / <code>has:media</code> などの演算子を試してみてください。
              </div>
            )}
            {posts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                onReact={async (p, reaction) => {
                  if (!signedIn) return;
                  const reactions = await reactToPost(p, reaction);
                  if (reactions) patchPost(p.id, { reactions });
                }}
                onBookmark={async (p) => {
                  if (!signedIn) return;
                  const bookmarked = await toggleBookmark(p);
                  if (bookmarked !== null) patchPost(p.id, { bookmarked });
                }}
                onRenote={() => undefined}
                onReply={onReply}
                onQuote={onQuote}
                onShare={sharePost}
                signedIn={signedIn}
                myId={myId}
                canModerate={canModerate}
              />
            ))}
          </>
        )}
      </div>
    </>
  );
}
