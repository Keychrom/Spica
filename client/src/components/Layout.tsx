/**
 * アプリの骨格（シェル）。
 * デスクトップ: 左ナビ / 中央 / 欄外。モバイル: 中央 1 列 + 下部バー + 投稿ボタン + ドロワー。
 * 画面ごとの中身は children（views/）が入れる。
 */
import type { ReactNode } from 'react';
import AnnouncementBar from './AnnouncementBar';
import { Bell, Feather, Home, Search, User } from 'lucide-react';
import Nav from './Nav';
import Drawer from './Drawer';
import type { SessionUser } from '../lib/format';
import type { ThemeChoice } from '../lib/theme';

interface LayoutProps {
  path: string;
  user: SessionUser | null;
  unread: number;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  onCompose: () => void;
  onLogout: () => void;
  onOpenProfile: () => void;
  drawerOpen: boolean;
  onOpenDrawer: () => void;
  onCloseDrawer: () => void;
  /** モバイル下部バーで「通知」を光らせる */
  notificationsActive?: boolean;
  aside: ReactNode;
  children: ReactNode;
}

export default function Layout(props: LayoutProps) {
  const { path, user, unread } = props;
  const onHome = path === '/' || path.startsWith('/?');

  return (
    <>
      <div className="app">
        <Nav
          path={path}
          user={user}
          unread={unread}
          onCompose={props.onCompose}
          onOpenProfile={props.onOpenProfile}
        />
        <main className="main">
          <AnnouncementBar path={path} />
          {props.children}
        </main>
        <aside className="aside">{props.aside}</aside>
      </div>

      {/* モバイル: 下部バー（よく行く 4 つだけ）と投稿ボタン */}
      <nav className="mbar">
        <a className={`mbar__item${onHome ? ' mbar__item--on' : ''}`} href="/">
          <Home size={20} strokeWidth={1.5} />
          ホーム
        </a>
        <a className={`mbar__item${path.startsWith('/search') ? ' mbar__item--on' : ''}`} href="/search">
          <Search size={20} strokeWidth={1.5} />
          検索
        </a>
        <a
          className={`mbar__item${props.notificationsActive ? ' mbar__item--on' : ''}`}
          href="/notifications"
        >
          <Bell size={20} strokeWidth={1.5} />
          通知
          {unread > 0 && <span className="mbar__badge">{unread > 99 ? '99+' : unread}</span>}
        </a>
        <button type="button" className="mbar__item" onClick={props.onOpenProfile}>
          <User size={20} strokeWidth={1.5} />
          自分
        </button>
      </nav>

      <button type="button" className="fab" onClick={props.onCompose} aria-label="ノートを作成">
        <Feather size={22} strokeWidth={1.6} />
      </button>

      <Drawer
        open={props.drawerOpen}
        onClose={props.onCloseDrawer}
        path={path}
        user={user}
        unread={unread}
        theme={props.theme}
        onTheme={props.onTheme}
        onCompose={props.onCompose}
        onLogout={props.onLogout}
      />
    </>
  );
}
