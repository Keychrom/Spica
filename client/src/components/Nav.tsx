/**
 * デスクトップの左ナビ。
 * ・全画面で消えない（通知・設定・プロフィールでも常にここにいる）
 * ・選択中は「淡い塗り＋影なし」だけ（タブと同じ言語）
 */
import { Feather } from 'lucide-react';
import { NAV_ADMIN, NAV_COLLECTIONS, NAV_PRIMARY, NAV_SYSTEM, canModerate, isActive, type NavItem } from '../lib/nav';
import type { SessionUser } from '../lib/format';

interface NavProps {
  path: string;
  user: SessionUser | null;
  unread: number;
  onCompose: () => void;
  onOpenProfile: () => void;
}

function Item({ item, path, unread }: { item: NavItem; path: string; unread: number }) {
  const Icon = item.icon;
  const on = isActive(path, item);
  return (
    <a className={`nav__item${on ? ' nav__item--on' : ''}`} href={item.path}>
      <Icon size={18} strokeWidth={1.5} />
      {item.label}
      {item.badge === 'notifications' && unread > 0 && <span className="nav__count">{unread}</span>}
    </a>
  );
}

export default function Nav({ path, user, unread, onCompose, onOpenProfile }: NavProps) {
  return (
    <nav className="nav">
      <a className="nav__brand" href="/">
        <span className="nav__mark">✦</span>
        <b>Spica</b>
      </a>

      {NAV_PRIMARY.map((item) => (
        <Item key={item.path} item={item} path={path} unread={unread} />
      ))}

      <div className="nav__sep" />
      {NAV_COLLECTIONS.map((item) => (
        <Item key={item.path} item={item} path={path} unread={unread} />
      ))}

      <div className="nav__sep" />
      {NAV_SYSTEM.map((item) => (
        <Item key={item.path} item={item} path={path} unread={unread} />
      ))}
      {canModerate(user?.role) &&
        NAV_ADMIN.map((item) => <Item key={item.path} item={item} path={path} unread={unread} />)}

      <button type="button" className="nav__compose" onClick={onCompose}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Feather size={16} strokeWidth={1.6} />
          ノートを作成
        </span>
      </button>

      <button type="button" className="nav__me" onClick={onOpenProfile}>
        <span className="av av--s av--pearl" style={{ width: 34, height: 34 }}>
          {user?.icon_url ? <img src={user.icon_url} alt="" /> : (user?.name || '?').slice(0, 1)}
        </span>
        <span style={{ minWidth: 0 }}>
          <b>{user?.name || 'ログインしていません'}</b>
          <span>{user?.handle || 'ログイン / 新規登録'}</span>
        </span>
      </button>
    </nav>
  );
}
