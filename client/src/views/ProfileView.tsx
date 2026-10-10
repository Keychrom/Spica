/**
 * プロフィール（/users/:id）。
 * 見出し（ProfileHeader）＋ タブ（ノート / メディア / フォロー / フォロワー）。
 * 取得は lib/profile.ts に任せ、ここは状態と組み立てだけ。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import ScreenHead, { type ScreenTab } from '../components/ScreenHead';
import PostCard from '../components/PostCard';
import ProfileHeader from '../components/ProfileHeader';
import PeopleList from '../components/PeopleList';
import PostCalendar from '../components/PostCalendar';
import { useTimeline } from '../lib/useTimeline';
import { navigate } from '../lib/router';
import { reactToPost, renotePost, sharePost, toggleBookmark } from '../lib/postActions';
import { postPath } from '../lib/permalink';
import {
  flipFollow,
  follow,
  loadPeople,
  loadProfile,
  setRelation,
  unfollow,
  type Person,
  type Profile,
} from '../lib/profile';
import { isImageMedia, mediaThumb, type Post } from '../lib/format';

const TABS: ScreenTab[] = [
  { value: 'posts', label: 'ノート' },
  { value: 'media', label: 'メディア' },
  { value: 'following', label: 'フォロー' },
  { value: 'followers', label: 'フォロワー' },
];

interface ProfileViewProps {
  menuButton: ReactNode;
  signedIn: boolean;
  /** 自分のユーザー ID（自分のプロフィールかの判定に使う） */
  myId?: string;
  identifier: string;
  /** URL の ?tab= から */
  initialTab?: string;
  onReply: (post: Post) => void;
  onQuote: (post: Post) => void;
  onOpenSettings: () => void;
}

export default function ProfileView({
  menuButton,
  signedIn,
  myId,
  identifier,
  initialTab,
  onReply,
  onQuote,
  onOpenSettings,
}: ProfileViewProps) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(initialTab && TABS.some((t) => t.value === initialTab) ? initialTab : 'posts');
  const [people, setPeople] = useState<Person[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);

  // ノート（この画面の主役。返信やリアクションは共通の仕組みで反映する）
  const timeline = useTimeline(
    profile && (tab === 'posts' || tab === 'media')
      ? '/api/users/' + encodeURIComponent(identifier) + '/posts'
      : null,
    signedIn,
  );

  const loadProfileData = useCallback(async () => {
    setLoading(true);
    const next = await loadProfile(identifier);
    setProfile(next);
    setLoading(false);
  }, [identifier]);

  useEffect(() => {
    void loadProfileData();
  }, [loadProfileData]);

  // つながりの一覧は、そのタブを開いたときに読む
  useEffect(() => {
    if (tab !== 'followers' && tab !== 'following') return;
    let alive = true;
    setPeopleLoading(true);
    void (async () => {
      const list = await loadPeople(tab, identifier.replace(/^@/, ''));
      if (!alive) return;
      setPeople(list);
      setPeopleLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [tab, identifier]);

  const isMe = Boolean(myId && profile && profile.id === myId);

  async function onFollowClick() {
    if (!profile || busy) return;
    setBusy(true);
    const handle = profile.handle.startsWith('@') ? profile.handle : '@' + profile.handle;
    const ok = profile.is_following ? await unfollow(handle) : await follow(handle);
    if (ok) setProfile((current) => (current ? flipFollow(current) : current));
    setBusy(false);
  }

  async function onRelation(action: 'mute' | 'unmute' | 'block' | 'unblock') {
    if (!profile) return;
    const ok = await setRelation(identifier, action);
    if (!ok) return;
    setProfile((current) => {
      if (!current) return current;
      if (action === 'mute') return { ...current, is_muted: true };
      if (action === 'unmute') return { ...current, is_muted: false };
      if (action === 'block') return { ...current, is_blocked: true, is_following: false };
      return { ...current, is_blocked: false };
    });
  }

  const posts = timeline.posts;
  const mediaPosts = posts.filter((post) => (post.media_attachments || post.attachments || []).length > 0);
  const showMedia = tab === 'media';
  const visible = showMedia ? mediaPosts : posts;

  const actions = (post: Post) => ({
    onReact: (p: Post, reaction: string) => void timeline.react(p, reaction),
    onBookmark: (p: Post) => void timeline.bookmark(p),
    onRenote: (p: Post) => void timeline.renote(p),
    onReply,
    onQuote,
    onShare: sharePost,
  });

  const title = profile ? profile.name : identifier;

  return (
    <>
      <ScreenHead
        title={profile ? `@${profile.id}` : `@${identifier}`}
        sub={loading ? '読み込み中…' : profile ? title : '見つかりません'}
        menuButton={menuButton}
        onReload={tab === 'posts' || tab === 'media' ? () => void timeline.reload({ keepScroll: true }) : undefined}
        reloading={timeline.loading}
      />
      <div className="divider" />

      {!loading && !profile && (
        <div className="feed">
          <div className="feed__state">
            この人は見つかりませんでした。
            <br />
            <button type="button" className="btn btn--text" onClick={() => navigate('/')}>
              タイムラインへ戻る
            </button>
          </div>
        </div>
      )}

      {profile && (
        <>
          <ProfileHeader
            profile={profile}
            isMe={isMe}
            signedIn={signedIn}
            busy={busy}
            onFollow={() => void onFollowClick()}
            onRelation={(action) => void onRelation(action)}
            onOpenPeople={(kind) => setTab(kind)}
            onEdit={onOpenSettings}
          />

          {isMe && tab === 'posts' && <PostCalendar />}

          {(profile.pinned_posts || []).length > 0 && tab === 'posts' && (
            <div className="feed">
              <h2 className="plain__title">ピン留め</h2>
              {(profile.pinned_posts || []).map((post) => (
                <PostCard
                  key={'pin-' + post.id}
                  post={post}
                  {...actions(post)}
                  signedIn={signedIn}
                  myId={myId}
                />
              ))}
            </div>
          )}

          {profile.is_blocked && (
            <div className="feed">
              <div className="feed__state">この人をブロックしています。ノートは表示されません。</div>
            </div>
          )}

          {!profile.is_blocked && (
            <>
              <div className="headrow">
                <div className="seg">
                  {TABS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={'seg__t' + (tab === item.value ? ' seg__t--on' : '')}
                      onClick={() => setTab(item.value)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="divider" />

              {tab === 'followers' || tab === 'following' ? (
                <div className="feed">
                  <PeopleList
                    people={people}
                    loading={peopleLoading}
                    empty={tab === 'followers' ? 'まだフォロワーはいません。' : 'まだ誰もフォローしていません。'}
                  />
                </div>
              ) : showMedia ? (
                <>
                  {!timeline.loading && mediaPosts.length === 0 && (
                    <div className="feed">
                      <div className="feed__state">メディアつきのノートはまだありません。</div>
                    </div>
                  )}
                  <div className="mediagrid">
                    {mediaPosts.map((post) => {
                      // 画像だけを並べる（音声・動画の URL を <img> にすると壊れて見える）
                      const media = (post.media_attachments || post.attachments || []).find(isImageMedia);
                      const thumb = media ? mediaThumb(media) : '';
                      if (!thumb) return null;
                      return (
                        <a
                          key={post.id}
                          href={postPath(post)}
                          title={post.content?.slice(0, 80)}
                        >
                          <img src={thumb} alt="" loading="lazy" />
                        </a>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="feed">
                  {timeline.loading && posts.length === 0 && <div className="feed__state">読み込んでいます…</div>}
                  {!timeline.loading && posts.length === 0 && <div className="feed__state">まだノートがありません。</div>}
                  {posts.map((post) => (
                    <PostCard key={post.id} post={post} {...actions(post)} signedIn={signedIn} myId={myId} />
                  ))}
                  {timeline.cursor && posts.length > 0 && (
                    <div className="feed__more">
                      <button type="button" onClick={() => void timeline.loadMore()} disabled={timeline.loadingMore}>
                        {timeline.loadingMore ? '読み込んでいます…' : '過去のノートを読み込む'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {!signedIn && (
                <div className="feed">
                  <div className="feed__state" style={{ paddingTop: 18 }}>
                    ログインすると、フォローやリアクションが使えます。
                    <br />
                    <button type="button" className="btn btn--text" onClick={() => navigate('/login')}>
                      ログイン / 新規登録
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
