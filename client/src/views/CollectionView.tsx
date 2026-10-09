/**
 * ブックマーク / リスト / アンテナ / チャンネルの 1 画面。
 * 「集めたノートを読む」画面はどれも同じ形なので、1 つにまとめている。
 *   kind: bookmarks（一覧だけ） / lists / antennas / channels（一覧 + 選択したもののタイムライン）
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import ScreenHead from '../components/ScreenHead';
import CollectionEditor from '../components/CollectionEditor';
import PostList from '../components/PostList';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { useTimeline } from '../lib/useTimeline';
import type { Post } from '../lib/format';

export type CollectionKind = 'bookmarks' | 'lists' | 'antennas' | 'channels';

const META: Record<CollectionKind, { title: string; empty: ReactNode; note?: string }> = {
  bookmarks: {
    title: 'ブックマーク',
    empty: (
      <>
        保存したノートはまだありません。
        <br />
        ノートの右下のしおりから保存できます。
      </>
    ),
  },
  lists: {
    title: 'リスト',
    empty: <>このリストにはまだノートがありません。</>,
  },
  antennas: {
    title: 'アンテナ',
    empty: <>このアンテナに合うノートはまだありません。</>,
  },
  channels: {
    title: 'チャンネル',
    empty: <>このチャンネルにはまだノートがありません。</>,
  },
};

interface CollectionItem {
  id: string;
  members?: { id: string; member: string; display_name?: string }[];
  name?: string;
  /** アンテナは文字列（カンマ区切り）、リストは配列で来ることがある */
  keywords?: string | string[];
  description?: string;
  followers_count?: number;
  posts_count?: number;
}

/** チップに出す補足（アンテナの条件など）。形が違っても落ちないようにする */
function itemNote(item: CollectionItem): string | undefined {
  if (Array.isArray(item.keywords)) return item.keywords.join(' / ') || undefined;
  if (typeof item.keywords === 'string' && item.keywords.trim()) return item.keywords.trim();
  return item.description || undefined;
}

interface CollectionViewProps {
  kind: CollectionKind;
  menuButton: ReactNode;
  signedIn: boolean;
  onReply: (post: Post) => void;
  onQuote: (post: Post) => void;
  /** URL から来た選択（/lists/:id など） */
  selectedId?: string;
  myId?: string;
  canModerate?: boolean;
}

export default function CollectionView({
  kind,
  menuButton,
  signedIn,
  onReply,
  onQuote,
  selectedId,
  myId,
  canModerate,
}: CollectionViewProps) {
  const meta = META[kind];
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(selectedId);
  const [loadingItems, setLoadingItems] = useState(kind !== 'bookmarks');
  /** 作成・編集の画面（'new' なら新規） */
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const [version, setVersion] = useState(0);

  // 一覧（リスト / アンテナ / チャンネル）
  useEffect(() => {
    if (kind === 'bookmarks') return;
    if (!signedIn && kind !== 'channels') {
      setLoadingItems(false);
      return;
    }
    let alive = true;
    void (async () => {
      const res = await api.get('/api/' + kind, { auth: kind !== 'channels' });
      if (!alive) return;
      if (res.ok && Array.isArray(res.data)) {
        const list = res.data as CollectionItem[];
        setItems(list);
        // 選択が無ければ先頭を開く（URL 指定があればそれを使う）
        setActiveId((current) => current ?? selectedId ?? list[0]?.id);
      }
      setLoadingItems(false);
    })();
    return () => {
      alive = false;
    };
  }, [kind, signedIn, selectedId, version]);

  const timelinePath =
    kind === 'bookmarks'
      ? '/api/bookmarks'
      : activeId
        ? '/api/' + kind + '/' + encodeURIComponent(activeId) + '/timeline'
        : null;
  const timeline = useTimeline(timelinePath, signedIn);

  const select = useCallback(
    (id: string) => {
      setActiveId(id);
      if (kind !== 'bookmarks') navigate('/' + kind + '/' + encodeURIComponent(id), { keepScroll: true });
    },
    [kind],
  );

  const active = items.find((item) => item.id === activeId);

  return (
    <>
      <ScreenHead
        title={meta.title}
        sub={
          timeline.loading
            ? '読み込み中…'
            : timeline.posts.length > 0
              ? `${timeline.posts.length}件を表示中`
              : active?.name
        }
        menuButton={menuButton}
      />
      <div className="divider" />

      {kind !== 'bookmarks' && (
        <div className="picker">
          {loadingItems && <span className="picker__state">読み込んでいます…</span>}
          {!loadingItems && items.length === 0 && (
            <span className="picker__state">
              {kind === 'channels'
                ? 'チャンネルはまだありません。'
                : signedIn
                  ? 'まだありません。右上の「＋ 作る」から作れます。'
                  : 'ログインすると使えます。'}
            </span>
          )}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`tg${item.id === activeId ? ' tg--on' : ''}`}
              onClick={() => select(item.id)}
              title={itemNote(item)}
            >
              {item.name || item.id}
            </button>
          ))}
          {signedIn && (
            <>
              <button type="button" className="tg" onClick={() => setEditing('new')}>
                ＋ 作る
              </button>
              {activeId && (
                <button type="button" className="tg" onClick={() => setEditing(activeId)}>
                  編集
                </button>
              )}
            </>
          )}
        </div>
      )}

      {!signedIn && kind === 'bookmarks' && (
        <div className="feed">
          <div className="feed__state">
            ブックマークを見るにはログインしてください。
            <br />
            <button type="button" className="btn btn--text" onClick={() => navigate('/login')}>
              ログイン / 新規登録
            </button>
          </div>
        </div>
      )}

      {signedIn && timelinePath && (
        <PostList
          timeline={timeline}
          signedIn={signedIn}
          myId={myId}
          canModerate={canModerate}
          onReply={onReply}
          onQuote={onQuote}
          empty={meta.empty}
        />
      )}

      {editing && (
        <CollectionEditor
          kind={kind}
          item={editing === 'new' ? undefined : items.find((item) => item.id === editing) || { id: editing }}
          onClose={() => setEditing(null)}
          onSaved={() => setVersion((current) => current + 1)}
        />
      )}

      {signedIn && !timelinePath && !loadingItems && (
        <div className="feed">
          <div className="feed__state">{meta.empty}</div>
        </div>
      )}
    </>
  );
}
