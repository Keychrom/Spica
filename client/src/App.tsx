/**
 * アプリの入口。ここは「薄いシェル」だけにする（大きくしない）。
 *  ・セッション（トークン → /api/auth/me）
 *  ・テーマ
 *  ・未読件数 / サーバー情報 / おすすめ
 *  ・URL → 画面の割り当て
 * 画面の中身は views/、部品は components/、通信と整形は lib/ にある。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Layout from './components/Layout';
import Aside from './components/Aside';
import Composer from './components/Composer';
import ErrorBoundary from './components/ErrorBoundary';
import LoginView from './views/LoginView';
import RegisterView from './views/RegisterView';
import Routes from './Routes';
import LoginNotice from './components/LoginNotice';
import { api, getToken, setToken } from './lib/api';
import { navigate, useLinkInterceptor, usePath } from './lib/router';
import { applyAccent, applyTheme, getThemeChoice, setThemeChoice, watchSystemTheme, type ThemeChoice } from './lib/theme';
import { loadPrefs, type Prefs } from './lib/settings';
import { applyDisplayPrefs } from './lib/display';
import { publishPrefs, updatePrefs } from './lib/prefs';
import { useAppBadge, useLaunchParams } from './lib/usePwaActions';
import { useAsideData } from './lib/useAsideData';
import { useKeyboardShortcuts } from './lib/useKeyboardShortcuts';
import ShortcutHelp from './components/ShortcutHelp';
import MenuButton from './components/MenuButton';
import { useLiveUpdates } from './lib/useLiveUpdates';
import type { DirectoryUser, Post, SessionUser } from './lib/format';

interface ComposerTarget {
  replyTo?: Post | null;
  quoteOf?: Post | null;
  /** 下書きの続きから開くとき */
  content?: string;
  cw?: string;
  draftId?: string;
}

export default function App() {
  useLinkInterceptor();
  const path = usePath();

  const [user, setUser] = useState<SessionUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const { server, tags, directory } = useAsideData(user?.id);
  const [followed, setFollowed] = useState<Set<string>>(new Set());
  const [unread, setUnread] = useState(0);
  const [theme, setTheme] = useState<ThemeChoice>(() => getThemeChoice());
  const [composer, setComposer] = useState<ComposerTarget | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>({});

  const refreshUnread = useCallback(async () => {
    if (!getToken()) {
      setUnread(0);
      return;
    }
    const res = await api.get('/api/notifications/unread-count');
    if (!res.ok) return;
    const data = res.data as { unreadCount?: number; count?: number } | number | null;
    const count = typeof data === 'number' ? data : data?.unreadCount ?? data?.count;
    if (typeof count === 'number') setUnread(count);
  }, []);

  // 起動時: テーマ・サーバー情報・公開データ・ログイン状態
  useEffect(() => {
    applyTheme(getThemeChoice());
    applyAccent(localStorage.getItem('spica_accent') || 'indigo');
    return watchSystemTheme();
  }, []);

  useEffect(() => {
    void (async () => {
      if (!getToken()) {
        setAuthChecked(true);
        return;
      }
      const res = await api.get('/api/auth/me');
      if (res.ok && res.data && typeof res.data === 'object') {
        setUser(res.data as SessionUser);
      } else if (res.status === 401) {
        setToken(null);
      }
      setAuthChecked(true);
    })();
  }, []);

  useEffect(() => {
    void refreshUnread();
    const timer = window.setInterval(() => void refreshUnread(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshUnread, user?.id]);

  // フォロー中のハンドル（おすすめのボタンの状態に使う）
  useEffect(() => {
    if (!user) return;
    void (async () => {
      const res = await api.get('/api/following');
      if (!res.ok || !Array.isArray(res.data)) return;
      const handles = (res.data as { handle?: string }[]).map((f) => f.handle || '').filter(Boolean);
      setFollowed(new Set(handles));
    })();
  }, [user]);

  // リアルタイム更新（SSE）: ログイン中はつなぎっぱなし。通知は未読に反映する
  const live = useLiveUpdates(Boolean(user), () => void refreshUnread());

  // ホーム画面のショートカット・共有シートから開かれたとき / アイコンのバッジ
  useLaunchParams({
    onCompose: (content) => setComposer(content ? { content } : {}),
    onSearch: () => navigate('/search'),
  });
  useAppBadge(unread, Boolean(user));

  // アカウントに保存した表示の好み（文字の大きさ・行のつめ方・既定のタブ）
  useEffect(() => {
    if (!user) {
      setPrefs({});
      publishPrefs({});
      applyDisplayPrefs(null);
      return;
    }
    void (async () => {
      const loaded = await loadPrefs();
      if (loaded) {
        setPrefs(loaded);
        publishPrefs(loaded);
        applyDisplayPrefs(loaded);
        // 見た目（テーマとアクセント）はサーバーの値が正。端末をまたいで同じになる
        if (loaded.themeMode === 'light' || loaded.themeMode === 'dark' || loaded.themeMode === 'system') {
          setTheme(loaded.themeMode);
          setThemeChoice(loaded.themeMode);
          applyTheme(loaded.themeMode);
        }
        applyAccent(typeof loaded.accentColor === 'string' ? loaded.accentColor : undefined);
      }
    })();
  }, [user]);

  // キーボードショートカット（設定で入れた人だけ。n 投稿 / ? 一覧 ほか）
  const shortcuts = useKeyboardShortcuts(() => setComposer({}));

  const onTheme = useCallback((choice: ThemeChoice) => {
    setThemeChoice(choice);
    setTheme(choice);
    // 端末をまたいで同じ見た目にする（サーバーにも残す）
    void updatePrefs({ themeMode: choice });
  }, []);

  const onLogout = useCallback(async () => {
    await api.post('/api/auth/logout');
    setToken(null);
    setUser(null);
    setDrawerOpen(false);
    navigate('/');
  }, []);

  const onFollow = useCallback(async (target: DirectoryUser) => {
    const res = await api.post('/api/follow', { targetHandle: target.handle });
    if (res.ok) setFollowed((current) => new Set(current).add(target.handle));
  }, []);

  const onPosted = useCallback(() => {
    // タイムラインの読み直しは各画面が持つので、いちばん簡単なのは再読み込み
    window.dispatchEvent(new CustomEvent('spica:posted'));
  }, []);

  const menuButton = useMemo(
    () => <MenuButton user={user} server={server} onOpen={() => setDrawerOpen(true)} />,
    [user, server],
  );

  const aside = (
    <Aside
      live={live}
      server={server}
      tags={tags}
      recommended={directory}
      followed={followed}
      signedIn={Boolean(user)}
      onFollow={(target) => void onFollow(target)}
    />
  );

  // ログイン / 新規登録はシェルを付けない
  if (path.startsWith('/login') || path.startsWith('/register')) {
    if (path.startsWith('/register')) {
      return (
        <RegisterView
          server={server}
          onSignedIn={(next) => {
            setUser(next);
            void refreshUnread();
          }}
        />
      );
    }
    return (
      <LoginView
        onSignedIn={(next) => {
          setUser(next);
          void refreshUnread();
        }}
      />
    );
  }

  const signedIn = Boolean(user) && authChecked;

  const content = (
    // 1 つの画面が落ちても、ナビ（シェル）は残す
    <ErrorBoundary resetKey={path}>
      <Routes
        path={path}
        menuButton={menuButton}
        signedIn={signedIn}
        user={user}
        server={server}
        dmEnabled={Boolean(server?.features?.dm)}
        serverLoaded={Boolean(server)}
        prefs={prefs}
        onCompose={() => setComposer({})}
        onReply={(post) => setComposer({ replyTo: post })}
        onQuote={(post) => setComposer({ quoteOf: post })}
        onOpenProfile={(userId) => navigate(`/users/${encodeURIComponent(userId)}`)}
        onRead={() => void refreshUnread()}
        onLogout={() => void onLogout()}
        onPrefsChange={(next) => {
          setPrefs(next);
          publishPrefs(next);
          applyDisplayPrefs(next);
        }}
        theme={theme}
        onTheme={onTheme}
        onOnboarded={() => {
          void (async () => {
            const res = await api.get('/api/auth/me');
            if (res.ok && res.data && typeof res.data === 'object') setUser(res.data as SessionUser);
          })();
        }}
        onResumeDraft={(draft) => setComposer({ content: draft.content, cw: draft.cw, draftId: draft.id })}
      />
    </ErrorBoundary>
  );

  return (
    <>
      <Layout
        path={path}
        user={user}
        server={server}
        unread={unread}
        theme={theme}
        onTheme={onTheme}
        onCompose={() => setComposer({})}
        onLogout={() => void onLogout()}
        onOpenProfile={() => (user ? navigate(`/users/${user.id}`) : navigate('/login'))}
        drawerOpen={drawerOpen}
        onOpenDrawer={() => setDrawerOpen(true)}
        onCloseDrawer={() => setDrawerOpen(false)}
        notificationsActive={path.startsWith('/notifications')}
        aside={aside}
      >
        {content}
      </Layout>

      {user && composer && (
        <Composer
          user={user}
          replyTo={composer.replyTo}
          quoteOf={composer.quoteOf}
          initialContent={composer.content}
          initialCw={composer.cw}
          draftId={composer.draftId}
          onClose={() => setComposer(null)}
          onPosted={onPosted}
        />
      )}
      {!user && composer && <LoginNotice onClose={() => setComposer(null)} />}

      <ShortcutHelp open={shortcuts.helpOpen} onClose={shortcuts.closeHelp} />
    </>
  );
}
