/**
 * URL → 画面の割り当て。
 * App はシェル（セッション・テーマ・ドロワー・コンポーザ）だけを持ち、
 * どの URL でどの画面を出すかはこのファイルだけが知っている。
 */
import type { ReactNode } from 'react';
import HomeView from './views/HomeView';
import NotificationsView from './views/NotificationsView';
import SearchView from './views/SearchView';
import CollectionView, { type CollectionKind } from './views/CollectionView';
import DriveView from './views/DriveView';
import MessagesView from './views/MessagesView';
import ProfileView from './views/ProfileView';
import PostScreen from './views/PostScreen';
import SettingsView from './views/SettingsView';
import OnboardingView from './views/OnboardingView';
import DraftsView from './views/DraftsView';
import AdminView from './views/AdminView';
import PlaceholderView from './views/PlaceholderView';
import { navigate } from './lib/router';
import { canModerate } from './lib/nav';
import type { Post, ServerInfo, SessionUser } from './lib/format';
import type { Prefs } from './lib/settings';
import type { ThemeChoice } from './lib/theme';

/** 仮の画面はもう無い（この表は空。当たらない URL は下の 404 案内になる） */
const PLACEHOLDERS: Record<string, { title: string; phase: string; note: string }> = {};

/** 「集めたノートを読む」画面（1 つの画面で兼ねる） */
const COLLECTIONS: CollectionKind[] = ['bookmarks', 'lists', 'antennas', 'channels'];

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** ?key=value を 1 つ取り出す */
function queryValue(path: string, key: string): string | undefined {
  const query = path.split('?')[1];
  if (!query) return undefined;
  const value = new URLSearchParams(query).get(key);
  return value || undefined;
}

interface RoutesProps {
  path: string;
  menuButton: ReactNode;
  signedIn: boolean;
  /** ログイン中の人（プロフィールや設定の初期値に使う） */
  user: SessionUser | null;
  /** サーバー情報（登録の出し分けにも使う） */
  server: ServerInfo | null;
  /** サーバーで DM が有効か */
  dmEnabled: boolean;
  /** サーバー情報が読めたか */
  serverLoaded: boolean;
  /** アカウントに保存した表示の好み */
  prefs: Prefs;
  onCompose: () => void;
  onReply: (post: Post) => void;
  onQuote: (post: Post) => void;
  /** 通知などから相手のプロフィールへ */
  onOpenProfile: (userId: string) => void;
  /** 未読を既読にしたあと、バッジを更新してもらう */
  onRead: () => void;
  onLogout: () => void;
  onPrefsChange: (prefs: Prefs) => void;
  /** テーマ（初回設定で選び直せるように） */
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  /** オンボーディングを終えたとき（セッションを取り直す） */
  onOnboarded: () => void;
  /** 下書きの続きを書く（コンポーザを中身つきで開く） */
  onResumeDraft: (draft: { id: string; content: string; cw?: string }) => void;
}

export default function Routes({
  path,
  menuButton,
  signedIn,
  user,
  server,
  dmEnabled,
  serverLoaded,
  prefs,
  onCompose,
  onReply,
  onQuote,
  onOpenProfile,
  onRead,
  onLogout,
  onPrefsChange,
  theme,
  onTheme,
  onOnboarded,
  onResumeDraft,
}: RoutesProps) {
  // クエリ・ハッシュを外した「場所」だけを見る
  const pathOnly = path.split(/[?#]/)[0];

  if (pathOnly === '/' || pathOnly.startsWith('/tags/')) {
    // リモートのノートは `/?post=<正規 ID>` で共有される（サーバーの案内がそうなっている）
    if (queryValue(path, 'post')) {
      return (
        <PostScreen
          menuButton={menuButton}
          signedIn={signedIn}
          user={user}
          canonicalId={decodePart(String(queryValue(path, 'post')))}
          onReply={onReply}
          onQuote={onQuote}
        />
      );
    }
    const tag = pathOnly.startsWith('/tags/') ? decodePart(pathOnly.slice('/tags/'.length)) : undefined;
    return (
      <HomeView
        menuButton={menuButton}
        signedIn={signedIn}
        tag={tag}
        mode={queryValue(path, 'mode')}
        defaultMode={prefs.defaultTimeline}
        onboardingPending={user?.onboarding_completed === 0}
        myId={user?.id}
        canModerate={canModerate(user?.role)}
        onCompose={onCompose}
        onReply={onReply}
        onQuote={onQuote}
      />
    );
  }

  if (pathOnly === '/notifications') {
    return (
      <NotificationsView
        menuButton={menuButton}
        signedIn={signedIn}
        onRead={onRead}
        onOpenProfile={onOpenProfile}
      />
    );
  }

  if (pathOnly === '/search') {
    return (
      <SearchView
        menuButton={menuButton}
        signedIn={signedIn}
        myId={user?.id}
        canModerate={canModerate(user?.role)}
        query={queryValue(path, 'q') ?? ''}
        onReply={onReply}
        onQuote={onQuote}
      />
    );
  }

  if (pathOnly === '/messages') {
    return (
      <MessagesView
        menuButton={menuButton}
        signedIn={signedIn}
        dmEnabled={dmEnabled}
        loaded={serverLoaded}
        to={queryValue(path, 'to')}
      />
    );
  }

  if (pathOnly === '/settings') {
    return (
      <SettingsView
        menuButton={menuButton}
        signedIn={signedIn}
        me={
          user
            ? {
                id: user.id,
                email: user.email ?? '',
                emailVerified: Boolean(user.email_verified),
                hasPassword: Boolean(user.hasPassword),
              }
            : null
        }
        initialSection={queryValue(path, 'section')}
        theme={theme}
        onTheme={onTheme}
        onLogout={onLogout}
        onPrefsChange={onPrefsChange}
      />
    );
  }

  if (pathOnly === '/onboarding') {
    return (
      <OnboardingView
        menuButton={menuButton}
        user={user}
        theme={theme}
        onTheme={onTheme}
        prefs={prefs}
        onPrefsChange={onPrefsChange}
        onCompose={onCompose}
        onFinished={onOnboarded}
      />
    );
  }

  // /users/:user/posts/:postId（通知や検索から飛ぶ先）
  if (pathOnly.startsWith('/users/')) {
    const rest = pathOnly.slice('/users/'.length);
    const postsAt = rest.indexOf('/posts/');
    if (postsAt > 0) {
      return (
        <PostScreen
          menuButton={menuButton}
          signedIn={signedIn}
          user={user}
          fromPath={{
            author: decodePart(rest.slice(0, postsAt)),
            postPathId: decodePart(rest.slice(postsAt + '/posts/'.length)),
          }}
          onReply={onReply}
          onQuote={onQuote}
        />
      );
    }
    return (
      <ProfileView
        menuButton={menuButton}
        signedIn={signedIn}
        myId={user?.id}
        identifier={decodePart(rest)}
        initialTab={queryValue(path, 'tab')}
        onReply={onReply}
        onQuote={onQuote}
        onOpenSettings={() => navigate('/settings?section=profile')}
      />
    );
  }

  const collection = COLLECTIONS.find(
    (kind) => pathOnly === '/' + kind || pathOnly.startsWith('/' + kind + '/'),
  );
  if (collection) {
    const rest = pathOnly.slice(collection.length + 1).replace(/^\//, '');
    return (
      <CollectionView
        kind={collection}
        menuButton={menuButton}
        signedIn={signedIn}
        myId={user?.id}
        canModerate={canModerate(user?.role)}
        selectedId={rest ? decodePart(rest) : undefined}
        onReply={onReply}
        onQuote={onQuote}
      />
    );
  }

  if (pathOnly === '/drive') {
    return <DriveView menuButton={menuButton} signedIn={signedIn} />;
  }

  if (pathOnly === '/drafts') {
    return <DraftsView menuButton={menuButton} signedIn={signedIn} onResume={onResumeDraft} />;
  }

  if (pathOnly === '/admin') {
    return (
      <AdminView
        menuButton={menuButton}
        signedIn={signedIn}
        myId={user?.id}
        allowed={canModerate(user?.role)}
      />
    );
  }

  const placeholderKey = Object.keys(PLACEHOLDERS).find((key) => pathOnly.startsWith(key));
  if (placeholderKey) {
    const info = PLACEHOLDERS[placeholderKey];
    return (
      <PlaceholderView title={info.title} phase={info.phase} note={info.note} menuButton={menuButton} />
    );
  }

  return (
    <PlaceholderView
      title="見つかりません"
      phase="404"
      note={`${pathOnly} に対応する画面はまだありません。`}
      menuButton={menuButton}
    />
  );
}
