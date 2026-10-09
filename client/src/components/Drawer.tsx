/**
 * モバイルのドロワー（左上のアバターから開く「左ナビ」）。
 * デスクトップの左ナビと同じ並び ＋ テーマ切替とログアウトを持つ。
 */
import { useEffect } from 'react';
import { LogOut } from 'lucide-react';
import {
  NAV_ADMIN,
  NAV_COLLECTIONS,
  NAV_PRIMARY,
  NAV_SYSTEM,
  canModerate,
  isActive,
  type NavItem,
} from '../lib/nav';
import type { SessionUser } from '../lib/format';
import type { ThemeChoice } from '../lib/theme';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  path: string;
  user: SessionUser | null;
  unread: number;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  onCompose: () => void;
  onLogout: () => void;
}

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: 'ライト' },
  { value: 'dark', label: 'ダーク' },
  { value: 'system', label: '端末に合わせる' },
];

function Item({ item, path, unread }: { item: NavItem; path: string; unread: number }) {
  const Icon = item.icon;
  const on = isActive(path, item);
  return (
    <a className={`nav__item${on ? ' nav__item--on' : ''}`} href={item.path} style={{ fontSize: 14.5 }}>
      <Icon size={18} strokeWidth={1.5} />
      {item.label}
      {item.badge === 'notifications' && unread > 0 && <span className="nav__count">{unread}</span>}
    </a>
  );
}

export default function Drawer({
  open,
  onClose,
  path,
  user,
  unread,
  theme,
  onTheme,
  onCompose,
  onLogout,
}: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="drawer" role="dialog" aria-modal="true">
      <button type="button" className="drawer__dim" aria-label="閉じる" onClick={onClose} />
      <div className="drawer__panel">
        <div className="drawer__brand">
          <span className="nav__mark">✦</span>
          <b>Spica</b>
        </div>

        {user ? (
          <button
            type="button"
            className="drawer__who"
            style={{ textAlign: 'left', width: '100%' }}
            onClick={() => {
              onClose();
              onCompose();
            }}
          >
            <span className="av av--s av--pearl" style={{ width: 34, height: 34 }}>
              {user.icon_url ? <img src={user.icon_url} alt="" /> : user.name.slice(0, 1)}
            </span>
            <span style={{ minWidth: 0 }}>
              <b style={{ display: 'block', fontSize: 13.5 }}>{user.name}</b>
              <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-faint)' }}>
                {user.handle}
              </span>
            </span>
          </button>
        ) : (
          <a className="drawer__who" href="/login" style={{ fontSize: 13.5 }}>
            ログイン / 新規登録
          </a>
        )}

        {NAV_PRIMARY.map((item) => (
          <Item key={item.path} item={item} path={path} unread={unread} />
        ))}
        <div className="drawer__sep" />
        <div className="drawer__group">まとめ</div>
        {NAV_COLLECTIONS.map((item) => (
          <Item key={item.path} item={item} path={path} unread={unread} />
        ))}
        <div className="drawer__sep" />
        {NAV_SYSTEM.map((item) => (
          <Item key={item.path} item={item} path={path} unread={unread} />
        ))}
        {canModerate(user?.role) &&
          NAV_ADMIN.map((item) => <Item key={item.path} item={item} path={path} unread={unread} />)}

        <div className="drawer__foot">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              className={`tg${theme === t.value ? ' tg--on' : ''}`}
              onClick={() => onTheme(t.value)}
            >
              {t.label}
            </button>
          ))}
          {user && (
            <button type="button" className="tg" onClick={onLogout} style={{ marginLeft: 'auto' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <LogOut size={14} strokeWidth={1.6} />
                ログアウト
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
