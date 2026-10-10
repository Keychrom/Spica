/**
 * タイムライン（ホーム / ローカル / 連合 / タグ）。
 * ・画面名は選んでいるタブに追従する（タグページのときはタグ名）
 * ・取得と操作は useTimeline、描画は PostList に任せる（この画面は組み立てだけ）
 */
import { useEffect, useState, type ReactNode } from 'react';
import ScreenHead, { type ScreenTab } from '../components/ScreenHead';
import PostList from '../components/PostList';
import { useTimeline } from '../lib/useTimeline';
import { navigate } from '../lib/router';
import type { Post } from '../lib/format';

const TABS: ScreenTab[] = [
  { value: 'home', label: 'ホーム' },
  { value: 'local', label: 'ローカル' },
  { value: 'all', label: '連合' },
];

interface HomeViewProps {
  menuButton: ReactNode;
  onCompose: () => void;
  onReply: (post: Post) => void;
  onQuote: (post: Post) => void;
  signedIn: boolean;
  /** タグページ（/tags/:tag）のときだけ渡す */
  tag?: string;
  /**
   * URL の `?mode=`（無ければホーム）。**選択を URL に載せる**のは、ナビの「ホーム」を
   * 押したときに確実に戻れるようにするため（画面の中だけで持つと、`/` へ移動しても
   * URL が変わらず、連合を選んだまま何も起きない）
   */
  mode?: string;
  /** 設定で選んだ既定のタブ（ホーム / ローカル / 連合） */
  defaultMode?: string;
  /** はじめての設定がまだか（済んでいれば出さない） */
  onboardingPending?: boolean;
  myId?: string;
  canModerate?: boolean;
}

export default function HomeView({
  menuButton,
  onCompose,
  onReply,
  onQuote,
  signedIn,
  tag,
  mode: modeProp,
  defaultMode,
  onboardingPending,
  myId,
  canModerate,
}: HomeViewProps) {
  /** 選べる値だけを受け付ける（URL に変な値が入っていても既定へ落とす） */
  const pick = (value?: string) => (value && TABS.some((tab) => tab.value === value) ? value : undefined);
  const mode = pick(modeProp) ?? pick(defaultMode) ?? 'home';

  /**
   * タブを選ぶ = URL を書き換える（画面の中だけで持たない）。**ホームも明示する**
   * （`/?mode=home`）。「指定が無ければ既定のタブ」に頼ると、既定を ローカル にしたときに
   * ホームの状態が URL から読めず、ナビの「ホーム」や戻るで辻褄が合わなくなる。
   *
   * 指定なしの `/` は「設定の既定のタブ」のまま（ブックマークや初回の入口）。
   */
  const goToMode = (value: string) => navigate('/?mode=' + encodeURIComponent(value));

  // キーボードショートカット（g h / g l / g f）から切り替える
  useEffect(() => {
    const onModeEvent = (event: Event) => {
      const next = (event as CustomEvent<{ mode?: string }>).detail?.mode;
      if (next && TABS.some((tab) => tab.value === next)) goToMode(next);
    };
    window.addEventListener('spica:timeline-mode', onModeEvent);
    return () => window.removeEventListener('spica:timeline-mode', onModeEvent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [nudge, setNudge] = useState(() => !window.localStorage.getItem('spica_onboarding_done'));

  const path = tag
    ? '/api/timeline?mode=tag&tag=' + encodeURIComponent(tag)
    : '/api/timeline?mode=' + encodeURIComponent(mode);
  const timeline = useTimeline(path, signedIn);

  const title = tag ? '#' + tag : TABS.find((t) => t.value === mode)?.label ?? 'ホーム';

  const empty = tag ? (
    <>
      #{tag} のノートはまだありません。
      <br />
      <button type="button" className="btn btn--text" onClick={() => navigate('/')}>
        タイムラインへ戻る
      </button>
    </>
  ) : signedIn ? (
    <>
      まだノートがありません。
      <button type="button" className="btn btn--text" onClick={onCompose}>
        最初のノートを書く
      </button>
    </>
  ) : (
    <>
      ログインすると、フォロー中のノートがここに並びます。
      <br />
      <button type="button" className="btn btn--text" onClick={() => navigate('/login')}>
        ログイン / 新規登録
      </button>
    </>
  );

  return (
    <>
      <ScreenHead
        title={title}
        sub={
          timeline.loading
            ? '読み込み中…'
            : `${timeline.posts.length}件を表示中`
        }
        tabs={TABS}
        activeTab={tag ? '' : mode}
        onTab={(value) => {
          // 選択は URL に載せる（goToMode）。タグページから押したらタイムラインに戻る
          goToMode(value);
          window.scrollTo({ top: 0 });
        }}
        newCount={timeline.newCount}
        onShowNew={() => {
          timeline.clearNewCount();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
        onReload={() => void timeline.reload({ keepScroll: true })}
        reloading={timeline.loading}
        menuButton={menuButton}
      />
      <div className="divider" />

      {signedIn && onboardingPending && nudge && (
        <div className="nudge">
          <span className="nudge__body">
            <b>はじめての設定がまだです</b>
            <span>見た目とプロフィールを 1 分で整えられます。</span>
          </span>
          <button type="button" className="btn btn--outline" onClick={() => navigate('/onboarding')}>
            はじめる
          </button>
          <button
            type="button"
            className="btn btn--text"
            onClick={() => {
              window.localStorage.setItem('spica_onboarding_done', '1');
              setNudge(false);
            }}
          >
            あとで
          </button>
        </div>
      )}

      <PostList
        timeline={timeline}
        signedIn={signedIn}
        myId={myId}
        canModerate={canModerate}
        onReply={onReply}
        onQuote={onQuote}
        empty={empty}
        showSignInHint
        onSignIn={() => navigate('/login')}
      />
    </>
  );
}
